/**
 * Cloudflare Pages Function: /api/solve-issue
 * بيولّد حل (خطوات + كود) لمشكلة واحدة بس، عند ما المستخدم يدوس "حل المشكلة" —
 * مش تلقائي لكل المشاكل دفعة واحدة. ده بيقلل تكلفة الـ AI، وبيقفل باب "اختراع" مشاكل
 * جديدة (لأن الـ AI هنا بيرد على مشكلة واحدة محددة إحنا وصفناها، مش بيقترح قائمة حرة).
 */
import { getGeminiKeys, getStartIndex, callGemini } from './analyze.js';

export async function onRequestPost(context) {
    const { request, env } = context;

    let body;
    try {
        body = await request.json();
    } catch {
        return jsonError('بيانات الطلب غير صحيحة.', 400);
    }

    const { title, description, device, url, email } = body;
    if (!title) return jsonError('من فضلك ابعت عنوان المشكلة.', 400);

    let isPro = false;
    if (email && env.DB) {
        const user = await env.DB.prepare("SELECT is_pro FROM users WHERE email = ?").bind(email).first();
        isPro = !!user?.is_pro;
    }

    const keys = getGeminiKeys(env, isPro);
    if (keys.length === 0) {
        return jsonError('مفيش مفتاح Gemini متاح دلوقتي.', 503);
    }

    const prompt = `
أنت مهندس ويب خبير. المشكلة دي حصلت فعليًا في موقع ${url || 'الموقع'} (تصنيفها: ${device || 'عام'}):

العنوان: ${title}
${description ? `الوصف: ${description}` : ''}

اكتب حل عملي لهذه المشكلة تحديدًا فقط، من غير ما تضيف أي مشكلة تانية أو تتوسع لموضوعات غير مذكورة هنا.

رجّع بصيغة JSON فقط، من غير أي نص زيادة أو backticks:
{
  "steps": ["خطوة عملية قصيرة ومباشرة", "..."],
  "codeExample": "كود فعلي جاهز للنسخ يحل المشكلة دي بالذات، أو null صراحة لو مفيش كود منطقي (ممنوع تختلق كود وهمي)"
}
`.trim();

    const startIndex = await getStartIndex(env, keys.length, isPro ? 2 : 1);

    for (let attempt = 0; attempt < keys.length; attempt++) {
        const keyEntry = keys[(startIndex + attempt) % keys.length];
        try {
            const result = await callGemini(keyEntry.key, prompt);
            return new Response(JSON.stringify({
                success: true,
                steps: result.steps || [],
                codeExample: result.codeExample || null
            }), { headers: { 'Content-Type': 'application/json' } });
        } catch (err) {
            if (err.isRateLimit && attempt < keys.length - 1) continue;
            return jsonError('تعذّر توليد الحل دلوقتي، جرب تاني بعد شوية.', 503);
        }
    }

    return jsonError('تعذّر توليد الحل دلوقتي.', 503);
}

function jsonError(message, status) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}
