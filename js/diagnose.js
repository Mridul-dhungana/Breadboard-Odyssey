/* Live diagnostics — Arduino measure + Gemini chat coach (no mocks). */
(function (global) {
  const EXPECTED = {
    VCC: { nom: 5.0, tol: 0.4, label: 'Supply rail' },
    '0': { nom: 0.0, tol: 0.15, label: 'Ground' },
    CTRL: { nom: 3.33, tol: 0.35, label: 'Control (≈⅔ VCC)' },
    OUT: { nom: 2.5, tol: 2.2, label: 'Output (astable average / either rail)' },
    TIMING: { nom: 2.5, tol: 1.4, label: 'Timing node (between ⅓–⅔ VCC)' },
    DISCHARGE: { nom: 2.5, tol: 2.5, label: 'Discharge node' }
  };

  const SYMPTOMS = [
    { id: 'no_blink', label: 'LED / output does not blink', firstNet: 'VCC' },
    { id: 'stuck_low', label: 'Output stuck low', firstNet: 'OUT' },
    { id: 'stuck_high', label: 'Output stuck high', firstNet: 'OUT' },
    { id: 'no_power', label: 'Board seems unpowered', firstNet: 'VCC' }
  ];

  const OPENING =
    "What's not working with your circuit? Describe the symptom — I'll ask clarifying questions if needed, then suggest probe or repair steps.";

  const state = {
    stage: 'build',
    symptom: null,
    readings: [],
    pending: null,
    repairDone: false,
    verified: false,
    coach: 'Import a netlist, auto-set or place parts — wires fit automatically.',
    coachSource: 'local',
    history: []
  };

  function expectedFor(net) {
    return EXPECTED[net] || EXPECTED[net === 'GND' ? '0' : net];
  }

  function within(reading, exp) {
    if (!exp) return null;
    return Math.abs(reading - exp.nom) <= exp.tol;
  }

  function circuitSnapshot() {
    const snap = Board.snapshot();
    return {
      hasTimer: snap.hasTimer,
      allPlaced: snap.allPlaced,
      allJumpersDrawn: snap.allJumpersDrawn,
      jumperCount: snap.jumpersDrawn?.length ?? 0,
      parts: (snap.parts || []).map((p) => ({
        id: p.id,
        kind: p.kind,
        value: p.value,
        nets: (p.pins || []).map((pin) => pin.net)
      })),
      nets: [
        ...new Set(
          (snap.placements || []).flatMap((p) => (p.pins || []).map((pin) => pin.net))
        )
      ]
    };
  }

  function historyForApi() {
    return state.history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role,
        text: String(m.text || '').slice(0, 1200),
        at: m.at || null
      }));
  }

  function pushMessage(role, text, meta = {}) {
    const msg = {
      id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      role,
      text: String(text || '').trim(),
      at: new Date().toISOString(),
      ...meta
    };
    if (!msg.text) return null;
    state.history.push(msg);
    if (role === 'assistant' || role === 'system') {
      state.coach = msg.text;
      state.coachSource = meta.source || (role === 'assistant' ? 'gemini' : 'local');
    }
    Diagnose.onHistoryChange?.(state.history);
    return msg;
  }

  function ensureOpening() {
    if (!state.history.length) {
      pushMessage('assistant', OPENING, { source: 'local', kind: 'opening' });
    }
  }

  function clearChat() {
    state.history = [];
    ensureOpening();
  }

  function localCoach(ctx) {
    const { stage, snap } = ctx;
    if (stage === 'build') {
      if (!snap.parts?.length) return 'Import a netlist (Divider, 555, or Dual LEDs), then place parts.';
      if (!snap.allPlaced) return 'Place all parts on the board (Auto-set is fine).';
      if (!snap.allJumpersDrawn) return 'Move parts or press Fit wires so every net can connect.';
      return 'Build looks complete. Open Debug and say what’s not working in the chat.';
    }
    if (stage === 'debug' || stage === 'investigate' || stage === 'chat') {
      return OPENING;
    }
    return 'Live Arduino + Gemini only — no simulated measurements.';
  }

  async function askCoach(extra = {}) {
    const snap = Board.snapshot();
    const payload = {
      stage: state.stage,
      symptom: state.symptom,
      pending: state.pending,
      readings: state.readings,
      circuit: circuitSnapshot(),
      ...extra
    };
    const fallback = localCoach({
      stage: state.stage,
      pending: state.pending,
      lastReading: state.readings[state.readings.length - 1],
      snap,
      symptom: state.symptom
    });
    try {
      const res = await fetch('/api/diagnose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('diagnose failed');
      const data = await res.json();
      state.coach = data.message || fallback;
      state.coachSource = data.source || 'local';
      return data;
    } catch {
      state.coach = fallback;
      state.coachSource = 'local';
      return { message: fallback, source: 'local' };
    }
  }

  async function sendChat(extra = {}) {
    ensureOpening();
    const userText = String(extra.userMessage || '').trim();
    if (userText) {
      pushMessage('user', userText, {
        kind: extra.markStepsDone ? 'steps_done' : extra.intent === 'analyze_signal' ? 'scope' : 'chat'
      });
    }

    state.stage = 'chat';
    const payload = {
      stage: 'chat',
      intent: extra.intent || (extra.markStepsDone ? 'steps_done' : 'chat'),
      userMessage: userText || null,
      markStepsDone: !!extra.markStepsDone,
      history: historyForApi(),
      circuit: circuitSnapshot(),
      readings: (state.readings || []).slice(-6),
      channel: extra.channel,
      net: extra.net,
      holes: extra.holes,
      scope: extra.scope
    };

    try {
      const res = await fetch('/api/diagnose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('diagnose failed (' + res.status + ')');
      const data = await res.json();
      const message = data.message || 'No reply from the coach.';
      pushMessage('assistant', message, {
        source: data.source || 'error',
        model: data.model || null
      });
      return data;
    } catch (err) {
      const message = 'Chat request failed: ' + (err?.message || 'network error');
      pushMessage('assistant', message, { source: 'error' });
      return { message, source: 'error', reason: 'network_error', error: String(err?.message || err) };
    }
  }

  async function measure(net, hole, manualVolts) {
    const exp = expectedFor(net);
    let volts = manualVolts;
    let source = 'manual';
    let meta = {};
    if (volts == null || Number.isNaN(volts)) {
      const res = await fetch('/api/measure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ net, hole })
      });
      const data = await res.json();
      if (data.source !== 'arduino' || data.voltage == null) {
        throw new Error(data.arduinoError || data.note || 'Arduino measure failed');
      }
      volts = data.voltage;
      source = 'arduino';
      meta = {
        channel: data.channel,
        note: data.note,
        live: true
      };
    }
    const reading = {
      net,
      hole,
      volts: Number(volts),
      expected: exp?.nom ?? null,
      ok: within(Number(volts), exp),
      source,
      ...meta,
      at: new Date().toISOString()
    };
    state.readings.push(reading);
    await askCoach({ lastReading: reading });
    return reading;
  }

  function requestMeasure(net) {
    const hit = Board.holeForNet(net) || (net === 'VCC' ? Board.holeForNet('VCC') : null);
    const hole = hit?.hole;
    const exp = expectedFor(net);
    state.pending = hole && exp ? { net, hole, expected: exp } : null;
    Board.setMeasureTargets(hole ? [hole] : []);
    return state.pending;
  }

  function nextNetAfter(reading) {
    if (!reading) return 'VCC';
    if (reading.net === 'VCC' && reading.ok === false) return null;
    if (reading.net === 'VCC') return '0';
    if (reading.net === '0') return 'OUT';
    if (reading.net === 'OUT') return 'CTRL';
    if (reading.net === 'CTRL') return 'TIMING';
    return null;
  }

  function suggestRepair() {
    return {
      title: 'Use Debug chat',
      steps: ['Describe the symptom in Debug chat and follow the coach steps.']
    };
  }

  function evaluateVerify() {
    const byNet = {};
    for (const r of state.readings) {
      if (r.source === 'arduino') byNet[r.net] = r;
    }
    const vcc = byNet.VCC;
    const gnd = byNet['0'];
    const out = byNet.OUT;
    const railsOk =
      vcc &&
      vcc.ok &&
      (!gnd || gnd.ok !== false) &&
      (!out || out.ok !== false || out.volts > 0.2);
    const pass = !!railsOk;
    state.verified = !!pass;
    return pass;
  }

  async function processFault(extra = {}) {
    // Scope capture attaches into the chat so history stays continuous.
    const scopeNote = extra.scope
      ? 'I captured a live scope sweep on ' +
        (extra.channel || 'ADC') +
        (extra.net ? ' (net ' + extra.net + ')' : '') +
        '. What does this signal suggest, and what should I do next?'
      : 'Please diagnose the circuit from the live scope capture.';
    return sendChat({
      ...extra,
      intent: extra.intent || 'analyze_signal',
      userMessage: extra.userMessage || scopeNote
    });
  }

  global.Diagnose = {
    SYMPTOMS,
    EXPECTED,
    OPENING,
    state,
    askCoach,
    sendChat,
    processFault,
    measure,
    requestMeasure,
    nextNetAfter,
    suggestRepair,
    evaluateVerify,
    expectedFor,
    within,
    pushMessage,
    ensureOpening,
    clearChat,
    historyForApi,
    onHistoryChange: null,
    setStage(stage) {
      state.stage = stage;
    },
    setFault() {
      /* mock fault model removed — live hardware only */
    },
    setSymptom(symptomId) {
      state.symptom = SYMPTOMS.find((s) => s.id === symptomId) || null;
    },
    clearReadings() {
      state.readings = [];
      state.pending = null;
      state.verified = false;
      Board.setMeasureTargets([]);
    }
  };
})(window);
