document.addEventListener('DOMContentLoaded', () => {

    // ==========================================================================
    // 0. كشف المتصفحات المدمجة (فيسبوك/إنستجرام/ماسنجر/تيك توك) — جوجل بتمنع
    //    تسجيل الدخول منها عمدًا، فبنوضح للمستخدم السبب الحقيقي بدل رسالة غامضة
    // ==========================================================================
    detectInAppBrowserAndWarn();

    // ==========================================================================
    // 1. معالجة تسجيل الدخول العادي (Email & Password)
    // ==========================================================================
    const loginForm = document.getElementById('login-form');

    if (loginForm) {
        loginForm.addEventListener('submit', async (event) => {
            event.preventDefault();

            const email = document.getElementById('email').value.trim();
            const password = document.getElementById('password').value.trim();

            try {
                // إرسال الطلب للـ API في Cloudflare
                const response = await fetch('/api/auth', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'login',
                        email: email,
                        password: password
                    })
                });

                const result = await response.json();

                if (response.ok && result.success) {
                    // حفظ بيانات المستخدم في المتصفح
                    localStorage.setItem('user', JSON.stringify(result.user));
                    alert('تم تسجيل الدخول بنجاح!');
                    window.location.href = 'index.html';
                } else {
                    alert(result.error || 'فشل تسجيل الدخول، تحقق من البيانات.');
                }
            } catch (err) {
                console.error(err);
                alert('حدث خطأ أثناء الاتصال بالسيرفر.');
            }
        });
    }

    // ==========================================================================
    // 2. معالجة إنشاء حساب جديد (الاسم + الإيميل + الباسورد)
    // ==========================================================================
    const registerForm = document.getElementById('register-form');

    if (registerForm) {
        registerForm.addEventListener('submit', async (event) => {
            event.preventDefault();

            const name = document.getElementById('reg-name').value.trim();
            const email = document.getElementById('reg-email').value.trim();
            const password = document.getElementById('reg-password').value;
            const confirmPassword = document.getElementById('reg-confirm-password').value;

            if (!name || !email || !password || !confirmPassword) {
                alert('من فضلك املأ كل الحقول');
                return;
            }

            if (password !== confirmPassword) {
                alert('كلمة المرور وتأكيدها مش متطابقين');
                return;
            }

            if (password.length < 6) {
                alert('كلمة المرور لازم تكون 6 حروف على الأقل');
                return;
            }

            const submitBtn = document.getElementById('register-submit-btn');
            const originalText = submitBtn.textContent;
            submitBtn.disabled = true;
            submitBtn.textContent = 'جاري إنشاء الحساب...';

            try {
                const response = await fetch('/api/auth', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'register', name, email, password })
                });

                const result = await response.json();

                if (response.ok && result.success) {
                    localStorage.setItem('user', JSON.stringify(result.user));
                    alert('تم إنشاء الحساب بنجاح!');
                    window.location.href = 'index.html';
                } else {
                    alert(result.error || 'فشل إنشاء الحساب، حاول مرة أخرى.');
                }
            } catch (err) {
                console.error(err);
                alert('حدث خطأ أثناء الاتصال بالسيرفر.');
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = originalText;
            }
        });
    }

});

// ==========================================================================
// 3. معالجة تسجيل الدخول عبر Google
// ملحوظة: مكتبة جوجل بترسم الزرار وتستدعي الدالة دي تلقائياً بنفسها
// عن طريق data-callback الموجودة في login.html (مفيش أي تعديل في الزرار نفسه)
// عشان كده لازم الدالة تفضل معرّفة على window، مش جوه أي Scope مقفول
// ==========================================================================
async function handleGoogleLogin(googleResponse) {
    if (!googleResponse || !googleResponse.credential) {
        // جوجل مبعتتش توكين خالص — الحالة النموذجية لما نكون جوه متصفح مدمج (فيسبوك/إنستجرام)
        alert('تسجيل الدخول بجوجل فشل. لو إنت جاي من رابط في فيسبوك أو إنستجرام، افتح الرابط في متصفح حقيقي (كروم/سفاري) من قائمة (⋮ أو ...) فوق، وجرب تاني.');
        return;
    }

    try {
        const response = await fetch('/api/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'google',
                googleToken: googleResponse.credential
            })
        });

        const result = await response.json();

        if (response.ok && result.success) {
            localStorage.setItem('user', JSON.stringify(result.user));
            alert(`أهلاً بك يا ${result.user.name || ''}! تم التسجيل وحفظ البيانات بنجاح.`);
            window.location.href = 'index.html';
        } else {
            alert(result.error || 'فشل الاتصال بقاعدة البيانات عبر جوجل.');
        }
    } catch (err) {
        console.error(err);
        alert('حدث خطأ أثناء معالجة حساب جوجل. لو إنت داخل من رابط في فيسبوك/إنستجرام، افتح الرابط في متصفح حقيقي وجرب تاني.');
    }
}

window.handleGoogleLogin = handleGoogleLogin;

// ============================================================
// كشف المتصفحات المدمجة (In-App Browsers) وعرض تحذير واضح
// جوجل بتمنع Sign-In من جواها عمدًا، فبنوضح السبب بدل ما نسيب
// المستخدم يشوف رسالة "خطأ في السيرفر" غامضة ومربكة
// ============================================================
function detectInAppBrowserAndWarn() {
    const ua = navigator.userAgent || '';
    const isInAppBrowser = /FBAN|FBAV|Instagram|Line\/|MicroMessenger|TikTok/i.test(ua);
    if (!isInAppBrowser) return;

    const banner = document.createElement('div');
    banner.className = 'inapp-browser-warning';
    banner.innerHTML = `
        ⚠️ إنت داخل من متصفح مدمج (فيسبوك/إنستجرام/تيك توك)، وتسجيل الدخول بجوجل ممنوع منه لأسباب أمنية بتاعة جوجل نفسها.
        <br>افتح الرابط في متصفح حقيقي: دوس على (⋮ أو •••) فوق الشاشة واختار "فتح في المتصفح" (Open in Browser).
    `;
    document.body.insertBefore(banner, document.body.firstChild);
}

