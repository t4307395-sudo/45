/**
 * منطق صفحة محلل المواقع: الفحص + عرض النتائج + ربط Drive الحفظ
 */

const GOOGLE_CLIENT_ID = '205809787174-a73p118a4mmkpn6cju1dnqcm07eut7v4.apps.googleusercontent.com';
const DRIVE_SCOPES = 'https://www.googleapis.com/auth/drive.file';

const LOADING_STEPS = [
    'بنفحص أداء الموبايل...',
    'بنفحص أداء الديسكتوب...',
    'بنتأكد من الأمان...',
    'بنحلل الأرشفة (SEO)...',
    'بنولّد التوصيات بالذكاء الاصطناعي...'
];

let lastReport = null;
let driveCodeClient = null;
let loadingStepInterval = null;

function getCurrentUser() {
    try {
        return JSON.parse(localStorage.getItem('user'));
    } catch {
        return null;
    }
}

function startLoadingSteps() {
    const el = document.getElementById('loading-step-text');
    if (!el) return;
    let i = 0;
    el.textContent = LOADING_STEPS[0];
    loadingStepInterval = setInterval(() => {
        i = (i + 1) % LOADING_STEPS.length;
        el.textContent = LOADING_STEPS[i];
    }, 2200);
}

function stopLoadingSteps() {
    if (loadingStepInterval) {
        clearInterval(loadingStepInterval);
        loadingStepInterval = null;
    }
}

