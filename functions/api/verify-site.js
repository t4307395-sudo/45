/**
 * Cloudflare Pages Function: /api/verify-site
 * إدارة "مواقعي" — التحقق من ملكية أكتر من دومين لكل حساب.
 *
 * action = "list"    : يرجّع كل المواقع النشطة (active=1) بتاعة الحساب مع حالة كل واحد.
 * action = "generate": ينشئ/يرجّع كود التحقق لدومين معين (ملف superweb-verify.txt).
 * action = "check"   : يتأكد من وجود الملف بالكود الصحيح، ويعلّم الدومين كمتحقق منه.
 * action = "remove"  : حذف "ناعم" — الموقع بيتشال من القائمة النشطة، ولو المستخدم عايز
 *                       يرجّعه لازم يتحقق من ملكيته تاني من الصفر (مش بيرجع تلقائي).
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

    const { action, email } = body;
    if (!email) return jsonError('لازم تسجّل دخول الأول.', 401);

    // ============ قائمة مواقعي ============
    if (action === 'list') {
        const { results } = await env.DB.prepare(
            "SELECT domain, verified, created_at, verified_at FROM site_verifications WHERE identifier = ? AND active = 1 ORDER BY created_at DESC"
        ).bind(email).all();

        return new Response(JSON.stringify({ success: true, sites: results || [] }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // باقي الإجراءات محتاجة رابط
    const { url } = body;
    if (!url) return jsonError('من فضلك أدخل رابط الموقع.', 400);

    let domain;
    try {
        domain = new URL(url).hostname;
    } catch {
        return jsonError('الرابط غير صحيح.', 400);
    }

    // ============ توليد كود تحقق ============
    if (action === 'generate') {
        const existing = await env.DB.prepare(
            "SELECT token, verified, active FROM site_verifications WHERE identifier = ? AND domain = ?"
        ).bind(email, domain).first();

        // موجود، نشط، ومتحقق منه بالفعل — نرجّع نفس الحالة من غير كود جديد
        if (existing && existing.active && existing.verified) {
            return new Response(JSON.stringify({
                success: true, domain, token: existing.token, verified: true,
                fileName: 'superweb-verify.txt', filePath: `https://${domain}/superweb-verify.txt`
            }), { headers: { 'Content-Type': 'application/json' } });
        }

        // موجود بس لسه مش متحقق منه (وطالما نشط)، نرجّع نفس الكود القديم
        if (existing && existing.active && !existing.verified) {
            return new Response(JSON.stringify({
                success: true, domain, token: existing.token, verified: false,
                fileName: 'superweb-verify.txt', filePath: `https://${domain}/superweb-verify.txt`,
                instructions: `اعمل ملف باسم superweb-verify.txt في جذر موقعك، وحط جواه الكود ده بالظبط: ${existing.token}`
            }), { headers: { 'Content-Type': 'application/json' } });
        }

        // مفيش سجل، أو كان اتشال قبل كده (active=0) — كود جديد من الصفر، لازم يتحقق تاني
        const token = crypto.randomUUID().replace(/-/g, '');

        await env.DB.prepare(
            `INSERT INTO site_verifications (identifier, domain, token, verified, active, created_at)
             VALUES (?, ?, ?, 0, 1, ?)
             ON CONFLICT (identifier, domain) DO UPDATE SET
                token = excluded.token, verified = 0, active = 1, created_at = excluded.created_at, verified_at = NULL`
        ).bind(email, domain, token, Date.now()).run();

        return new Response(JSON.stringify({
            success: true, domain, token, verified: false,
            fileName: 'superweb-verify.txt', filePath: `https://${domain}/superweb-verify.txt`,
            instructions: `اعمل ملف نصي باسم superweb-verify.txt في جذر موقعك (نفس مستوى index.html)، حط جواه الكود ده بالظبط: ${token} وبعدين دوس "تحقق الآن".`
        }), { headers: { 'Content-Type': 'application/json' } });
    }

    // ============ تأكيد التحقق ============
    if (action === 'check') {
        const row = await env.DB.prepare(
            "SELECT token, verified FROM site_verifications WHERE identifier = ? AND domain = ? AND active = 1"
        ).bind(email, domain).first();

        if (!row) {
            return jsonError('لازم تعمل خطوة "توليد الكود" الأول.', 400);
        }

        if (row.verified) {
            return new Response(JSON.stringify({ success: true, verified: true }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        try {
            const fileRes = await fetch(`https://${domain}/superweb-verify.txt`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SuperWebBot/1.0; +ownership-verification)' }
            });

            if (!fileRes.ok) {
                return new Response(JSON.stringify({
                    success: true, verified: false,
                    reason: `الملف مش لاقيه على ${domain} (${fileRes.status}). تأكد إنك رفعته في الجذر بالظبط.`
                }), { headers: { 'Content-Type': 'application/json' } });
            }

            const content = (await fileRes.text()).trim();
            const isMatch = content === row.token;

            if (isMatch) {
                await env.DB.prepare(
                    "UPDATE site_verifications SET verified = 1, verified_at = ? WHERE identifier = ? AND domain = ?"
                ).bind(Date.now(), email, domain).run();
            }

            return new Response(JSON.stringify({
                success: true, verified: isMatch,
                reason: isMatch ? null : 'محتوى الملف مش مطابق للكود المطلوب.'
            }), { headers: { 'Content-Type': 'application/json' } });

        } catch (err) {
            return new Response(JSON.stringify({
                success: true, verified: false,
                reason: 'تعذّر الوصول للملف: ' + err.message
            }), { headers: { 'Content-Type': 'application/json' } });
        }
    }

    // ============ حذف ناعم — الموقع بيتشال من القائمة، ولازم إعادة تحقق كاملة لو رجع ============
    if (action === 'remove') {
        await env.DB.prepare(
            "UPDATE site_verifications SET active = 0, verified = 0 WHERE identifier = ? AND domain = ?"
        ).bind(email, domain).run();

        return new Response(JSON.stringify({ success: true, removed: true }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    return jsonError('إجراء غير معروف.', 400);
}

function jsonError(message, status) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}
