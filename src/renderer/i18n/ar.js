// All user-facing strings produced from JavaScript live here, in Arabic.
// Static labels live directly in index.html.

export const ar = Object.freeze({
  versionUnknown: 'غير معروف',

  phase: {
    detecting: 'جارٍ فحص جهازك…',
    engineRelease: 'جارٍ البحث عن أحدث نسخة من محرك التشغيل…',
    engineDownload: 'جارٍ تنزيل محرك التشغيل',
    engineExtract: 'جارٍ فك ضغط محرك التشغيل…',
    engineTest: 'جارٍ التأكد من أن المحرك يعمل مع كرت الشاشة…',
    modelResolve: 'جارٍ التحقق من الموديل على Hugging Face…',
    modelDownload: 'جارٍ تنزيل الموديل',
    waitingNetwork: 'انقطع الاتصال بالإنترنت',
    waitingNetworkHint: 'لا تقلق، الجزء الذي تم تنزيله محفوظ. سنكمل التنزيل تلقائياً من حيث توقف عند عودة الاتصال.',
    loading: 'جارٍ تحميل الموديل في الذاكرة…',
    loadingHint: 'قد يستغرق هذا دقيقة في أول مرة.',
    stopped: 'المحرك متوقف',
    stoppedHint: 'أوقفت محرك الذكاء الاصطناعي. شغّله عندما تريد المتابعة.',
  },

  setup: {
    title: 'لنجهّز الذكاء الاصطناعي على جهازك',
    intro: 'سننزّل محرك التشغيل والموديل مرة واحدة فقط، وبعدها يعمل كل شيء على جهازك بدون إرسال محادثاتك لأي جهة.',
    gpu: 'كرت الشاشة',
    ram: 'الذاكرة (RAM)',
    noNvidia: 'لم نجد كرت NVIDIA',
    cpuNotice: 'لم نجد كرت شاشة من NVIDIA، لذلك سيعمل الذكاء الاصطناعي على المعالج بموديل صغير. الردود ستكون أبطأ.',
    recommended: 'مقترح لجهازك',
    notFit: 'أكبر من ذاكرة كرتك',
    slowOnCpu: 'بطيء على المعالج',
    downloaded: 'منزّل',
    start: 'ابدأ التثبيت',
    startDownloaded: 'ابدأ',
    chooseOther: 'أو اختر موديلاً آخر:',
    fallbackNotice: (variant) => `لم تعمل النسخة الأحدث من المحرك مع تعريف كرتك، فاستخدمنا نسخة بديلة (${variant}). يُفضَّل تحديث تعريف NVIDIA.`,
  },

  actions: {
    retry: 'إعادة المحاولة',
    chooseModel: 'اختيار موديل آخر',
    startServer: 'تشغيل',
    stopServer: 'إيقاف المحرك',
    newChat: 'محادثة جديدة',
    send: 'إرسال',
    stop: 'إيقاف',
    copy: 'نسخ',
    copied: 'تم النسخ',
    details: 'تفاصيل تقنية للدعم',
  },

  status: {
    ready: 'جاهز',
    loading: 'يُحمِّل',
    stopped: 'متوقف',
    busy: 'قيد التجهيز',
    error: 'خطأ',
  },

  chat: {
    placeholder: 'اكتب رسالتك هنا…',
    emptyTitle: 'ابدأ محادثة',
    emptyHint: 'اسأل أي سؤال، اطلب شرحاً أو ترجمة أو كتابة رسالة أو كود.',
    thinking: 'يفكّر…',
    thought: (sec) => `فكّر لمدة ${sec} ث`,
    stopped: 'أُوقف التوليد.',
    speed: (tps, n) => `${tps.toFixed(1)} توكن/ث · ${n} توكن`,
    code: 'كود',
    // Appended to the system prompt on every request: the model has no clock
    // and no internet, and otherwise assumes its training year.
    dateContext: (gregorian, hijri, time) =>
      `تاريخ اليوم: ${gregorian} (${hijri})، والساعة الآن ${time} بتوقيت جهاز المستخدم. ` +
      'أنت تعمل على جهاز المستخدم بدون اتصال بالإنترنت، ومعلوماتك تتوقف عند تاريخ تدريبك. ' +
      'إذا سُئلت عن أحداث أو أسعار أو أخبار حديثة فوضّح أنك قد لا تعرف آخر المستجدات، ولا تخترع معلومات.',
    errors: {
      contextFull: 'المحادثة أصبحت أطول من حجم السياق المسموح. ابدأ محادثة جديدة، أو كبّر حجم السياق من الإعدادات.',
      serverGone: 'انقطع الاتصال بمحرك الذكاء الاصطناعي. إذا توقف المحرك ستظهر رسالة بالسبب أعلى الصفحة.',
      generic: 'حدث خطأ أثناء توليد الرد. حاول مرة أخرى.',
    },
  },


  device: {
    gpuSection: 'كرت الشاشة',
    cpuSection: 'المعالج',
    ramSection: 'الذاكرة (RAM)',
    storageSection: 'التخزين',
    systemSection: 'الجهاز',
    chartsSection: 'آخر 5 دقائق',
    nowRunning: 'يعمل الآن',
    model: 'الموديل',
    server: 'المحرك',
    lastSpeed: 'آخر سرعة توليد',
    none: 'لا يوجد',
    unavailable: 'غير متاح',
    usage: 'الاستخدام',
    vram: 'ذاكرة الكرت',
    power: 'سحب طاقة الكرت',
    temp: 'الحرارة',
    fan: 'المروحة',
    clocks: 'السرعة (الكرت / الذاكرة)',
    pstate: 'حالة الأداء',
    slowdown: 'تخفيض السرعة',
    slowdownNone: 'لا يوجد',
    reasons: {
      gpu_idle: 'خامل',
      sw_power_cap: 'حد الطاقة',
      hw_slowdown: 'تخفيض من العتاد',
      hw_thermal_slowdown: 'حرارة (عتاد)',
      sw_thermal_slowdown: 'حرارة (تعريف)',
      hw_power_brake_slowdown: 'مكابح الطاقة',
    },
    modelVram: 'ذاكرة الكرت للموديل',
    modelRam: 'ذاكرة الجهاز للمحرك',
    cpuName: 'المعالج',
    cores: 'الأنوية / الخيوط',
    cpuClock: 'السرعة الحالية',
    cpuTemp: 'حرارة المعالج',
    cpuPower: 'سحب طاقة المعالج',
    perCore: 'الاستخدام حسب النواة',
    ramUsed: 'المستخدم',
    ramAvailable: 'المتاح',
    ramType: 'النوع والسرعة',
    diskFree: 'المساحة الفاضية',
    modelsSize: 'حجم الموديلات المنزّلة',
    osVersion: 'نظام التشغيل',
    machine: 'الجهاز',
    board: 'اللوحة الأم',
    battery: 'البطارية',
    onBattery: 'على البطارية',
    onAc: 'موصول بالكهرباء',
    noBattery: 'لا توجد بطارية (جهاز مكتبي)',
    driver: 'التعريف',
    of: 'من',
    limit: 'الحد',
    maxTempNote: (t) => `أقصى حرارة تشغيل حسب الكرت: ${t} درجة`,
    chartUtil: 'الاستخدام %',
    chartTemp: 'حرارة الكرت (درجة مئوية)',
    chartPower: 'طاقة الكرت (واط)',
    chartVram: 'ذاكرة الكرت (جيجابايت)',
    chartRam: 'ذاكرة الجهاز (جيجابايت)',
    seriesGpu: 'الكرت',
    seriesCpu: 'المعالج',
    now: 'الآن',
    minutesAgo: (m) => `قبل ${m} د`,
    benchmark: 'اختبار أداء',
    benchmarkRunning: 'جارٍ الاختبار… (أقل من دقيقة عادةً)',
    benchmarkNeedsModel: 'شغّل الموديل أولاً من صفحة المحادثة، ثم أعد الاختبار.',
    benchmarkFailed: 'تعذّر إكمال الاختبار. تأكد أن المحرك يعمل وحاول مرة أخرى.',
    benchGen: 'سرعة التوليد',
    benchPrompt: 'سرعة معالجة الإدخال',
    benchMaxTemp: 'أقصى حرارة للكرت',
    benchMaxPower: 'أقصى طاقة للكرت',
    benchDuration: 'مدة الاختبار',
    exportReport: 'تصدير تقرير الجهاز',
    exported: 'تم حفظ التقرير. لا يحتوي اسم الجهاز ولا اسم المستخدم.',
    why: {
      noNvidia: 'المراقبة التفصيلية للحرارة والطاقة مدعومة لكروت NVIDIA فقط.',
      notReported: 'الكرت أو التعريف لا يوفر هذه القراءة.',
      cpuSensor: 'ويندوز لا يوفر هذه القراءة بدون برنامج حساسات خاص يحتاج صلاحيات المدير.',
      serverOff: 'المحرك غير مشغّل.',
      windowsOnly: 'متاحة على ويندوز فقط.',
      processVram: 'ويندوز لم يوفر هذه القراءة لهذا البرنامج.',
      noBattery: 'لا توجد بطارية.',
      waiting: 'بانتظار القراءة الأولى…',
    },
    otherGpus: 'كروت الشاشة في الجهاز',
    totalPowerNote: 'سحب الطاقة المعروض هو للكرت فقط. قياس سحب الجهاز الكلي يحتاج جهاز قياس خارجي.',
  },

  alerts: {
    'gpu-temp': (a) =>
      a.level === 'danger'
        ? `حرارة كرت الشاشة مرتفعة جداً: ${Math.round(a.value)} درجة مئوية. خفّف الحمل أو تأكد من تهوية الجهاز.`
        : `حرارة كرت الشاشة مرتفعة: ${Math.round(a.value)} درجة مئوية.`,
    'thermal-slowdown': () => 'كرت الشاشة خفّض سرعته بسبب الحرارة، فسيكون التوليد أبطأ. تأكد من تهوية الجهاز ونظافة المراوح.',
    'hw-slowdown': () => 'كرت الشاشة خفّض سرعته (حد من العتاد أو مزود الطاقة).',
  },

  settingsPage: {
    monitorTitle: 'لوحة "جهازي"',
    interval: 'فترة التحديث',
    seconds: (n) => `${n} ث`,
    warn: 'حد التحذير لحرارة الكرت (درجة مئوية)',
    danger: 'حد الخطر لحرارة الكرت (درجة مئوية)',
    auto: 'تلقائي حسب حدود الكرت',
    autoNote: (w, d) => `القيم التلقائية الآن: تحذير عند ${w} درجة، وخطر عند ${d} درجة.`,
    save: 'حفظ',
    saved: 'تم الحفظ',
    invalid: 'أدخل رقماً بين 30 و110، وحد الخطر أكبر من حد التحذير.',
    more: 'باقي الإعدادات (المحرك، الموديلات، التحديثات) تأتي في المرحلة القادمة.',
  },

  // Keyed by the error codes produced in src/main (errors.js, server.js).
  errors: {
    network: {
      title: 'تعذّر الاتصال بالإنترنت',
      hint: 'تأكد من اتصالك بالإنترنت ثم اضغط "إعادة المحاولة". التنزيل يكمل من حيث توقف.',
    },
    'engine-release': {
      title: 'تعذّر الوصول إلى صفحة إصدارات محرك التشغيل',
      hint: 'قد يكون GitHub غير متاح مؤقتاً أو محجوباً في شبكتك. حاول بعد قليل.',
    },
    'engine-no-asset': {
      title: 'لم نجد نسخة مناسبة من محرك التشغيل لويندوز',
      hint: 'قد يكون الإصدار الأخير ناقصاً. حاول مرة أخرى لاحقاً.',
    },
    'engine-extract': {
      title: 'تعذّر فك ضغط محرك التشغيل',
      hint: 'قد يكون برنامج الحماية منع الملفات. أضف مجلد التطبيق للاستثناءات ثم أعد المحاولة.',
    },
    'engine-test-failed': {
      title: 'محرك التشغيل لم يعمل على جهازك',
      hint: 'حدّث تعريف كرت الشاشة من موقع NVIDIA أو من تطبيق NVIDIA، ثم أعد تشغيل الجهاز وأعد المحاولة.',
    },
    'unsupported-os': {
      title: 'نظام التشغيل غير مدعوم',
      hint: 'هذا التطبيق يعمل على ويندوز 10 و11 فقط.',
    },
    'disk-full': {
      title: 'لا توجد مساحة كافية على القرص',
      hint: 'احذف بعض الملفات لتفريغ مساحة، أو غيّر مكان حفظ الموديلات من الإعدادات، ثم أعد المحاولة.',
    },
    'verify-failed': {
      title: 'الملف المنزّل تالف',
      hint: 'حذفنا الملف التالف. اضغط "إعادة المحاولة" لتنزيله من جديد.',
    },
    io: {
      title: 'تعذّرت الكتابة على القرص',
      hint: 'تأكد من أن القرص يعمل وأن لديك صلاحية الكتابة في مجلد التطبيق.',
    },
    'model-invalid': {
      title: 'اسم الموديل غير صحيح',
      hint: 'يجب أن يكون بصيغة repo:quant.',
    },
    'model-not-found': {
      title: 'لم نجد هذا الموديل على Hugging Face',
      hint: 'تأكد من اسم المستودع والصيغة (quant).',
    },
    'port-in-use': {
      title: 'المنفذ مستخدم من برنامج آخر',
      hint: 'اضغط "إعادة المحاولة" وسنختار منفذاً آخر تلقائياً.',
    },
    'vram-insufficient': {
      title: 'ذاكرة كرت الشاشة لا تكفي لهذا الموديل',
      hint: 'أغلق الألعاب والبرامج الثقيلة التي تستخدم الكرت، أو اختر موديلاً أصغر، أو صغّر حجم السياق من الإعدادات.',
    },
    'ram-insufficient': {
      title: 'ذاكرة الجهاز (RAM) لا تكفي لهذا الموديل',
      hint: 'أغلق البرامج المفتوحة أو اختر موديلاً أصغر.',
    },
    'model-load-failed': {
      title: 'تعذّر تحميل الموديل',
      hint: 'قد يكون الملف تالفاً أو غير مدعوم في هذه النسخة من المحرك. جرّب موديلاً آخر.',
    },
    'server-crashed': {
      title: 'توقف محرك الذكاء الاصطناعي بشكل مفاجئ',
      hint: 'اضغط "إعادة المحاولة". إذا تكرر ذلك، حدّث تعريف كرت الشاشة أو جرّب موديلاً أصغر.',
    },
    unknown: {
      title: 'حدث خطأ غير متوقع',
      hint: 'اضغط "إعادة المحاولة". إذا تكرر الخطأ، انسخ التفاصيل التقنية وأرسلها لنا.',
    },
  },
});

export function errorText(code) {
  return ar.errors[code] || ar.errors.unknown;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 ميجابايت';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(2)} جيجابايت`;
  return `${Math.round(bytes / 1024 ** 2)} ميجابايت`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${Math.ceil(seconds)} ثانية`;
  const min = Math.ceil(seconds / 60);
  if (min < 60) return `${min} دقيقة`;
  return `${Math.floor(min / 60)} ساعة و${min % 60} دقيقة`;
}