// ============================================================
// فحص الموقع
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('analyze-form');
    if (!form) return;

    // تسجيل الدخول إجباري لاستخدام الأداة
    const currentUser = getCurrentUser();
    if (!currentUser || !currentUser.email) {
        document.getElementById('analyzer-input-section').style.display = 'none';
        document.getElementById('login-required-box').style.display = 'block';
        return;
    }

    // الصفحة دي لمشتركي Pro بس — حتى لو الرابط اتسرب، محدش يقدر يستخدمها من غير اشتراك فعلي
    if (!currentUser.is_pro) {
        document.getElementById('analyzer-input-section').style.display = 'none';
        document.getElementById('my-sites-box').style.display = 'none';
        document.getElementById('pro-lock-box').style.display = 'block';
        return;
    }

    // ============ إدارة "مواقعي" (نافذة منبثقة) ============
    document.getElementById('my-sites-box').style.display = 'block';
    let mySites = []; // { domain, verified }

    const modalOverlay = document.getElementById('my-sites-modal-overlay');
    document.getElementById('open-my-sites-btn').addEventListener('click', () => {
        modalOverlay.style.display = 'flex';
    });
    document.getElementById('close-my-sites-modal').addEventListener('click', () => {
        modalOverlay.style.display = 'none';
    });
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) modalOverlay.style.display = 'none'; // قفل بالدوس برا الصندوق
    });

    async function loadMySites() {
        try {
            const res = await fetch('/api/verify-site', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'list', email: currentUser.email })
            });
            const data = await res.json();
            mySites = data.sites || [];
            renderMySites();

            // شارة عدد المواقع على زرار "مواقعي"
            const badge = document.getElementById('my-sites-count-badge');
            const verifiedCount = mySites.filter(s => s.verified).length;
            badge.textContent = mySites.length > 0 ? `(${verifiedCount}/${mySites.length} متحقق)` : '';
        } catch (err) {
            console.error('تعذّر تحميل مواقعي:', err);
        }
    }

    function renderMySites() {
        const listEl = document.getElementById('my-sites-list');
        if (mySites.length === 0) {
            listEl.innerHTML = `<p class="ownership-note">لسه مفيش مواقع مضافة.</p>`;
            return;
        }
        listEl.innerHTML = mySites.map(site => `
            <div class="my-site-row" data-domain="${site.domain}">
                <span class="my-site-status">${site.verified ? '✅' : '⏳'}</span>
                <span class="my-site-domain">${site.domain}</span>
                <span class="my-site-badge">${site.verified ? 'متحقق منه' : 'قيد التحقق'}</span>
                <button type="button" class="my-site-use-btn" data-domain="${site.domain}" ${site.verified ? '' : 'disabled'}>استخدام</button>
                <button type="button" class="my-site-remove-btn" data-domain="${site.domain}">حذف</button>
            </div>
        `).join('');

        listEl.querySelectorAll('.my-site-use-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const domain = btn.dataset.domain;
                document.getElementById('analyze-url').value = `https://${domain}`;
                syncDeepScanAvailability();
                modalOverlay.style.display = 'none'; // اقفل النافذة تلقائي بعد الاختيار
                document.getElementById('my-sites-selected-hint').textContent = `الموقع المختار: ${domain}`;
            });
        });

        listEl.querySelectorAll('.my-site-remove-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const domain = btn.dataset.domain;
                if (!confirm(`لو مسحت ${domain}، لازم تتحقق من ملكيته تاني من الصفر لو عايز تستخدمه. متأكد؟`)) return;
                try {
                    await fetch('/api/verify-site', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'remove', url: `https://${domain}`, email: currentUser.email })
                    });
                    await loadMySites();
                    syncDeepScanAvailability();
                } catch (err) {
                    alert('تعذّر الحذف: ' + err.message);
                }
            });
        });
    }

    // فحص الأمان العميق يتفعّل بس لو الرابط المكتوب دلوقتي يطابق دومين متحقق منه فعلاً
    function syncDeepScanAvailability() {
        const urlVal = document.getElementById('analyze-url').value.trim();
        const checkbox = document.getElementById('deep-scan-checkbox');
        const statusEl = document.getElementById('deep-scan-label');
        let domain = null;
        try { domain = new URL(urlVal).hostname; } catch { /* رابط ناقص لسه */ }

        const matched = domain && mySites.find(s => s.domain === domain && s.verified);
        if (matched) {
            checkbox.disabled = false;
            statusEl.textContent = `✅ متاح — الموقع ده متحقق من ملكيته (${domain})`;
            statusEl.className = 'deep-scan-status deep-scan-status--on';
        } else {
            checkbox.disabled = true;
            checkbox.checked = false;
            statusEl.textContent = '🔒 غير متاح — اختار موقع متحقق منه من "مواقعي" الأول';
            statusEl.className = 'deep-scan-status deep-scan-status--off';
        }
    }

    document.getElementById('analyze-url').addEventListener('input', syncDeepScanAvailability);

    document.getElementById('add-site-btn').addEventListener('click', async () => {
        const url = document.getElementById('new-site-url').value.trim();
        if (!url) { alert('اكتب رابط الموقع الأول'); return; }
        try {
            const res = await fetch('/api/verify-site', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'generate', url, email: currentUser.email })
            });
            const data = await res.json();
            if (!res.ok || data.error) {
                alert(data.error || 'حصل خطأ');
                return;
            }
            document.getElementById('ownership-token-display').textContent = data.token;
            document.getElementById('ownership-file-url').textContent = data.filePath;
            document.getElementById('ownership-step-instructions').style.display = 'block';
            document.getElementById('ownership-step-instructions').dataset.pendingUrl = url;
            document.getElementById('ownership-status').textContent = data.verified ? '✅ متحقق منه بالفعل' : '';
            await loadMySites();
        } catch (err) {
            alert('تعذّر توليد كود التحقق: ' + err.message);
        }
    });

    document.getElementById('check-verify-btn').addEventListener('click', async () => {
        const url = document.getElementById('ownership-step-instructions').dataset.pendingUrl;
        const statusEl = document.getElementById('ownership-status');
        if (!url) { statusEl.textContent = '❌ اعمل خطوة الإضافة الأول'; return; }
        statusEl.textContent = 'بنتحقق...';
        try {
            const res = await fetch('/api/verify-site', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'check', url, email: currentUser.email })
            });
            const data = await res.json();
            if (data.verified) {
                statusEl.textContent = '✅ تم التحقق من ملكية الدومين بنجاح';
                await loadMySites();
            } else {
                statusEl.textContent = '❌ ' + (data.reason || 'مش لاقيين الملف، تأكد إنك رفعته صح');
            }
        } catch (err) {
            statusEl.textContent = '❌ تعذّر التحقق: ' + err.message;
        }
    });

    loadMySites();

    // ============ تحليل المنافسين ============
    document.getElementById('competitor-box').style.display = 'block';
    const competitorOverlay = document.getElementById('competitor-modal-overlay');

    document.getElementById('open-competitor-btn').addEventListener('click', () => {
        competitorOverlay.style.display = 'flex';
    });
    document.getElementById('close-competitor-modal').addEventListener('click', () => {
        competitorOverlay.style.display = 'none';
    });
    competitorOverlay.addEventListener('click', (e) => {
        if (e.target === competitorOverlay) competitorOverlay.style.display = 'none';
    });

    document.getElementById('run-competitor-btn').addEventListener('click', async () => {
        const myUrl = document.getElementById('competitor-my-url').value.trim();
        const competitorUrl = document.getElementById('competitor-url').value.trim();
        const resultBox = document.getElementById('competitor-result');
        const btn = document.getElementById('run-competitor-btn');

        if (!myUrl || !competitorUrl) {
            alert('اكتب رابط موقعك ورابط المنافس الاتنين');
            return;
        }

        btn.disabled = true;
        btn.textContent = 'بنقارن...';
        resultBox.style.display = 'none';

        try {
            const res = await fetch('/api/compare-competitor', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ myUrl, competitorUrl, email: currentUser.email })
            });
            const data = await res.json();

            if (!res.ok || data.error) {
                alert(data.error || 'حصل خطأ');
                return;
            }

            renderCompetitorResult(data);
            resultBox.style.display = 'block';
        } catch (err) {
            alert('تعذّر إجراء المقارنة: ' + err.message);
        } finally {
            btn.disabled = false;
            btn.textContent = 'قارن الآن';
        }
    });

    function renderCompetitorResult(data) {
        const resultBox = document.getElementById('competitor-result');
        const rows = [
            { label: 'الأداء', mine: data.mySite.performance, theirs: data.competitorSite.performance },
            { label: 'SEO', mine: data.mySite.seoScore, theirs: data.competitorSite.seoScore },
            { label: 'الأمان', mine: data.mySite.securityScore, theirs: data.competitorSite.securityScore },
            { label: 'عدد الكلمات', mine: data.mySite.wordCount, theirs: data.competitorSite.wordCount }
        ];

        const rowsHtml = rows.map(r => {
            const mineWins = (r.mine ?? 0) >= (r.theirs ?? 0);
            return `
                <div class="competitor-row">
                    <span class="competitor-row-label">${r.label}</span>
                    <span class="competitor-row-value ${mineWins ? 'win' : 'lose'}">${r.mine ?? '—'}</span>
                    <span class="competitor-row-vs">مقابل</span>
                    <span class="competitor-row-value">${r.theirs ?? '—'}</span>
                </div>
            `;
        }).join('');

        const tipsHtml = (data.comparison?.tips || []).map(t => `
            <li><strong>${t.area}:</strong> ${t.advice}</li>
        `).join('');

        resultBox.innerHTML = `
            <div class="competitor-rows">${rowsHtml}</div>
            <p class="competitor-summary">${data.comparison?.summary || ''}</p>
            <ul class="competitor-tips">${tipsHtml}</ul>
        `;
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const url = document.getElementById('analyze-url').value.trim();
        if (!url) return;

        const btn = document.getElementById('analyze-btn');
        const loading = document.getElementById('analyze-loading');
        const results = document.getElementById('analyze-results');
        const user = getCurrentUser();

        const deepScan = document.getElementById('deep-scan-checkbox')?.checked || false;
        const extraUrls = (document.getElementById('extra-urls')?.value || '')
            .split('\n')
            .map(u => u.trim())
            .filter(Boolean);

        btn.disabled = true;
        loading.style.display = 'flex';
        results.style.display = 'none';
        startLoadingSteps();

        try {
            const res = await fetch('/api/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, email: user?.email || null, deepScan, extraUrls })
            });

            const data = await res.json();

            if (!res.ok || data.error) {
                alert(data.error || 'حصل خطأ أثناء الفحص');
                return;
            }

            lastReport = data;
            renderResults(data);
            results.style.display = 'block';

        } catch (err) {
            console.error(err);
            alert('حدث خطأ أثناء الاتصال بالسيرفر');
        } finally {
            btn.disabled = false;
            loading.style.display = 'none';
            stopLoadingSteps();
        }
    });

    setupDriveConnection();
    setupCopyButtons();
    setupFixesFilter();
    setupDeviceTabs();
    setupPrintButton();
});

