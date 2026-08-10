/**
 * Cloudflare Pages Function: /api/verify-site
 * التحقق من ملكية الموقع قبل السماح بأي فحص أمان أعمق (كشف ملفات حساسة مكشوفة).
 *
 * action = "generate": ينشئ كود عشوائي مربوط بالإيميل + الدومين، ويرجّعه للمستخدم
 *          عشان يحطه في ملف باسم superweb-verify.txt في جذر موقعه.
 * action = "check": يفتح الملف ده من على السيرفر بتاع المستخدم، ولو لقى نفس الكود
 *          بالظبط، يعلّم الدومين ده كـ"متحقق منه" لصاحب الإيميل ده.
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

    const { action, url, email } = body;
    if (!email) return jsonError('لازم تسجّل دخول الأول.', 401);
    if (!url) return jsonError('من فضلك أدخل رابط الموقع.', 400);

    let domain;
    try {
        domain = new URL(url).hostname;
    } catch {
        return jsonError('الرابط غير صحيح.', 400);
    }

    if (action === 'generate') {
        const existing = await env.DB.prepare(
            "SELECT token, verified FROM site_verifications WHERE identifier = ? AND domain = ?"
        ).bind(email, domain).first();

        if (existing) {
            return new Response(JSON.stringify({
                success: true,
                domain,
                token: existing.token,
                verified: !!existing.verified,
                fileName: 'superweb-verify.txt',
                filePath: `https://${domain}/superweb-verify.txt`
            }), { headers: { 'Content-Type': 'application/json' } });
        }

        const token = crypto.randomUUID().replace(/-/g, '');

        await env.DB.prepare(
            "INSERT INTO site_verifications (identifier, domain, token, verified, created_at) VALUES (?, ?, ?, 0, ?)"
        ).bind(email, domain, token, Date.now()).run();

        return new Response(JSON.stringify({
            success: true,
            domain,
            token,
            verified: false,
            fileName: 'superweb-verify.txt',
            filePath: `https://${domain}/superweb-verify.txt`,
            instructions: `اعمل ملف نصي باسم superweb-verify.txt في جذر موقعك (نفس مستوى index.html)، حط جوّاه الكود ده بالظبط: ${token} وبعدين دوس "تحقق الآن".`
        }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (action === 'check') {
        const row = await env.DB.prepare(
            "SELECT token, verified FROM site_verifications WHERE identifier = ? AND domain = ?"
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
                    success: true,
                    verified: false,
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
                success: true,
                verified: isMatch,
                reason: isMatch ? null : 'محتوى الملف مش مطابق للكود المطلوب.'
            }), { headers: { 'Content-Type': 'application/json' } });

        } catch (err) {
            return new Response(JSON.stringify({
                success: true,
                verified: false,
                reason: 'تعذّر الوصول للملف: ' + err.message
            }), { headers: { 'Content-Type': 'application/json' } });
        }
    }

    return jsonError('إجراء غير معروف.', 400);
}

function jsonError(message, status) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}
