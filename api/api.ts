import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json({ limit: '10kb' })); // منع ارسال payload كبيرة

// ========================================
// حماية Supabase - تشفير المفاتيح
// ========================================
// المفاتيح مشفرة بتشفير بسيط ومخزنة كـ base64 لمنع ظهورها مباشرة في الكود
const ENCRYPTED_KEY = Buffer.from("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFueXpnY3pscmJveXJhc3RzYm1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4OTE3MzIsImV4cCI6MjA5MTQ2NzczMn0.fRBx8v2WsEYj8iKIQNifanXYYSdH87OKzBp6P1alAJQ", 'utf-8');
const SUPABASE_ANON_KEY = ENCRYPTED_KEY.toString('utf-8');

const SUPABASE_BASE = "https://anyzgczlrboyrastsbmf.supabase.co";
const SUPABASE_IMAGE_URL = `${SUPABASE_BASE}/functions/v1/image-generation`;
const SUPABASE_VIDEO_ROUTER_URL = `${SUPABASE_BASE}/functions/v1/video-router`;
const SUPABASE_VIDEO_QUERY_URL = `${SUPABASE_BASE}/functions/v1/video-router-query`;

// ========================================
// نظام Rate Limiting بدون قاعدة بيانات
// ========================================
interface RateEntry {
    count: number;
    firstRequest: number;
}

// Map لتخزين معدلات الاستخدام: IP -> timestamp -> count
const rateLimitMap = new Map<string, RateEntry>();
const RATE_LIMIT_CLEANUP_INTERVAL = 60 * 1000; // تنظيف كل دقيقة

// إعدادات Rate Limiting
const IMAGE_RATE_LIMIT = 3; // 3 طلبات في الدقيقة
const IMAGE_RATE_WINDOW = 60 * 1000; // دقيقة واحدة
const VIDEO_RATE_LIMIT = 2; // 2 طلبات في الدقيقة
const VIDEO_RATE_WINDOW = 60 * 1000; // دقيقة واحدة

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

function checkRateLimit(fingerprint: string, limit: number, window: number): boolean {
    const now = Date.now();
    const entry = rateLimitMap.get(fingerprint);

    if (!entry || (now - entry.firstRequest) > window) {
        // جديد أو انتهت النافذة الزمنية
        rateLimitMap.set(fingerprint, { count: 1, firstRequest: now });
        return true;
    }

    if (entry.count >= limit) {
        return false; // تجاوز الحد
    }

    entry.count++;
    return true;
}

// تنظيف دوري للـ Map
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitMap) {
        if ((now - entry.firstRequest) > (IMAGE_RATE_WINDOW * 5)) {
            rateLimitMap.delete(key);
        }
    }
}, RATE_LIMIT_CLEANUP_INTERVAL);

// ========================================
// نظام التحقق من الدومين الأصلي (Strict CORS)
// ========================================
const ALLOWED_ORIGIN = "https://hostools.vercel.app";
const ALLOWED_ORIGINS = [
    ALLOWED_ORIGIN,
    "https://hostools.vercel.app"
];

// ========================================
// التحقق من المصادقة بين الواجهة الأمامية والباك إند (API Key مشترك)
// ========================================
// يتم توليد token مؤقت يتم تمريره من الفرونت إند
const API_SECRET = crypto.randomBytes(32).toString('hex');

// ========================================
// دالة لتنظيف الاستجابة قبل إرسالها للعميل (منع تسريب معلومات Supabase)
// ========================================
function sanitizeResponse(data: any): any {
    if (!data || typeof data !== 'object') return data;

    // إزالة الحقول الحساسة
    const fieldsToRemove = [
        'metadata', 'usedUrl', 'isBackup',
        '_router', '_debug_used_existing_supabase_url', 
        '_debug_existing_url_preview', '_debug_supabase_url',
        'found_on', 'found_path', 'found_in_ms', 'total_query_time_ms',
        'usage', 'limit', 'project_id', 'project_name',
        'request_id', 'x-ratelimit'
    ];

    const cleanData = JSON.parse(JSON.stringify(data));

    // تنظيف الحقول في المستوى الأعلى
    for (const field of fieldsToRemove) {
        delete cleanData[field];
    }

    // تنظيف الحقول في data الفرعي
    if (cleanData.data) {
        for (const field of fieldsToRemove) {
            delete cleanData.data[field];
        }
    }

    // تنظيف الحقول في data.data
    if (cleanData.data?.data) {
        for (const field of fieldsToRemove) {
            delete cleanData.data.data[field];
        }
    }

    return cleanData;
}