const SEVERITY_LABELS = {
    critical: 'حرجة',
    high: 'مهمة',
    medium: 'بسيطة'
};

let currentFixes = [];
let activeFilter = 'all';

function renderResults(data) {
    renderDevicePanel('mobile', data.mobile, data.safety);
    renderDevicePanel('desktop', data.desktop, data.safety);

    currentFixes = data.aiRecommendations?.fixes || [];
    renderFixes();
    renderSummaryStrip();
    renderKeyIndicator(data.aiRecommendations?.keyUsed);
    renderComparisonBadge(data.comparison, data.fromCache);
    renderCruxCard(data.realUserData);
    renderSeoDetails(data.seo);
    renderGeoDetails(data.geo);
    renderDeepScanResults(data.deepScan);
    loadAndRenderTrendChart(data.url);

    document.getElementById('result-meta').textContent =
        data.aiRecommendations?.suggestedMetaDescription || 'لا توجد توصية';

    document.getElementById('result-schema').textContent =
        data.aiRecommendations?.schemaMarkup || 'لا يوجد كود مقترح';
}

// ============================================================
// كارت نتائج الفحص العميق — شفافية كاملة: بيعرض كل حاجة اتفحصت
// حتى لو كانت النتيجة "نضيفة" (مش بس المشاكل اللي طلعت)
// ============================================================
function renderDeepScanResults(deepScan) {
    const card = document.getElementById('deep-scan-results-card');
    const grid = document.getElementById('deep-scan-results-grid');
    if (!card || !grid) return;

    if (!deepScan || !deepScan.ran) {
        card.style.display = 'none';
        return;
    }

    const items = deepScan.checks.map(check => {
        const status = check.clean ? 'ok' : 'bad';
        const icon = check.clean ? '✅' : '🚨';
        const value = check.clean
            ? `اتفحص (${check.checkedCount} عنصر) — نضيف، مفيش مشاكل`
            : `⚠️ لقينا ${check.foundCount} مشكلة — شوف "الحلول المقترحة" تحت للتفاصيل`;
        return `
            <div class="seo-item seo-item--${status}">
                <span class="seo-item-icon">${icon}</span>
                <span class="seo-item-label">${check.label}</span>
                <span class="seo-item-value">${value}</span>
            </div>
        `;
    });

    grid.innerHTML = items.join('');
    card.style.display = 'block';
}

