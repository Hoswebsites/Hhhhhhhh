import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json({ limit: '10kb' }));

// ========================================
// مفاتيح Supabase 
// ========================================
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFueXpnY3pscmJveXJhc3RzYm1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4OTE3MzIsImV4cCI6MjA5MTQ2NzczMn0.fRBx8v2WsEYj8iKIQNifanXYYSdH87OKzBp6P1alAJQ";
const SUPABASE_BASE = "https://anyzgczlrboyrastsbmf.supabase.co";
const SUPABASE_IMAGE_URL = `${SUPABASE_BASE}/functions/v1/image-generation`;
const SUPABASE_VIDEO_ROUTER_URL = `${SUPABASE_BASE}/functions/v1/video-router`;
const SUPABASE_VIDEO_QUERY_URL = `${SUPABASE_BASE}/functions/v1/video-router-query`;

// ========================================
// نظام Rate Limiting بدون قاعدة بيانات (In-Memory)
// ========================================
interface RateEntry {
    count: number;
    firstRequest: number;
}

const rateLimitMap = new Map<string, RateEntry>();
const IMAGE_RATE_LIMIT = 3;
const IMAGE_RATE_WINDOW = 60 * 1000;
const VIDEO_RATE_LIMIT = 2;
const VIDEO_RATE_WINDOW = 60 * 1000;

function getClientIP(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = typeof forwarded === 'string'
        ? forwarded.split(',')[0].trim()
        : req.ip || req.socket.remoteAddress || 'unknown';
    return ip;
}

function generateFingerprint(req: Request): string {
    const ip = getClientIP(req);
    const userAgent = (req.headers['user-agent'] || 'unknown').substring(0, 200);
    const combined = `${ip}|${userAgent}`;
    return crypto.createHash('sha256').update(combined).digest('hex').substring(0, 32);
}

function checkRateLimit(fingerprint: string, limit: number, window: number): { allowed: boolean; resetAt: number } {
    const now = Date.now();
    const entry = rateLimitMap.get(fingerprint);

    if (!entry || (now - entry.firstRequest) > window) {
        rateLimitMap.set(fingerprint, { count: 1, firstRequest: now });
        return { allowed: true, resetAt: now + window };
    }

    if (entry.count >= limit) {
        return { allowed: false, resetAt: entry.firstRequest + window };
    }

    entry.count++;
    return { allowed: true, resetAt: entry.firstRequest + window };
}

// تنظيف دوري للـ Rate Limit
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitMap) {
        if ((now - entry.firstRequest) > (IMAGE_RATE_WINDOW * 5)) {
            rateLimitMap.delete(key);
        }
    }
}, 60 * 1000);

// ========================================
// Middleware: CORS + حماية الدومين
// ========================================
const ALLOWED_ORIGIN = "https://hostools.vercel.app";

app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;

    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '3600');

    // رفض الطلبات من دومينات أخرى
    if (origin && origin !== ALLOWED_ORIGIN) {
        return res.status(403).json({
            status: 1,
            message: "Forbidden: غير مصرح لك بالوصول إلى هذا الخادم."
        });
    }

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    next();
});

// ========================================
// دالة تنظيف الاستجابة ومعالجة الـ Base64 للصور
// ========================================
function formatAndSanitizeResponse(data: any): any {
    if (!data || typeof data !== 'object') return data;

    // 1. تنظيف البيانات من معلومات Supabase الحساسة
    const fieldsToRemove = [
        'metadata', 'usedUrl', 'isBackup',
        '_router', '_debug_used_existing_supabase_url',
        '_debug_existing_url_preview', '_debug_supabase_url',
        'found_on', 'found_path', 'found_in_ms', 'total_query_time_ms',
        'usage', 'limit', 'project_id', 'project_name',
        'request_id', 'x-ratelimit'
    ];

    let cleanData = JSON.parse(JSON.stringify(data)); // Deep Copy

    for (const field of fieldsToRemove) { delete cleanData[field]; }
    if (cleanData.data) { for (const field of fieldsToRemove) { delete cleanData.data[field]; } }
    if (cleanData.data?.data) { for (const field of fieldsToRemove) { delete cleanData.data.data[field]; } }

    // 2. استخراج صورة Base64 وتجهيزها للـ Frontend (الحل للمشكلة المكتشفة)
    try {
        // البحث عن Base64 في المسار الذي ذكرته
        const base64Image = cleanData?.data?.result?.content?.[0]?.image?.data;
        
        if (base64Image) {
            // إضافة المتغير image_url في الجذر لسهولة الوصول من الـ Frontend
            cleanData.image_url = `data:image/jpeg;base64,${base64Image}`;
            cleanData.is_ready = true; // لتسهيل الفحص في الواجهة
        } 
        // في حال تم إرجاع URL عادي في المستقبل
        else if (cleanData?.data?.url || cleanData?.url) {
            cleanData.image_url = cleanData?.data?.url || cleanData?.url;
            cleanData.is_ready = true;
        }
    } catch (e) {
        console.error("Error formatting image response:", e);
    }

    return cleanData;
}

// ========================================
// Helper: الاتصال بـ Supabase Edge Function
// ========================================
async function callSupabaseEdgeFunction(url: string, payload: any): Promise<any> {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
            "apikey": SUPABASE_ANON_KEY
        },
        body: JSON.stringify(payload),
        cache: 'no-store'
    });

    const contentType = response.headers.get("content-type");
    if (contentType && contentType.indexOf("application/json") !== -1) {
        return await response.json();
    } else {
        const text = await response.text();
        throw new Error(`Supabase returned non-JSON: ${text.substring(0, 100)}`);
    }
}

