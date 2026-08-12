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
        return; // منوقفش أي Listeners تانية، الأداة كلها متعطلة لغير المسجلين
    }

    // مشترك Pro؟ نعرضله نافذة تحويل للنسخة المحسّنة على طول
    if (currentUser.is_pro) {
        showProRedirectModal();
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const url = document.getElementById('analyze-url').value.trim();
        if (!url) return;

        const btn = document.getElementById('analyze-btn');
        const loading = document.getElementById('analyze-loading');
        const results = document.getElementById('analyze-results');
        const user = getCurrentUser();

        btn.disabled = true;
        loading.style.display = 'flex';
        results.style.display = 'none';
        startLoadingSteps();

        try {
            const res = await fetch('/api/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, email: user?.email || null })
            });

            const data = await res.json();

            if (!res.ok || data.error) {
                if (res.status === 429) {
                    alert(data.error || 'وصلت للحد الأقصى من الفحوصات اليوم (3 فحوصات). حاول تاني بكرة.');
                } else {
                    alert(data.error || 'حصل خطأ أثناء الفحص');
                }
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

    document.getElementById('result-meta').textContent =
        data.aiRecommendations?.suggestedMetaDescription || 'لا توجد توصية';

    document.getElementById('result-schema').textContent =
        data.aiRecommendations?.schemaMarkup || 'لا يوجد كود مقترح';
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

// ============================================================
// نافذة تحويل مشتركي Pro للنسخة المحسّنة (تظهر تلقائي كل ما يدخلوا النسخة المجانية)
// ============================================================
function showProRedirectModal() {
    const overlay = document.createElement('div');
    overlay.className = 'pro-modal-overlay';
    overlay.innerHTML = `
        <div class="pro-modal-box">
            <h3>🎉 إنت مشترك في النسخة المحسّنة</h3>
            <p>عندك فحوصات غير محدودة وميزات أمان إضافية في محلل المواقع Pro.</p>
            <div class="pro-modal-actions">
                <button type="button" id="pro-modal-go" class="btn-primary">روح للنسخة المحسّنة</button>
                <button type="button" id="pro-modal-stay" class="btn-secondary">استمر هنا (النسخة العادية)</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('pro-modal-go').addEventListener('click', () => {
        window.location.href = '/site-analyzer-honorable.html';
    });
    document.getElementById('pro-modal-stay').addEventListener('click', () => {
        overlay.remove();
    });
}
