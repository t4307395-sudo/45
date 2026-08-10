/**
 * Cloudflare Pages Function: /api/analyze
 * محلل المواقع: سرعة (موبايل + ديسكتوب) + أمان + SEO أساسي + توصيات AI شاملة
 * المفاتيح المستخدمة: EXT_TOKEN_MAIN (PageSpeed + Safe Browsing + Custom Search)
 *                      GEMINI_API_KEY / GEMINI_API_KEY2 / GEMINI_API_KEY3 / GEMINI_API_KEY4
 *                      (تدوير تلقائي بينهم + Fallback لو مفتاح خلّصت كوتته)
 *                      env.DB (D1) لتخزين عداد التدوير
 */
export async function onRequestPost(context) {
    const { request, env } = context;

    if (!env.EXT_TOKEN_MAIN) {
        return jsonError('مفتاح الخدمات الخارجية غير مربوط بالمشروع (EXT_TOKEN_MAIN).', 500);
    }
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
    if (!url || !isValidUrl(url)) {
        return jsonError('من فضلك أدخل رابط صحيح يبدأ بـ http:// أو https://', 400);
    }

    // تسجيل الدخول إجباري لاستخدام الأداة
    if (!email) {
        return jsonError('لازم تسجّل دخول الأول عشان تقدر تستخدم الأداة.', 401);
    }

    const userExists = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
    if (!userExists) {
        return jsonError('الحساب ده مش موجود، سجّل دخول تاني.', 401);
    }

    // المعرّف: الإيميل بس (تسجيل الدخول إجباري دلوقتي)
    const identifier = email;

    // 1) تحقق من الكاش الأول (ساعة واحدة) قبل أي حاجة تانية
    const cached = await getCachedResult(env, url);
    if (cached) {
        return new Response(JSON.stringify({ ...cached, fromCache: true }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // 2) تحقق من الحد اليومي (3 فحوصات فقط، الكاش مبيتحسبش منها)
    const limitCheck = await checkAndIncrementLimit(env, identifier);
    if (!limitCheck.allowed) {
        return jsonError(
            `وصلت للحد الأقصى (3 فحوصات في اليوم). حاول تاني بكرة، أو جرب رابط فحصته قبل كده هيرجع من الكاش فوراً.`,
            429
        );
    }

    const apiKey = env.EXT_TOKEN_MAIN;

    try {
        // تشغيل كل الفحوصات بالتوازي: موبايل + ديسكتوب + أمان (تصنيف خبيث) + أمان (إعدادات فعلية) + تحليل HTML + بيانات مستخدمين حقيقيين + GEO
        const [mobileResult, desktopResult, safeBrowsingResult, securityAuditResult, pageContent, cruxResult, geoResult] = await Promise.allSettled([
            fetchPageSpeed(url, apiKey, 'mobile'),
            fetchPageSpeed(url, apiKey, 'desktop'),
            fetchSafeBrowsing(url, apiKey),
            analyzeSecurityConfig(url),
            fetchAndParsePage(url),
            fetchCrUX(url, apiKey),
            fetchGeoSignals(url)
        ]);

        const mobile = mobileResult.status === 'fulfilled' ? mobileResult.value : null;
        const desktop = desktopResult.status === 'fulfilled' ? desktopResult.value : null;
        const malwareCheck = safeBrowsingResult.status === 'fulfilled' ? safeBrowsingResult.value : null;
        const securityConfig = securityAuditResult.status === 'fulfilled' ? securityAuditResult.value : null;
        const seo = pageContent.status === 'fulfilled' ? pageContent.value : null;
        const realUserData = cruxResult.status === 'fulfilled' ? cruxResult.value : null;
        const geo = geoResult.status === 'fulfilled' ? geoResult.value : null;

        // دمج فحص "الموقع مصنّف كخبيث؟" مع فحص "إعدادات الأمان الفعلية" في كيان واحد
        // السكور النهائي = 0 فوري لو الموقع مصنّف خبيث، وإلا سكور إعدادات الأمان الفعلية
        const safety = buildFinalSecurity(malwareCheck, securityConfig);

        // 2.5) فحص الملفات الحساسة المكشوفة — بس لو الدومين متحقق من ملكيته لنفس الحساب
        const domain = new URL(url).hostname;
        const isOwnershipVerified = await checkOwnershipVerified(env, identifier, domain);
        let exposedFilesResult = null;
        if (isOwnershipVerified) {
            exposedFilesResult = await checkExposedFiles(url);
            if (exposedFilesResult.issues.length > 0) {
                safety.score = Math.max(0, safety.score - exposedFilesResult.issues.length * 15);
                safety.issues = [...(safety.issues || []), ...exposedFilesResult.issues];
            }
        }

        // دمج مشاكل الموبايل والديسكتوب والأمان وGEO مع بعض (كل مشكلة موسومة بالجهاز/الفئة)
        const allAudits = [
            ...(mobile?.actionableAudits || []).map(a => ({ ...a, device: 'mobile' })),
            ...(desktop?.actionableAudits || []).map(a => ({ ...a, device: 'desktop' })),
            ...(securityConfig?.issues || []).map(a => ({ ...a, device: 'security' })),
            ...(exposedFilesResult?.issues || []).map(a => ({ ...a, device: 'security' })),
            ...(geo?.issues || []).map(a => ({ ...a, device: 'geo' }))
        ];

        const aiRecommendations = await generateAIRecommendations(env, url, allAudits, safety, seo, realUserData);

        // 3) قارن بآخر فحص سابق لنفس الرابط ونفس الحساب/IP
        const comparison = await getComparison(env, identifier, url, mobile?.performanceScore, mobile?.seoScore);

        const responseData = {
            success: true,
            url,
            checkedAt: new Date().toISOString(),
            mobile: mobile ? stripAudits(mobile) : null,
            desktop: desktop ? stripAudits(desktop) : null,
            safety,
            deepScan: { ownershipVerified: isOwnershipVerified, exposedFiles: exposedFilesResult },
            seo,
            geo,
            realUserData,
            aiRecommendations,
            comparison
        };

        // احفظ في الكاش وفي السجل التاريخي (من غير ما نستنى، مش لازم نأخر الرد بسببهم)
        context.waitUntil(saveToCache(env, url, responseData));
        context.waitUntil(saveToHistory(env, identifier, url, mobile?.performanceScore, mobile?.seoScore));

        return new Response(JSON.stringify(responseData), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (err) {
        return jsonError(err.message, 500);
    }
}

// ============================================================
// الكاش (ساعة واحدة لكل رابط)
// ============================================================
async function getCachedResult(env, url) {
    try {
        const row = await env.DB.prepare(
            "SELECT result_json, cached_at FROM analysis_cache WHERE url = ?"
        ).bind(url).first();

        if (!row) return null;

        const ageMs = Date.now() - row.cached_at;
        if (ageMs > 60 * 60 * 1000) return null; // أقدم من ساعة

        return JSON.parse(row.result_json);
    } catch {
        return null; // لو الجدول لسه مش موجود، منكملش الطلب من غير كاش
    }
}

async function saveToCache(env, url, data) {
    try {
        await env.DB.prepare(
            "INSERT INTO analysis_cache (url, result_json, cached_at) VALUES (?, ?, ?) " +
            "ON CONFLICT(url) DO UPDATE SET result_json = excluded.result_json, cached_at = excluded.cached_at"
        ).bind(url, JSON.stringify(data), Date.now()).run();
    } catch {
        // متعمّد: فشل الكاش مايوقفش الطلب الأساسي
    }
}

// ============================================================
// الحد اليومي (3 فحوصات لكل حساب/IP)
// ============================================================
async function checkAndIncrementLimit(env, identifier) {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    try {
        const row = await env.DB.prepare(
            "SELECT count FROM scan_limits WHERE identifier = ? AND scan_date = ?"
        ).bind(identifier, today).first();

        const currentCount = row?.count || 0;

        if (currentCount >= 3) {
            return { allowed: false };
        }

        await env.DB.prepare(
            "INSERT INTO scan_limits (identifier, scan_date, count) VALUES (?, ?, 1) " +
            "ON CONFLICT(identifier, scan_date) DO UPDATE SET count = count + 1"
        ).bind(identifier, today).run();

        return { allowed: true };
    } catch {
        return { allowed: true }; // لو الجدول لسه مش موجود، منمنعش المستخدم بسبب مشكلة عندنا
    }
}

// ============================================================
// مقارنة "قبل وبعد" مع آخر فحص سابق لنفس الرابط
// ============================================================
async function getComparison(env, identifier, url, newPerformance, newSeo) {
    try {
        const previous = await env.DB.prepare(
            "SELECT performance_score, seo_score, checked_at FROM scan_history " +
            "WHERE identifier = ? AND url = ? ORDER BY checked_at DESC LIMIT 1"
        ).bind(identifier, url).first();

        if (!previous) return null;

        return {
            previousPerformance: previous.performance_score,
            previousSeo: previous.seo_score,
            performanceDelta: newPerformance != null && previous.performance_score != null
                ? newPerformance - previous.performance_score : null,
            seoDelta: newSeo != null && previous.seo_score != null
                ? newSeo - previous.seo_score : null,
            previousCheckedAt: previous.checked_at
        };
    } catch {
        return null;
    }
}

async function saveToHistory(env, identifier, url, performanceScore, seoScore) {
    try {
        await env.DB.prepare(
            "INSERT INTO scan_history (identifier, url, performance_score, seo_score, checked_at) VALUES (?, ?, ?, ?, ?)"
        ).bind(identifier, url, performanceScore ?? null, seoScore ?? null, Date.now()).run();
    } catch {
        // متعمّد: فشل حفظ التاريخ مايوقفش الطلب الأساسي
    }
}

// نشيل قائمة الأودتس التفصيلية من الرد النهائي (استخدمناها داخلياً بس مع الـAI)
function stripAudits(deviceResult) {
    const { actionableAudits, ...rest } = deviceResult;
    return rest;
}

// ============================================================
// فحص السرعة (PageSpeed Insights API) — لجهاز واحد (موبايل/ديسكتوب)
// ============================================================
async function fetchPageSpeed(url, apiKey, strategy) {
    const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed` +
        `?url=${encodeURIComponent(url)}` +
        `&key=${apiKey}` +
        `&strategy=${strategy}` +
        `&category=performance&category=seo&category=accessibility`;

    const res = await fetch(endpoint);
    if (!res.ok) {
        throw new Error(`تعذّر فحص ${strategy === 'mobile' ? 'الموبايل' : 'الديسكتوب'} (${res.status})`);
    }
    const data = await res.json();
    const lighthouse = data?.lighthouseResult || {};
    const categories = lighthouse.categories || {};
    const audits = lighthouse.audits || {};

    return {
        strategy,
        performanceScore: Math.round((categories.performance?.score || 0) * 100),
        seoScore: Math.round((categories.seo?.score || 0) * 100),
        accessibilityScore: Math.round((categories.accessibility?.score || 0) * 100),
        firstContentfulPaint: audits['first-contentful-paint']?.displayValue || null,
        largestContentfulPaint: audits['largest-contentful-paint']?.displayValue || null,
        totalBlockingTime: audits['total-blocking-time']?.displayValue || null,
        // صورة فعلية للموقع من نفس الـAPI (مفيش مفتاح إضافي مطلوب)
        screenshot: audits['final-screenshot']?.details?.data || null,
        actionableAudits: extractActionableAudits(lighthouse)
    };
}

// ============================================================
// استخراج كل المشاكل (كبيرة وصغيرة) من تقرير Lighthouse الكامل
// ============================================================
function extractActionableAudits(lighthouse) {
    const audits = lighthouse.audits || {};
    const categories = lighthouse.categories || {};
    const relevantIds = new Set();

    ['performance', 'seo', 'accessibility'].forEach(catKey => {
        (categories[catKey]?.auditRefs || []).forEach(ref => relevantIds.add(ref.id));
    });

    const results = [];

    for (const id of relevantIds) {
        const audit = audits[id];
        if (!audit) continue;
        if (audit.scoreDisplayMode === 'notApplicable' || audit.scoreDisplayMode === 'manual') continue;

        // نضم أي مشكلة معندهاش علامة كاملة (score < 1) وكمان أي فرصة توفير حقيقية حتى لو صغيرة
        const hasOpportunity = audit.details?.type === 'opportunity' &&
            ((audit.details.overallSavingsMs || 0) > 0 || (audit.details.overallSavingsBytes || 0) > 0);
        const isImperfect = audit.score !== null && audit.score < 1;

        if (!hasOpportunity && !isImperfect) continue;

        const entry = {
            id,
            title: audit.title,
            description: stripMarkdownLinks(audit.description || ''),
            displayValue: audit.displayValue || null,
            score: audit.score
        };

        if (audit.details?.type === 'opportunity') {
            entry.potentialSavingsMs = audit.details.overallSavingsMs ?? null;
            entry.potentialSavingsBytes = audit.details.overallSavingsBytes ?? null;
        }

        if (Array.isArray(audit.details?.items)) {
            entry.affectedItems = audit.details.items.slice(0, 5).map(item => ({
                url: item.url || item.node?.snippet || null,
                wastedBytes: item.wastedBytes ?? null,
                wastedMs: item.wastedMs ?? null
            }));
        }

        results.push(entry);
    }

    results.sort((a, b) => (a.score ?? 1) - (b.score ?? 1));

    return results.slice(0, 30); // حد أقصى 30 مشكلة لكل جهاز عشان الطلب ميبقاش ضخم جداً
}

function stripMarkdownLinks(text) {
    return text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

// ============================================================
// بيانات المستخدمين الحقيقيين (Chrome UX Report API)
// بيانات حقيقية من زوار الموقع الفعليين، مش محاكاة معملية
// ============================================================
async function fetchCrUX(url, apiKey) {
    const endpoint = `https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${apiKey}`;

    // نحاول الأول على مستوى الصفحة بالظبط، ولو مفيش بيانات كافية نرجع لمستوى الدومين كله
    let result = await tryCruxQuery(endpoint, { url });
    let level = 'page';

    if (!result) {
        const origin = new URL(url).origin;
        result = await tryCruxQuery(endpoint, { origin });
        level = 'origin';
    }

    if (!result) return null;

    const metrics = result.record?.metrics || {};

    return {
        level, // 'page' لو بيانات دقيقة للصفحة، 'origin' لو بيانات عامة للدومين كله
        collectionPeriod: result.record?.collectionPeriod || null,
        largestContentfulPaint: extractCruxMetric(metrics.largest_contentful_paint),
        cumulativeLayoutShift: extractCruxMetric(metrics.cumulative_layout_shift),
        interactionToNextPaint: extractCruxMetric(metrics.interaction_to_next_paint),
        timeToFirstByte: extractCruxMetric(metrics.experimental_time_to_first_byte)
    };
}

async function tryCruxQuery(endpoint, body) {
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!res.ok) return null; // 404 يعني مفيش بيانات كافية من مستخدمين حقيقيين، ده طبيعي لمواقع صغيرة
    return await res.json();
}

function extractCruxMetric(metric) {
    if (!metric) return null;

    const goodBucket = metric.histogram?.[0]?.density || 0;
    const p75 = metric.percentiles?.p75 ?? null;

    return {
        p75,
        goodPercent: Math.round(goodBucket * 100)
    };
}

// ============================================================
// فحص الأمان (Safe Browsing API)
// ============================================================
async function fetchSafeBrowsing(url, apiKey) {
    const endpoint = `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${apiKey}`;

    const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client: { clientId: 'super-web', clientVersion: '1.0' },
            threatInfo: {
                threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
                platformTypes: ['ANY_PLATFORM'],
                threatEntryTypes: ['URL'],
                threatEntries: [{ url }]
            }
        })
    });

    if (!res.ok) {
        throw new Error(`تعذّر فحص الأمان (${res.status})`);
    }

    const data = await res.json();
    const isSafe = !data.matches || data.matches.length === 0;

    return {
        isSafe,
        threats: isSafe ? [] : data.matches.map(m => m.threatType)
    };
}

// ============================================================
// فحص إعدادات الأمان الفعلية (Security Headers Audit)
// فحص "سلبي" بالكامل (Passive) — بيقرا استجابة الموقع العادية بس،
// من غير أي محاولة اختراق أو استغلال ثغرات. نفس أسلوب أدوات معروفة
// زي securityheaders.com و Mozilla Observatory.
// ============================================================
async function analyzeSecurityConfig(url) {
    const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SuperWebBot/1.0; +security-audit)' },
        redirect: 'follow'
    });

    const headers = res.headers;
    const finalUrl = res.url || url;
    const isHttps = finalUrl.startsWith('https://');
    const html = await res.text().catch(() => '');

    const issues = [];
    let score = 100;

    const deduct = (points, entry) => {
        score -= points;
        issues.push(entry);
    };

    // 1) HTTPS أصلاً
    if (!isHttps) {
        deduct(30, {
            id: 'no-https',
            title: 'الموقع مش شغال بـ HTTPS',
            description: 'الاتصال بين المستخدم والموقع غير مشفر، أي حد على نفس الشبكة يقدر يقرا أو يعدّل البيانات المتبادلة.',
            score: 0
        });
    }

    // 2) HSTS
    if (isHttps && !headers.get('strict-transport-security')) {
        deduct(12, {
            id: 'missing-hsts',
            title: 'هيدر Strict-Transport-Security (HSTS) مفقود',
            description: 'من غير الهيدر ده، المتصفح ممكن يقبل يفتح نسخة HTTP غير مشفرة من الموقع لو حد حاول يجبره على كده.',
            score: 0.5
        });
    }

    // 3) Content-Security-Policy
    if (!headers.get('content-security-policy')) {
        deduct(18, {
            id: 'missing-csp',
            title: 'هيدر Content-Security-Policy (CSP) مفقود',
            description: 'من غير CSP، لو حصل XSS في الموقع (حتى بالغلط)، مفيش طبقة حماية إضافية توقف تنفيذ كود خبيث.',
            score: 0.3
        });
    }

    // 4) X-Content-Type-Options
    if (!headers.get('x-content-type-options')) {
        deduct(8, {
            id: 'missing-x-content-type-options',
            title: 'هيدر X-Content-Type-Options مفقود',
            description: 'المتصفح ممكن "يخمّن" نوع الملف بدل ما يلتزم بالنوع المعلن، وده ممكن يستغل لتنفيذ ملفات كأنها كود.',
            score: 0.5
        });
    }

    // 5) X-Frame-Options / frame-ancestors
    const csp = headers.get('content-security-policy') || '';
    if (!headers.get('x-frame-options') && !/frame-ancestors/i.test(csp)) {
        deduct(10, {
            id: 'missing-frame-protection',
            title: 'الموقع مش محمي من هجمات Clickjacking',
            description: 'مفيش X-Frame-Options ولا frame-ancestors في CSP، يعني موقع تاني يقدر يحط موقعك جوه iframe مخفي ويخدع المستخدمين.',
            score: 0.5
        });
    }

    // 6) Referrer-Policy
    if (!headers.get('referrer-policy')) {
        deduct(5, {
            id: 'missing-referrer-policy',
            title: 'هيدر Referrer-Policy مفقود',
            description: 'روابط الموقع بتسرّب عنوان الصفحة الكامل (ممكن يحتوي بيانات حساسة في الرابط) للمواقع اللي بيتنقل ليها الزائر.',
            score: 0.3
        });
    }

    // 7) تسريب معلومات السيرفر (Server / X-Powered-By)
    const serverHeader = headers.get('server') || '';
    const poweredBy = headers.get('x-powered-by') || '';
    if (/\d/.test(serverHeader) || poweredBy) {
        deduct(6, {
            id: 'server-info-leak',
            title: 'الموقع بيسرّب معلومات عن السيرفر أو التقنية المستخدمة',
            description: `القيمة الظاهرة: "${serverHeader}${poweredBy ? ' / ' + poweredBy : ''}" — دي معلومات بتسهّل على أي حد يدور على ثغرات معروفة في نفس النسخة.`,
            score: 0.4
        });
    }

    // 8) محتوى مختلط (Mixed Content): موارد HTTP جوه صفحة HTTPS
    if (isHttps) {
        const httpResources = (html.match(/(?:src|href)=["']http:\/\/[^"']+["']/gi) || []).length;
        if (httpResources > 0) {
            deduct(10, {
                id: 'mixed-content',
                title: `محتوى مختلط (Mixed Content): ${httpResources} مورد بيتحمّل عبر HTTP غير مشفر`,
                description: 'صور أو سكريبتات أو ستايل شيتات بتتحمّل بروابط http:// عادية جوه صفحة https://، وده بيفتح ثغرة تلاعب في المحتوى.',
                score: 0.5
            });
        }
    }

    // 9) Set-Cookie بدون Secure/HttpOnly/SameSite
    const cookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    const insecureCookies = cookies.filter(c =>
        !/secure/i.test(c) || !/httponly/i.test(c) || !/samesite/i.test(c)
    );
    if (insecureCookies.length > 0) {
        deduct(8, {
            id: 'insecure-cookies',
            title: `${insecureCookies.length} كوكي مفعّلة بدون كل خصائص الحماية (Secure / HttpOnly / SameSite)`,
            description: 'الكوكيز دي ممكن تتسرق عن طريق XSS أو تتقرا عبر اتصال غير مشفر لو مش محمية بالخصائص التلاتة دي مع بعض.',
            score: 0.5
        });
    }

    score = Math.max(0, Math.round(score));

    return {
        score,
        checkedUrl: finalUrl,
        isHttps,
        headersChecked: {
            hsts: !!headers.get('strict-transport-security'),
            csp: !!headers.get('content-security-policy'),
            xContentTypeOptions: !!headers.get('x-content-type-options'),
            frameProtection: !!headers.get('x-frame-options') || /frame-ancestors/i.test(csp),
            referrerPolicy: !!headers.get('referrer-policy')
        },
        issues
    };
}

// دمج فحص "الموقع خبيث؟" (Safe Browsing) مع فحص "إعدادات الأمان" في نتيجة نهائية واحدة
function buildFinalSecurity(malwareCheck, securityConfig) {
    // لو Safe Browsing نفسه فشل (مثلاً مشكلة في المفتاح)، منعتمدش عليه في القرار
    const isMalwareFlagged = malwareCheck ? !malwareCheck.isSafe : false;

    if (isMalwareFlagged) {
        // موقع مصنّف كخبيث/تصيّد = صفر فوري بغض النظر عن أي حاجة تانية
        return {
            score: 0,
            isSafe: false,
            threats: malwareCheck.threats,
            configScore: securityConfig?.score ?? null,
            issues: securityConfig?.issues || []
        };
    }

    return {
        score: securityConfig?.score ?? (malwareCheck ? 100 : null),
        isSafe: true,
        threats: [],
        configScore: securityConfig?.score ?? null,
        issues: securityConfig?.issues || []
    };
}

// ============================================================
// فحص ملكية الدومين (شرط لازم قبل فحص الملفات الحساسة)
// ============================================================
async function checkOwnershipVerified(env, identifier, domain) {
    try {
        const row = await env.DB.prepare(
            "SELECT verified FROM site_verifications WHERE identifier = ? AND domain = ?"
        ).bind(identifier, domain).first();
        return !!row?.verified;
    } catch {
        return false;
    }
}

// ============================================================
// فحص ملفات حساسة مكشوفة — فحص "سلبي" بحت (GET عادي لمسار معروف،
// نتأكد بس إن الملف مش راجع 404). ده بيتشغل فقط بعد التحقق من الملكية.
// مفيش أي محاولة استغلال أو تجاوز صلاحيات هنا، مجرد سؤال "الملف ده موجود؟"
// ============================================================
const SENSITIVE_PATHS = [
    { path: '.env', label: 'ملف .env (متغيرات بيئة/مفاتيح سرية)' },
    { path: '.git/config', label: 'مجلد .git مكشوف (كود المصدر الكامل والتاريخ)' },
    { path: 'wp-config.php.bak', label: 'نسخة احتياطية من wp-config.php' },
    { path: '.DS_Store', label: 'ملف .DS_Store (بيكشف أسماء ملفات السيرفر)' },
    { path: 'config.php.bak', label: 'نسخة احتياطية من config.php' },
    { path: 'phpinfo.php', label: 'صفحة phpinfo() (بتكشف تفاصيل السيرفر بالكامل)' },
    { path: '.htpasswd', label: 'ملف .htpasswd (بيانات مصادقة)' },
    { path: 'backup.zip', label: 'ملف backup.zip في الجذر' }
];

async function checkExposedFiles(url) {
    const origin = new URL(url).origin;
    const issues = [];

    const checks = SENSITIVE_PATHS.map(async ({ path, label }) => {
        try {
            const res = await fetch(`${origin}/${path}`, {
                method: 'GET',
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SuperWebBot/1.0; +owner-verified-scan)' },
                redirect: 'manual' // ريدايركت لصفحة 404 مخصصة يبقى برضو "مش موجود"، منتبعوش
            });

            // 200 صريحة بس = الملف موجود فعلاً. أي حاجة تانية (404, 403, redirect) = مش مكشوف
            if (res.status === 200) {
                issues.push({
                    id: `exposed-${path.replace(/[^a-z0-9]/gi, '-')}`,
                    title: `ملف حساس مكشوف: ${label}`,
                    description: `تم العثور على ${path} متاح للعموم على ${origin}/${path}. احذفه أو امنع الوصول ليه فوراً.`,
                    score: 0.2
                });
            }
        } catch {
            // فشل الطلب (timeout, DNS...) — نتجاهله، مش دليل على وجود الملف
        }
    });

    await Promise.allSettled(checks);

    return { checkedPaths: SENSITIVE_PATHS.length, issues };
}

// ============================================================
// تحليل SEO موسّع (Title, Meta, Headings, Schema, Robots, OG...)
// ============================================================
async function fetchAndParsePage(url) {
    const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SuperWebBot/1.0)' }
    });

    if (!res.ok) {
        throw new Error(`تعذّر فتح الصفحة (${res.status})`);
    }

    const html = await res.text();

    const title = extractTag(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
    const metaDescription = extractAttr(html, /<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i);
    const h1Count = (html.match(/<h1[\s>]/gi) || []).length;
    const h2Count = (html.match(/<h2[\s>]/gi) || []).length;
    const imgTags = html.match(/<img\s[^>]*>/gi) || [];
    const imagesWithoutAlt = imgTags.filter(tag => !/alt=["'][^"']+["']/i.test(tag)).length;
    const hasCanonical = /<link[^>]+rel=["']canonical["']/i.test(html);
    const hasSchema = /application\/ld\+json/i.test(html);
    const isHttps = url.startsWith('https://');

    // فحوصات إضافية
    const hasViewport = /<meta\s+name=["']viewport["']/i.test(html);
    const hasFavicon = /<link[^>]+rel=["'](?:icon|shortcut icon)["']/i.test(html);
    const hreflangCount = (html.match(/<link[^>]+rel=["']alternate["'][^>]+hreflang=/gi) || []).length;

    // Robots meta tag (لو فيه noindex، الموقع مش هيظهر في نتائج البحث خالص — مشكلة حرجة)
    const robotsMetaMatch = html.match(/<meta\s+name=["']robots["']\s+content=["']([^"']*)["']/i);
    const robotsMeta = robotsMetaMatch ? robotsMetaMatch[1].toLowerCase() : null;
    const hasNoindex = robotsMeta ? robotsMeta.includes('noindex') : false;

    // Open Graph (مهم لمشاركة الروابط على السوشيال ميديا)
    const hasOgTitle = /<meta[^>]+property=["']og:title["']/i.test(html);
    const hasOgDescription = /<meta[^>]+property=["']og:description["']/i.test(html);
    const hasOgImage = /<meta[^>]+property=["']og:image["']/i.test(html);

    // عدد الروابط الداخلية/الخارجية (تقريبي، مش دقيق 100% بس مؤشر كافي)
    const origin = new URL(url).origin;
    const allLinks = [...html.matchAll(/<a\s+[^>]*href=["']([^"'#]+)["']/gi)].map(m => m[1]);
    let internalLinks = 0, externalLinks = 0;
    allLinks.forEach(href => {
        if (href.startsWith('http://') || href.startsWith('https://')) {
            if (href.startsWith(origin)) internalLinks++; else externalLinks++;
        } else if (!href.startsWith('mailto:') && !href.startsWith('tel:') && !href.startsWith('javascript:')) {
            internalLinks++;
        }
    });

    // عدد كلمات تقريبي للمحتوى النصي (بعد شيل الوسوم)
    const textOnly = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const wordCount = textOnly ? textOnly.split(' ').length : 0;

    return {
        title: title || null,
        titleLength: title ? title.length : 0,
        metaDescription: metaDescription || null,
        metaDescriptionLength: metaDescription ? metaDescription.length : 0,
        h1Count,
        h2Count,
        totalImages: imgTags.length,
        imagesWithoutAlt,
        hasCanonical,
        hasSchema,
        isHttps,
        hasViewport,
        hasFavicon,
        hreflangCount,
        hasNoindex,
        robotsMeta,
        openGraph: { title: hasOgTitle, description: hasOgDescription, image: hasOgImage },
        internalLinks,
        externalLinks,
        wordCount
    };
}

// ============================================================
// GEO — تحسين الظهور في محركات الإجابة بالذكاء الاصطناعي
// (ChatGPT Search, Perplexity, Google AI Overviews...)
// فحص "سلبي" بالكامل: بيقرا robots.txt وllms.txt الموجودين أصلاً
// ============================================================
const AI_CRAWLERS = [
    'GPTBot', 'ChatGPT-User', 'ClaudeBot', 'anthropic-ai', 'Google-Extended',
    'PerplexityBot', 'CCBot', 'Bytespider', 'Applebot-Extended'
];

async function fetchGeoSignals(url) {
    const origin = new URL(url).origin;

    const [robotsRes, llmsRes] = await Promise.allSettled([
        fetch(`${origin}/robots.txt`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SuperWebBot/1.0)' } }),
        fetch(`${origin}/llms.txt`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SuperWebBot/1.0)' } })
    ]);

    let robotsTxt = null;
    if (robotsRes.status === 'fulfilled' && robotsRes.value.ok) {
        robotsTxt = await robotsRes.value.text();
    }

    const hasLlmsTxt = llmsRes.status === 'fulfilled' && llmsRes.value.ok;

    const blockedBots = [];
    if (robotsTxt) {
        // فحص تقريبي: هل فيه User-agent: <بوت AI معروف> متبوع بـ Disallow: /
        const blocks = robotsTxt.split(/User-agent:/i).slice(1);
        for (const block of blocks) {
            const agentLine = block.split('\n')[0].trim();
            const matchedBot = AI_CRAWLERS.find(bot => agentLine.toLowerCase().includes(bot.toLowerCase()));
            if (matchedBot && /Disallow:\s*\/\s*$/im.test(block.split(/User-agent:/i)[0] || block)) {
                blockedBots.push(matchedBot);
            }
        }
    }

    const issues = [];
    if (!hasLlmsTxt) {
        issues.push({
            id: 'missing-llms-txt',
            title: 'مفيش ملف llms.txt',
            description: 'ملف llms.txt بيدي لمحركات الذكاء الاصطناعي ملخص منظم عن موقعك، بيسهّل عليها فهم محتواك واقتباسه في إجاباتها.',
            score: 0.3
        });
    }
    if (blockedBots.length > 0) {
        issues.push({
            id: 'ai-crawlers-blocked',
            title: `robots.txt بيمنع بوتات AI معروفة: ${blockedBots.join(', ')}`,
            description: 'لو محتواك مسموح يظهر في إجابات الذكاء الاصطناعي، امنعهم يقلل فرصة ظهور موقعك في نتائج ChatGPT/Perplexity/Google AI Overviews.',
            score: 0.4
        });
    }

    return {
        hasLlmsTxt,
        hasRobotsTxt: !!robotsTxt,
        aiCrawlersBlocked: blockedBots,
        issues
    };
}

function extractTag(html, regex) {
    const match = html.match(regex);
    return match ? match[1].trim().replace(/\s+/g, ' ') : null;
}

function extractAttr(html, regex) {
    const match = html.match(regex);
    return match ? match[1].trim() : null;
}

// ============================================================
// تدوير مفاتيح Gemini (Round-Robin عبر D1)
// ============================================================
function getGeminiKeys(env) {
    return [env.GEMINI_API_KEY, env.GEMINI_API_KEY2, env.GEMINI_API_KEY3, env.GEMINI_API_KEY4]
        .map((key, i) => ({ key, index: i + 1 }))
        .filter(k => !!k.key);
}

async function getStartIndex(env, totalKeys) {
    if (!env.DB || totalKeys <= 1) return 0;

    try {
        const row = await env.DB.prepare(
            `UPDATE api_key_rotation SET counter = (counter + 1) % ? WHERE id = 1 RETURNING counter`
        ).bind(totalKeys).first();

        return row ? row.counter : 0;
    } catch {
        // لو الجدول لسه مش موجود، نبدأ من أول مفتاح من غير ما نكسر الطلب
        return 0;
    }
}

// ============================================================
// توصيات الذكاء الاصطناعي (Gemini API) — مع تدوير مفاتيح وFallback
// ============================================================
async function generateAIRecommendations(env, url, audits, safety, seo, realUserData) {
    const keys = getGeminiKeys(env);

    if (keys.length === 0) {
        return fallbackRecommendations('مفيش أي مفتاح Gemini مربوط بالمشروع.');
    }

    const prompt = buildPrompt(url, audits, safety, seo, realUserData);
    const startIndex = await getStartIndex(env, keys.length);

    // نجرب كل مفتاح بالترتيب بدءاً من دوره، ولو خلّص كوتته ننتقل للتالي تلقائياً
    for (let attempt = 0; attempt < keys.length; attempt++) {
        const keyEntry = keys[(startIndex + attempt) % keys.length];

        try {
            const result = await callGemini(keyEntry.key, prompt);
            result.keyUsed = keyEntry.index;
            return result;
        } catch (err) {
            if (err.isRateLimit && attempt < keys.length - 1) {
                continue; // جرّب المفتاح اللي بعده
            }
            if (err.isRateLimit) {
                return fallbackRecommendations('الخدمة مشغولة حالياً، من فضلك حاول تاني بعد بضع دقائق.');
            }
            return fallbackRecommendations('تعذّر توليد التوصيات: ' + err.message);
        }
    }

    return fallbackRecommendations('يرجى المحاولة بعد بضع دقائق.');
}

function buildPrompt(url, audits, safety, seo, realUserData) {
    return `
أنت مهندس ويب خبير في الأداء والأرشفة (SEO). قدّامك تقرير Lighthouse كامل لموقع ${url}
(موبايل وديسكتوب مع بعض)، فيه كل المشاكل الحقيقية اللي الموقع فاشل فيها (كبيرة وصغيرة، مش ملخص فقط).

المشاكل المكتشفة (${audits.length} مشكلة، كل واحدة موسومة بجهاز mobile أو desktop):
${JSON.stringify(audits)}

بيانات إضافية عن الصفحة: ${seo ? JSON.stringify(seo) : 'غير متاحة'}
بيانات الأمان: ${safety ? JSON.stringify(safety) : 'غير متاحة'}

${realUserData ? `
بيانات حقيقية من زوار الموقع الفعليين آخر 28 يوم (مش محاكاة، دي تجربة المستخدمين الحقيقية):
${JSON.stringify(realUserData)}
(goodPercent = نسبة الزوار اللي شافوا تجربة كويسة في المقياس ده. لو goodPercent قليل رغم إن نتيجة
Lighthouse المعملية كويسة، ده مهم جداً تنبّه عليه لأنه معناه الفحص المعملي مابيعكسش تجربة المستخدم
الحقيقية على الإنترنت والأجهزة الواقعية)
` : 'بيانات المستخدمين الحقيقيين غير متاحة (الموقع لسه مفيهوش زيارات كافية من Chrome لتوليدها).'}

المطلوب منك بالظبط، لكل مشكلة مهمة (اختار أهمها، صغيرة كانت أو كبيرة، بحد أقصى 12 مشكلة):
- severity: صنّفها "critical" أو "high" أو "medium" فقط، حسب حجم تأثيرها الفعلي
  (لو فيه تعارض بين نتيجة المعمل وبيانات المستخدمين الحقيقيين، اعتمد على الحقيقية في التصنيف)
- title: اسم المشكلة بالعربي وبشكل مباشر
- impact: تأثيرها الفعلي بالأرقام (مثال: "بيبطّئ التحميل 1.2 ثانية على الموبايل")
- steps: مصفوفة (array) من الخطوات العملية المرقّمة تلقائياً، كل خطوة جملة قصيرة واحدة ومباشرة
  (متكتبش الخطوات كلها في نص واحد طويل، كل خطوة عنصر منفصل في المصفوفة)
- codeExample: كود فعلي جاهز للنسخ يحل المشكلة، أو null صراحة لو مفيش كود منطقي (متختلقش كود وهمي)

وبرضو:
- suggestedMetaDescription: لو الـmeta description ناقصة أو قصيرة، وصف Meta جاهز (155 حرف تقريباً)
- schemaMarkup: كود Schema Markup (JSON-LD نوع WebPage) جاهز للنسخ

رد بصيغة JSON فقط بالشكل ده بالظبط، من غير أي نص زيادة قبله أو بعده، ومن غير علامات كود markdown:
{
  "fixes": [
    { "severity": "critical", "title": "...", "impact": "...", "steps": ["...", "..."], "codeExample": "..." }
  ],
  "suggestedMetaDescription": "...",
  "schemaMarkup": "..."
}
`.trim();
}

async function callGemini(apiKey, prompt) {
    const res = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
            },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.3,
                    responseMimeType: 'application/json'
                }
            })
        }
    );

    if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const message = errData.error?.message || `فشل استدعاء Gemini (${res.status})`;
        const error = new Error(message);
        error.isRateLimit = res.status === 429;
        throw error;
    }

    const data = await res.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

    return parsed || fallbackRecommendations('تعذّر فهم رد الذكاء الاصطناعي.');
}

function fallbackRecommendations(message) {
    return {
        fixes: [{ severity: 'medium', title: 'تعذّر توليد التوصيات', impact: null, steps: [message], codeExample: null }],
        suggestedMetaDescription: null,
        schemaMarkup: null,
        keyUsed: null
    };
}

// ============================================================
// أدوات مساعدة
// ============================================================
function isValidUrl(str) {
    try {
        const u = new URL(str);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

function jsonError(message, status) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}
