# بنية Blazma AI

تطبيق Electron بطبقات معزولة، وخوادم محلية على `127.0.0.1` فقط: llama.cpp للمحادثة، وأدوات اختيارية تُنزَّل عند أول استخدام (الفهرسة والصوت والرسم وVS Code).

```
┌──────────────── العملية الرئيسية (Node) ────────────────┐
│ main.js      النافذة، البروتوكولات، دورة الحياة           │
│ ipc.js       كل قنوات الواجهة (تتحقق من المُرسل)          │
│ setup.js     آلة الحالة: فحص ← محرك ← موديل ← جاهز       │
│ server.js    تشغيل llama-server وإيقافه ومراقبته           │
│ engine.js    تنزيل نسخ llama.cpp واختبارها وتحديثها        │
│ models.js    الكتالوج، التنزيل من HF، التحقق              │
│ localmodels.js  ملفات GGUF وموديلات Ollama وLM Studio      │
│ monitor.js + hardware/   قراءات الحساسات، benchmark، report │
│ web.js       البحث وقراءة الصفحات (مع حماية SSRF)          │
│ documents.js → doc-worker.js (utilityProcess) PDF/Word     │
│ knowledge.js "مكتبتي" (Qwen3-Embedding عبر llama.cpp)      │
│ voice.js     الصوت إلى نص (whisper-server)                 │
│ images.js    رسم الصور (sd-server + Z-Image Turbo)          │
│ vscode.js    VS Code (خادم VSCodium) + untar.js             │
│ chats.js / personas.js / exporter.js                       │
│ settings.js / updates.js / protocol.js / download.js       │
└──────┬──────────────────────────────┬─────────────────────┘
       │ IPC (preload.js)              │ عمليات فرعية (معاملات ثابتة)
┌──────▼─────────────────────────┐ ┌──▼────────────────────────┐
│ الواجهة app://blazma (معزولة)   │ │ llama-server  127.0.0.1    │
│ pages/ chat, studio (VS Code),  │─▶ │ مفتاح عشوائي لكل تشغيل    │
│        device, models,          │ │ whisper-server / sd-server │
│        settings, personas,      │ │ خادم VSCodium (node)       │
│        overlay                  │ └────────────────────────────┘
│ lib/   markdown, sse, chart,    │
│        toolcalls, tour, tooltip │
└──────┬─────────────────────────┘
       │ WebContentsView (جلسة persist:vscode منفصلة)
┌──────▼─────────────────────────┐
│ VS Code: http://127.0.0.1:<منفذ> │  بلا وصول لقنوات التطبيق
└────────────────────────────────┘
```

## العزل والأمان

- **الواجهة:**
  - `contextIsolation`، و`sandbox`، وبدون `nodeIntegration`.
  - `preload.js` يعرض قنوات محددة باسمها فقط، و`ipc.js` يرفض أي طلب من إطار لا يُخدم من `app://blazma`.
  - CSP صارمة في ترويسة الرد: `script-src 'self'`، و`style-src 'self'`، و`connect-src` لمنفذ الخادم المحلي فقط، وبدون إطارات ولا Workers (`frame-src 'none'`، `worker-src 'none'`).
  - ردود الموديل تُعرض كنص آمن (markdown بلا HTML).
- **الأوامر:** كل برنامج يُشغَّل بمعاملات ثابتة بدون shell (`exec.js`)، ولا يمر فيها نص من المستخدم أو من الموديل.
- **الخوادم المحلية:**
  - تستمع على `127.0.0.1` فقط.
  - llama-server: مفتاح API عشوائي يمرَّر عبر متغير بيئة، و`--cors-origins app://blazma`.
