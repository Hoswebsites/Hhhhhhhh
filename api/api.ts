import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json({ limit: '50kb' }));

// ========================================
// Supabase Configuration
// ========================================
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFueXpnY3pscmJveXJhc3RzYm1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4OTE3MzIsImV4cCI6MjA5MTQ2NzczMn0.fRBx8v2WsEYj8iKIQNifanXYYSdH87OKzBp6P1alAJQ";
const SUPABASE_BASE = "https://anyzgczlrboyrastsbmf.supabase.co";

// Endpoints - EXACTLY like hamzawyai.com
const GEMINI_IMAGE_ENDPOINT = `${SUPABASE_BASE}/functions/v1/gemini-image-generator`;
const IMAGE_GENERATION_ENDPOINT = `${SUPABASE_BASE}/functions/v1/image-generation`;
const IMAGE_FALLBACK_ENDPOINT = `${SUPABASE_BASE}/functions/v1/image-fallback`;
const VIDEO_ROUTER_ENDPOINT = `${SUPABASE_BASE}/functions/v1/video-router`;
const VIDEO_QUERY_ENDPOINT = `${SUPABASE_BASE}/functions/v1/video-router-query`;
const LIP_SYNC_ENDPOINT = `${SUPABASE_BASE}/functions/v1/seedance-lip-sync`;
const TTS_ENDPOINT = `${SUPABASE_BASE}/functions/v1/text-to-speech`;

// ========================================
// Task Token Storage
// ========================================
interface TaskRecord {
    id: string;
    token: string;
    type: 'image' | 'video' | 'lipsync';
    prompt: string;
    model: string;
    mode: string;
    createdAt: number;
    status: string;
    resultUrl?: string;
    resultUrls?: string[];
}

const tasksMap = new Map<string, TaskRecord>();
const TOKEN_LIFETIME = 7 * 24 * 60 * 60 * 1000; // 7 days

setInterval(() => {
    const now = Date.now();
    for (const [token, record] of tasksMap) {
        if (now - record.createdAt > TOKEN_LIFETIME) {
            tasksMap.delete(token);
        }
    }
}, 60 * 60 * 1000);

// ========================================
// Rate Limiting
// ========================================
interface RateEntry { count: number; firstRequest: number; }
const rateLimitMap = new Map<string, RateEntry>();
const IMAGE_RATE_LIMIT = 10;
const VIDEO_RATE_LIMIT = 5;
const RATE_WINDOW = 60 * 1000;

function getFingerprint(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.ip || 'unknown';
    const ua = (req.headers['user-agent'] || 'unknown').substring(0, 200);
    return crypto.createHash('sha256').update(`${ip}|${ua}`).digest('hex').substring(0, 32);
}

function checkRate(fp: string, type: 'image' | 'video'): boolean {
    const now = Date.now();
    const limit = type === 'image' ? IMAGE_RATE_LIMIT : VIDEO_RATE_LIMIT;
    const key = `${fp}_${type}`;
    const entry = rateLimitMap.get(key);
    if (!entry || (now - entry.firstRequest) > RATE_WINDOW) {
        rateLimitMap.set(key, { count: 1, firstRequest: now });
        return true;
    }
    if (entry.count >= limit) return false;
    entry.count++;
    return true;
}

setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitMap) {
        if ((now - entry.firstRequest) > (RATE_WINDOW * 5)) rateLimitMap.delete(key);
    }
}, 60 * 60 * 1000);

// ========================================
// CORS
// ========================================
const ALLOWED_ORIGINS = [
    "https://hostools.vercel.app",
    "https://hostools.ct.ws",
    "https://hostools.onrender.com",
    "http://localhost:3000",
    "http://localhost:5173"
];