// ============================================================
// رسم بياني بسيط (SVG خام، بدون مكتبات) لتطور الأداء والـ SEO عبر آخر 20 فحص لنفس الرابط
// ============================================================
async function loadAndRenderTrendChart(url) {
    const card = document.getElementById('trend-chart-card');
    const container = document.getElementById('trend-chart-container');
    if (!card || !container) return;

    const currentUser = getCurrentUser();
    if (!currentUser?.is_pro) { card.style.display = 'none'; return; }

    try {
        const res = await fetch('/api/scan-trend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, email: currentUser.email })
        });
        const data = await res.json();
        const history = data.history || [];

        if (history.length < 2) {
            card.style.display = 'none'; // مفيش فايدة من رسم بياني بنقطة واحدة أو صفر
            return;
        }

        container.innerHTML = buildTrendSvg(history);
        card.style.display = 'block';
    } catch (err) {
        console.error('تعذّر تحميل تاريخ الفحوصات:', err);
        card.style.display = 'none';
    }
}

function buildTrendSvg(history) {
    const width = 640, height = 220, padding = 36;
    const maxScore = 100;
    const stepX = (width - padding * 2) / (history.length - 1);

    const toY = (score) => height - padding - ((score || 0) / maxScore) * (height - padding * 2);
    const toX = (i) => padding + i * stepX;

    const perfPoints = history.map((h, i) => `${toX(i)},${toY(h.performance_score)}`).join(' ');
    const seoPoints = history.map((h, i) => `${toX(i)},${toY(h.seo_score)}`).join(' ');

    const dateLabel = (ts) => {
        const d = new Date(ts);
        return `${d.getMonth() + 1}/${d.getDate()}`;
    };

    const firstLabel = dateLabel(history[0].checked_at);
    const lastLabel = dateLabel(history[history.length - 1].checked_at);

    return `
        <svg viewBox="0 0 ${width} ${height}" class="trend-chart-svg" xmlns="http://www.w3.org/2000/svg">
            <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#e5e7eb" stroke-width="1"/>
            <line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}" stroke="#e5e7eb" stroke-width="1"/>
            <polyline points="${perfPoints}" fill="none" stroke="#7C3AED" stroke-width="2.5"/>
            <polyline points="${seoPoints}" fill="none" stroke="#10b981" stroke-width="2.5"/>
            <text x="${padding}" y="${height - 10}" font-size="11" fill="#6b7280">${firstLabel}</text>
            <text x="${width - padding - 20}" y="${height - 10}" font-size="11" fill="#6b7280">${lastLabel}</text>
        </svg>
        <div class="trend-chart-legend">
            <span><span class="legend-dot" style="background:#7C3AED"></span> الأداء</span>
            <span><span class="legend-dot" style="background:#10b981"></span> SEO</span>
        </div>
    `;
}

