'use strict';
(function () {
  const api = window.stuadio;
  const $ = (s) => document.querySelector(s);
  const body = document.body;
  if (api.platform === 'darwin') body.classList.add('is-mac');

  /* ------------------------------------------------------------------ *
   * Studio chain definition — the order mirrors the actual signal flow.
   * ------------------------------------------------------------------ */
  const CHAIN = [
    { group: 'Clean', items: [
      { key: 'noise', icon: 'noise', title: 'Noise removal', desc: 'Neural suppression of hiss, fans, traffic and room tone.',
        opts: { field: 'strength', choices: [['gentle', 'Gentle'], ['balanced', 'Balanced'], ['strong', 'Strong']] } },
      { key: 'hum', icon: 'hum', title: 'Hum removal', desc: 'Notches out electrical mains hum and its harmonics.',
        opts: { field: 'freq', choices: [[50, '50 Hz'], [60, '60 Hz']] } },
      { key: 'rumble', icon: 'rumble', title: 'Rumble filter', desc: 'Cuts low thumps, wind, desk bumps and handling noise.' },
      { key: 'echo', icon: 'echo', title: 'Echo reduction', desc: 'Tightens the room so your voice sounds close and dry.',
        opts: { field: 'amount', choices: [['light', 'Light'], ['medium', 'Medium'], ['strong', 'Strong']] } },
      { key: 'declip', icon: 'declip', title: 'Clipping repair', desc: 'Rebuilds peaks that distorted while recording.' },
    ] },
    { group: 'Shape', items: [
      { key: 'tone', icon: 'tone', title: 'Studio tone', desc: 'Matches your voice to a studio reference — less mud, more presence and air.',
        opts: { field: 'character', choices: [['natural', 'Natural'], ['warm', 'Warm'], ['bright', 'Bright']] } },
      { key: 'deess', icon: 'deess', title: 'De-esser', desc: 'Softens sharp “s” and “t” sounds.',
        opts: { field: 'amount', choices: [['light', 'Light'], ['medium', 'Medium'], ['strong', 'Strong']] } },
      { key: 'level', icon: 'level', title: 'Voice leveling', desc: 'Evens out loud and quiet moments, like an engineer riding the fader.',
        opts: { field: 'amount', choices: [['light', 'Light'], ['medium', 'Medium'], ['heavy', 'Heavy']] } },
    ] },
    { group: 'Edit', items: [
      { key: 'pauses', icon: 'scissors', title: 'Trim pauses', desc: 'Shortens long silences and dead air between sentences.',
        opts: { field: 'style', choices: [['natural', 'Natural'], ['tight', 'Tight']] } },
    ] },
    { group: 'Master', items: [
      { key: 'loudness', icon: 'gauge', title: 'Loudness mastering', desc: 'Platform-standard loudness with a true-peak limiter.',
        opts: { field: 'target', grid: true, choices: [['podcast', 'Podcast', '−16 LUFS'], ['youtube', 'YouTube & social', '−14 LUFS'], ['audiobook', 'Audiobook', '−19 LUFS, ACX'], ['broadcast', 'Broadcast', '−23 LUFS, EBU R128']] } },
    ] },
  ];
  const TARGETS = { podcast: 'Podcast', youtube: 'YouTube & social', audiobook: 'Audiobook', broadcast: 'Broadcast' };
  // Where each step sits on the progress timeline (matches engine stages).
  const STAGE_OF = { declip: 'A', rumble: 'A', hum: 'A', noise: 'A', echo: 'B', tone: 'B', deess: 'B', level: 'B', pauses: 'E', loudness: 'M' };
  const STAGE_RANGE = { A: [0, 0.4], B: [0.4, 0.7], E: [0.7, 0.8], M: [0.8, 1] };
  const PHASE_LABEL = { clean: 'Cleaning & shaping', edit: 'Trimming pauses', master: 'Mastering', verify: 'Final checks' };

  /* ------------------------------------------------------------------ */
  const S = { state: 'empty', file: null, settings: null, recommended: null, result: null, snapshot: '', view: 'original', format: 'wav', channels: 'mono', exporting: false };
  const audio = { original: $('#audioOriginal'), studio: $('#audioStudio') };
  const wave = new Wave.PlayerWave($('#wave'));
  Icons.hydrate();

  function setState(st) {
    S.state = st; body.dataset.state = st;
    $('#btnPlay').disabled = !(st === 'ready' || st === 'done');
    $('#btnEnhance').disabled = st !== 'ready';
    updateDirty();
  }

  /* ---------- Formatting ---------- */
  const fmtTime = (t, tenths = true) => {
    t = Math.max(0, t || 0);
    const m = Math.floor(t / 60), s = t - m * 60;
    return tenths ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
  };
  const fmtLong = (t) => { const h = Math.floor(t / 3600); return h ? `${h}:${fmtTime(t - h * 3600, false).padStart(5, '0')}` : fmtTime(t, false); };
  const num = (v, d = 1) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(d);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const basename = (p) => p.split(/[\\/]/).pop();

  /* ---------- Toasts ---------- */
  function toast({ kind = 'good', title, text = '', action, timeout = 5200 }) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = `${Icons.svg(kind === 'bad' ? 'alert' : kind === 'info' ? 'info' : 'check')}<div class="toast-text"><b>${esc(title)}</b>${text ? `<div>${esc(text)}</div>` : ''}</div>`;
    if (action) {
      const b = document.createElement('button');
      b.className = 'btn btn-secondary'; b.innerHTML = `${action.icon ? Icons.svg(action.icon) : ''}${esc(action.label)}`;
      b.onclick = () => { action.fn(); close(); };
      el.appendChild(b);
    }
    const x = document.createElement('button');
    x.className = 'icon-btn small'; x.innerHTML = Icons.svg('x'); x.title = 'Dismiss'; x.onclick = () => close();
    el.appendChild(x);
    $('#toasts').appendChild(el);
    let gone = false;
    function close() { if (gone) return; gone = true; el.classList.add('out'); setTimeout(() => el.remove(), 260); }
    if (timeout) setTimeout(close, timeout);
  }

  /* ---------- Chain panel ---------- */
  function detectedTag(key) {
    const a = S.file && S.file.analysis;
    if (!a) return '';
    if (key === 'noise' && a.snrDb < 38) return 'Detected';
    if (key === 'hum' && a.hum.detected) return `${a.hum.freq} Hz found`;
    if (key === 'declip' && a.clipping.events > 0) return 'Detected';
    if (key === 'pauses' && a.longPauses > 0) return `${a.longPauses} found`;
    return '';
  }

  /* One-click modes. Each is a full preset computed by the engine from the analysis. */
  const MODES = [
    { id: 'studio', icon: 'mic', title: 'Studio sound', desc: 'Clean, rich and balanced voice, mastered for release.' },
    { id: 'phone', icon: 'phone', title: 'Phone recording', desc: 'Strongest repair for phone and laptop mics: noise, echo, thin sound.' },
    { id: 'clean', icon: 'noise', title: 'Noise removal only', desc: 'Removes noise and hum. Your voice stays as recorded.' },
  ];
  const FINE = CHAIN.filter((g) => g.group === 'Clean' || g.group === 'Shape');
  const FINE_KEYS = FINE.flatMap((g) => g.items.map((i) => i.key));
  const MAIN_ITEMS = CHAIN.filter((g) => g.group === 'Edit' || g.group === 'Master').flatMap((g) => g.items);
  let fineOpen = false;

  function isCustomised() {
    const p = S.file && S.file.presets[S.settings.mode];
    return !!p && FINE_KEYS.some((k) => JSON.stringify(p[k]) !== JSON.stringify(S.settings[k]));
  }

  function selectMode(id) {
    if (S.state === 'processing') return;
    const keep = { pauses: S.settings.pauses, loudness: S.settings.loudness };
    S.settings = { ...structuredClone(S.file.presets[id]), ...keep };
    renderChain();
    onSettingsChanged();
  }

  function renderChain() {
    const root = $('#chain');
    root.innerHTML = '';
    const suggested = S.recommended && S.recommended.mode;

    const modes = document.createElement('div');
    modes.className = 'modes';
    modes.setAttribute('role', 'radiogroup');
    modes.setAttribute('aria-label', 'Enhancement mode');
    for (const m of MODES) {
      const b = document.createElement('button');
      b.type = 'button';
      const active = S.settings.mode === m.id;
      b.className = 'mode' + (active ? ' is-active' : '');
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(active));
      b.innerHTML = `
        <div class="mode-icon">${Icons.svg(m.icon)}</div>
        <div class="mode-text">
          <div class="mode-title">${m.title}${m.id === suggested ? '<span class="tag tag-accent">Recommended</span>' : ''}</div>
          <div class="mode-desc">${m.desc}</div>
        </div>
        <div class="mode-radio">${Icons.svg('check')}</div>`;
      b.addEventListener('click', () => selectMode(m.id));
      modes.appendChild(b);
    }
    root.appendChild(modes);

    const opts = document.createElement('div');
    opts.className = 'group';
    opts.innerHTML = '<div class="group-title">Options</div>';
    for (const it of MAIN_ITEMS) opts.appendChild(renderRow(it));
    root.appendChild(opts);

    const fine = document.createElement('div');
    fine.className = 'fine' + (fineOpen ? ' open' : '');
    const custom = isCustomised();
    fine.innerHTML = `
      <button type="button" class="fine-head" aria-expanded="${fineOpen}">
        <span class="fine-title">Fine-tune</span>
        ${custom ? '<span class="tag">Customised</span>' : `<span class="fine-count">${FINE_KEYS.filter((k) => S.settings[k].on).length} of ${FINE_KEYS.length} fixes on</span>`}
        <span class="fine-chev">${Icons.svg('chevron')}</span>
      </button>
      <div class="fine-body"></div>`;
    const fb = fine.querySelector('.fine-body');
    for (const g of FINE) {
      const grp = document.createElement('div');
      grp.className = 'group';
      grp.innerHTML = `<div class="group-title">${g.group}</div>`;
      for (const it of g.items) grp.appendChild(renderRow(it));
      fb.appendChild(grp);
    }
    fine.querySelector('.fine-head').addEventListener('click', () => {
      fineOpen = !fineOpen;
      fine.classList.toggle('open', fineOpen);
      fine.querySelector('.fine-head').setAttribute('aria-expanded', String(fineOpen));
    });
    root.appendChild(fine);
  }

  function refreshFineHead() {
    const head = document.querySelector('.fine-head');
    if (!head) return;
    const custom = isCustomised();
    const old = head.querySelector('.tag, .fine-count');
    const el = document.createElement('span');
    if (custom) { el.className = 'tag'; el.textContent = 'Customised'; }
    else { el.className = 'fine-count'; el.textContent = `${FINE_KEYS.filter((k) => S.settings[k].on).length} of ${FINE_KEYS.length} fixes on`; }
    old.replaceWith(el);
  }

  function renderRow(it) {
    const st = S.settings[it.key];
    const row = document.createElement('div');
    row.className = 'row' + (st.on ? ' on' : '');
    row.dataset.key = it.key;
    const tag = detectedTag(it.key);
    let opts = '';
    if (it.opts) {
      const cur = st[it.opts.field];
      opts = `<div class="row-opts"><div class="seg ${it.opts.grid ? 'grid' : ''}">` +
        it.opts.choices.map(([v, label, sub]) => `<button type="button" class="seg-btn ${String(v) === String(cur) ? 'is-active' : ''}" data-value="${v}">${it.opts.grid ? `<b>${label}</b><span>${sub}</span>` : label}</button>`).join('') +
        `</div>${noteFor(it.key)}</div>`;
    } else if (noteFor(it.key)) {
      opts = `<div class="row-opts">${noteFor(it.key)}</div>`;
    }
    row.innerHTML = `
      <div class="row-icon">${Icons.svg(it.icon)}</div>
      <div class="row-main">
        <div class="row-title">${it.title}${tag ? `<span class="tag">${tag}</span>` : ''}</div>
        <div class="row-desc">${it.desc}</div>
        ${opts}
      </div>
      <div class="row-side">
        <div class="row-state"></div>
        <label class="switch" title="${st.on ? 'Turn off' : 'Turn on'}"><input type="checkbox" ${st.on ? 'checked' : ''} aria-label="${it.title}"><span class="track"></span><span class="thumb"></span></label>
      </div>`;
    row.querySelector('input').addEventListener('change', (e) => {
      st.on = e.target.checked;
      const fresh = renderRow(it);
      row.replaceWith(fresh);
      onSettingsChanged();
    });
    row.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => {
      const v = b.dataset.value;
      st[it.opts.field] = typeof it.opts.choices[0][0] === 'number' ? Number(v) : v;
      row.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('is-active', x === b));
      onSettingsChanged();
    }));
    return row;
  }

  function noteFor(key) {
    if (key === 'pauses' && S.file && S.file.info.hasVideo && S.settings.pauses.on) {
      return `<div class="row-note">${Icons.svg('info')}<span>Trimming changes timing, so the result exports as audio only. Turn this off to export your video.</span></div>`;
    }
    return '';
  }

  function onSettingsChanged() { refreshFineHead(); updateDirty(); }
  function updateDirty() {
    const dirty = S.state === 'done' && S.settings && JSON.stringify(S.settings) !== S.snapshot;
    body.classList.toggle('dirty', !!dirty);
  }

  function setRowProgress(value) {
    const enabled = Object.keys(STAGE_OF).filter((k) => S.settings[k] && S.settings[k].on);
    const byStage = {};
    enabled.forEach((k) => (byStage[STAGE_OF[k]] = byStage[STAGE_OF[k]] || []).push(k));
    for (const [stage, keys] of Object.entries(byStage)) {
      const [a, b] = STAGE_RANGE[stage];
      keys.forEach((k, i) => {
        const s0 = a + (b - a) * (i / keys.length), s1 = a + (b - a) * ((i + 1) / keys.length);
        const el = document.querySelector(`.row[data-key="${k}"] .row-state`);
        if (!el) return;
        const mode = value >= s1 ? 'done' : value >= s0 ? 'busy' : 'wait';
        if (el.dataset.mode === mode) return;
        el.dataset.mode = mode;
        el.innerHTML = mode === 'done' ? Icons.svg('check') : mode === 'busy' ? Icons.svg('loader') : '';
      });
    }
  }
  function clearRowProgress() { document.querySelectorAll('.row-state').forEach((el) => { el.innerHTML = ''; delete el.dataset.mode; }); }

  /* ---------- File header + diagnosis ---------- */
  function renderFileHead(name, info) {
    $('#fileName').textContent = name;
    $('#titleName').textContent = name;
    $('#titleFile').hidden = false;
    const fi = $('#fileIcon');
    fi.dataset.icon = info && info.hasVideo ? 'file-video' : 'file-audio';
    Icons.hydrate(fi.parentNode);
    if (!info) { $('#fileMeta').innerHTML = '<span>Reading file…</span>'; return; }
    const ch = info.channels === 1 ? 'Mono' : info.channels === 2 ? 'Stereo' : info.channels === 6 ? '5.1' : `${info.channels} ch`;
    const parts = [fmtLong(info.duration), info.sampleRate ? `${(info.sampleRate / 1000).toFixed(info.sampleRate % 1000 ? 1 : 0)} kHz` : null, ch, (info.codec || '').replace(/^pcm_.*/, 'PCM').toUpperCase(), info.hasVideo ? 'Video' : null].filter(Boolean);
    $('#fileMeta').innerHTML = parts.map((p) => `<span>${esc(p)}</span>`).join('');
  }

  function renderDiagnosis(a) {
    const chips = [];
    if (!a) {
      $('#diagChips').innerHTML = '<span class="chip skeleton"></span><span class="chip skeleton"></span><span class="chip skeleton"></span>';
      return;
    }
    const snr = a.snrDb;
    if (snr >= 52) chips.push(['good', 'Clean background']);
    else if (snr >= 38) chips.push(['warn', '<b>Light</b> background noise']);
    else if (snr >= 24) chips.push(['warn', '<b>Noticeable</b> background noise']);
    else chips.push(['bad', '<b>Heavy</b> background noise']);
    chips.push(a.hum.detected ? ['warn', `<b>${a.hum.freq} Hz</b> hum`] : ['good', 'No hum']);
    const l = a.integratedLufs;
    if (l < -24) chips.push(['warn', `<b>Too quiet</b> ${num(l)} LUFS`]);
    else if (l > -11) chips.push(['warn', `<b>Very loud</b> ${num(l)} LUFS`]);
    else chips.push(['good', `Level ${num(l)} LUFS`]);
    chips.push(a.clipping.events > 0 ? ['bad', `<b>${a.clipping.events}</b> clipped peak${a.clipping.events === 1 ? '' : 's'}`] : ['good', 'No clipping']);
    if (a.longPauses > 0) chips.push(['warn', `<b>${a.longPauses}</b> long pause${a.longPauses === 1 ? '' : 's'}`]);
    $('#diagChips').innerHTML = chips.map(([k, t], i) => `<span class="chip ${k}" style="animation-delay:${i * 50}ms">${Icons.svg(k)}<span>${t}</span></span>`).join('');
  }

  function renderResults() {
    const r = S.result, a = S.file.analysis;
    if (!r) { $('#results').innerHTML = ''; return; }
    const snrAfter = r.speechLevelDb - r.noiseFloorDb;
    const gain = snrAfter - a.snrDb;
    const tiles = [
      { icon: 'gauge', label: 'Loudness', value: `${num(r.lufs)}<small>LUFS</small>`, sub: S.settings.loudness.on ? `${TARGETS[S.settings.loudness.target]} target, was ${num(a.integratedLufs)}` : `Level kept, was ${num(a.integratedLufs)}` },
      { icon: 'noise', label: 'Background noise', value: gain > 1 ? `${num(-gain, 0)}<small>dB quieter</small>` : 'Clean', sub: `Signal-to-noise ${a.snrDb.toFixed(0)} → <span class="up">${snrAfter.toFixed(0)} dB</span>` },
      { icon: 'clock', label: 'Length', value: fmtLong(r.duration), sub: r.removedSeconds > 0 ? `<span class="up">${r.removedSeconds.toFixed(1)} s</span> of dead air trimmed` : 'Timing untouched' },
      { icon: 'shield', label: 'True peak', value: `${num(r.truePeak)}<small>dBTP</small>`, sub: 'Safe from clipping everywhere' },
    ];
    $('#results').innerHTML = tiles.map((t) => `<div class="stat"><div class="stat-label">${Icons.svg(t.icon)}${t.label}</div><div class="stat-value">${t.value}</div><div class="stat-sub">${t.sub}</div></div>`).join('');
  }

  /* ---------- Player ---------- */
  let raf = 0;
  const durOf = (v) => (v === 'studio' ? (S.result && S.result.duration) : (S.file && S.file.info.duration)) || 0;
  const cur = () => audio[S.view];

  function mapTime(t, from, to) {
    const segs = S.result ? S.result.segments : null;
    if (!segs || from === to) return t;
    if (from === 'original') {
      for (const [s, e, d] of segs) { if (t < s) return d; if (t < e) return d + (t - s); }
      const l = segs[segs.length - 1]; return l[2] + (l[1] - l[0]);
    }
    for (const [s, e, d] of segs) { if (t < d + (e - s)) return s + Math.max(0, t - d); }
    return segs[segs.length - 1][1];
  }

  function tick() {
    const a = cur(), d = durOf(S.view);
    const t = a.currentTime || 0;
    $('#timeNow').textContent = fmtTime(t);
    wave.set({ progress: d ? Math.min(1, t / d) : 0 });
    if (!a.paused) raf = requestAnimationFrame(tick); else raf = 0;
  }
  function updatePlayIcon() {
    const playing = !cur().paused;
    const span = $('#btnPlay span');
    span.dataset.icon = playing ? 'pause' : 'play';
    Icons.hydrate($('#btnPlay'));
  }
  async function togglePlay() {
    if (!(S.state === 'ready' || S.state === 'done')) return;
    const a = cur();
    if (a.paused) {
      if (a.ended || a.currentTime >= durOf(S.view) - 0.05) a.currentTime = 0;
      try { await a.play(); } catch (e) { toast({ kind: 'bad', title: 'Playback failed', text: e.message }); }
    } else a.pause();
  }
  for (const k of ['original', 'studio']) {
    audio[k].addEventListener('play', () => { updatePlayIcon(); if (!raf) raf = requestAnimationFrame(tick); });
    audio[k].addEventListener('pause', () => { updatePlayIcon(); tick(); });
    audio[k].addEventListener('ended', () => { updatePlayIcon(); tick(); });
    audio[k].addEventListener('seeked', () => tick());
  }
  function stopAll() { for (const k in audio) { audio[k].pause(); } }
  function seekTo(t) {
    const a = cur(), d = durOf(S.view);
    a.currentTime = Math.max(0, Math.min(d - 0.01, t));
    tick();
  }
  function setView(v, animate = true) {
    if (v === 'studio' && !S.result) return;
    const prev = S.view;
    if (v !== prev) {
      const a = audio[prev], b = audio[v];
      const playing = !a.paused;
      const t = mapTime(a.currentTime || 0, prev, v);
      a.pause();
      S.view = v;
      try { b.currentTime = t; } catch {}
      if (playing) b.play().catch(() => {});
      wave.setView(v, animate);
    }
    $('#timeTotal').textContent = fmtTime(durOf(v));
    $('#abOriginal').classList.toggle('is-active', v === 'original');
    $('#abStudio').classList.toggle('is-active', v === 'studio');
    body.classList.toggle('listening-studio', v === 'studio');
    $('#legend').classList.toggle('show', v === 'original' && !!(S.result && S.result.removedSeconds > 0));
    tick();
    updatePlayIcon();
  }

  const ww = $('#waveWrap');
  ww.addEventListener('mousemove', (e) => {
    const r = ww.getBoundingClientRect(), x = Math.max(0, Math.min(r.width, e.clientX - r.left));
    $('#waveHover').style.left = x + 'px';
    $('#waveHoverTime').textContent = fmtTime((x / r.width) * durOf(S.view));
  });
  ww.addEventListener('click', (e) => {
    if (!(S.state === 'ready' || S.state === 'done')) return;
    const r = ww.getBoundingClientRect();
    seekTo(((e.clientX - r.left) / r.width) * durOf(S.view));
  });

  /* ---------- Load ---------- */
  async function openPath(p) {
    if (!p) return;
    if (S.state === 'processing' || S.state === 'loading') { toast({ kind: 'info', title: 'Hang on — still working on the current file.' }); return; }
    stopAll();
    S.result = null; S.file = null; S.view = 'original';
    for (const k in audio) { audio[k].removeAttribute('src'); audio[k].load(); }
    $('#abStudio').disabled = true;
    $('#results').innerHTML = '';
    clearRowProgress();
    setView('original', false);
    renderFileHead(basename(p), null);
    renderDiagnosis(null);
    $('#chain').innerHTML = '';
    $('#waveStatusText').textContent = 'Listening to your recording…';
    $('#timeNow').textContent = '0:00.0'; $('#timeTotal').textContent = '0:00.0';
    wave.set({ loading: true, data: { original: null, studio: null }, cuts: [], progress: 0, scan: null });
    setState('loading');

    const r = await api.load(p);
    wave.set({ loading: false });
    if (!r.ok) {
      setState('empty');
      $('#titleFile').hidden = true;
      if (!r.cancelled) toast({ kind: 'bad', title: 'Couldn’t open that file', text: r.error, timeout: 8000 });
      return;
    }
    S.file = r.data;
    S.recommended = r.data.recommended;
    S.settings = structuredClone(r.data.recommended);
    renderFileHead(r.data.name, r.data.info);
    renderDiagnosis(r.data.analysis);
    renderChain();
    audio.original.src = r.data.previewUrl;
    wave.set({ data: { original: r.data.analysis.waveform, studio: null }, duration: { original: r.data.info.duration, studio: 0 } });
    setView('original', false);
    setState('ready');
  }

  async function pick() {
    const p = await api.pickFile();
    if (p) openPath(p);
  }

  /* ---------- Enhance ---------- */
  async function enhance() {
    if (!S.file || S.state === 'processing') return;
    stopAll();
    const wasDone = !!S.result;
    setView('original', false);
    clearRowProgress();
    setState('processing');
    setProgress({ phase: 'clean', value: 0 });
    const settings = structuredClone(S.settings);
    const r = await api.enhance(settings);
    wave.set({ scan: null });
    if (!r.ok) {
      clearRowProgress();
      setState(wasDone ? 'done' : 'ready');
      if (wasDone) setView('studio', false);
      if (!r.cancelled) toast({ kind: 'bad', title: 'Enhancement failed', text: r.error, timeout: 9000 });
      return;
    }
    S.result = r.data;
    S.snapshot = JSON.stringify(settings);
    audio.studio.src = r.data.previewUrl;
    const cuts = [];
    let prevEnd = 0;
    for (const [s, e] of r.data.segments) { if (s - prevEnd > 0.05) cuts.push([prevEnd, s]); prevEnd = e; }
    if (S.file.info.duration - prevEnd > 0.05) cuts.push([prevEnd, S.file.info.duration]);
    wave.set({ data: { original: S.file.analysis.waveform, studio: r.data.waveform }, cuts, duration: { original: S.file.info.duration, studio: r.data.duration } });
    $('#abStudio').disabled = false;
    renderResults();
    setState('done');
    setTimeout(() => clearRowProgress(), 900);
    setView('studio', true);
    toast({ title: 'Your studio audio is ready', text: 'Press Space to listen, B to compare with the original.' });
  }

  function setProgress({ phase, value }) {
    $('#busyLabel').textContent = PHASE_LABEL[phase] || 'Working';
    $('#busyPct').textContent = Math.round(value * 100) + '%';
    $('#busyBar').style.width = (value * 100).toFixed(1) + '%';
    wave.set({ scan: value });
    setRowProgress(value);
  }

  api.onProgress((p) => {
    if (p.task === 'load' && S.state === 'loading') $('#waveStatusText').textContent = `Listening to your recording… ${Math.round(p.value * 100)}%`;
    else if (p.task === 'enhance' && S.state === 'processing') setProgress(p);
    else if (p.task === 'export') { $('#exportPct').textContent = Math.round(p.value * 100) + '%'; $('#exportBar').style.width = (p.value * 100).toFixed(1) + '%'; }
  });

  /* ---------- Export ---------- */
  const FORMATS = [
    { id: 'wav', icon: 'file-audio', name: 'WAV', ext: '24-bit', desc: 'Lossless master. Best for editing and archiving.', badge: 'Best quality' },
    { id: 'flac', icon: 'file-audio', name: 'FLAC', ext: '24-bit', desc: 'Lossless and about half the size of WAV.' },
    { id: 'mp3', icon: 'file-audio', name: 'MP3', ext: '320 kbps', desc: 'Plays everywhere. Great for podcast hosts.' },
    { id: 'm4a', icon: 'file-audio', name: 'AAC (M4A)', ext: '256 kbps', desc: 'Compact and clean. Apple & mobile friendly.' },
  ];
  function videoAllowed() { return S.file.info.hasVideo && S.result && !(S.result.removedSeconds > 0); }
  function openExport() {
    if (S.state !== 'done') return;
    stopAll();
    const fm = $('#formats');
    const list = [...FORMATS];
    if (S.file.info.hasVideo) {
      list.unshift({ id: 'video', icon: 'film', name: 'Video with studio audio', ext: (S.file.name.split('.').pop() || 'mp4').toUpperCase(), wide: true,
        desc: videoAllowed() ? 'Your original picture, untouched, with the new soundtrack.' : 'Unavailable: pauses were trimmed, so picture and sound would drift apart. Turn off “Trim pauses” and apply.',
        disabled: !videoAllowed() });
    }
    if (!list.find((f) => f.id === S.format && !f.disabled)) S.format = (list.find((f) => !f.disabled) || list[1]).id;
    fm.innerHTML = list.map((f) => `
      <button type="button" class="fmt ${f.wide ? 'wide' : ''} ${f.id === S.format ? 'is-active' : ''}" data-id="${f.id}" ${f.disabled ? 'disabled' : ''}>
        <div class="fmt-top">${Icons.svg(f.icon)}${f.name}${f.badge ? `<span class="fmt-badge">${f.badge}</span>` : ''}<span class="fmt-ext">${f.ext}</span></div>
        <div class="fmt-desc">${f.desc}</div>
      </button>`).join('');
    fm.querySelectorAll('.fmt').forEach((b) => b.addEventListener('click', () => {
      S.format = b.dataset.id;
      fm.querySelectorAll('.fmt').forEach((x) => x.classList.toggle('is-active', x === b));
      $('#channelsRow').hidden = S.format === 'video';
    }));
    $('#channelsRow').hidden = S.format === 'video';
    $('#exportSub').textContent = body.classList.contains('dirty') ? 'Exports the last enhanced version — apply your changes first to include them.' : 'Choose a format for your studio audio.';
    $('#exportProgress').hidden = true;
    $('#btnSave').disabled = false;
    $('#exportSheet').hidden = false;
  }
  function closeExport() {
    if (S.exporting) return;
    $('#exportSheet').hidden = true;
    if (U.pending) setTimeout(showUpdate, 800);
  }
  $('#channelsSeg').querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => {
    S.channels = b.dataset.value;
    $('#channelsSeg').querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('is-active', x === b));
  }));
  async function doExport() {
    if (S.exporting) return;
    S.exporting = true;
    $('#btnSave').disabled = true;
    $('#exportPct').textContent = '0%'; $('#exportBar').style.width = '0%';
    $('#exportProgress').hidden = false;
    const r = await api.exportAudio({ format: S.format, channels: S.channels });
    S.exporting = false;
    $('#btnSave').disabled = false;
    $('#exportProgress').hidden = true;
    if (r.canceled) return;
    if (!r.ok) { if (!r.cancelled) toast({ kind: 'bad', title: 'Export failed', text: r.error, timeout: 9000 }); return; }
    closeExport();
    toast({ title: 'Exported', text: r.data.name, action: { label: 'Show in folder', icon: 'folder', fn: () => api.reveal(r.data.path) }, timeout: 9000 });
  }

  /* ---------- Wiring ---------- */
  $('#dropzone').addEventListener('click', pick);
  $('#dropzone').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); pick(); } });
  $('#btnChoose').addEventListener('click', (e) => { e.stopPropagation(); pick(); });
  $('#btnReplace').addEventListener('click', pick);
  $('#btnPlay').addEventListener('click', togglePlay);
  $('#btnBack').addEventListener('click', () => seekTo((cur().currentTime || 0) - 5));
  $('#btnFwd').addEventListener('click', () => seekTo((cur().currentTime || 0) + 5));
  $('#abOriginal').addEventListener('click', () => setView('original'));
  $('#abStudio').addEventListener('click', () => setView('studio'));
  $('#btnEnhance').addEventListener('click', enhance);
  $('#btnApply').addEventListener('click', enhance);
  $('#btnCancel').addEventListener('click', () => api.cancel());
  $('#btnExport').addEventListener('click', openExport);
  $('#btnSave').addEventListener('click', doExport);
  $('#btnSheetClose').addEventListener('click', closeExport);
  $('#btnSheetCancel').addEventListener('click', closeExport);
  $('#exportSheet').addEventListener('mousedown', (e) => { if (e.target.id === 'exportSheet') closeExport(); });
  $('#btnReset').addEventListener('click', () => {
    if (!S.recommended || S.state === 'processing') return;
    S.settings = structuredClone(S.recommended);
    renderChain(); updateDirty();
    toast({ kind: 'info', title: 'Back to recommended settings', timeout: 2500 });
  });

  // Drag & drop anywhere in the window.
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); if (++dragDepth === 1) { $('#dropOverlay').hidden = false; body.classList.add('is-dragging'); } });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true; body.classList.remove('is-dragging'); } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0; $('#dropOverlay').hidden = true; body.classList.remove('is-dragging');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    const p = api.pathForFile(f);
    if (p) openPath(p);
  });

  // Keyboard
  window.addEventListener('keydown', (e) => {
    const sheetOpen = !$('#exportSheet').hidden;
    const mod = e.ctrlKey || e.metaKey;
    if (!$('#updateModal').hidden) { if (e.key === 'Escape') closeUpdate(); return; }
    if (e.key === 'Escape') { if (sheetOpen) closeExport(); return; }
    if (sheetOpen) { if (e.key === 'Enter') { e.preventDefault(); doExport(); } return; }
    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); pick(); return; }
    if (mod && e.key === 'Enter') { e.preventDefault(); if (S.state === 'ready' || (S.state === 'done' && body.classList.contains('dirty'))) enhance(); return; }
    if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); openExport(); return; }
    if (mod) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (e.code === 'Space' && tag !== 'input') { e.preventDefault(); togglePlay(); return; }
    if (e.key.toLowerCase() === 'b' && S.result) { setView(S.view === 'original' ? 'studio' : 'original'); return; }
    if (e.key === 'ArrowLeft' && tag !== 'input') { seekTo((cur().currentTime || 0) - 5); }
    if (e.key === 'ArrowRight' && tag !== 'input') { seekTo((cur().currentTime || 0) + 5); }
  });

  /* ---------- Updates (GitHub Releases) ---------- */
  const U = { info: null, phase: 'idle', dismissed: null, pending: null };
  function renderNotes(text) {
    const box = $('#updateNotes');
    box.textContent = '';
    if (!text) { box.hidden = true; return; }
    let list = null;
    for (const line of text.split('\n')) {
      if (/^- /.test(line)) {
        if (!list) { list = document.createElement('ul'); box.appendChild(list); }
        const li = document.createElement('li'); li.textContent = line.slice(2); list.appendChild(li);
      } else {
        list = null;
        const p = document.createElement('p'); p.textContent = line; box.appendChild(p);
      }
    }
    box.hidden = false;
  }
  function setUpdatePhase(phase) {
    U.phase = phase;
    const go = $('#btnUpdateGo');
    $('#updateProgress').hidden = phase !== 'downloading';
    go.disabled = phase === 'downloading';
    $('#btnUpdateLater').hidden = phase === 'downloading';
    const label = { available: 'Download & install', downloading: 'Downloading…', ready: 'Restart to update' }[phase] || 'Download & install';
    $('#btnUpdateGoLabel').textContent = label;
    const icon = go.querySelector('[data-icon]');
    icon.dataset.icon = phase === 'ready' ? 'refresh' : 'download';
    Icons.hydrate(go);
    if (phase === 'ready') {
      $('#updateTitle').textContent = 'Ready to install';
      const busy = S.state === 'processing' || (S.result && body.classList.contains('dirty'));
      $('#updateSub').textContent = `Stuadio ${U.info.version} has been downloaded. ` + (S.result || busy ? 'Export anything you want to keep first — Stuadio will restart.' : 'Stuadio will restart to finish.');
    }
  }
  function showUpdate() {
    if (!U.info) return;
    // Never interrupt active work; show once the current task finishes.
    if (S.state === 'processing' || S.state === 'loading' || S.exporting || !$('#exportSheet').hidden) { U.pending = true; return; }
    U.pending = false;
    $('#updateTitle').textContent = 'Update available';
    $('#updateSub').textContent = `Stuadio ${U.info.version} is available. You have ${U.info.current}.`;
    renderNotes(U.info.notes);
    setUpdatePhase(U.phase === 'ready' ? 'ready' : 'available');
    $('#updateModal').hidden = false;
  }
  function closeUpdate() {
    if (U.phase === 'downloading') { $('#updateModal').hidden = true; return; } // keeps downloading in background
    $('#updateModal').hidden = true;
    if (U.info) U.dismissed = U.info.version;
  }
  api.onUpdate((m) => {
    if (m.type === 'available') {
      if (U.dismissed === m.version || (U.info && U.info.version === m.version)) return;
      U.info = m; U.phase = 'available';
      showUpdate();
    } else if (m.type === 'progress') {
      $('#updatePct').textContent = Math.round(m.percent) + '%';
      $('#updateBar').style.width = m.percent.toFixed(1) + '%';
    } else if (m.type === 'downloaded') {
      setUpdatePhase('ready');
      $('#updateModal').hidden = false;
    } else if (m.type === 'error') {
      setUpdatePhase('available');
      toast({ kind: 'bad', title: 'Update failed', text: m.message, timeout: 8000 });
    }
  });
  $('#btnUpdateGo').addEventListener('click', async () => {
    if (U.phase === 'ready') { api.installUpdate(); return; }
    if (U.phase === 'downloading') return;
    $('#updatePct').textContent = '0%'; $('#updateBar').style.width = '0%';
    setUpdatePhase('downloading');
    const r = await api.downloadUpdate();
    if (r && r.error) { setUpdatePhase('available'); toast({ kind: 'bad', title: 'Update failed', text: r.error, timeout: 8000 }); }
  });
  $('#btnUpdateLater').addEventListener('click', closeUpdate);
  $('#btnUpdateClose').addEventListener('click', closeUpdate);
  // Coming back online is a good moment to look for a new release.
  window.addEventListener('online', () => api.reportOnline());
  // Show a deferred update prompt once work finishes.
  const _setState = setState;
  setState = function (st) { _setState(st); if (U.pending && (st === 'ready' || st === 'done' || st === 'empty')) setTimeout(showUpdate, 1200); };

  setState('empty');
  // Hooks for the automated UI walkthrough (scripts only; not user-facing).
  window.__stuadio = { openPath, enhance, openExport, setView };
  window.__errors = [];
  window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)));
})();
