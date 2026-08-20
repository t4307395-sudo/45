/**
 * Cloudflare Pages Function: /api/analyze
 * محلل المواقع: سرعة (موبايل + ديسكتوب) + أمان + SEO أساسي + توصيات AI شاملة
 * المفاتيح المستخدمة: EXT_TOKEN_MAIN (PageSpeed + Safe Browsing + Custom Search)
 *                      GEMINI_API_KEY / GEMINI_API_KEY2 / GEMINI_API_KEY3 / GEMINI_API_KEY4
 *                      (تدوير تلقائي بينهم + Fallback لو مفتاح خلّصت كوتته)
 *                      env.DB (D1) لتخزين عداد التدوير
 */
export function onRequestGet() {
    return jsonError('استخدم POST مع رابط الموقع للفحص.', 405, { 'Allow': 'POST' });
}

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

    const { url, email, deepScan, extraUrls } = body;
    if (!url || !isValidUrl(url)) {
        return jsonError('من فضلك أدخل رابط صحيح يبدأ بـ http:// أو https://', 400);
    }

    // تسجيل الدخول اختياري: البريد يُستخدم فقط لو كان حساباً موجوداً، وإلا نعامل الطلب كزائر.
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const userExists = normalizedEmail
        ? await env.DB.prepare("SELECT id, email, is_pro FROM users WHERE email = ?").bind(normalizedEmail).first()
        : null;
    const isRegistered = !!userExists;
    const isPro = !!userExists?.is_pro;
    const guestIdentity = getGuestIdentity(request);
    const identifier = isRegistered ? `user:${userExists.email.toLowerCase()}` : `guest:${guestIdentity.id}`;
    const quotaLimit = isPro ? null : (isRegistered ? 6 : 3);
    let quota = null;

    // الفحص الأول للزائر متاح بدون حساب. الزائر يحصل على 3 فحوصات يومياً، والمسجل على 6.
    if (quotaLimit !== null) {
        quota = await checkAndIncrementLimit(env, identifier, quotaLimit);
        if (!quota.allowed) {
            const message = isRegistered
                ? 'خلصت فحوصاتك الستة اليوم. ارجع بكرة وحاول تاني.'
                : 'خلصت الفحوصات الثلاثة المجانية اليوم. سجّل حسابك للحصول على 6 فحوصات يومياً.';
            return jsonError(message, 429, guestIdentity.setCookie ? { 'Set-Cookie': guestIdentity.setCookie } : {});
        }
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
        const dataQuality = buildDataQuality({ mobileResult, desktopResult, safeBrowsingResult, securityAuditResult, pageContent, cruxResult, geoResult });

        if (!mobile && !desktop) {
            return jsonError('لم نتمكن من الحصول على قياسات السرعة من PageSpeed لهذا الرابط. جرّب مرة أخرى أو تأكد أن الموقع متاح للعامة.', 502);
        }

        // دمج فحص "الموقع مصنّف كخبيث؟" مع فحص "إعدادات الأمان الفعلية" في كيان واحد
        // السكور النهائي = 0 فوري لو الموقع مصنّف خبيث، وإلا سكور إعدادات الأمان الفعلية
        const safety = buildFinalSecurity(malwareCheck, securityConfig);

        // 2.5) الفحص العميق — بس لو المستخدم Pro، طالب فحص عميق صراحةً، والدومين متحقق من ملكيته
        const domain = new URL(url).hostname;
        const isOwnershipVerified = await checkOwnershipVerified(env, identifier, domain);
        let exposedFilesResult = null;
        let secretsResult = null;
        let authRiskResult = null;
        let apiExposureResult = null;
        let deepScanRan = false;

        if (isPro && deepScan && isOwnershipVerified) {
            deepScanRan = true;

            // أ) ملفات حساسة مكشوفة (.env, .git, إلخ)
            exposedFilesResult = await checkExposedFiles(url);
            if (exposedFilesResult.issues.length > 0) {
                safety.score = Math.max(0, safety.score - exposedFilesResult.issues.length * 15);
                safety.issues = [...(safety.issues || []), ...exposedFilesResult.issues];
            }

            // ب) تسريب أسرار في كود JS (روابط قواعد بيانات، مفاتيح API، باسوردات صريحة)
            if (securityConfig?.html) {
                const origin = new URL(securityConfig.checkedUrl).origin;
                secretsResult = await checkExposedSecrets(securityConfig.html, origin);
                if (secretsResult.issues.length > 0) {
                    safety.score = Math.max(0, safety.score - secretsResult.issues.length * 20);
                    safety.issues = [...(safety.issues || []), ...secretsResult.issues];
                }

                // ج) فحص استدلالي: صلاحيات أدمن بتتفحص في المتصفح بس؟
                authRiskResult = checkClientSideAuthRisk(securityConfig.html);
                if (authRiskResult) {
                    safety.score = Math.max(0, safety.score - 10);
                    safety.issues = [...(safety.issues || []), authRiskResult];
                }

                // د) Endpoints بترجع بيانات من غير تسجيل دخول (Broken Access Control) — فحص قراءة سلبي بحت
                apiExposureResult = await checkUnauthenticatedApiExposure(secretsResult.jsText || '', origin);
                if (apiExposureResult.issues.length > 0) {
                    safety.score = Math.max(0, safety.score - apiExposureResult.issues.length * 25);
                    safety.issues = [...(safety.issues || []), ...apiExposureResult.issues];
                }
            }
        }

        // دمج مشاكل الموبايل والديسكتوب والأمان وGEO مع بعض (كل مشكلة موسومة بالجهاز/الفئة)
        const allAudits = [
            ...(mobile?.actionableAudits || []).map(a => ({ ...a, device: 'mobile' })),
            ...(desktop?.actionableAudits || []).map(a => ({ ...a, device: 'desktop' })),
            ...(securityConfig?.issues || []).map(a => ({ ...a, device: 'security' })),
            ...(exposedFilesResult?.issues || []).map(a => ({ ...a, device: 'security' })),
            ...(secretsResult?.issues || []).map(a => ({ ...a, device: 'security' })),
            ...(authRiskResult ? [{ ...authRiskResult, device: 'security' }] : []),
            ...(apiExposureResult?.issues || []).map(a => ({ ...a, device: 'security' })),
            ...(geo?.issues || []).map(a => ({ ...a, device: 'geo' }))
        ];

        const aiRecommendations = await generateAIRecommendations(env, url, allAudits, safety, seo, realUserData, isPro);

        // 2.7) فحص صفحات إضافية من نفس الموقع (بس لمشتركي Pro) — فحص خفيف: أمان + SEO أساسي بس
        // (من غير PageSpeed كامل لكل صفحة، عشان الوقت والتكلفة، الصفحة الرئيسية بس بتاخد الفحص الكامل)
        let additionalPages = null;
        if (isPro && Array.isArray(extraUrls) && extraUrls.length > 0) {
            const limitedUrls = extraUrls.filter(isValidUrl).slice(0, 5); // حد أقصى 5 صفحات إضافية في المرة
            const pageChecks = await Promise.allSettled(
                limitedUrls.map(async (pageUrl) => {
                    const [pageSecurity, pageSeo] = await Promise.allSettled([
                        analyzeSecurityConfig(pageUrl),
                        fetchAndParsePage(pageUrl)
                    ]);
                    return {
                        url: pageUrl,
                        security: pageSecurity.status === 'fulfilled'
                            ? { ...pageSecurity.value, html: undefined } // منسربش الـ HTML الكامل في الرد
                            : null,
                        seo: pageSeo.status === 'fulfilled' ? pageSeo.value : null
                    };
                })
            );
            additionalPages = pageChecks.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);
        }

        // 3) قارن بآخر فحص سابق لنفس الرابط ونفس الحساب/IP
        const comparison = await getComparison(env, identifier, url, mobile?.performanceScore, mobile?.seoScore);

        const responseData = {
            success: true,
            url,
            dataQuality,
            usage: {
                accountType: isPro ? 'pro' : (isRegistered ? 'registered' : 'guest'),
                limit: quotaLimit,
                used: quota?.count ?? null,
                remaining: quota?.remaining ?? null,
                registrationPrompt: !isRegistered && (quota?.remaining ?? 0) > 0
                    ? 'سجّل للحصول على 6 فحوصات يومياً بدل 3 فحوصات للزائر.'
                    : null
            },
            checkedAt: new Date().toISOString(),
            mobile: mobile ? stripAudits(mobile) : null,
            desktop: desktop ? stripAudits(desktop) : null,
            safety,
            deepScan: {
                ran: deepScanRan,
                ownershipVerified: isOwnershipVerified,
                // "شفافية": قائمة توضح كل حاجة اتفحصت والنتيجة، حتى لو كانت النتيجة "نضيفة"
                // عشان لو مفيش مشاكل، المستخدم يشوف "اتفحصت وطلعت نضيفة" مش سكوت غامض
                checks: deepScanRan ? [
                    {
                        id: 'exposed-files',
                        label: 'ملفات حساسة مكشوفة (.env, .git, wp-config.php.bak, إلخ)',
                        checkedCount: exposedFilesResult?.checkedPaths ?? 0,
                        foundCount: exposedFilesResult?.issues.length ?? 0,
                        clean: (exposedFilesResult?.issues.length ?? 0) === 0
                    },
                    {
                        id: 'exposed-secrets',
                        label: 'تسريب أسرار في كود JS (روابط قواعد بيانات، مفاتيح API، باسوردات)',
                        checkedCount: SECRET_PATTERNS_COUNT,
                        foundCount: secretsResult?.issues.length ?? 0,
                        clean: (secretsResult?.issues.length ?? 0) === 0
                    },
                    {
                        id: 'client-auth-risk',
                        label: 'فحص استدلالي لصلاحيات العميل (زي فحص أدمن من JS)',
                        checkedCount: 1,
                        foundCount: authRiskResult ? 1 : 0,
                        clean: !authRiskResult
                    },
                    {
                        id: 'api-exposure',
                        label: 'Endpoints بترجع بيانات من غير تسجيل دخول',
                        checkedCount: apiExposureResult?.checkedEndpoints ?? 0,
                        foundCount: apiExposureResult?.issues.length ?? 0,
                        clean: (apiExposureResult?.issues.length ?? 0) === 0
                    }
                ] : [],
                exposedFiles: exposedFilesResult,
                exposedSecrets: secretsResult ? { issues: secretsResult.issues } : null, // بدون jsText، ده داخلي بس
                authRisk: authRiskResult,
                apiExposure: apiExposureResult
            },
            seo,
            geo,
            additionalPages,
            realUserData,
            aiRecommendations,
            comparison
        };

        // احفظ في الكاش (لغير المشتركين بس، الـ Pro مالوش كاش خالص) وفي السجل التاريخي دايمًا
        // الكاش اتشال بالكامل — بنسجل بس في السجل التاريخي للمقارنات
        context.waitUntil(saveToHistory(env, identifier, url, mobile?.performanceScore, mobile?.seoScore));

        const responseHeaders = { 'Content-Type': 'application/json' };
        if (guestIdentity.setCookie) responseHeaders['Set-Cookie'] = guestIdentity.setCookie;
        return new Response(JSON.stringify(responseData), { headers: responseHeaders });

    } catch (err) {
        return jsonError(err.message, 500);
    }
}