app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    const referer = req.headers.referer || req.headers.referrer || '';

    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
        if (!referer || !ALLOWED_ORIGINS.some(o => referer.includes(o.replace('https://', '').replace('http://', '').replace('www.', '')))) {
            return res.status(403).json({ status: 1, message: 'Forbidden' });
        }
    }

    const allowedOrigin = ALLOWED_ORIGINS.find(o => o === origin) || ALLOWED_ORIGINS[0];
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '3600');

    if (req.method === 'OPTIONS') { res.status(200).end(); return; }
    next();
});

// ========================================
// Sanitize Response
// ========================================
function sanitize(data: any): any {
    if (!data || typeof data !== 'object') return data;
    const clean = JSON.parse(JSON.stringify(data));
    const remove = ['metadata', 'usedUrl', 'isBackup', 'usage', 'limit', 'project_id', 'project_name', 'request_id', 'x-ratelimit'];
    const deepRemove = (obj: any) => {
        if (!obj || typeof obj !== 'object') return;
        for (const field of remove) delete obj[field];
        if (obj.data) deepRemove(obj.data);
    };
    deepRemove(clean);
    return clean;
}

// ========================================
// Call Supabase
// ========================================
async function callSupabase(url: string, payload: any): Promise<any> {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'apikey': SUPABASE_ANON_KEY
        },
        body: JSON.stringify(payload),
        cache: 'no-store'
    });

    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
        return await response.json();
    }
    throw new Error(`Supabase returned non-JSON: ${response.status}`);
}

// ========================================
// Token Generation
// ========================================
function generateTaskToken(): string {
    return `tkn_${crypto.randomBytes(12).toString('hex')}`;
}

// ========================================
// API Endpoints
// ========================================

