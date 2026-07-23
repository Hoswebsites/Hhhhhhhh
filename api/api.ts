import express, { Request, Response, NextFunction } from 'express';

const app = express();
app.use(express.json());

// Hardcoded Supabase Credentials
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFueXpnY3pscmJveXJhc3RzYm1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4OTE3MzIsImV4cCI6MjA5MTQ2NzczMn0.fRBx8v2WsEYj8iKIQNifanXYYSdH87OKzBp6P1alAJQ";

// Endpoints
const SUPABASE_IMAGE_URL = "https://anyzgczlrboyrastsbmf.supabase.co/functions/v1/image-generation";
const SUPABASE_VIDEO_ROUTER_URL = "https://anyzgczlrboyrastsbmf.supabase.co/functions/v1/video-router";
const SUPABASE_VIDEO_QUERY_URL = "https://anyzgczlrboyrastsbmf.supabase.co/functions/v1/video-router-query";

// ----------------------------------------
// نظام الحماية الصارم (Strict CORS & Origin Check)
// ----------------------------------------
const ALLOWED_ORIGIN = "https://hostools.vercel.app";

app.use((req: Request, res: Response, next: NextFunction) => {
    // جلب مصدر الطلب
    const origin = req.headers.origin;

    // التحقق: إذا لم يكن هناك مصدر، أو المصدر لا يطابق الدومين المسموح به تماماً، يتم حظر الطلب.
    if (origin !== ALLOWED_ORIGIN) {
        console.warn(`Blocked unauthorized request from origin: ${origin}`);
        return res.status(403).json({ 
            status: 1, 
            message: "Forbidden: غير مصرح لك بالوصول إلى هذا الخادم. يسمح بالوصول من الدومين الرسمي فقط." 
        });
    }

    // إذا كان المصدر صحيحاً، يتم إضافة الهيدرز للسماح له
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS'); // نكتفي بـ POST و OPTIONS لأننا لا نستخدم GET
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');
    
    // التعامل مع طلبات OPTIONS الخاصة بالمتصفح
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    next();
});

// Helper function to handle Supabase Edge Function calls
async function callSupabaseEdgeFunction(url: string, payload: any, headers: any) {
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload),
            cache: 'no-store' // لمنع الكاش
        });
        
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") !== -1) {
            return await response.json();
        } else {
            const text = await response.text();
            throw new Error(`Supabase returned non-JSON: ${text.substring(0, 100)}`);
        }
    } catch (error) {
        console.error('Error calling Supabase Edge Function:', error);
        throw error;
    }
}

// ----------------------------------------
// Image Generation Endpoints
// ----------------------------------------

app.post('/api/generate-image', async (req: Request, res: Response) => {
    try {
        const { prompt, mode, n } = req.body;
        if (!prompt || !mode || !n) {
            return res.status(400).json({ status: 1, message: 'Missing required parameters: prompt, mode, n' });
        }

        const headers = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
            "apikey": SUPABASE_ANON_KEY
        };

        const payload = {
            action: "submit",
            prompt: prompt,
            mode: mode,
            n: n,
            project_id: "slave-51" // لاحظ قيمة الـ project_id هنا
        };

        const data = await callSupabaseEdgeFunction(SUPABASE_IMAGE_URL, payload, headers);
        res.json(data);
    } catch (error: any) {
        res.status(500).json({ status: 1, message: error.message || 'Internal Server Error' });
    }
});

app.post('/api/query-image', async (req: Request, res: Response) => {
    try {
        const { taskId } = req.body;
        if (!taskId) {
            return res.status(400).json({ status: 1, message: 'Missing taskId' });
        }

        const headers = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
            "apikey": SUPABASE_ANON_KEY
        };

        const payload = {
            action: "query",
            task_id: taskId,
            project_id: "slave-51" // <-- [تم التصحيح هنا] كانت 51، أصبحت متطابقة مع الإنشاء
        };

        const data = await callSupabaseEdgeFunction(SUPABASE_IMAGE_URL, payload, headers);
        res.json(data);
    } catch (error: any) {
        res.status(500).json({ status: 1, message: error.message || 'Internal Server Error' });
    }
});

// ----------------------------------------
// Video Generation Endpoints
// ----------------------------------------

app.post('/api/generate-video', async (req: Request, res: Response) => {
    try {
        const { prompt, duration, aspect_ratio, sound, mode } = req.body;
        const headers = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
            "apikey": SUPABASE_ANON_KEY
        };

        const payload = {
            prompt: prompt,
            duration: String(duration),
            aspect_ratio: aspect_ratio,
            sound: sound,
            mode: mode,
            audio_enabled: (sound === 'on'), 
            project_id: "slave-51"
        };

        const data = await callSupabaseEdgeFunction(SUPABASE_VIDEO_ROUTER_URL, payload, headers);
        res.json(data);
    } catch (error: any) {
        res.status(500).json({ status: 1, message: error.message || 'Internal Server Error' });
    }
});

app.post('/api/query-video', async (req: Request, res: Response) => {
    try {
        const { taskId } = req.body;
        const headers = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
            "apikey": SUPABASE_ANON_KEY
        };

        const payload = {
            task_id: taskId,
            project_id: "slave-51" // <-- [تم التصحيح هنا] كانت 51، أصبحت متطابقة مع الإنشاء
        };

        const data = await callSupabaseEdgeFunction(SUPABASE_VIDEO_QUERY_URL, payload, headers);
        res.json(data);
    } catch (error: any) {
        res.status(500).json({ status: 1, message: error.message || 'Internal Server Error' });
    }
});

export default app;
