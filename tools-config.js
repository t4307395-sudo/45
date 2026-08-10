/**
 * ============================================================================
 * سجل الأدوات (Tools Registry) — سوبر ويب
 * ============================================================================
 * كل أداة ليها مجلد خاص بيها جوه tools/ فيه كل ملفاتها (index.html, الأكواد،
 * وأي حاجة تانية محتاجاها الأداة)، بالإضافة لملف tool.json صغير فيه بيانات
 * الكارت (الاسم، الوصف، الأيقونة، الحالة).
 *
 * عشان تضيف أداة جديدة:
 *   1. اعمل مجلد جديد جوه tools/ باسم الأداة (مثلاً: tools/translator/)
 *   2. حط جوه المجلد كل ملفات الأداة، بما فيها index.html كصفحة رئيسية للأداة
 *   3. اعمل ملف tool.json جوه نفس المجلد بنفس شكل tools/site-analyzer/tool.json:
 *        {
 *          "id": "translator",
 *          "name": "المترجم",
 *          "description": "وصف قصير للأداة",
 *          "icon": "languages",   // اسم أيقونة موجودة في app.js، أو سيبها فاضية
 *          "status": "active"     // أو "coming-soon" لو لسه مش جاهزة
 *        }
 *   4. ضيف اسم المجلد في المصفوفة TOOL_FOLDERS تحت
 *
 * وبس — الكارت هيظهر تلقائياً في الشريط الجانبي وشبكة الأدوات بالصفحة
 * الرئيسية بالاسم والوصف والأيقونة اللي حطيتها في tool.json، من غير ما
 * تلمس أي كود تاني خالص.
 * ============================================================================
 */

const TOOL_FOLDERS = ['site-analyzer'];

/**
 * بيجيب بيانات كل أداة من ملف tool.json بتاعها، ويبني منها مصفوفة الأدوات
 * الكاملة (بما فيها مسار الصفحة route). بيستخدم مسار مطلق (يبدأ بـ /) عشان
 * يشتغل صح سواء اتنادى من الصفحة الرئيسية أو من جوه صفحة أداة تانية.
 */
async function loadTools() {
    const results = await Promise.all(TOOL_FOLDERS.map(async (folder) => {
        try {
            const res = await fetch(`/tools/${folder}/tool.json`);
            if (!res.ok) return null;
            const meta = await res.json();
            return { ...meta, route: `/tools/${folder}/index.html` };
        } catch {
            return null;
        }
    }));

    return results.filter(Boolean);
}

if (typeof window !== 'undefined') {
    window.loadTools = loadTools;
}