// ============================================================
// كارت تفاصيل SEO
// ============================================================
function renderSeoDetails(seo) {
    const card = document.getElementById('seo-details-card');
    const grid = document.getElementById('seo-details-grid');
    if (!card || !grid) return;

    if (!seo) {
        card.style.display = 'none';
        return;
    }

    const items = [];

    items.push(seoItem(
        seo.title ? 'ok' : 'bad',
        'عنوان الصفحة (Title)',
        seo.title ? `"${seo.title}" (${seo.titleLength} حرف)` : 'مفقود تماماً'
    ));

    items.push(seoItem(
        seo.hasNoindex ? 'bad' : (seo.metaDescription ? 'ok' : 'warn'),
        'وصف Meta',
        seo.metaDescription ? `${seo.metaDescriptionLength} حرف` : 'مفقود'
    ));

    if (seo.hasNoindex) {
        items.push(seoItem('bad', 'noindex ⚠️', 'الصفحة دي متعلّم عليها بمنع الظهور في نتائج البحث نهائياً!'));
    }

    items.push(seoItem(
        seo.h1Count === 1 ? 'ok' : 'warn',
        'عناوين H1',
        `${seo.h1Count} عنوان` + (seo.h1Count === 0 ? ' (لازم يكون فيه واحد بالظبط)' : seo.h1Count > 1 ? ' (المفروض واحد بس)' : '')
    ));

    items.push(seoItem(
        seo.imagesWithoutAlt === 0 ? 'ok' : 'warn',
        'صور بدون alt',
        `${seo.imagesWithoutAlt} من ${seo.totalImages} صورة`
    ));

    items.push(seoItem(seo.hasCanonical ? 'ok' : 'warn', 'Canonical Link', seo.hasCanonical ? 'موجود' : 'مفقود'));
    items.push(seoItem(seo.hasSchema ? 'ok' : 'warn', 'Schema Markup', seo.hasSchema ? 'موجود' : 'مفقود'));
    items.push(seoItem(seo.hasViewport ? 'ok' : 'bad', 'Viewport Meta', seo.hasViewport ? 'موجود' : 'مفقود'));
    items.push(seoItem(seo.hasFavicon ? 'ok' : 'warn', 'Favicon', seo.hasFavicon ? 'موجود' : 'مفقود'));

    const ogCount = [seo.openGraph?.title, seo.openGraph?.description, seo.openGraph?.image].filter(Boolean).length;
    items.push(seoItem(ogCount === 3 ? 'ok' : 'warn', 'Open Graph (مشاركة السوشيال)', `${ogCount}/3 وسوم موجودة`));

    items.push(seoItem('info', 'عدد الكلمات', `${seo.wordCount} كلمة تقريباً`));
    items.push(seoItem('info', 'الروابط', `${seo.internalLinks} داخلي / ${seo.externalLinks} خارجي`));

    grid.innerHTML = items.join('');
    card.style.display = 'block';
}

// ============================================================
// كارت GEO
// ============================================================
function renderGeoDetails(geo) {
    const card = document.getElementById('geo-card');
    const grid = document.getElementById('geo-details-grid');
    if (!card || !grid) return;

    if (!geo) {
        card.style.display = 'none';
        return;
    }

    const items = [];
    items.push(seoItem(geo.hasLlmsTxt ? 'ok' : 'warn', 'ملف llms.txt', geo.hasLlmsTxt ? 'موجود' : 'مفقود'));
    items.push(seoItem(geo.hasRobotsTxt ? 'ok' : 'warn', 'ملف robots.txt', geo.hasRobotsTxt ? 'موجود' : 'مفقود'));

    if (geo.aiCrawlersBlocked?.length > 0) {
        items.push(seoItem('bad', 'بوتات AI ممنوعة', geo.aiCrawlersBlocked.join(', ')));
    } else {
        items.push(seoItem('ok', 'بوتات AI', 'مفيش أي بوت ذكاء اصطناعي ممنوع'));
    }

    grid.innerHTML = items.join('');
    card.style.display = 'block';
}

function seoItem(status, label, value) {
    const icon = status === 'ok' ? '✅' : status === 'bad' ? '❌' : status === 'warn' ? '⚠️' : 'ℹ️';
    return `
        <div class="seo-item seo-item--${status}">
            <span class="seo-item-icon">${icon}</span>
            <span class="seo-item-label">${label}</span>
            <span class="seo-item-value">${value}</span>
        </div>
    `;
}

