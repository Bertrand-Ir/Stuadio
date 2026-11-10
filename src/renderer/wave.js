'use strict';
/* Player waveform: A/B morph, played progress, trimmed regions, processing scan. Colours come from CSS tokens. */
(function () {
  const BAR = 3, GAP = 2;

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    return {
      orig: v('--wave-orig'), origPlayed: v('--wave-orig-played'),
      studio: v('--wave-studio'), studioPlayed: v('--wave-studio-played'),
      mid: v('--wave-mid'), idle: v('--wave-idle'),
      cut: v('--cut'), cutLine: v('--cut-line'), head: v('--text'), accent: v('--accent'),
    };
  }

  function resample(data, n) {
    const out = new Float32Array(n);
    if (!data || !data.length) return out;
    for (let i = 0; i < n; i++) {
      const s = Math.floor(i * data.length / n), e = Math.max(s + 1, Math.floor((i + 1) * data.length / n));
      let m = 0;
      for (let k = s; k < e; k++) if (data[k] > m) m = data[k];
      out[i] = m;
    }
    return out;
  }
  // Logarithmic display (−60…0 dBFS): quiet takes stay readable, and the noise floor between
  // words is visible in the original but drops away in the studio version.
  const RANGE = 60;
  const shape = (v) => {
    if (!(v > 0)) return 0;
    const d = 20 * Math.log10(Math.min(1, v));
    return Math.pow(Math.max(0, (d + RANGE) / RANGE), 2.2);
  };

  function bar(ctx, x, y, w, h) {
    const r = Math.min(w / 2, h / 2);
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
    ctx.fill();
  }

  class PlayerWave {
    constructor(canvas) {
      this.c = canvas; this.ctx = canvas.getContext('2d');
      this.data = { original: null, studio: null };
      this.cuts = []; this.duration = { original: 0, studio: 0 };
      this.view = 'original'; this.progress = 0; this.scan = null; this.loading = false;
      this.morph = 1; this.from = null; this.t0 = 0;
      this.colors = readColors();
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { this.colors = readColors(); this.draw(); });
      new ResizeObserver(() => this.resize()).observe(canvas);
      this.resize();
    }
    resize() {
      const r = this.c.getBoundingClientRect(), d = window.devicePixelRatio || 1;
      this.w = r.width; this.h = r.height;
      this.c.width = Math.max(1, Math.round(r.width * d)); this.c.height = Math.max(1, Math.round(r.height * d));
      this.ctx.setTransform(d, 0, 0, d, 0, 0);
      this.n = Math.max(10, Math.floor((this.w + GAP) / (BAR + GAP)));
      this.cache = {};
      this.draw();
    }
    bars(key) {
      if (!this.data[key]) return null;
      const k = key + this.n;
      if (!this.cache[k]) this.cache[k] = resample(this.data[key], this.n);
      return this.cache[k];
    }
    set(opts) { Object.assign(this, opts); if (opts.data) this.cache = {}; this.draw(); }
    setView(view, animate = true) {
      if (view === this.view) return;
      this.from = animate ? this.heights(this.view) : null;
      this.view = view; this.morph = animate ? 0 : 1; this.t0 = performance.now();
      if (!animate) return this.draw();
      const step = (t) => {
        this.morph = Math.min(1, (t - this.t0) / 380);
        this.draw();
        if (this.morph < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
    heights(view) {
      const b = this.bars(view) || this.bars('original');
      return b ? Float32Array.from(b, shape) : new Float32Array(this.n);
    }
    draw() {
      const { ctx, w, h, colors: C } = this;
      if (!w) return;
      ctx.clearRect(0, 0, w, h);
      const mid = h / 2, maxH = h * 0.94;
      ctx.fillStyle = C.mid; ctx.fillRect(0, mid - 0.5, w, 1);

      if (this.loading || !this.data.original) {
        const t = performance.now() / 500;
        ctx.fillStyle = C.idle;
        for (let i = 0; i < this.n; i++) {
          const bh = Math.max(2, (0.05 + 0.04 * Math.sin(i * 0.3 - t * 2)) * maxH);
          bar(ctx, i * (BAR + GAP), mid - bh / 2, BAR, bh);
        }
        if (this.loading) requestAnimationFrame(() => this.draw());
        return;
      }

      const view = this.view, studio = view === 'studio';
      const target = this.heights(view);
      const e = 1 - Math.pow(1 - this.morph, 3);
      const hts = this.from && this.morph < 1 ? target.map((v, i) => this.from[i] + (v - this.from[i]) * e) : target;

      if (view === 'original' && this.cuts.length && this.duration.original) {
        for (const [s, en] of this.cuts) {
          const x0 = (s / this.duration.original) * w, x1 = (en / this.duration.original) * w;
          ctx.fillStyle = C.cut; ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
          ctx.fillStyle = C.cutLine; ctx.fillRect(x0, 0, 1, h); ctx.fillRect(Math.max(x0, x1 - 1), 0, 1, h);
        }
      }

      const playedX = this.progress * w;
      const scanX = this.scan == null ? -1 : this.scan * w;
      for (let i = 0; i < this.n; i++) {
        const x = i * (BAR + GAP);
        const bh = Math.max(2, hts[i] * maxH);
        if (scanX >= 0) ctx.fillStyle = x < scanX ? C.studioPlayed : C.orig;
        else if (studio) ctx.fillStyle = x < playedX ? C.studioPlayed : C.studio;
        else ctx.fillStyle = x < playedX ? C.origPlayed : C.orig;
        bar(ctx, x, mid - bh / 2, BAR, bh);
      }

      if (scanX >= 0) {
        ctx.fillStyle = C.accent; ctx.fillRect(Math.round(scanX) - 1, 0, 2, h);
      } else if (this.progress > 0) {
        ctx.fillStyle = C.head; ctx.fillRect(Math.round(playedX) - 1, 0, 2, h);
      }
    }
  }

  window.Wave = { PlayerWave };
})();