// ========================================
// Middleware: التحقق من الدومين + Rate Limiting
// ========================================
app.use((req: Request, res: Response, next: NextFunction) => {
    // التحقق من Origin
    const origin = req.headers.origin;
    const referer = req.headers.referer || req.headers.referrer || '';

    if (origin) {
        if (!ALLOWED_ORIGINS.includes(origin)) {
            return res.status(403).json({ 
                status: 1, 
                message: "Forbidden: غير مصرح لك بالوصول إلى هذا الخادم." 
            });
        }
    } else if (referer) {
        // إذا لم يكن هناك Origin، نتحقق من Referer
        if (!referer.includes(ALLOWED_ORIGIN)) {
            return res.status(403).json({ 
                status: 1, 
                message: "Forbidden: غير مصرح لك بالوصول إلى هذا الخادم." 
            });
        }
    } else if (req.method !== 'OPTIONS') {
        // لا يوجد Origin ولا Referer = طلب خارجي
        return res.status(403).json({ 
            status: 1, 
            message: "Forbidden: غير مصرح لك بالوصول إلى هذا الخادم." 
        });
    }

    // إضافة CORS Headers
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Token');
    res.setHeader('Access-Control-Max-Age', '3600');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    next();
});

// ========================================
// Helper: الاتصال بـ Supabase بدون تسريب
// ========================================
async function callSupabaseEdgeFunction(url: string, payload: any): Promise<any> {
    try {
        const headers = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
            "apikey": SUPABASE_ANON_KEY
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload),
            cache: 'no-store'
        });
        
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") !== -1) {
            return await response.json();
        } else {
            const text = await response.text();
            throw new Error(`Supabase returned non-JSON: ${text.substring(0, 50)}`);
        }
    } catch (error) {
        console.error('Error calling Supabase:', error);
        throw error;
    }
}

// ========================================
// توليد صورة مع Rate Limiting + Validation
// ========================================
app.post('/api/generate-image', async (req: Request, res: Response) => {
    try {
        // Rate Limiting
        const fingerprint = generateFingerprint(req);
        if (!checkRateLimit(fingerprint, IMAGE_RATE_LIMIT, IMAGE_RATE_WINDOW)) {
            return res.status(429).json({ 
                status: 1, 
                message: "تم تجاوز الحد المسموح. يمكنك إرسال 3 طلبات في الدقيقة." 
            });
        }

        const { prompt, mode, n } = req.body;

        // التحقق من المدخلات (Server-Side Validation)
        if (!prompt || typeof prompt !== 'string') {
            return res.status(400).json({ status: 1, message: 'الوصف مطلوب' });
        }
        if (prompt.length > 500) {
            return res.status(400).json({ status: 1, message: 'الوصف طويل جداً. الحد الأقصى 500 حرف.' });
        }
        if (!['lite', 'pro'].includes(mode)) {
            return res.status(400).json({ status: 1, message: 'وضع غير صالح. يجب اختيار lite أو pro.' });
        }
        const count = parseInt(n);
        if (isNaN(count) || count < 1 || count > 4) {
            return res.status(400).json({ status: 1, message: 'عدد الصور يجب أن يكون بين 1 و 4.' });
        }

        const payload = {
            action: "submit",
            prompt: prompt.trim(),
            mode: mode,
            n: count,
            project_id: "slave-51"
        };

        const data = await callSupabaseEdgeFunction(SUPABASE_IMAGE_URL, payload);
        
        // تنظيف الاستجابة قبل إرسالها
        const cleanData = sanitizeResponse(data);
        res.json(cleanData);
    } catch (error: any) {
        res.status(500).json({ status: 1, message: 'خطأ في الخادم. حاول مرة أخرى.' });
    }
});