// ============================================================
// كارت مقارنة "قبل وبعد" مع آخر فحص سابق
// ============================================================
function renderComparisonBadge(comparison, fromCache) {
    const badge = document.getElementById('comparison-badge');
    if (!badge) return;

    if (fromCache) {
        badge.style.display = 'inline-flex';
        badge.className = 'comparison-badge comparison-badge--cache';
        badge.textContent = '⚡ نتيجة من الكاش (اتفحص قبل كده خلال آخر ساعة)';
        return;
    }

    if (!comparison || comparison.performanceDelta == null) {
        badge.style.display = 'none';
        return;
    }

    const delta = comparison.performanceDelta;
    const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
    const cls = delta > 0 ? 'comparison-badge--up' : delta < 0 ? 'comparison-badge--down' : 'comparison-badge--same';

    badge.style.display = 'inline-flex';
    badge.className = `comparison-badge ${cls}`;
    badge.textContent = delta === 0
        ? 'الأداء زي آخر فحص بالظبط'
        : `${arrow} الأداء ${delta > 0 ? 'تحسّن' : 'قلّ'} ${Math.abs(delta)} نقطة منذ آخر فحص`;
}

// ============================================================
// كارت بيانات المستخدمين الحقيقيين (Chrome UX Report)
// ============================================================
function renderCruxCard(realUserData) {
    const card = document.getElementById('crux-card');
    const metricsContainer = document.getElementById('crux-metrics');
    const note = document.getElementById('crux-note');

    if (!realUserData) {
        card.style.display = 'none';
        return;
    }

    const metricLabels = {
        largestContentfulPaint: { label: 'سرعة ظهور المحتوى', unit: 'ms' },
        cumulativeLayoutShift: { label: 'ثبات التصميم', unit: '' },
        interactionToNextPaint: { label: 'سرعة الاستجابة', unit: 'ms' },
        timeToFirstByte: { label: 'سرعة استجابة السيرفر', unit: 'ms' }
    };

    const chips = Object.entries(metricLabels)
        .filter(([key]) => realUserData[key])
        .map(([key, info]) => {
            const metric = realUserData[key];
            const colorClass = metric.goodPercent >= 75 ? 'crux-chip--good'
                : metric.goodPercent >= 50 ? 'crux-chip--mid'
                : 'crux-chip--bad';
            return `
                <div class="crux-chip ${colorClass}">
                    <span class="crux-chip-value">${metric.goodPercent}%</span>
                    <span class="crux-chip-label">${info.label}</span>
                </div>
            `;
        }).join('');

    if (!chips) {
        card.style.display = 'none';
        return;
    }

    metricsContainer.innerHTML = chips;
    note.textContent = realUserData.level === 'page'
        ? 'بيانات دقيقة لنفس الصفحة (آخر 28 يوم)'
        : 'بيانات عامة لكل الموقع (الصفحة لسه مفيهاش زيارات كافية لبيانات دقيقة)';

    card.style.display = 'block';
}

function setupPrintButton() {
    const btn = document.getElementById('print-report-btn');
    if (!btn) return;
    btn.addEventListener('click', () => window.print());
}

// ============================================================
// تابات الموبايل/الديسكتوب: دوائر النتائج + الصورة الفعلية
// ============================================================
function renderDevicePanel(device, deviceData, safety) {
    const gaugesContainer = document.getElementById(`score-gauges-${device}`);
    const screenshotEl = document.getElementById(`screenshot-${device}`);

    const gauges = [
        { label: 'الأداء', value: deviceData?.performanceScore ?? null },
        { label: 'الأرشفة (SEO)', value: deviceData?.seoScore ?? null },
        { label: 'إمكانية الوصول', value: deviceData?.accessibilityScore ?? null },
        {
            label: 'الأمان',
            value: safety ? safety.score : null,
            customText: safety && !safety.isSafe ? 'يوجد تهديد' : null
        }
    ];

    gaugesContainer.innerHTML = gauges.map(g => buildGaugeSVG(g.label, g.value, g.customText)).join('');

    if (deviceData?.screenshot) {
        screenshotEl.src = deviceData.screenshot;
        screenshotEl.style.display = 'block';
    } else {
        screenshotEl.style.display = 'none';
    }
}

function setupDeviceTabs() {
    const tabsBar = document.getElementById('device-tabs');
    if (!tabsBar) return;

    tabsBar.addEventListener('click', (e) => {
        const btn = e.target.closest('.device-tab');
        if (!btn) return;

        const device = btn.getAttribute('data-device');

        tabsBar.querySelectorAll('.device-tab').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');

        document.getElementById('device-panel-mobile').style.display = device === 'mobile' ? 'block' : 'none';
        document.getElementById('device-panel-desktop').style.display = device === 'desktop' ? 'block' : 'none';
    });
}