// ========================================
// توليد صورة 
// ========================================
app.post('/api/generate-image', async (req: Request, res: Response) => {
    try {
        const fingerprint = generateFingerprint(req);
        const rl = checkRateLimit(fingerprint, IMAGE_RATE_LIMIT, IMAGE_RATE_WINDOW);
        if (!rl.allowed) {
            return res.status(429).json({ status: 1, message: "تم تجاوز الحد المسموح. يمكنك إرسال 3 طلبات في الدقيقة." });
        }

        const { prompt, mode, n } = req.body;

        if (!prompt || typeof prompt !== 'string') return res.status(400).json({ status: 1, message: 'الوصف مطلوب' });
        if (prompt.length > 500) return res.status(400).json({ status: 1, message: 'الوصف طويل جداً.' });
        if (!['lite', 'pro'].includes(mode)) return res.status(400).json({ status: 1, message: 'وضع غير صالح.' });
        
        const count = parseInt(n);
        if (isNaN(count) || count < 1 || count > 4) return res.status(400).json({ status: 1, message: 'عدد الصور غير صالح.' });

        const payload = {
            action: "submit",
            mode: mode,
            prompt: prompt.trim(),
            n: count
        };

        const data = await callSupabaseEdgeFunction(SUPABASE_IMAGE_URL, payload);
        res.json(formatAndSanitizeResponse(data));
    } catch (error: any) {
        console.error('Image generation error:', error.message);
        res.status(500).json({ status: 1, message: 'خطأ في الخادم. حاول مرة أخرى.' });
    }
});

// ========================================
// استعلام حالة الصورة 
// ========================================
app.post('/api/query-image', async (req: Request, res: Response) => {
    try {
        const { taskId } = req.body;
        if (!taskId || typeof taskId !== 'string' || taskId.length > 60) {
            return res.status(400).json({ status: 1, message: 'taskId غير صالح أو مفقود' });
        }

        const payload = {
            action: "query",
            taskId: taskId
        };

        const data = await callSupabaseEdgeFunction(SUPABASE_IMAGE_URL, payload);
        // الدالة formatAndSanitizeResponse ستقوم باكتشاف الـ Base64 هنا وإرجاعه كـ URL
        res.json(formatAndSanitizeResponse(data));
    } catch (error: any) {
        console.error('Image query error:', error.message);
        res.status(500).json({ status: 1, message: 'خطأ في الخادم.' });
    }
});

// ========================================
// توليد فيديو
// ========================================
app.post('/api/generate-video', async (req: Request, res: Response) => {
    try {
        const fingerprint = generateFingerprint(req) + '_video';
        const rl = checkRateLimit(fingerprint, VIDEO_RATE_LIMIT, VIDEO_RATE_WINDOW);
        if (!rl.allowed) {
            return res.status(429).json({ status: 1, message: "تم تجاوز الحد المسموح. 2 طلب فيديو بالدقيقة." });
        }

        const { prompt, duration, aspect_ratio, sound, mode } = req.body;

        if (!prompt || typeof prompt !== 'string' || prompt.length > 500) {
            return res.status(400).json({ status: 1, message: 'الوصف غير صالح.' });
        }

        const allowedDurations = ['5', '8', '15', 5, 8, 15];
        const durValue = String(duration).trim();
        if (!allowedDurations.includes(durValue)) {
            return res.status(400).json({ status: 1, message: 'المدة يجب أن تكون 5, 8, أو 15 ثانية.' });
        }

        const allowedAspects = ['9:16', '16:9', '1:1', '4:3'];
        if (!allowedAspects.includes(aspect_ratio)) return res.status(400).json({ status: 1, message: 'أبعاد غير صالحة.' });
        if (!['lite', 'pro'].includes(mode)) return res.status(400).json({ status: 1, message: 'وضع غير صالح.' });
        if (!['on', 'off'].includes(sound)) return res.status(400).json({ status: 1, message: 'إعداد الصوت غير صالح.' });

        const payload = {
            prompt: prompt.trim(),
            duration: durValue,
            aspect_ratio: aspect_ratio,
            sound: sound,
            mode: mode,
            audio_enabled: (sound === 'on'),
            project_id: "slave-51"
        };

        const data = await callSupabaseEdgeFunction(SUPABASE_VIDEO_ROUTER_URL, payload);
        res.json(formatAndSanitizeResponse(data)); // نمررها لنفس الدالة لتنظيف الـ Headers
    } catch (error: any) {
        console.error('Video generation error:', error.message);
        res.status(500).json({ status: 1, message: 'خطأ في الخادم.' });
    }
});

// ========================================
// استعلام حالة الفيديو
// ========================================
app.post('/api/query-video', async (req: Request, res: Response) => {
    try {
        const { taskId } = req.body;
        if (!taskId || typeof taskId !== 'string' || taskId.length > 60) {
            return res.status(400).json({ status: 1, message: 'taskId غير صالح' });
        }

        const payload = {
            task_id: taskId,
            project_id: 51
        };

        const data = await callSupabaseEdgeFunction(SUPABASE_VIDEO_QUERY_URL, payload);
        res.json(formatAndSanitizeResponse(data));
    } catch (error: any) {
        console.error('Video query error:', error.message);
        res.status(500).json({ status: 1, message: 'خطأ في الخادم.' });
    }
});

// ========================================
// رفض أي مسار غير معروف
// ========================================
app.use((req: Request, res: Response) => {
    res.status(404).json({ status: 1, message: 'Not Found' });
});

export default app;
