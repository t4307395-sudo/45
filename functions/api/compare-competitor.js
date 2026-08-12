/**
 * Cloudflare Pages Function: /api/compare-competitor
 * تحليل منافسين — ميزة Pro. بيفحص موقعك وموقع منافس مرة واحدة (فحص خفيف: سرعة + SEO + أمان أساسي بس،
 * مش الفحص العميق الكامل)، وبيبعت النتيجتين لـ Gemini عشان يطلع مقارنة ونصايح.
 *
 * مهم: النصايح بتتكلم عن "موقعك إنت بس" — إزاي تتفوق على المنافس — مش عن مشاكل موقع المنافس نفسه،
 * وده متعمّد عشان الأداة تفضل أداة تحليل لصاحب الموقع مش أداة استكشاف لموقع حد تاني.
 */
import { fetchPageSpeed, analyzeSecurityConfig, fetchAndParsePage, getGeminiKeys, getStartIndex, callGemini } from './analyze.js';

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

    const { myUrl, competitorUrl, email } = body;
    if (!email) return jsonError('لازم تسجّل دخول الأول.', 401);
    if (!myUrl || !competitorUrl) return jsonError('من فضلك أدخل رابط موقعك ورابط المنافس.', 400);

    let myUrlValid, competitorUrlValid;
    try {
        myUrlValid = new URL(myUrl).href;
        competitorUrlValid = new URL(competitorUrl).href;
    } catch {
        return jsonError('واحد من الرابطين غير صحيح.', 400);
    }

    const user = await env.DB.prepare("SELECT is_pro FROM users WHERE email = ?").bind(email).first();
    if (!user || !user.is_pro) {
        return jsonError('تحليل المنافسين ميزة لمشتركي Pro بس.', 403);
    }

    const apiKey = env.EXT_TOKEN_MAIN;
    if (!apiKey) return jsonError('مفتاح PageSpeed غير مربوط بالمشروع.', 500);

    try {
        // فحص خفيف للاثنين بالتوازي: سرعة موبايل + أمان أساسي + SEO أساسي (مش الفحص العميق)
        const [myPerf, myConfig, mySeo, compPerf, compConfig, compSeo] = await Promise.allSettled([
            fetchPageSpeed(myUrlValid, apiKey, 'mobile'),
            analyzeSecurityConfig(myUrlValid),
            fetchAndParsePage(myUrlValid),
            fetchPageSpeed(competitorUrlValid, apiKey, 'mobile'),
            analyzeSecurityConfig(competitorUrlValid),
            fetchAndParsePage(competitorUrlValid)
        ]);

        const mySite = {
            performance: myPerf.status === 'fulfilled' ? myPerf.value.performanceScore : null,
            seoScore: myPerf.status === 'fulfilled' ? myPerf.value.seoScore : null,
            securityScore: myConfig.status === 'fulfilled' ? myConfig.value.score : null,
            title: mySeo.status === 'fulfilled' ? mySeo.value.title : null,
            wordCount: mySeo.status === 'fulfilled' ? mySeo.value.wordCount : null,
            hasSchema: mySeo.status === 'fulfilled' ? mySeo.value.hasSchema : null
        };

        const competitorSite = {
            performance: compPerf.status === 'fulfilled' ? compPerf.value.performanceScore : null,
            seoScore: compPerf.status === 'fulfilled' ? compPerf.value.seoScore : null,
            securityScore: compConfig.status === 'fulfilled' ? compConfig.value.score : null,
            title: compSeo.status === 'fulfilled' ? compSeo.value.title : null,
            wordCount: compSeo.status === 'fulfilled' ? compSeo.value.wordCount : null,
            hasSchema: compSeo.status === 'fulfilled' ? compSeo.value.hasSchema : null
        };

        const comparison = await generateCompetitorComparison(env, myUrlValid, competitorUrlValid, mySite, competitorSite);

        return new Response(JSON.stringify({
            success: true,
            myUrl: myUrlValid,
            competitorUrl: competitorUrlValid,
            mySite,
            competitorSite,
            comparison
        }), { headers: { 'Content-Type': 'application/json' } });

    } catch (err) {
        return jsonError('حصل خطأ أثناء المقارنة: ' + err.message, 500);
    }
}

async function generateCompetitorComparison(env, myUrl, competitorUrl, mySite, competitorSite) {
    const keys = getGeminiKeys(env, true); // تحليل المنافسين Pro بس، فدايمًا يستخدم مجمّع مفاتيح Pro (أو fallback)
    if (keys.length === 0) {
        return { summary: 'مفيش مفتاح Gemini متاح دلوقتي.', tips: [] };
    }

    const prompt = `
إنت خبير تسويق رقمي وتحسين محركات بحث. قارن بين موقعين بناءً على البيانات دي، واكتب باللغة العربية فقط:

موقعي (${myUrl}):
- سرعة الأداء: ${mySite.performance ?? 'غير متاح'}/100
- SEO: ${mySite.seoScore ?? 'غير متاح'}/100
- الأمان: ${mySite.securityScore ?? 'غير متاح'}/100
- عدد الكلمات: ${mySite.wordCount ?? 'غير متاح'}
- Schema Markup: ${mySite.hasSchema ? 'موجود' : 'غير موجود'}

موقع المنافس (${competitorUrl}):
- سرعة الأداء: ${competitorSite.performance ?? 'غير متاح'}/100
- SEO: ${competitorSite.seoScore ?? 'غير متاح'}/100
- الأمان: ${competitorSite.securityScore ?? 'غير متاح'}/100
- عدد الكلمات: ${competitorSite.wordCount ?? 'غير متاح'}
- Schema Markup: ${competitorSite.hasSchema ? 'موجود' : 'غير موجود'}

مهم جدًا: النصايح كلها لازم تتكلم عن "موقعي" بس — إيه اللي أقدر أعمله في موقعي عشان أتفوق على المنافس أو ألحقه. متقترحش أي حاجة عن موقع المنافس نفسه أو مشاكله (ده مش موقعي ومش من حقي أتدخل فيه).

رجّع الرد بصيغة JSON بس، من غير أي نص إضافي أو backticks، بالشكل ده بالظبط:
{
  "summary": "ملخص من 2-3 جمل عن الوضع العام مقارنة بالمنافس",
  "tips": [
    { "area": "السرعة", "advice": "نصيحة محددة وقابلة للتنفيذ لموقعي" },
    { "area": "SEO", "advice": "..." },
    { "area": "المحتوى", "advice": "..." }
  ]
}
`;

    const startIndex = await getStartIndex(env, keys.length, 3); // عداد تدوير مستقل (id=3) لتحليل المنافسين

    for (let i = 0; i < keys.length; i++) {
        const { key } = keys[(startIndex + i) % keys.length];
        try {
            const raw = await callGemini(key, prompt);
            const cleaned = raw.replace(/```json|```/g, '').trim();
            return JSON.parse(cleaned);
        } catch {
            continue; // جرب المفتاح اللي بعده
        }
    }

    return { summary: 'تعذّر توليد المقارنة دلوقتي، جرب تاني.', tips: [] };
}

function jsonError(message, status) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}