// ============================================================
// دائرة تقدّم واحدة (SVG)
// ============================================================
function buildGaugeSVG(label, value, customText) {
    const radius = 42;
    const circumference = 2 * Math.PI * radius;
    const safeValue = value ?? 0;
    const offset = circumference * (1 - safeValue / 100);
    const colorClass = value === null ? 'gauge-unknown'
        : value >= 90 ? 'gauge-good'
        : value >= 50 ? 'gauge-mid'
        : 'gauge-bad';

    return `
        <div class="gauge-item">
            <div class="gauge-circle-wrap">
                <svg viewBox="0 0 100 100" class="gauge-svg ${colorClass}">
                    <circle cx="50" cy="50" r="${radius}" class="gauge-track" />
                    <circle cx="50" cy="50" r="${radius}" class="gauge-progress"
                        stroke-dasharray="${circumference}"
                        stroke-dashoffset="${offset}" />
                </svg>
                <div class="gauge-value">${customText || (value != null ? value : '—')}</div>
            </div>
            <div class="gauge-label">${label}</div>
        </div>
    `;
}

// ============================================================
// مؤشر رقم مفتاح Gemini المستخدم (بسيط وغير ملحوظ)
// ============================================================
function renderKeyIndicator(keyUsed) {
    const el = document.getElementById('key-indicator');
    if (!el) return;
    el.textContent = keyUsed ? `#${keyUsed}` : '';
}

// ============================================================
// شريط الملخص العلوي
// ============================================================
function renderSummaryStrip() {
    const strip = document.getElementById('report-summary-strip');
    const counts = { critical: 0, high: 0, medium: 0 };

    currentFixes.forEach(f => {
        const sev = f.severity && counts.hasOwnProperty(f.severity) ? f.severity : 'medium';
        counts[sev]++;
    });

    if (currentFixes.length === 0) {
        strip.innerHTML = `<div class="summary-pill summary-pill--good">✓ الموقع في حالة ممتازة، مفيش مشاكل كبيرة</div>`;
        return;
    }

    strip.innerHTML = `
        ${counts.critical > 0 ? `<div class="summary-pill summary-pill--critical">${counts.critical} مشكلة حرجة</div>` : ''}
        ${counts.high > 0 ? `<div class="summary-pill summary-pill--high">${counts.high} مشكلة مهمة</div>` : ''}
        ${counts.medium > 0 ? `<div class="summary-pill summary-pill--medium">${counts.medium} ملاحظة بسيطة</div>` : ''}
    `;
}

// ============================================================
// كروت الحلول (المشكلة فوق، الحل كخطوات مرقّمة تحتها)
// ============================================================
function renderFixes() {
    const container = document.getElementById('result-fixes');
    const countLabel = document.getElementById('fixes-count');
    const keyIndicatorEl = document.getElementById('key-indicator');
    const keyIndicatorHtml = keyIndicatorEl ? keyIndicatorEl.outerHTML : '';

    const visibleFixes = activeFilter === 'all'
        ? currentFixes
        : currentFixes.filter(f => (f.severity || 'medium') === activeFilter);

    countLabel.innerHTML = currentFixes.length > 0
        ? `الحلول المقترحة (${currentFixes.length}) ${keyIndicatorHtml}`
        : `الحلول المقترحة ${keyIndicatorHtml}`;

    if (currentFixes.length === 0) {
        container.innerHTML = '<p class="fixes-empty">مفيش مشاكل كبيرة، الموقع في حالة كويسة 👍</p>';
        return;
    }

    if (visibleFixes.length === 0) {
        container.innerHTML = '<p class="fixes-empty">مفيش مشاكل في التصنيف ده</p>';
        return;
    }

    container.innerHTML = visibleFixes.map((fix, index) => {
        const codeBlockId = `fix-code-${index}`;
        const severity = fix.severity && SEVERITY_LABELS[fix.severity] ? fix.severity : 'medium';
        const steps = Array.isArray(fix.steps) ? fix.steps : (fix.instructions ? [fix.instructions] : []);

        return `
            <div class="fix-card fix-card--${severity}">
                <div class="fix-severity-bar"></div>
                <div class="fix-card-body">
                    <div class="fix-card-header">
                        <span class="fix-severity-badge fix-severity-badge--${severity}">${SEVERITY_LABELS[severity]}</span>
                        ${fix.impact ? `<span class="fix-impact">${escapeHtml(fix.impact)}</span>` : ''}
                    </div>

                    <div class="fix-section">
                        <span class="fix-section-label">المشكلة</span>
                        <h4 class="fix-title">${escapeHtml(fix.title || 'مشكلة')}</h4>
                    </div>

                    <div class="fix-section">
                        <span class="fix-section-label fix-section-label--solution">الحل المقترح</span>
                        <ol class="fix-steps">
                            ${steps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}
                        </ol>
                    </div>

                    ${fix.codeExample ? `
                        <div class="fix-code-wrap">
                            <button class="copy-btn" data-copy-target="${codeBlockId}">نسخ الكود</button>
                            <pre id="${codeBlockId}" class="result-code result-code--block">${escapeHtml(fix.codeExample)}</pre>
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    }).join('');

    setupCopyButtons();
}

