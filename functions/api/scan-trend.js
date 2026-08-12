/**
 * Cloudflare Pages Function: /api/scan-trend
 * يرجّع آخر 20 فحص لرابط معين، عشان نرسم رسم بياني لتطور الأداء والـ SEO عبر الوقت.
 * ميزة Pro بس (بيانات المستخدمين المجانيين محدودة أصلاً لـ 3 فحوصات، مفيش فايدة من رسم بياني).
 */
export async function onRequestPost(context) {
    const { request, env } = context;

    if (!env.DB) {
        return jsonError('قاعدة البيانات غير مربوطة بالمشروع (DB).', 500);
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return jsonError('بيانات الطلب غير صحيحة.', 400);
    }

    const { url, email } = body;
    if (!email) return jsonError('لازم تسجّل دخول الأول.', 401);
    if (!url) return jsonError('من فضلك أدخل رابط الموقع.', 400);

    const user = await env.DB.prepare("SELECT is_pro FROM users WHERE email = ?").bind(email).first();
    if (!user || !user.is_pro) {
        return jsonError('الميزة دي لمشتركي Pro بس.', 403);
    }

    const { results } = await env.DB.prepare(
        `SELECT performance_score, seo_score, checked_at
         FROM scan_history
         WHERE identifier = ? AND url = ?
         ORDER BY checked_at ASC
         LIMIT 20`
    ).bind(email, url).all();

    return new Response(JSON.stringify({ success: true, history: results || [] }), {
        headers: { 'Content-Type': 'application/json' }
    });
}

function jsonError(message, status) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}
