/* Oscilloscope helper for Debug mode (A0 by default). */
(function (global) {
  const CHANNEL_NET = {
    A0: 'VCC',
    A1: '0',
    A2: 'OUT',
    A3: 'CTRL',
    A4: 'TIMING',
    A5: 'DISCHARGE'
  };

  const state = {
    running: false,
    timer: null,
    channel: 'A0',
    samples: [],
    source: 'mock',
    lastVolts: null,
    expanded: false,
    inFlight: false
  };

  const RUN_SAMPLES = 40;
  const ONCE_SAMPLES = 120;
  const RUN_INTERVAL_MS = 90;

  function netFor(channel) {
    return CHANNEL_NET[String(channel || 'A0').toUpperCase()] || 'VCC';
  }

  function holesForChannel(channel) {
    const net = netFor(channel);
    const snap = Board.snapshot();
    const holes = [];
    for (const place of snap.placements) {
      for (const pin of place.pins) {
        if (pin.net === net || (net === '0' && pin.net === '0')) {
          holes.push(pin.hole);
        }
      }
    }
    const hit = Board.holeForNet(net);
    if (hit?.hole && !holes.includes(hit.hole)) holes.push(hit.hole);
    return { net, holes: [...new Set(holes)] };
  }

  function highlightProbe(channel) {
    state.channel = (channel || 'A0').toUpperCase();
    const { net, holes } = holesForChannel(state.channel);
    Board.setMeasureTargets(holes);
    return { net, holes };
  }

  function syncCanvasSize(canvas) {
    if (!canvas) return;
    const wrap = canvas.parentElement;
    const cssW = Math.max(wrap?.clientWidth || canvas.clientWidth || 720, 320);
    const ratio = state.expanded ? 16 / 9 : 720 / 320;
    const cssH = state.expanded
      ? Math.max(Math.min(window.innerHeight * 0.72, cssW / ratio), 280)
      : Math.max(cssW / ratio, 220);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const tw = Math.round(cssW * dpr);
    const th = Math.round(cssH * dpr);
    if (canvas.width !== tw || canvas.height !== th) {
      canvas.width = tw;
      canvas.height = th;
    }
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
  }

  function draw(canvas, samples, opts = {}) {
    if (!canvas) return;
    syncCanvasSize(canvas);
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const scale = w / 720;
    ctx.fillStyle = '#030303';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = Math.max(1, scale);
    const gx = 40 * scale;
    const gy = 28 * scale;
    for (let x = 0; x <= w; x += gx) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y <= h; y += gy) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    const vmin = 0;
    const vmax = 5.5;
    const yAt = (v) => h - ((v - vmin) / (vmax - vmin)) * (h - 16 * scale) - 8 * scale;
    ctx.strokeStyle = '#2a2a2a';
    ctx.setLineDash([4 * scale, 4 * scale]);
    for (const v of [0, 1.65, 3.3, 5]) {
      const y = yAt(v);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillStyle = '#6a6a6a';
      ctx.font = `${Math.max(11, 12 * scale)}px "IBM Plex Mono", monospace`;
      ctx.fillText(v.toFixed(2) + 'V', 6 * scale, y - 3 * scale);
    }
    ctx.setLineDash([]);

    if (!samples.length) {
      ctx.fillStyle = '#6a6a6a';
      ctx.fillText('No samples yet — press Run scope', 16 * scale, h / 2);
      return;
    }

    ctx.strokeStyle = opts.color || '#3dff9a';
    ctx.lineWidth = Math.max(2, 2 * scale);
    ctx.beginPath();
    samples.forEach((v, i) => {
      const x = (i / Math.max(samples.length - 1, 1)) * (w - 12 * scale) + 6 * scale;
      const y = yAt(v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  async function fetchSweep(channel, count = RUN_SAMPLES) {
    const res = await fetch('/api/scope', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, samples: count })
    });
    if (!res.ok) throw new Error('scope failed');
    return res.json();
  }

  function stop() {
    state.running = false;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  async function tick(canvas, readout, onUpdate) {
    if (!state.running || state.inFlight) {
      if (state.running) {
        state.timer = setTimeout(() => tick(canvas, readout, onUpdate), RUN_INTERVAL_MS);
      }
      return;
    }
    state.inFlight = true;
    try {
      const data = await fetchSweep(state.channel, RUN_SAMPLES);
      state.samples = data.volts || [];
      state.source = data.source || 'mock';
      state.lastVolts = state.samples.length ? state.samples[state.samples.length - 1] : null;
      draw(canvas, state.samples, { color: state.source === 'arduino' ? '#5ad6ff' : '#3dff9a' });
      if (readout) {
        const avg =
          state.samples.reduce((a, b) => a + b, 0) / Math.max(state.samples.length, 1);
        readout.textContent = `${state.channel} · ${state.source} · now ${state.lastVolts?.toFixed(2) ?? '—'} V · avg ${avg.toFixed(2)} V · ${state.samples.length} pts`;
      }
      onUpdate?.(data);
    } catch (err) {
      if (readout) readout.textContent = 'Scope error: ' + err.message;
    } finally {
      state.inFlight = false;
    }
    if (state.running) {
      state.timer = setTimeout(() => tick(canvas, readout, onUpdate), RUN_INTERVAL_MS);
    }
  }

  function start(canvas, readout, onUpdate) {
    stop();
    state.running = true;
    tick(canvas, readout, onUpdate);
  }

  async function once(canvas, readout, onUpdate) {
    stop();
    const data = await fetchSweep(state.channel, ONCE_SAMPLES);
    state.samples = data.volts || [];
    state.source = data.source || 'mock';
    state.lastVolts = state.samples.length ? state.samples[state.samples.length - 1] : null;
    draw(canvas, state.samples, { color: state.source === 'arduino' ? '#5ad6ff' : '#3dff9a' });
    if (readout) {
      const avg = state.samples.reduce((a, b) => a + b, 0) / Math.max(state.samples.length, 1);
      readout.textContent = `${state.channel} · ${state.source} · single · avg ${avg.toFixed(2)} V`;
    }
    onUpdate?.(data);
    return data;
  }

  function setExpanded(expanded, canvas) {
    state.expanded = !!expanded;
    const panel = document.getElementById('scopePanel');
    const expandBtn = document.getElementById('scopeExpand');
    const collapseBtn = document.getElementById('scopeCollapse');
    document.body.classList.toggle('scope-expanded', state.expanded);
    panel?.classList.toggle('expanded', state.expanded);
    if (expandBtn) {
      expandBtn.setAttribute('aria-expanded', state.expanded ? 'true' : 'false');
      expandBtn.textContent = state.expanded ? 'Expanded' : 'Expand scope';
      expandBtn.disabled = state.expanded;
    }
    if (collapseBtn) collapseBtn.hidden = !state.expanded;
    if (canvas) draw(canvas, state.samples, { color: state.source === 'arduino' ? '#5ad6ff' : '#3dff9a' });
  }

  global.Scope = {
    CHANNEL_NET,
    state,
    netFor,
    holesForChannel,
    highlightProbe,
    draw,
    start,
    stop,
    once,
    setExpanded,
    syncCanvasSize
  };
})(window);
