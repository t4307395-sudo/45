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
let cooldownInterval = null;

// رابط Google Apps Script (Web App) بتاع نموذج الاشتراك في الباقة الاحترافية
// (لازم تستبدله بالرابط اللي هيطلع لك بعد نشر السكربت — الخطوات في ملف subscribe.gs)
const SUBSCRIBE_SCRIPT_URL = 'ضع رابط Apps Script Web App هنا';

// ============================================================
// عداد فترة الانتظار (7 دقايق بين كل فحص والتاني)
// ============================================================
function startCooldown(untilTimestamp) {
    const btn = document.getElementById('analyze-btn');
    const timerEl = document.getElementById('cooldown-timer');
    if (!btn || !timerEl) return;

    localStorage.setItem('nextScanAllowedAt', String(untilTimestamp));
    if (cooldownInterval) clearInterval(cooldownInterval);

    function tick() {
        const remaining = untilTimestamp - Date.now();
        if (remaining <= 0) {
            clearInterval(cooldownInterval);
            cooldownInterval = null;
            btn.disabled = false;
            btn.textContent = 'ابدأ الفحص';
            timerEl.textContent = '';
            localStorage.removeItem('nextScanAllowedAt');
            return;
        }
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000).toString().padStart(2, '0');
        btn.disabled = true;
        btn.textContent = 'ابدأ الفحص';
        timerEl.textContent = `⏳ استنى ${mins}:${secs}`;
    }

    tick();
    cooldownInterval = setInterval(tick, 1000);
}

function checkExistingCooldown() {
    const saved = localStorage.getItem('nextScanAllowedAt');
    if (!saved) return;
    const ts = Number(saved);
    if (ts > Date.now()) {
        startCooldown(ts);
    } else {
        localStorage.removeItem('nextScanAllowedAt');
    }
}

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

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (cooldownInterval) return; // فترة الانتظار لسه شغالة

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
                    if (data.reason === 'daily') {
                        showProLimitModal();
                    } else {
                        alert(data.error || 'وصلت للحد الأقصى من الفحوصات اليوم (3 فحوصات). حاول تاني بكرة.');
                    }
                    if (data.reason === 'cooldown' && data.retryAfterSeconds) {
                        startCooldown(Date.now() + data.retryAfterSeconds * 1000);
                    }
                } else {
                    alert(data.error || 'حصل خطأ أثناء الفحص');
                }
                return;
            }

            lastReport = data;
            renderResults(data);
            results.style.display = 'block';

            const proCard = document.getElementById('pro-plan-card');
            if (proCard) proCard.style.display = 'block';

            // ابدأ عدّاد الانتظار (7 دقايق) لغاية الفحص الجاي
            if (data.nextAllowedAt) {
                startCooldown(data.nextAllowedAt);
            }

        } catch (err) {
            console.error(err);
            alert('حدث خطأ أثناء الاتصال بالسيرفر');
        } finally {
            if (!cooldownInterval) btn.disabled = false; // لو فيه عدّاد انتظار شغال، سيب الزرار متعطل
            loading.style.display = 'none';
            stopLoadingSteps();
        }
    });

    setupDriveConnection();
    setupCopyButtons();
    setupFixesFilter();
    setupDeviceTabs();
    setupPrintButton();
    checkExistingCooldown();
});

