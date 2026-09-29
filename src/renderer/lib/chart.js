// Small canvas line chart for the last N seconds of readings. No libraries.
// Time runs left to right (newest on the right), as in Task Manager.

const GRID = 'rgba(255,255,255,0.07)';
const AXIS_TEXT = '#626a7a';

export class LineChart {
  // opts: { windowSec, yMax (number or 'auto'), yMin, format(v), labels: { now, ago(min) } }
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.opts = opts;
    this.series = []; // [{ color, points: [{ t, v }] }]
    this.observer = new ResizeObserver(() => this.draw());
    this.observer.observe(canvas);
  }

  setSeries(series) {
    this.series = series;
    this.draw();
  }

  draw() {
    const { canvas, opts } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const pad = { l: 36, r: 8, t: 8, b: 18 };
    const pw = w - pad.l - pad.r;
    const ph = h - pad.t - pad.b;
    const now = Date.now();
    const t0 = now - opts.windowSec * 1000;

    const values = this.series.flatMap((s) => s.points.filter((p) => p.t >= t0 && p.v != null).map((p) => p.v));
    const yMin = opts.yMin ?? 0;
    let yMax = opts.yMax === 'auto' || opts.yMax == null ? Math.max(1, ...values) * 1.15 : opts.yMax;
    if (!Number.isFinite(yMax) || yMax <= yMin) yMax = yMin + 1;

    const x = (t) => pad.l + ((t - t0) / (now - t0)) * pw;
    const y = (v) => pad.t + ph - ((v - yMin) / (yMax - yMin)) * ph;

    // Grid and y labels (3 lines).
    ctx.font = '11px "Plex Arabic", "Segoe UI", sans-serif';
    ctx.fillStyle = AXIS_TEXT;
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 2; i++) {
      const v = yMin + ((yMax - yMin) * i) / 2;
      const yy = Math.round(y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.l, yy);
      ctx.lineTo(w - pad.r, yy);
      ctx.stroke();
      ctx.fillText(opts.format ? opts.format(v) : String(Math.round(v)), pad.l - 6, yy);
    }

    // Time labels.
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'right';
    ctx.fillText(opts.labels.now, w - pad.r, h - 4);
    ctx.textAlign = 'left';
    ctx.fillText(opts.labels.ago(Math.round(opts.windowSec / 60)), pad.l, h - 4);

    // Lines; a gap in readings (null) breaks the line instead of inventing data.
    for (const s of this.series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let drawing = false;
      for (const p of s.points) {
        if (p.t < t0 || p.v == null) {
          drawing = false;
          continue;
        }
        const px = x(p.t);
        const py = y(Math.min(Math.max(p.v, yMin), yMax));
        if (drawing) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
        drawing = true;
      }
      ctx.stroke();
    }
  }
}
