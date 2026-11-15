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
    lastVolts: null
  };

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
    // Always try primary hole for the net
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

  function draw(canvas, samples, opts = {}) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = '#0d1520';
    ctx.fillRect(0, 0, w, h);
    // Grid
    ctx.strokeStyle = '#243246';
    ctx.lineWidth = 1;
    for (let x = 0; x <= w; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y <= h; y += 28) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    // 0V / 5V guides
    const vmin = 0;
    const vmax = 5.5;
    const yAt = (v) => h - ((v - vmin) / (vmax - vmin)) * (h - 16) - 8;
    ctx.strokeStyle = '#3a516a';
    ctx.setLineDash([4, 4]);
    for (const v of [0, 1.65, 3.3, 5]) {
      const y = yAt(v);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillStyle = '#7f93a8';
      ctx.font = '11px monospace';
      ctx.fillText(v.toFixed(2) + 'V', 6, y - 3);
    }
    ctx.setLineDash([]);

    if (!samples.length) {
      ctx.fillStyle = '#7f93a8';
      ctx.fillText('No samples yet — press Run scope', 16, h / 2);
      return;
    }

    ctx.strokeStyle = opts.color || '#78efd2';
    ctx.lineWidth = 2;
    ctx.beginPath();
    samples.forEach((v, i) => {
      const x = (i / Math.max(samples.length - 1, 1)) * (w - 12) + 6;
      const y = yAt(v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  async function fetchSweep(channel, count = 80) {
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
    if (!state.running) return;
    try {
      const data = await fetchSweep(state.channel, 64);
      state.samples = data.volts || [];
      state.source = data.source || 'mock';
      state.lastVolts = state.samples.length ? state.samples[state.samples.length - 1] : null;
      draw(canvas, state.samples, { color: state.source === 'arduino' ? '#7bd9ef' : '#78efd2' });
      if (readout) {
        const avg =
          state.samples.reduce((a, b) => a + b, 0) / Math.max(state.samples.length, 1);
        readout.textContent = `${state.channel} · ${state.source} · now ${state.lastVolts?.toFixed(2) ?? '—'} V · avg ${avg.toFixed(2)} V · ${state.samples.length} pts`;
      }
      onUpdate?.(data);
    } catch (err) {
      if (readout) readout.textContent = 'Scope error: ' + err.message;
    }
    if (state.running) {
      state.timer = setTimeout(() => tick(canvas, readout, onUpdate), 350);
    }
  }

  function start(canvas, readout, onUpdate) {
    stop();
    state.running = true;
    tick(canvas, readout, onUpdate);
  }

  async function once(canvas, readout, onUpdate) {
    stop();
    const data = await fetchSweep(state.channel, 120);
    state.samples = data.volts || [];
    state.source = data.source || 'mock';
    state.lastVolts = state.samples.length ? state.samples[state.samples.length - 1] : null;
    draw(canvas, state.samples, { color: state.source === 'arduino' ? '#7bd9ef' : '#78efd2' });
    if (readout) {
      const avg = state.samples.reduce((a, b) => a + b, 0) / Math.max(state.samples.length, 1);
      readout.textContent = `${state.channel} · ${state.source} · single · avg ${avg.toFixed(2)} V`;
    }
    onUpdate?.(data);
    return data;
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
    once
  };
})(window);