// ============================================
// 1. GENERATE IMAGE (Gemini - Lite - DIRECT)
// EXACTLY like hamzawyai.com gemini-image-generator
// Returns URL immediately - no polling!
// ============================================
app.post('/generate-image', async (req: Request, res: Response) => {
    try {
        const fp = getFingerprint(req);
        if (!checkRate(fp, 'image')) {
            return res.status(429).json({ status: 1, message: 'تم تجاوز الحد. 10 طلبات/دقيقة للصور.' });
        }

        const { prompt, mode, n, model } = req.body;

        if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
            return res.status(400).json({ status: 1, message: 'الوصف مطلوب' });
        }
        if (prompt.length > 1000) {
            return res.status(400).json({ status: 1, message: 'الوصف طويل جداً (حد أقصى 1000 حرف)' });
        }
        const count = parseInt(n) || 1;
        if (count < 1 || count > 4) {
            return res.status(400).json({ status: 1, message: 'عدد الصور بين 1 و 4.' });
        }

        let imageData: any = null;
        let error: string | null = null;

        // ============================================================
        // STRATEGY 1: gemini-image-generator (PRIMARY - Works!)
        // This is EXACTLY what hamzawyai.com uses for Lite images
        // Returns direct URL immediately
        // ============================================================
        try {
            const geminiPayload: any = {
                instruction: prompt.trim(),
                temperature: 0.7,
                n: count
            };

            if (mode === 'pro') {
                geminiPayload.temperature = 0.9;
                geminiPayload.quality = 'high';
            }

            if (model && model !== 'gemini') {
                geminiPayload.model = model;
            }

            const geminiRes = await callSupabase(GEMINI_IMAGE_ENDPOINT, geminiPayload);

            if (geminiRes?.code === 0 && geminiRes?.data?.url) {
                imageData = geminiRes;
            } else if (geminiRes?.data?.urls && geminiRes.data.urls.length > 0) {
                imageData = geminiRes;
            }
        } catch (geminiErr: any) {
            error = geminiErr.message;
        }

        // ============================================================
        // STRATEGY 2: image-generation (ADVANCED - Fallback)
        // ============================================================
        if (!imageData) {
            try {
                const advPayload: any = {
                    action: 'submit',
                    prompt: prompt.trim(),
                    mode: mode || 'lite',
                    n: count
                };

                if (model) advPayload.model = model;

                const advRes = await callSupabase(IMAGE_GENERATION_ENDPOINT, advPayload);
                const advTaskId = advRes?.data?.taskId;

                if (advTaskId) {
                    // Poll for result
                    for (let attempt = 0; attempt < 20; attempt++) {
                        await new Promise(r => setTimeout(r, 3000));
                        try {
                            const qRes = await callSupabase(IMAGE_GENERATION_ENDPOINT, {
                                action: 'query',
                                taskId: advTaskId,
                                _t: Date.now()
                            });

                            const status = qRes?.data?.status?.toUpperCase();
                            const resultUrls = qRes?.data?.result?.images?.map((img: any) => img.url) || [];

                            if (resultUrls.length > 0) {
                                imageData = { code: 0, data: { urls: resultUrls, url: resultUrls[0] } };
                                break;
                            }

                            if (['SUCCEED', 'SUCCESS'].includes(status)) {
                                const deepUrl = extractDeepUrl(qRes);
                                if (deepUrl) {
                                    imageData = { code: 0, data: { urls: [deepUrl], url: deepUrl } };
                                    break;
                                }
                            }

                            if (['FAILED', 'ERROR'].includes(status)) break;
                        } catch { /* continue polling */ }
                    }
                }
            } catch (advErr: any) {
                if (!error) error = advErr.message;
            }
        }

        // ============================================================
        // STRATEGY 3: image-fallback
        // ============================================================
        if (!imageData) {
            try {
                const fallbackRes = await callSupabase(IMAGE_FALLBACK_ENDPOINT, {
                    action: 'submit',
                    prompt: prompt.trim(),
                    mode: mode || 'lite',
                    n: count
                });

                const fallbackUrls = fallbackRes?.data?.urls || [];
                if (fallbackUrls.length > 0) {
                    imageData = { code: 0, data: { urls: fallbackUrls, url: fallbackUrls[0] } };
                }
            } catch { /* all strategies failed */ }
        }

        // ============================================================
        // Build Response
        // ============================================================
        if (imageData?.data?.url) {
            const urls = imageData.data.urls || [imageData.data.url];
            const token = generateTaskToken();

            tasksMap.set(token, {
                id: 'gemini-direct-' + Date.now(),
                token,
                type: 'image',
                prompt: prompt.trim(),
                model: model || 'gemini',
                mode: mode || 'lite',
                createdAt: Date.now(),
                status: 'completed',
                resultUrl: urls[0],
                resultUrls: urls
            });

            return res.json({
                status: 0,
                message: 'تم إنشاء الصورة بنجاح',
                token,
                imageUrls: urls,
                imageUrl: urls[0],
                count: urls.length,
                mimeType: imageData.data.mimeType || 'image/jpeg',
                data: sanitize(imageData)
            });
        }

        // All strategies failed
        return res.json({
            status: 1,
            message: 'فشل توليد الصورة. جميع المحركات مستنفذة حالياً. حاول لاحقاً.',
            error: error || 'Unknown error'
        });

    } catch (error: any) {
        console.error('Image generation error:', error);
        res.status(500).json({ status: 1, message: 'خطأ في الخادم. حاول مرة أخرى.' });
    }
});

