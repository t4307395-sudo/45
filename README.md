# سوبر ويب (Super Web)

لوحة أدوات ويب عربية، مبنية على **Cloudflare Pages + Pages Functions + D1**.

## اللي تم إصلاحه في المراجعة دي

- **الخطأ اللي كان بيوقف المشروع كله**: في `site-analyzer.js` كان فيه رابط Google Apps Script
  متكتوب جوه `fetch(...)` من غير علامات تنصيص (quotes)، وده خطأ صياغة (Syntax Error) في JavaScript.
  الخطأ ده كان بيمنع الملف بالكامل من التحميل، فأي حاجة في صفحة محلل المواقع (الفحص، الفلاتر،
  ربط Drive، الطباعة...) كانت واقفة. تم تصحيحه بإضافة علامات التنصيص حوالين الرابط.
- تمت مراجعة باقي كل ملفات JS (`app.js`, `script.js`, `tools-config.js`, وكل ملفات
  `functions/api/*.js`) والتأكد إنها خالية من أخطاء الصياغة، وكذلك مراجعة كل ملفات HTML
  للتأكد من تطابق الوسوم (tags) وربط الـ IDs بين HTML والـ JS بشكل صحيح.
- تمت إضافة صفحتين ناقصتين ضروريتين لأي موقع بيجمع بيانات مستخدمين (تسجيل دخول، فحوصات،
  ربط Drive): **`privacy.html`** (سياسة الخصوصية) و **`terms.html`** (الشروط والأحكام)،
  وتمت إضافتهم في تذييل كل الصفحات وفي `sitemap.xml`.
- تمت إضافة `schema.sql` (لم يكن موجوداً في المشروع الأصلي) يحتوي على كل جداول قاعدة
  بيانات D1 اللي الكود بيفترض وجودها، عشان تقدر تجهز القاعدة بضغطة واحدة قبل النشر.
- تمت إعادة هيكلة الأدوات: كل أداة بقى ليها مجلد خاص بيها جوه `tools/` (بدل ما تكون
  ملفاتها متفرقة في الجذر)، والكروت في الصفحة الرئيسية بقت بتظهر تلقائياً من الأدوات
  الموجودة فعلاً — مفيش تاني كروت وهمية مكتوب عليها "قريباً" لأدوات لسه مبنيتش. التفاصيل
  في قسم "إضافة أداة جديدة" تحت.

## إضافة أداة جديدة

كل أداة بقت مستقلة تماماً في مجلدها الخاص، وبتظهر تلقائياً في الشريط الجانبي وشبكة
الأدوات بالصفحة الرئيسية من غير ما تلمس أي كود مشترك. الخطوات:

1. اعمل مجلد جديد جوه `tools/` باسم الأداة، مثلاً `tools/translator/`.
2. حط جوه المجلد كل ملفات الأداة (صفحة `index.html`، ملفات JS/CSS الخاصة بيها لو فيه،
   إلخ). لو الأداة محتاجة تربط بـ `style.css` أو `app.js` أو `tools-config.js` المشتركين،
   اربطهم بمسار مطلق بيبدأ بـ `/` (زي `/style.css`) عشان يشتغلوا صح من جوه أي مجلد.
3. اعمل ملف `tool.json` جوه نفس المجلد بنفس شكل `tools/site-analyzer/tool.json`:
   ```json
   {
     "id": "translator",
     "name": "المترجم",
     "description": "وصف قصير يظهر تحت اسم الأداة في الكارت",
     "icon": "languages",
     "status": "active"
   }
   ```
   - `icon`: اسم أيقونة جاهزة موجودة في `app.js` (`scan`, `languages`, `presentation`,
     `video`, `clock`، إلخ)، أو اسم مش موجود فهيستخدم أيقونة افتراضية.
   - `status`: خليها `"active"` عشان الكارت يبقى قابل للفتح، أو `"coming-soon"` لو
     عايز تحط الأداة كـ"قريباً" لحد ما تخلصها (بدل ما تعمل كارت وهمي يدوي).
4. ضيف اسم المجلد في مصفوفة `TOOL_FOLDERS` في `tools-config.js` بالجذر.

وبس — الكارت هيظهر تلقائياً بالاسم والوصف والأيقونة من `tool.json` بتاعته.

## الإعداد قبل النشر

### 1. قاعدة بيانات D1

أنشئ قاعدة D1 من لوحة Cloudflare (Workers & Pages → D1)، وشغّل عليها `schema.sql`:

```bash
wrangler d1 execute <DB_NAME> --remote --file=schema.sql
```

بعدين اربطها بمشروع الـ Pages من **Settings → Functions → D1 database bindings**
باسم binding: **`DB`** (بالظبط بالاسم ده، لأنه المستخدم في الكود).

### 2. متغيرات البيئة (Environment Variables / Secrets)

من **Settings → Environment variables** في مشروع الـ Pages، ضيف:

| المتغير | الوصف |
|---|---|
| `EXT_TOKEN_MAIN` | مفتاح Google Cloud API واحد مفعّل عليه: PageSpeed Insights API, Safe Browsing API, Chrome UX Report API |
| `GEMINI_API_KEY` | مفتاح Gemini API الأساسي (من Google AI Studio) |
| `GEMINI_API_KEY2`, `GEMINI_API_KEY3`, ... | (اختياري) مفاتيح Gemini إضافية للتدوير التلقائي عند نفاذ الكوتة — الكود بيكتشفها تلقائياً بالترقيم |
| `GOOGLE_CLIENT_ID` | Client ID بتاع OAuth Client في Google Cloud Console (نفسه المستخدم في `login.html`/`register.html`/`tools/site-analyzer/site-analyzer.js`) |
| `GOOGLE_CLIENT_SECRET` | Client Secret بتاع نفس الـ OAuth Client (لازم يكون Web application، ومربوط بيه الدومين بتاعك في Authorized JavaScript origins) |

> ملحوظة: الـ Client ID موجود حالياً "hardcoded" في `login.html`, `register.html`,
> `forgot-password.html`, و `tools/site-analyzer/site-analyzer.js`. لو غيّرت الـ OAuth
> Client لاحقاً، لازم تحدّثه في الملفات الأربعة دي كمان.

### 3. نموذج الاشتراك في الباقة الاحترافية

في `tools/site-analyzer/site-analyzer.js` فيه رابط Google Apps Script Web App مكتوب مباشرة
(hardcoded) بيستقبل إيميلات المهتمين بالباقة الاحترافية. تأكد إنه لسه شغال ومنشور
(Deploy → Web app → Anyone)، أو استبدله برابط جديد لو عملت نسخة تانية من السكربت.

### 4. الدومين

استبدل `krack.pages.dev` في كل ملفات: `index.html`, `tools/site-analyzer/index.html`,
`privacy.html`, `terms.html`, `robots.txt`, و `sitemap.xml` بالدومين الفعلي لو هتنشر
على دومين مخصص.

## النشر

المشروع جاهز للنشر مباشرة على **Cloudflare Pages** (مجلد الجذر يحتوي على الملفات الثابتة،
ومجلد `functions/` بيتحوّل تلقائياً لـ Pages Functions). مفيش خطوة build، ارفع المجلد زي
ما هو أو اربطه بمستودع Git.