// ============================================================
// نموذج الاشتراك في الباقة الاحترافية (بيشتغل مع نسخة الكارت ونسخة النافذة المنبثقة)
// ============================================================
function wireProSubscribeForm(formId, emailId, btnId, msgId) {
    const form = document.getElementById(formId);
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const emailInput = document.getElementById(emailId);
        const btn = document.getElementById(btnId);
        const msg = document.getElementById(msgId);
        const email = emailInput.value.trim();
        if (!email) return;

        btn.disabled = true;
        btn.textContent = 'بنبعت طلبك...';

        try {
            await fetch('https://script.google.com/macros/s/AKfycbzLMErcPVyLilJOhkcUdM-Nz7M9eY86MnuEkpCXDImt-DQI11npTyvkUdw58p3N8BOB4A/exec', {
                method: 'POST',
                mode: 'no-cors', // Apps Script Web App بيرفض CORS العادي، ده طبيعي
                headers: { 'Content-Type': 'text/plain' },
                body: JSON.stringify({ email, source: 'site-analyzer', requestedAt: new Date().toISOString() })
            });
            msg.textContent = '✅ تم استلام طلبك! هيوصلك إيميل عليه خطوات تفعيل الباقة قريب.';
            msg.style.color = 'var(--success, #22c55e)';
            emailInput.value = '';
        } catch (err) {
            msg.textContent = '❌ حصل خطأ في إرسال الطلب، جرّب تاني.';
            msg.style.color = 'var(--danger, #ef4444)';
        } finally {
            btn.disabled = false;
            btn.textContent = 'اشترك الآن';
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    wireProSubscribeForm('pro-subscribe-form', 'pro-subscribe-email', 'pro-subscribe-btn', 'pro-subscribe-msg');
    wireProSubscribeForm('pro-subscribe-modal-form', 'pro-subscribe-modal-email', 'pro-subscribe-modal-btn', 'pro-subscribe-modal-msg');
});

// ============================================================
// النافذة المنبثقة اللي بتظهر لما المستخدم يخلّص فحوصاته المجانية اليومية
// ============================================================
function showProLimitModal() {
    const overlay = document.getElementById('pro-limit-modal-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function closeProLimitModal() {
    const overlay = document.getElementById('pro-limit-modal-overlay');
    if (overlay) overlay.style.display = 'none';
}

document.addEventListener('DOMContentLoaded', () => {
    const overlay = document.getElementById('pro-limit-modal-overlay');
    const closeBtn = document.getElementById('pro-limit-modal-close');
    if (!overlay) return;

    closeBtn?.addEventListener('click', closeProLimitModal);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeProLimitModal();
    });
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
    renderCrux(data.crux);

    currentFixes = data.aiRecommendations?.fixes || [];
    renderFixes();
    renderSummaryStrip();
    renderKeyIndicator(data.aiRecommendations?.keyUsed);
    renderComparisonBadge(data.comparison, data.fromCache);

    document.getElementById('result-meta').textContent =
        data.aiRecommendations?.suggestedMetaDescription || 'لا توجد توصية';

    document.getElementById('result-schema').textContent =
        data.aiRecommendations?.schemaMarkup || 'لا يوجد كود مقترح';
}

// ============================================================
// بيانات المستخدمين الحقيقية (CrUX) — أداء فعلي على أرض الواقع
// ============================================================
function renderCrux(crux) {
    const box = document.getElementById('crux-box');
    if (!box) return;

    if (!crux || !crux.available) {
        box.innerHTML = `<p class="crux-empty">📊 ${crux?.reason || 'مفيش بيانات مستخدمين حقيقيين كفاية للموقع ده لسه (محتاج حجم زيارات أكبر من Chrome).'}</p>`;
        return;
    }

    const metricLabel = (name, m, unit) => {
        if (!m || m.p75 == null) return '';
        return `
            <div class="crux-metric">
                <span class="crux-metric-name">${name}</span>
                <span class="crux-metric-value">${m.p75}${unit}</span>
                <div class="crux-bar">
                    <span style="width:${m.good ?? 0}%; background:#22c55e"></span>
                    <span style="width:${m.needsImprovement ?? 0}%; background:#f59e0b"></span>
                    <span style="width:${m.poor ?? 0}%; background:#ef4444"></span>
                </div>
            </div>`;
    };

    box.innerHTML = `
        <p class="crux-intro">📊 دي بيانات حقيقية من زوار الموقع الفعليين على Chrome (مش تقدير)، آخر 28 يوم:</p>
        <div class="crux-metrics">
            ${metricLabel('أكبر عنصر مرئي (LCP)', crux.largestContentfulPaint, 'ms')}
            ${metricLabel('استجابة التفاعل (INP)', crux.interactionToNextPaint, 'ms')}
            ${metricLabel('ثبات التصميم (CLS)', crux.cumulativeLayoutShift, '')}
            ${metricLabel('أول عرض للمحتوى (FCP)', crux.firstContentfulPaint, 'ms')}
        </div>`;
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
            value: safety ? (safety.isSafe ? 100 : 0) : null,
            customText: safety ? (safety.isSafe ? 'آمن' : 'يوجد تهديد') : null
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
                window.location.href = '/login.html';
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