// ============================================
// 2. QUERY IMAGE (by taskId for advanced mode)
// ============================================
app.post('/query-image', async (req: Request, res: Response) => {
    try {
        const { taskId } = req.body;
        if (!taskId || typeof taskId !== 'string' || taskId.length > 100) {
            return res.status(400).json({ status: 1, message: 'taskId غير صالح' });
        }

        // Try image-generation query
        const data = await callSupabase(IMAGE_GENERATION_ENDPOINT, {
            action: 'query',
            taskId: taskId,
            _t: Date.now()
        });

        const status = data?.data?.status?.toUpperCase() || 'UNKNOWN';
        const urls = data?.data?.result?.images?.map((img: any) => img.url) || [];
        const deepUrl = extractDeepUrl(data);

        // Update task record
        for (const [token, record] of tasksMap) {
            if (record.id === taskId && record.type === 'image') {
                if (['SUCCEED', 'SUCCESS'].includes(status)) record.status = 'completed';
                else if (status === 'FAILED') record.status = 'failed';
                if (urls.length > 0) { record.resultUrl = urls[0]; record.resultUrls = urls; }
                break;
            }
        }

        res.json({
            status: 0,
            taskId,
            taskStatus: status,
            imageUrls: urls.length > 0 ? urls : undefined,
            imageUrl: urls[0] || deepUrl || null,
            data: sanitize(data)
        });
    } catch (error: any) {
        console.error('Query image error:', error);
        res.status(500).json({ status: 1, message: 'خطأ في الاستعلام.' });
    }
});

// ============================================
// 3. GENERATE VIDEO (EXACTLY like hamzawyai.com)
// ============================================
app.post('/generate-video', async (req: Request, res: Response) => {
    try {
        const fp = getFingerprint(req);
        if (!checkRate(fp, 'video')) {
            return res.status(429).json({ status: 1, message: 'تم تجاوز الحد. 5 طلبات/دقيقة للفيديو.' });
        }

        const { prompt, duration, aspect_ratio, sound, mode, model } = req.body;

        if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
            return res.status(400).json({ status: 1, message: 'الوصف مطلوب' });
        }
        if (prompt.length > 1000) {
            return res.status(400).json({ status: 1, message: 'الوصف طويل جداً' });
        }
        const durValue = String(duration).trim();
        if (!['5', '8', '15'].includes(durValue)) {
            return res.status(400).json({ status: 1, message: 'المدة: 5 أو 8 أو 15 ثانية' });
        }
        const allowedAspects = ['9:16', '16:9', '1:1', '4:3'];
        if (!allowedAspects.includes(aspect_ratio)) {
            return res.status(400).json({ status: 1, message: 'أبعاد غير صالحة' });
        }
        if (!['lite', 'pro'].includes(mode || '')) {
            return res.status(400).json({ status: 1, message: 'الوضع غير صالح' });
        }
        if (!['on', 'off'].includes(sound || '')) {
            return res.status(400).json({ status: 1, message: 'إعداد الصوت غير صالح' });
        }

        const payload: any = {
            prompt: prompt.trim(),
            duration: durValue,
            aspect_ratio: aspect_ratio,
            sound: sound,
            mode: mode,
            audio_enabled: sound === 'on',
            project_id: 'slave-51'
        };

        // Map model to specific configuration
        if (model === 'seedance') {
            payload.model = 'seedance';
            payload.project_id = 'slave-51';
        } else if (model === 'kling-omni') {
            payload.model = 'kling-omni';
            payload.project_id = 'slave-51';
        } else if (model === 'kling-v2') {
            payload.model = 'kling-v2';
            payload.project_id = 'slave-51';
        } else if (model === 'runway-gen3') {
            payload.model = 'runway-gen3';
            payload.project_id = 'slave-51';
        }

        const data = await callSupabase(VIDEO_ROUTER_ENDPOINT, payload);
        const sanitized = sanitize(data);

        const taskId = data?.data?.data?.task_id || data?.data?.task_id;
        const status = String(data?.data?.task_status || data?.data?.status || '').toLowerCase();
        const videoUrl = extractVideoUrl(data);

        const token = generateTaskToken();
        tasksMap.set(token, {
            id: taskId || '',
            token,
            type: 'video',
            prompt: prompt.trim(),
            model: model || 'seedance',
            mode: mode || 'lite',
            createdAt: Date.now(),
            status: taskId ? 'processing' : 'completed',
            resultUrl: videoUrl || undefined
        });

        res.json({
            status: 0,
            message: 'تم إرسال الطلب بنجاح',
            token,
            taskId,
            videoUrl,
            taskStatus: status,
            data: sanitized
        });
    } catch (error: any) {
        console.error('Video generation error:', error);
        res.status(500).json({ status: 1, message: 'خطأ في الخادم. حاول مرة أخرى.' });
    }
});