function setupFixesFilter() {
    const filterBar = document.getElementById('fixes-filter');
    if (!filterBar) return;

    filterBar.addEventListener('click', (e) => {
        const btn = e.target.closest('.filter-chip');
        if (!btn) return;

        filterBar.querySelectorAll('.filter-chip').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        activeFilter = btn.getAttribute('data-filter');
        renderFixes();
    });
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ============================================================
// نسخ الأكواد بضغطة زرار
// ============================================================
function setupCopyButtons() {
    document.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.getAttribute('data-copy-target');
            const text = document.getElementById(targetId).textContent;
            navigator.clipboard.writeText(text).then(() => {
                const original = btn.textContent;
                btn.textContent = 'تم النسخ ✓';
                setTimeout(() => { btn.textContent = original; }, 1500);
            });
        });
    });
}

// ============================================================
// ربط Drive + الحفظ
// ============================================================
function setupDriveConnection() {
    const connectBtn = document.getElementById('connect-drive-btn');
    const saveBtn = document.getElementById('save-report-btn');

    const isDriveConnected = localStorage.getItem('driveConnected') === 'true';
    toggleDriveUI(isDriveConnected);

    if (connectBtn) {
        connectBtn.addEventListener('click', () => {
            const user = getCurrentUser();
            if (!user || !user.email) {
                alert('لازم تسجل دخول الأول');
                window.location.href = 'login.html';
                return;
            }

            if (typeof google === 'undefined' || !google.accounts?.oauth2) {
                alert('مكتبة جوجل لسه بتحمّل، حاول تاني بعد ثانية');
                return;
            }

            driveCodeClient = google.accounts.oauth2.initCodeClient({
                client_id: GOOGLE_CLIENT_ID,
                scope: DRIVE_SCOPES,
                ux_mode: 'popup',
                callback: async (response) => {
                    if (!response.code) {
                        alert('لم تتم الموافقة على ربط Drive');
                        return;
                    }
                    await sendCodeToServer(response.code, user.email);
                }
            });

            driveCodeClient.requestCode();
        });
    }

    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            const user = getCurrentUser();
            if (!user || !lastReport) return;

            saveBtn.disabled = true;
            saveBtn.textContent = 'جاري الحفظ...';

            try {
                const res = await fetch('/api/save-report', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: user.email, report: lastReport })
                });

                const data = await res.json();

                if (!res.ok || data.error) {
                    alert(data.error || 'فشل حفظ النتيجة');
                    return;
                }

                const link = document.getElementById('sheet-link');
                link.href = data.reportUrl;
                link.style.display = 'inline-block';
                alert('تم الحفظ بنجاح!');

            } catch (err) {
                console.error(err);
                alert('حدث خطأ أثناء الحفظ');
            } finally {
                saveBtn.disabled = false;
                saveBtn.textContent = 'احفظ النتيجة في Drive';
            }
        });
    }
}

async function sendCodeToServer(code, email) {
    try {
        const res = await fetch('/api/connect-drive', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, email, redirectUri: 'postmessage' })
        });

        const data = await res.json();

        if (!res.ok || data.error) {
            alert(data.error || 'فشل ربط Drive');
            return;
        }

        localStorage.setItem('driveConnected', 'true');
        toggleDriveUI(true);
        alert('تم ربط Drive بنجاح!');

    } catch (err) {
        console.error(err);
        alert('حدث خطأ أثناء ربط Drive');
    }
}

function toggleDriveUI(connected) {
    const notConnected = document.getElementById('drive-not-connected');
    const connectedBox = document.getElementById('drive-connected');
    if (!notConnected || !connectedBox) return;

    notConnected.style.display = connected ? 'none' : 'block';
    connectedBox.style.display = connected ? 'block' : 'none';
}