// ============================================================
// الحد اليومي (3 فحوصات لكل حساب/IP)
// ============================================================
async function checkAndIncrementLimit(env, identifier, limit) {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    try {
        const row = await env.DB.prepare(
            "SELECT count FROM scan_limits WHERE identifier = ? AND scan_date = ?"
        ).bind(identifier, today).first();

        const currentCount = row?.count || 0;
        if (currentCount >= limit) {
            return { allowed: false, count: currentCount, remaining: 0 };
        }

        const nextCount = currentCount + 1;
        await env.DB.prepare(
            "INSERT INTO scan_limits (identifier, scan_date, count) VALUES (?, ?, 1) " +
            "ON CONFLICT(identifier, scan_date) DO UPDATE SET count = count + 1"
        ).bind(identifier, today).run();

        return { allowed: true, count: nextCount, remaining: Math.max(0, limit - nextCount) };
    } catch {
        // لو الجدول غير متاح، لا نمنع الفحص بسبب عطل داخلي؛ نترك usage غير معروف.
        return { allowed: true, count: null, remaining: null };
    }
}

function getGuestIdentity(request) {
    const cookieHeader = request.headers.get('Cookie') || '';
    const match = cookieHeader.match(/(?:^|;\\s*)sw_guest_id=([^;]+)/);
    const existing = match?.[1] ? decodeURIComponent(match[1]) : '';
    if (existing && /^[a-zA-Z0-9_-]{16,80}$/.test(existing)) {
        return { id: existing, setCookie: null };
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const id = `${crypto.randomUUID()}-${ip.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)}`;
    return {
        id,
        setCookie: `sw_guest_id=${encodeURIComponent(id)}; Max-Age=86400; Path=/; Secure; HttpOnly; SameSite=Lax`
    };
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

function scoreToPercent(score) {
    return typeof score === 'number' && Number.isFinite(score)
        ? Math.round(score * 100)
        : null;
}

function buildDataQuality(results) {
    const required = new Set(['mobileResult', 'desktopResult', 'securityAuditResult', 'pageContent']);
    const checks = Object.fromEntries(Object.entries(results).map(([name, result]) => {
        if (result.status !== 'fulfilled') {
            return [name, { status: 'unavailable', reason: result.reason?.message || 'مصدر البيانات لم يستجب' }];
        }
        if (result.value == null) {
            return [name, { status: 'no-data', reason: required.has(name) ? 'لم تصل بيانات كافية من المصدر' : 'لا توجد بيانات كافية لهذا الرابط' }];
        }
        return [name, { status: 'ok' }];
    }));
    const requiredProblems = Object.entries(checks).filter(([name, value]) => required.has(name) && value.status !== 'ok');
    const allProblems = Object.entries(checks).filter(([, value]) => value.status !== 'ok');
    return {
        complete: requiredProblems.length === 0,
        checks,
        warnings: allProblems.map(([name, value]) => `${name}: ${value.reason}`)
    };
}

// ============================================================
// فحص السرعة (PageSpeed Insights API) — لجهاز واحد (موبايل/ديسكتوب)
// ============================================================
export async function fetchPageSpeed(url, apiKey, strategy) {
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
        performanceScore: scoreToPercent(categories.performance?.score),
        seoScore: scoreToPercent(categories.seo?.score),
        accessibilityScore: scoreToPercent(categories.accessibility?.score),
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
export async function analyzeSecurityConfig(url) {
    const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SuperWebBot/1.0; +security-audit)' },
        redirect: 'follow'
    });

    const headers = res.headers;
    const finalUrl = res.url || url;
    const isHttps = finalUrl.startsWith('https://');
    const origin = new URL(finalUrl).origin;
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

    // 10) تسريب أسرار في كود الصفحة أو ملفات JS المرتبطة بيها (روابط قواعد بيانات، مفاتيح API، باسوردات)
    // ده فحص "سلبي" بحت: بيقرا بس محتوى ملفات JS العامة اللي المتصفح أصلاً بيحمّلها لأي زائر
    // (يعني أي حد بيفتح "View Page Source" أو DevTools يقدر يشوف نفس الحاجة دي أصلاً)
    // ملحوظة: تسريب الأسرار في JS وفحص الـ Auth الاستدلالي اتنقلوا للفحص العميق (Pro فقط)
    // — شوف onRequestPost تحت، بيتشغلوا بس لو isPro && deepScan && الدومين متحقق من ملكيته

    score = Math.max(0, Math.round(score));

    return {
        score,
        checkedUrl: finalUrl,
        isHttps,
        html, // بنرجّعه هنا عشان الفحص العميق يستخدمه من غير ما يعمل fetch تاني لنفس الصفحة
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

// ============================================================
// كشف أسرار مسرّبة في كود JS العام (روابط DB، مفاتيح API، باسوردات...)
// فحص سلبي: بيقرا بس ملفات JS اللي المتصفح أصلاً بيحمّلها لأي زائر عادي
// ============================================================
const SECRET_PATTERNS = [
    { regex: /mongodb(?:\+srv)?:\/\/[^\s'"]+/gi, label: 'رابط اتصال MongoDB (فيه يوزر وباسورد)' },
    { regex: /postgres(?:ql)?:\/\/[^\s'"]+/gi, label: 'رابط اتصال PostgreSQL (فيه يوزر وباسورد)' },
    { regex: /mysql:\/\/[^\s'"]+/gi, label: 'رابط اتصال MySQL (فيه يوزر وباسورد)' },
    { regex: /redis:\/\/[^\s'"]+/gi, label: 'رابط اتصال Redis' },
    { regex: /AKIA[0-9A-Z]{16}/g, label: 'مفتاح AWS Access Key' },
    { regex: /AIza[0-9A-Za-z_-]{35}/g, label: 'مفتاح Google API' },
    { regex: /sk_live_[0-9a-zA-Z]{20,}/g, label: 'مفتاح Stripe سرّي (Live)' },
    { regex: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g, label: 'مفتاح تشفير خاص (Private Key) كامل' },
    { regex: /["']?(?:db_)?password["']?\s*[:=]\s*["'][^"'\s]{4,}["']/gi, label: 'باسورد مكتوب صريح في الكود' },
    { regex: /["']?(?:api[_-]?key|secret[_-]?key)["']?\s*[:=]\s*["'][a-zA-Z0-9_-]{16,}["']/gi, label: 'مفتاح API/Secret مكتوب صريح في الكود' }
];

const SECRET_PATTERNS_COUNT = SECRET_PATTERNS.length;

async function checkExposedSecrets(html, origin) {
    const issues = [];
    const foundTypes = new Set();

    // نجمع كل ملفات JS المرتبطة بالصفحة (حد أقصى 8 ملفات، عشان الوقت)
    const scriptSrcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
        .map(m => m[1])
        .filter(src => !src.startsWith('http') || src.startsWith(origin)) // ملفات نفس الموقع بس، مش مكتبات خارجية زي jQuery/Google
        .slice(0, 8);

    const contents = [html]; // نفحص الـ HTML نفسه (فيه inline scripts) زيادة على الملفات

    await Promise.allSettled(scriptSrcs.map(async (src) => {
        try {
            const fullUrl = src.startsWith('http') ? src : `${origin}${src.startsWith('/') ? '' : '/'}${src}`;
            const res = await fetch(fullUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SuperWebBot/1.0)' } });
            if (res.ok) contents.push(await res.text());
        } catch { /* تجاهل ملف مش قادر يتحمّل */ }
    }));

    const fullText = contents.join('\n');

    for (const { regex, label } of SECRET_PATTERNS) {
        if (foundTypes.has(label)) continue;
        if (regex.test(fullText)) {
            foundTypes.add(label);
            issues.push({
                id: `exposed-secret-${label.replace(/[^a-z0-9]/gi, '-')}`,
                title: `تسريب محتمل: ${label}`,
                description: `لقينا نمط يشبه "${label}" ظاهر في كود JS اللي بيتحمّل لأي زائر للموقع. لو ده فعلاً بيانات حقيقية، غيّرها فورًا وانقلها لمتغيرات بيئة على السيرفر (مش في كود العميل خالص).`,
                score: 0.35
            });
        }
    }

    return { issues, jsText: fullText }; // بنرجّع نص كل ملفات JS عشان فحص الـ endpoints يستخدمه من غير ما يعمل تحميل تاني
}

// ============================================================
// فحص endpoints بترجع بيانات من غير أي تسجيل دخول (Broken Access Control)
// فحص "قراءة سلبي بحت": بيبعت طلب GET عادي بالظبط زي أي زائر عادي —
// مفيش أي بيانات مزيفة أو محاولة تعديل/حذف/إنشاء، بس بيسأل "الرد ده محتاج تسجيل دخول؟"
// ============================================================
async function checkUnauthenticatedApiExposure(jsText, origin) {
    const issues = [];

    // نستخرج مسارات الـ API المذكورة في كود JS (fetch('/api/...'), fetch("/api/..."))
    const endpointMatches = [...jsText.matchAll(/fetch\(\s*['"`](\/[a-zA-Z0-9\/_-]*(?:api|admin)[a-zA-Z0-9\/_-]*)['"`]/gi)];
    const uniqueEndpoints = [...new Set(endpointMatches.map(m => m[1]))].slice(0, 10); // حد أقصى 10

    await Promise.allSettled(uniqueEndpoints.map(async (path) => {
        try {
            const res = await fetch(`${origin}${path}`, {
                method: 'GET', // GET بس — قراءة، مفيش أي POST/PUT/DELETE خالص
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SuperWebBot/1.0; +readonly-access-check)' }
            });

            if (!res.ok) return; // 401/403/404 يعني محمي أو مش موجود بالطريقة دي — تمام، مفيش مشكلة

            const contentType = res.headers.get('content-type') || '';
            if (!contentType.includes('json')) return;

            const bodyText = await res.text();
            // لو الرد JSON حقيقي وحجمه معقول (مش رد فاضي {} أو [])، يبقى فيه بيانات فعلاً بترجع من غير حماية
            if (bodyText.length > 20) {
                issues.push({
                    id: `unauthenticated-api-${path.replace(/[^a-z0-9]/gi, '-')}`,
                    title: `Endpoint بيرجع بيانات من غير تسجيل دخول: ${path}`,
                    description: `بعتنا طلب GET عادي (من غير أي بيانات تسجيل دخول) على ${path} ورجع بيانات JSON بدل ما يرفض الطلب. لو الـ endpoint ده مفروض يكون لمستخدمين مسجلين بس، تأكد إن السيرفر بيتحقق من التوكين/الجلسة قبل ما يرجّع أي بيانات.`,
                    score: 0.4
                });
            }
        } catch { /* تجاهل — تعذّر الوصول مش دليل على مشكلة */ }
    }));

    return { issues, checkedEndpoints: uniqueEndpoints.length };
}

// ============================================================
// فحص استدلالي: أنماط كود بتوحي إن فحص الصلاحيات (زي أدمن) بيحصل في المتصفح بس
// ============================================================
function checkClientSideAuthRisk(html) {
    const riskyPatterns = [
        /localStorage\.getItem\(['"](?:is_?admin|role|permission)['"]\)/i,
        /if\s*\(\s*(?:user\.)?(?:is_?admin|role)\s*===?\s*['"]admin['"]\s*\)/i
    ];

    const matched = riskyPatterns.some(p => p.test(html));
    if (!matched) return null;

    return {
        id: 'client-side-auth-risk',
        title: 'احتمال إن صلاحيات مهمة (زي أدمن) بتتفحص في كود المتصفح بس',
        description: 'لقينا نمط في الكود بيشبه "لو role == admin اظهر الميزة دي" بيتنفذ في الجافاسكريبت. ده مش خطر في حد ذاته لو السيرفر برضو بيرفض أي طلب من غير صلاحية حقيقية — لكن لو السيرفر بيثق في القيمة الجاية من المتصفح من غير ما يتأكد منها تاني، أي حد يقدر يفتح Console ويغيّر القيمة دي يدوي ويوصل لميزات مش مفروض يشوفها. راجع كل endpoint حساس في الباك إند وتأكد إنه بيتحقق من الصلاحية بنفسه، مش بس بياخد كلام المتصفح على إنه صح.',
        score: 0.15
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
            "SELECT verified FROM site_verifications WHERE identifier = ? AND domain = ? AND active = 1"
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
export async function fetchAndParsePage(url) {
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
// مجمّعين منفصلين: مجاني (GEMINI_API_KEY..4) وPro (GEMINI_API_KEY_PRO1..5)
// عشان ضغط المستخدمين المجانيين ميأثرش على جودة خدمة المشتركين المدفوعين
// ============================================================
export function getGeminiKeys(env, isPro) {
    const proKeys = [env.GEMINI_API_KEY_PRO1, env.GEMINI_API_KEY_PRO2, env.GEMINI_API_KEY_PRO3, env.GEMINI_API_KEY_PRO4, env.GEMINI_API_KEY_PRO5]
        .map((key, i) => ({ key, index: `pro-${i + 1}` }))
        .filter(k => !!k.key);

    const freeKeys = [env.GEMINI_API_KEY, env.GEMINI_API_KEY2, env.GEMINI_API_KEY3, env.GEMINI_API_KEY4]
        .map((key, i) => ({ key, index: i + 1 }))
        .filter(k => !!k.key);

    // لو مشترك Pro ومفيش مفاتيح Pro مربوطة أصلاً، يرجع لمفاتيح المجاني كـ fallback بدل ما يفشل الطلب
    if (isPro) return proKeys.length > 0 ? proKeys : freeKeys;
    return freeKeys;
}

export async function getStartIndex(env, totalKeys, counterId) {
    if (!env.DB || totalKeys <= 1) return 0;

    try {
        const row = await env.DB.prepare(
            `UPDATE api_key_rotation SET counter = (counter + 1) % ? WHERE id = ? RETURNING counter`
        ).bind(totalKeys, counterId).first();

        return row ? row.counter : 0;
    } catch {
        // لو الجدول لسه مش موجود، نبدأ من أول مفتاح من غير ما نكسر الطلب
        return 0;
    }
}

// ============================================================
// قائمة المشاكل — بيانات حقيقية 100% من الفحص نفسه، بدون أي AI خالص
// كل عنصر جاي مباشرة من audits (PageSpeed الحقيقي أو فحوصاتنا الخاصة)،
// فمفيش أي احتمال "اختراع" مشكلة مش موجودة فعلياً
// ============================================================
function buildIssuesList(audits) {
    return audits.map(a => ({
        id: a.id || `${a.device || 'issue'}-${(a.title || '').slice(0, 30)}`,
        device: a.device || null,
        title: a.title,
        description: a.description || null,
        severity: deriveSeverity(a),
        // الحل (steps + codeExample) هيتولّد عند الطلب بس، لما المستخدم يدوس "حل المشكلة"
        hasSolution: false
    }));
}

function deriveSeverity(audit) {
    // مشاكل الأمان (device: 'security') والملفات الحساسة دايمًا حرجة
    if (audit.device === 'security') return 'critical';
    if (audit.device === 'geo') return 'medium';
    if (typeof audit.score === 'number') {
        if (audit.score < 0.5) return 'high';
        if (audit.score < 0.9) return 'medium';
    }
    return 'low';
}

// ============================================================
// توصيات إضافية بسيطة (وصف Meta وSchema بس) — استخدام محدود جداً للـ AI
// ============================================================
async function generateAIRecommendations(env, url, audits, safety, seo, realUserData, isPro) {
    const fixes = buildIssuesList(audits);

    const keys = getGeminiKeys(env, isPro);
    if (keys.length === 0) {
        return { fixes, suggestedMetaDescription: null, schemaMarkup: null, keyUsed: null };
    }

    // برومبت خفيف جداً بس لوصف Meta وSchema (مش لتوليد مشاكل خالص، عشان كده مفيش خطر اختراع)
    const prompt = `
أنت خبير SEO. بناءً على البيانات دي عن موقع ${url}:
${seo ? JSON.stringify(seo) : 'غير متاحة'}

رجّع بصيغة JSON فقط، من غير أي نص زيادة أو backticks:
{
  "suggestedMetaDescription": "وصف Meta بالعربي جاهز (155 حرف تقريباً) لو ناقص أو قصير، أو null لو موجود وكويس فعلاً",
  "schemaMarkup": "كود Schema Markup (JSON-LD نوع WebPage) جاهز للنسخ"
}
`.trim();

    const startIndex = await getStartIndex(env, keys.length, isPro ? 2 : 1);

    for (let attempt = 0; attempt < keys.length; attempt++) {
        const keyEntry = keys[(startIndex + attempt) % keys.length];
        try {
            const raw = await callGemini(keyEntry.key, prompt);
            return {
                fixes,
                suggestedMetaDescription: raw.suggestedMetaDescription || null,
                schemaMarkup: raw.schemaMarkup || null,
                keyUsed: keyEntry.index
            };
        } catch (err) {
            if (err.isRateLimit && attempt < keys.length - 1) continue;
            break;
        }
    }

    // حتى لو فشل جزء الـ Meta/Schema، قائمة المشاكل الحقيقية (fixes) لازم تفضل موجودة دايمًا
    return { fixes, suggestedMetaDescription: null, schemaMarkup: null, keyUsed: null };
}

export async function callGemini(apiKey, prompt) {
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

    if (!parsed) {
        throw new Error('تعذّر فهم رد الذكاء الاصطناعي.');
    }

    return parsed;
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

function jsonError(message, status, extraHeaders = {}) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'Content-Type': 'application/json', ...extraHeaders }
    });
}