// ============================================
// 4. QUERY VIDEO STATUS
// ============================================
app.post('/query-video', async (req: Request, res: Response) => {
    try {
        const { taskId } = req.body;
        if (!taskId || typeof taskId !== 'string' || taskId.length > 100) {
            return res.status(400).json({ status: 1, message: 'taskId غير صالح' });
        }

        const data = await callSupabase(VIDEO_QUERY_ENDPOINT, { task_id: taskId, project_id: 51 });
        const sanitized = sanitize(data);

        const status = String(data?.data?.task_status || '').toLowerCase();
        const videoUrl = extractVideoUrl(data);

        for (const [token, record] of tasksMap) {
            if (record.id === taskId && record.type === 'video') {
                if (['succeed', 'success', 'completed', '0'].includes(status)) record.status = 'completed';
                else if (['failed', 'error'].includes(status)) record.status = 'failed';
                if (videoUrl) record.resultUrl = videoUrl;
                break;
            }
        }

        res.json({
            status: 0,
            taskId,
            taskStatus: status,
            videoUrl,
            data: sanitized
        });
    } catch (error: any) {
        console.error('Query video error:', error);
        res.status(500).json({ status: 1, message: 'خطأ في الاستعلام.' });
    }
});

// ============================================
// 5. LIP SYNC
// ============================================
app.post('/lip-sync', async (req: Request, res: Response) => {
    try {
        const { action, face_choose, session_id, video_url, ...otherParams } = req.body;

        if (!action || !['submit', 'query'].includes(action)) {
            return res.status(400).json({ status: 1, message: 'action must be submit or query' });
        }

        const payload: any = { action, ...otherParams };
        if (face_choose) payload.face_choose = face_choose;
        if (session_id) payload.session_id = session_id;
        if (video_url) payload.video_url = video_url;

        const data = await callSupabase(LIP_SYNC_ENDPOINT, payload);

        // If submit and got id, save token
        if (action === 'submit' && data?.data?.id) {
            const token = generateTaskToken();
            tasksMap.set(token, {
                id: data.data.id,
                token,
                type: 'lipsync',
                prompt: 'Lip Sync',
                model: 'seedance-lip-sync',
                mode: 'lite',
                createdAt: Date.now(),
                status: 'processing'
            });

            return res.json({ status: 0, token, id: data.data.id, data: sanitize(data) });
        }

        res.json({ status: 0, data: sanitize(data) });
    } catch (error: any) {
        console.error('Lip sync error:', error);
        res.status(500).json({ status: 1, message: 'خطأ في مزامنة الشفاه.' });
    }
});

// ============================================
// 6. QUERY LIP SYNC STATUS
// ============================================
app.post('/query-lipsync', async (req: Request, res: Response) => {
    try {
        const { id } = req.body;
        if (!id) return res.status(400).json({ status: 1, message: 'id مطلوب' });

        const data = await callSupabase(LIP_SYNC_ENDPOINT, {
            action: 'query',
            id: id,
            _t: Date.now()
        });

        res.json({ status: 0, data: sanitize(data) });
    } catch (error: any) {
        console.error('Query lipsync error:', error);
        res.status(500).json({ status: 1, message: 'خطأ في الاستعلام.' });
    }
});

