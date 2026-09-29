<div dir="rtl">

# Blazma AI

تطبيق ويندوز مفتوح المصدر بواجهة عربية كاملة، يجمع شيئين:

1. **محادثة مع ذكاء اصطناعي يعمل محلياً** على كرت الشاشة في جهازك (موديلات مفتوحة فوق محرك [llama.cpp](https://github.com/ggml-org/llama.cpp)).
2. **لوحة مراقبة حيّة للجهاز**: كرت الشاشة والمعالج والذاكرة والحرارة وسحب الطاقة.

> ⚠️ المشروع في بداياته (المرحلة 0). التطبيق لا يحادث أي موديل بعد.

## الحالة الحالية

| الجزء | الحالة |
|---|---|
| هيكل التطبيق والنافذة والشريط الجانبي والصفحات الأربع | ✅ يعمل |
| الأمان: عزل السياق، بدون Node في الواجهة، CSP صارم، قنوات IPC محددة | ✅ يعمل |
| تنزيل المحرك وتشغيله والمحادثة | ⏳ المرحلة 1 |
| لوحة "جهازي" | ⏳ المرحلة 2 |
| حفظ المحادثات وصفحة الموديلات والإعدادات | ⏳ المرحلة 3 |
| ملف التنصيب | ⏳ المرحلة 4 |

خطة البناء الكاملة في [docs/PLAN.md](docs/PLAN.md).

## التشغيل من الكود المصدري

المتطلبات: [Node.js](https://nodejs.org) (نسخة LTS) و[Git](https://git-scm.com).

```powershell
git clone https://github.com/mr-kateba/blazma-ai.git
cd blazma-ai
npm install
npm start
```

## الخصوصية

- لا توجد أي تحليلات أو تتبع (telemetry).
- المحادثات وقراءات الجهاز تبقى على جهازك فقط.
- التطبيق يتصل بالإنترنت فقط من أجل: تنزيل المحرك من GitHub، وتنزيل الموديلات من Hugging Face، والتحقق من التحديثات.
- الخادم المحلي يستمع على `127.0.0.1` فقط، ولا يمكن الوصول إليه من الشبكة.

## الرخصة والإسناد

- التطبيق: رخصة [MIT](LICENSE).
- الخط: IBM Plex Sans Arabic، رخصة SIL Open Font License 1.1 ([src/renderer/fonts/OFL.txt](src/renderer/fonts/OFL.txt)).

</div>

---

## English

**Blazma AI** is an open-source Windows app with a fully Arabic (RTL) interface that combines a chat with open models running locally on your GPU (via llama.cpp's `llama-server`) and a live hardware monitor (GPU, CPU, RAM, temperatures, power draw).

Status: early scaffold (phase 0). Run from source with `npm install && npm start`. No telemetry; network access is used only to download the engine (GitHub), models (Hugging Face), and to check for updates. License: MIT.