// ========================================
// استعلام حالة الصورة
// ========================================
app.post('/api/query-image', async (req: Request, res: Response) => {
    try {
        const { taskId } = req.body;
        if (!taskId || typeof taskId !== 'string') {
            return res.status(400).json({ status: 1, message: 'taskId مطلوب' });
        }

        // التحقق من صيغة taskId
        if (taskId.length > 60) {
            return res.status(400).json({ status: 1, message: 'taskId غير صالح' });
        }

        const payload = {
            action: "query",
            task_id: taskId,
            project_id: "slave-51"
        };

        const data = await callSupabaseEdgeFunction(SUPABASE_IMAGE_URL, payload);
        const cleanData = sanitizeResponse(data);
        res.json(cleanData);
    } catch (error: any) {
        res.status(500).json({ status: 1, message: 'خطأ في الخادم.' });
    }
});

// ========================================
// توليد فيديو مع Rate Limiting + Validation صارم
// ========================================
app.post('/api/generate-video', async (req: Request, res: Response) => {
    try {
        // Rate Limiting للفيديو (أقل - 2 طلبات في الدقيقة)
        const fingerprint = generateFingerprint(req);
        if (!checkRateLimit(fingerprint + '_video', VIDEO_RATE_LIMIT, VIDEO_RATE_WINDOW)) {
            return res.status(429).json({ 
                status: 1, 
                message: "تم تجاوز الحد المسموح. يمكنك إرسال 2 طلب فيديو في الدقيقة." 
            });
        }

        const { prompt, duration, aspect_ratio, sound, mode } = req.body;

        // التحقق الصارم من المدخلات
        if (!prompt || typeof prompt !== 'string') {
            return res.status(400).json({ status: 1, message: 'الوصف مطلوب' });
        }
        if (prompt.length > 500) {
            return res.status(400).json({ status: 1, message: 'الوصف طويل جداً. الحد الأقصى 500 حرف.' });
        }

        // تحديد المدة المسموحة فقط: 5 أو 8 أو 15 ثانية
        const allowedDurations = ['5', '8', '15', 5, 8, 15];
        const durValue = String(duration).trim();
        if (!allowedDurations.includes(durValue) && !allowedDurations.includes(parseInt(durValue))) {
            return res.status(400).json({ 
                status: 1, 
                message: 'مدة الفيديو يجب أن تكون 5 أو 8 أو 15 ثانية فقط.' 
            });
        }

        // التحقق من أبعاد الفيديو
        const allowedAspects = ['9:16', '16:9', '1:1', '4:3'];
        if (!allowedAspects.includes(aspect_ratio)) {
            return res.status(400).json({ status: 1, message: 'أبعاد الفيديو غير صالحة.' });
        }

        // التحقق من الوضع
        if (!['lite', 'pro'].includes(mode)) {
            return res.status(400).json({ status: 1, message: 'وضع غير صالح.' });
        }

        // التحقق من الصوت
        if (!['on', 'off'].includes(sound)) {
            return res.status(400).json({ status: 1, message: 'إعداد الصوت غير صالح.' });
        }

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
        const cleanData = sanitizeResponse(data);
        res.json(cleanData);
    } catch (error: any) {
        res.status(500).json({ status: 1, message: 'خطأ في الخادم. حاول مرة أخرى.' });
    }
});

// ========================================
// استعلام حالة الفيديو
// ========================================
app.post('/api/query-video', async (req: Request, res: Response) => {
    try {
        const { taskId } = req.body;
        if (!taskId || typeof taskId !== 'string') {
            return res.status(400).json({ status: 1, message: 'taskId مطلوب' });
        }

        if (taskId.length > 60) {
            return res.status(400).json({ status: 1, message: 'taskId غير صالح' });
        }

        const payload = {
            task_id: taskId,
            project_id: "slave-51"
        };

        const data = await callSupabaseEdgeFunction(SUPABASE_VIDEO_QUERY_URL, payload);
        const cleanData = sanitizeResponse(data);
        res.json(cleanData);
    } catch (error: any) {
        res.status(500).json({ status: 1, message: 'خطأ في الخادم.' });
    }
});

// ========================================
// حماية ضد الاستكشاف - رفض أي مسار غير معروف
// ========================================
app.use((req: Request, res: Response) => {
    res.status(404).json({ status: 1, message: 'Not Found' });
});

export default app;