- **VS Code:**
  - يعمل في `WebContentsView` بجلسة منفصلة (`persist:vscode`)، و`sandbox`، بلا `preload` ولا وصول لقنوات التطبيق.
  - خادمه بمفتاح عشوائي لكل تشغيل محفوظ في ملف، و`--telemetry-level off`، و`--disable-workspace-trust`.
  - التنقل محصور في خادمه، والروابط الخارجية تفتح في المتصفح.
  - صفحاته الداخلية (webviews) تُخدم من النسخة على الجهاز بدل `vscode-cdn.net`.
  - هذا محرر حقيقي: طرفيته وإضافاته تعمل بصلاحيات المستخدم، والصفحة تقول ذلك قبل التثبيت.
- **الملفات المرفقة:** تُحلَّل في `utilityProcess` بمهلة، مع `isEvalSupported: false` لـpdf.js.
- **التنزيلات:** كل ملف يُتحقق منه بحجمه وبصمة SHA-256. أرشيفات tar.gz تُفك بـ`untar.js` (Node فقط) مع منع الخروج من مجلد الهدف.
- **الإنترنت:** من العملية الرئيسية فقط (`net.fetch`)، لتنزيل المحرك والموديلات والأدوات بعد الموافقة، وللبحث عند تفعيله، وللتحقق من التحديثات عند الضغط.

## أماكن البيانات (`%APPDATA%\Blazma AI`)

| المسار | المحتوى |
|---|---|
| `settings.json` | الإعدادات |
| `engine/` | نسخ llama.cpp المنزّلة (`current.json` يحدد الفعّالة) |
| `models/` | الموديلات المنزّلة (ذاكرة llama.cpp المؤقتة، بنية HF). يمكن نقله من الإعدادات |
| `models/images/` | أداة الرسم وموديلاتها |
| `models.json` | سجل الملفات المنزّلة وحالة التحقق |
| `custom-models.json` | الموديلات المضافة (HF، وGGUF محلي، وOllama) |
| `chats/` | المحادثات (JSON لكل محادثة) |
| `personas.json` | الشخصيات المخصصة |
| `knowledge/` | فهرس "مكتبتي" |
| `voice/` | whisper.cpp وموديله |
| `vscode/` | خادم VSCodium (`bin/`)، وبياناته وإضافاته، وإعدادات Continue (`continue/`) |

مشاريع VS Code نفسها في `المستندات\Blazma Projects` افتراضياً.

## مسار تشغيل الموديل

1. يحدد `setup.start(modelId)` المحرك عبر `ensureEngine` (موجود، أو ينزّل ويختبر بـ`--list-devices`).
2. **موديل من الكتالوج:** يُقرأ سجله، وإذا لم يكتمل التنزيل يُشغَّل llama-server بـ`-hf` فينزّل بنفسه، والتقدم يُقاس من حجم الملف.
3. **موديل محلي:** يُشغَّل بـ`-m` (و`--mmproj` للرؤية).
4. يراقب `server.js` `/health` حتى 200، ثم الحالة "جاهز". الموديل المنزّل يُتحقق منه بـSHA-256 في الخلفية.

## مسار صفحة VS Code

1. أول مرة: `vscode.install()` يقرأ آخر إصدار VSCodium من GitHub، وينزّل `vscodium-reh-web-win32-x64-*.tar.gz` ويتحقق من SHA-256، ويفكه في `bin/<الإصدار>.partial` ثم يعيد تسميته.
2. `ensureServer()` يشغّل `node out/server-main.js` بمعاملات ثابتة، وينتظر `/version`.
3. `showView()` يضع الصفحة فوق `#code-host` بالأبعاد التي ترسلها الواجهة (مع عكس الموضع عندما تكون لغة النظام من اليمين لليسار، لأن Chromium يعكس مواضع الطبقات حينها).
4. "ربط الذكاء": يفعّل الواجهة البرمجية، ويثبّت Continue من Open VSX، ويكتب `continue/config.yaml` بعنوان الخادم المحلي ومفتاحه.
5. يتوقف الخادم وكل عملياته (الطرفيات) عند إغلاق البرنامج.
