# بنية Blazma AI

تطبيق Electron بثلاث طبقات معزولة، وخادم llama.cpp محلي.

```
┌─────────────── العملية الرئيسية (Node) ───────────────┐
│ main.js      النافذة، البروتوكولات، دورة الحياة         │
│ ipc.js       كل قنوات الواجهة (تتحقق من المُرسل)        │
│ setup.js     آلة الحالة: فحص ← محرك ← موديل ← جاهز     │
│ server.js    تشغيل llama-server وإيقافه ومراقبته         │
│ engine.js    تنزيل نسخ llama.cpp واختبارها وتحديثها      │
│ models.js    الكتالوج، التنزيل من HF، التحقق            │
│ localmodels.js  ملفات GGUF وموديلات Ollama الموجودة      │
│ monitor.js + hardware/   قراءات الحساسات                 │
│ web.js       البحث وقراءة الصفحات (مع حماية SSRF)        │
│ documents.js → doc-worker.js (utilityProcess) PDF/Word   │
│ chats.js / personas.js / studio.js / exporter.js         │
│ settings.js / updates.js / protocol.js                   │
└──────────────┬─────────────────────────────┬────────────┘
               │ IPC (preload.js)             │ عملية فرعية
┌──────────────▼──────────────┐   ┌──────────▼───────────┐
│ الواجهة app://blazma (معزولة) │   │ llama-server          │
│ pages/  chat, studio, device,│──▶│ 127.0.0.1:<port>      │
│         models, settings     │   │ مفتاح عشوائي لكل تشغيل │
│ studio/ monaco, agent, ...   │   └──────────────────────┘
│ lib/    markdown, sse, chart │
└──────────────┬──────────────┘
               │ iframe (sandbox)
┌──────────────▼──────────────┐
│ معاينة الاستوديو studio://   │  بدون إنترنت، بدون وصول للتطبيق
└─────────────────────────────┘
```

## العزل والأمان

- **الواجهة:**
  - `contextIsolation`، و`sandbox`، وبدون `nodeIntegration`.
  - `preload.js` يعرض قنوات محددة باسمها فقط.
  - CSP:
    - السكربتات من `'self'`.
    - الاتصال بمنفذ الخادم المحلي فقط.
    - الأنماط تسمح بـ`'unsafe-inline'` لأن Monaco يضيف `<style>`.
    - الـWorkers تسمح بـ`blob:` لعامل Monaco.
- **معاينة الاستوديو:**
  - إطار `sandbox="allow-scripts allow-modals allow-same-origin"` على أصل `studio://preview` المختلف عن التطبيق.
  - CSP: `connect-src 'none'`.
  - `will-frame-navigate` يمنع مغادرته.
- **الخادم:**
  - يستمع على `127.0.0.1` فقط.
  - مفتاح API عشوائي يمرَّر عبر متغير بيئة.
  - `--cors-origins app://blazma`.
- **الملفات المرفقة:** تُحلَّل في `utilityProcess` بمهلة، مع `isEvalSupported: false` لـpdf.js.
- **الإنترنت:** من العملية الرئيسية فقط (`net.fetch`)، لتنزيل المحرك والموديلات، وللبحث عند تفعيله، وللتحقق من التحديثات عند الضغط.

## أماكن البيانات (`%APPDATA%\Blazma AI`)

| المسار | المحتوى |
|---|---|
| `settings.json` | الإعدادات |
| `engine/` | نسخ llama.cpp المنزّلة (`current.json` يحدد الفعّالة) |
| `models/` | الموديلات المنزّلة (ذاكرة llama.cpp المؤقتة، بنية HF) |
| `models.json` | سجل الملفات المنزّلة وحالة التحقق |
| `custom-models.json` | الموديلات المضافة (HF، وGGUF محلي، وOllama) |
| `chats/` | المحادثات (JSON لكل محادثة) |
| `studio/` | مشاريع الاستوديو |
| `personas.json` | الشخصيات المخصصة |

## مسار تشغيل الموديل

1. يحدد `setup.start(modelId)` المحرك عبر `ensureEngine` (موجود، أو ينزّل ويختبر بـ`--list-devices`).
2. **موديل من الكتالوج:** يُقرأ سجله، وإذا لم يكتمل التنزيل يُشغَّل llama-server بـ`-hf` فينزّل بنفسه، والتقدم يُقاس من حجم الملف.
3. **موديل محلي:** يُشغَّل بـ`-m` (و`--mmproj` للرؤية).
4. يراقب `server.js` `/health` حتى 200، ثم الحالة "جاهز". الموديل المنزّل يُتحقق منه بـSHA-256 في الخلفية.
