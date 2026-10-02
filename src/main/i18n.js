'use strict';

// The few strings the main process shows itself (file dialog titles, system
// alerts, default names), in the interface language (settings.language).
// Everything else is in the page (src/renderer/i18n).

const settings = require('./settings');

const STRINGS = {
  ar: {
    untitled: 'محادثة',
    exportChat: 'تصدير المحادثة',
    pickGguf: 'اختر ملف موديل GGUF',
    saveImage: 'حفظ الصورة',
    pickDocs: 'اختر مجلد مستندات',
    pickGgufFolder: 'اختر مجلداً فيه موديلات GGUF',
    pickModelsDir: 'اختر مجلد الموديلات',
    backup: 'نسخة احتياطية للمحادثات',
    restore: 'استعادة المحادثات من نسخة احتياطية',
    pickProject: 'اختر مجلد مشروع',
    saveCode: 'حفظ الكود كملف',
    deviceReport: 'تصدير تقرير الجهاز',
    gpuTemp: (v) => `حرارة كرت الشاشة ${Math.round(v)} درجة مئوية`,
    thermalSlowdown: 'كرت الشاشة خفّض سرعته بسبب الحرارة',
    hwSlowdown: 'كرت الشاشة خفّض سرعته',
    fromChat: 'من المحادثة',
    continueRule: 'أجب دائماً باللغة العربية الفصحى المبسطة. اترك الكود وأسماء الملفات والأوامر كما هي بالإنجليزية.',
    autocompleteName: 'Blazma: إكمال الكود (Qwen2.5 Coder 1.5B)',
  },
  en: {
    untitled: 'Chat',
    exportChat: 'Export chat',
    pickGguf: 'Choose a GGUF model file',
    saveImage: 'Save image',
    pickDocs: 'Choose a documents folder',
    pickGgufFolder: 'Choose a folder with GGUF models',
    pickModelsDir: 'Choose the models folder',
    backup: 'Back up chats',
    restore: 'Restore chats from a backup',
    pickProject: 'Choose a project folder',
    saveCode: 'Save code as a file',
    deviceReport: 'Export device report',
    gpuTemp: (v) => `Graphics card at ${Math.round(v)} °C`,
    thermalSlowdown: 'The graphics card slowed down because of heat',
    hwSlowdown: 'The graphics card slowed down',
    fromChat: 'From chat',
    continueRule: 'Answer in the language the user writes in. Keep code, file names and commands as they are.',
    autocompleteName: 'Blazma: code completion (Qwen2.5 Coder 1.5B)',
  },
};

const lang = () => (settings.get().language === 'en' ? 'en' : 'ar');
const t = (key) => STRINGS[lang()][key];

module.exports = { t, lang, STRINGS };