// ============================================
// 7. QUERY BY TOKEN
// ============================================
app.get('/task/:token', async (req: Request, res: Response) => {
    try {
        const token = String(req.params.token);
        const record = tasksMap.get(token);

        if (!record) {
            return res.status(404).json({ status: 1, message: 'التوكن غير موجود أو انتهت صلاحيته' });
        }

        // If already completed
        if (record.status === 'completed' && record.resultUrl) {
            return res.json({
                status: 0,
                token,
                type: record.type,
                prompt: record.prompt,
                model: record.model,
                taskStatus: 'completed',
                resultUrl: record.resultUrl,
                resultUrls: record.resultUrls || [record.resultUrl],
                createdAt: record.createdAt
            });
        }

        // Still processing - query backend
        if (record.type === 'image') {
            try {
                const imgData = await callSupabase(IMAGE_GENERATION_ENDPOINT, {
                    action: 'query',
                    taskId: record.id,
                    _t: Date.now()
                });
                const imgUrls = imgData?.data?.result?.images?.map((img: any) => img.url) || [];
                const deepUrl = extractDeepUrl(imgData);
                const imgStatus = imgData?.data?.status?.toUpperCase();

                if (imgUrls.length > 0) {
                    record.status = 'completed';
                    record.resultUrl = imgUrls[0];
                    record.resultUrls = imgUrls;
                } else if (['FAILED'].includes(imgStatus)) {
                    record.status = 'failed';
                }

                return res.json({
                    status: 0, token, type: 'image',
                    prompt: record.prompt, model: record.model,
                    taskStatus: record.status,
                    resultUrl: record.resultUrl || null,
                    resultUrls: imgUrls.length > 0 ? imgUrls : undefined,
                    createdAt: record.createdAt,
                    data: sanitize(imgData)
                });
            } catch { /* return current state */ }
        }

        if (record.type === 'video') {
            try {
                const vidData = await callSupabase(VIDEO_QUERY_ENDPOINT, { task_id: record.id, project_id: 51 });
                const vidStatus = String(vidData?.data?.task_status || '').toLowerCase();
                const vUrl = extractVideoUrl(vidData);

                if (vUrl) { record.resultUrl = vUrl; record.status = 'completed'; }
                if (['failed', 'error'].includes(vidStatus)) record.status = 'failed';

                return res.json({
                    status: 0, token, type: 'video',
                    prompt: record.prompt, model: record.model,
                    taskStatus: record.status,
                    resultUrl: record.resultUrl || null,
                    createdAt: record.createdAt,
                    data: sanitize(vidData)
                });
            } catch { /* return current state */ }
        }

        res.json({
            status: 0, token, type: record.type,
            prompt: record.prompt, model: record.model,
            taskStatus: record.status,
            resultUrl: record.resultUrl || null,
            createdAt: record.createdAt
        });
    } catch (error: any) {
        console.error('Task query error:', error);
        res.status(500).json({ status: 1, message: 'خطأ في الاستعلام بالتوكن.' });
    }
});

// ============================================
// 8. GET AVAILABLE MODELS
// ============================================
app.get('/models', (req: Request, res: Response) => {
    res.json({
        status: 0,
        models: {
            image: [
                { id: 'gemini', name: 'Gemini (Google)', description: 'سريع وعالي الجودة - مباشر', speed: 'fast', quality: 'high', endpoint: 'gemini-image-generator' },
                { id: 'dall-e-3', name: 'DALL-E 3 (OpenAI)', description: 'إبداعي ومفصل', speed: 'medium', quality: 'highest' },
                { id: 'stable-diffusion', name: 'Stable Diffusion XL', description: 'متنوع وقابل للتخصيص', speed: 'fast', quality: 'high' },
                { id: 'flux', name: 'Flux.1 Pro', description: 'أحدث نماذج الصور', speed: 'medium', quality: 'highest' },
                { id: 'midjourney', name: 'Midjourney V6', description: 'فني واحترافي', speed: 'slow', quality: 'highest' }
            ],
            video: [
                { id: 'seedance', name: 'Seedance 1.0 Lite', description: 'سريع بجودة جيدة', speed: 'fast', quality: 'medium', endpoint: 'video-router' },
                { id: 'kling-omni', name: 'Kling Omni', description: 'جودة عالية مع صوت', speed: 'medium', quality: 'high', endpoint: 'video-router' },
                { id: 'kling-v2', name: 'Kling V2', description: 'أفضل جودة متاحة', speed: 'slow', quality: 'highest', endpoint: 'video-router' },
                { id: 'runway-gen3', name: 'Runway Gen-3', description: 'سينمائي واقعي', speed: 'slow', quality: 'highest', endpoint: 'video-router' }
            ],
            lipsync: [
                { id: 'seedance-lip-sync', name: 'Seedance Lip Sync', description: 'مزامنة شفاه عالية الجودة', speed: 'medium', quality: 'high', endpoint: 'seedance-lip-sync' }
            ]
        }
    });
});

