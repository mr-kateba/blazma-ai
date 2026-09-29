'use strict';

// Short, repeatable performance test against the running model: one long-ish
// prompt (prompt processing speed) and a fixed-length answer (generation
// speed), with GPU temperature and power sampled throughout.

const crypto = require('node:crypto');
const gpu = require('./hardware/gpu');
const { AppError } = require('./errors');

const PARAGRAPH =
  'تعتمد نماذج الذكاء الاصطناعي اللغوية على شبكات عصبية ضخمة تتعلم أنماط اللغة من كميات هائلة من النصوص، ثم تستخدم ما تعلمته لتوقع الكلمة التالية في الجملة. ' +
  'وعند تشغيل هذه النماذج على جهاز شخصي، تُحمَّل أوزانها في ذاكرة كرت الشاشة حتى يتمكن المعالج الرسومي من إجراء ملايين العمليات الحسابية في الثانية. ';

async function runBenchmark({ connection, nvidia }) {
  if (!connection) throw new AppError('bench-not-ready');
  const index = nvidia && nvidia.available ? nvidia.best.index : null;
  const peaks = { temp: null, power: null };
  let sampling = true;
  const sampler = (async () => {
    while (sampling && index !== null) {
      const g = await gpu.sampleGpu(index);
      if (g) {
        if (g.temp != null) peaks.temp = Math.max(peaks.temp ?? -Infinity, g.temp);
        if (g.power != null) peaks.power = Math.max(peaks.power ?? -Infinity, g.power);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  })();

  // A random tag at the start defeats llama-server's prompt cache, so the
  // prompt is really processed each run.
  const nonce = crypto.randomBytes(6).toString('hex');
  const prompt = `[${nonce}]\n${PARAGRAPH.repeat(6)}\nلخّص النص السابق في فقرة واحدة.`;
  const started = Date.now();
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${connection.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.apiKey}` },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 256,
        temperature: 0,
        stream: false,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
  } finally {
    sampling = false;
    await sampler;
  }
  if (!res.ok) throw new AppError('bench-failed', `HTTP ${res.status}`);
  const json = await res.json();
  const t = json.timings || {};
  return {
    promptTokens: t.prompt_n ?? null,
    promptPerSecond: t.prompt_per_second ?? null,
    genTokens: t.predicted_n ?? null,
    genPerSecond: t.predicted_per_second ?? null,
    maxTempC: peaks.temp,
    maxPowerW: peaks.power,
    seconds: (Date.now() - started) / 1000,
    at: new Date().toISOString(),
  };
}

module.exports = { runBenchmark };