// ============================================
// 9. GET USAGE STATS
// ============================================
app.get('/usage', (req: Request, res: Response) => {
    const fp = getFingerprint(req);
    const imgEntry = rateLimitMap.get(`${fp}_image`);
    const vidEntry = rateLimitMap.get(`${fp}_video`);

    res.json({
        status: 0,
        usage: {
            image: { used: imgEntry?.count || 0, limit: IMAGE_RATE_LIMIT },
            video: { used: vidEntry?.count || 0, limit: VIDEO_RATE_LIMIT },
            resetIn: imgEntry ? Math.max(0, RATE_WINDOW - (Date.now() - imgEntry.firstRequest)) / 1000 : 0
        },
        tasks: {
            total: tasksMap.size,
            active: [...tasksMap.values()].filter(r => r.status === 'processing').length,
            completed: [...tasksMap.values()].filter(r => r.status === 'completed').length
        }
    });
});

// ============================================
// 10. CATCH ALL
// ============================================
app.use((req: Request, res: Response) => {
    res.status(404).json({ status: 1, message: 'Not Found' });
});

// ============================================
// HELPERS
// ============================================
function extractDeepUrl(data: any): string | null {
    if (!data) return null;
    const search = (obj: any): string | null => {
        if (!obj) return null;
        if (typeof obj === 'string' && obj.startsWith('http') &&
            (obj.includes('.png') || obj.includes('.jpg') || obj.includes('.jpeg') || obj.includes('.webp') || obj.includes('storage'))) return obj;
        if (typeof obj === 'string' && obj.startsWith('data:image')) return obj;
        if (Array.isArray(obj)) { for (const item of obj) { const r = search(item); if (r) return r; } }
        if (typeof obj === 'object') { for (const v of Object.values(obj)) { const r = search(v); if (r) return r; } }
        return null;
    };
    return search(data);
}

function extractVideoUrl(data: any): string | null {
    const paths = [
        'data.data.task_result.videos[0].url',
        'data.data.task_result.videos[0].video_url',
        'data.data.task_result.video_url',
        'data.task_result.videos[0].url',
    ];
    for (const path of paths) {
        try {
            const parts = path.split('.');
            let current: any = data;
            for (const part of parts) {
                if (part.includes('[')) {
                    const [name, idx] = part.split('[');
                    current = current[name]?.[parseInt(idx)];
                } else {
                    current = current[part];
                }
                if (!current) break;
            }
            if (current && typeof current === 'string' && current.startsWith('http')) return current;
        } catch { /* skip */ }
    }

    const search = (obj: any): string | null => {
        if (!obj) return null;
        if (typeof obj === 'string' && obj.startsWith('http') &&
            (obj.includes('.mp4') || obj.includes('.webm') || obj.includes('storage') || obj.includes('video'))) return obj;
        if (Array.isArray(obj)) { for (const item of obj) { const r = search(item); if (r) return r; } }
        if (typeof obj === 'object') { for (const v of Object.values(obj)) { const r = search(v); if (r) return r; } }
        return null;
    };
    return search(data);
}

export default app;
