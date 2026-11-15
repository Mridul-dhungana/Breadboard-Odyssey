/* Live diagnostics for TIMER_DEMO — Arduino measure + Gemini coach only (no mocks). */
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

  const state = {
    stage: 'build',
    symptom: null,
    readings: [],
    pending: null,
    repairDone: false,
    verified: false,
    coach: 'Import the 555 timer netlist, auto-set or place parts, then add suggested jumpers.',
    coachSource: 'local'
  };

  function expectedFor(net) {
    return EXPECTED[net] || EXPECTED[net === 'GND' ? '0' : net];
  }

  function within(reading, exp) {
    if (!exp) return null;
    return Math.abs(reading - exp.nom) <= exp.tol;
  }

  function localCoach(ctx) {
    const { stage, snap } = ctx;
    if (stage === 'build') {
      if (!snap.hasTimer) return 'Load the 555 timer example, then place every part and draw the suggested jumpers.';
      if (!snap.allPlaced) return 'Place all parts on the board (Auto-set is fine).';
      if (!snap.allJumpersDrawn) return 'Add every suggested jumper so the nets are connected.';
      return 'Build looks complete. Open Debug, connect Arduino for LIVE scope, then Analyze with Gemini.';
    }
    if (stage === 'debug' || stage === 'investigate') {
      return 'Connect Arduino, Run scope until readout says LIVE, then Analyze signal with Gemini.';
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
      circuit: {
        hasTimer: snap.hasTimer,
        allPlaced: snap.allPlaced,
        allJumpersDrawn: snap.allJumpersDrawn,
        jumperCount: snap.jumpersDrawn?.length ?? 0,
        parts: snap.parts,
        nets: snap.placements.flatMap((p) => p.pins.map((pin) => pin.net))
      },
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
    const last = state.readings[state.readings.length - 1];
    if (!last) {
      return { title: 'No live readings yet', steps: ['Capture a LIVE Arduino reading on VCC.'] };
    }
    if (last.net === 'VCC' && !last.ok) {
      return {
        title: 'Restore the 5 V rail',
        steps: [
          'Confirm the DC supply part sits on the top + / − rails.',
          'Add the red VCC jumper from the supply strip to the IC VCC net.',
          'Re-measure VCC live from Arduino.'
        ]
      };
    }
    if (last.net === '0' && !last.ok) {
      return {
        title: 'Fix the ground return',
        steps: [
          'Check the blue ground jumper to the IC GND pin.',
          'Ensure the supply − lead is on the top − rail.',
          'Re-measure ground live from Arduino.'
        ]
      };
    }
    if (last.net === 'OUT' && last.volts < 0.3) {
      return {
        title: 'Clear the output short / stuck-low path',
        steps: [
          'Inspect OUT wiring for an accidental short to ground.',
          'Confirm RESET is tied to VCC in the TIMER_DEMO fixture.',
          'Re-measure OUT live from Arduino.'
        ]
      };
    }
    return {
      title: 'General TIMER_DEMO repair',
      steps: [
        'Revisit jumpers for VCC, GND, TIMING, and OUT.',
        'Reseat the NE555P profile (XU1) if pins look misaligned.',
        'Use Analyze signal with Gemini on a LIVE capture.'
      ]
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
    state.stage = 'process_fault';
    const snap = Board.snapshot();
    const payload = {
      stage: 'process_fault',
      intent: extra.intent || 'analyze_signal',
      symptom: state.symptom,
      readings: (state.readings || []).slice(-6),
      circuit: {
        hasTimer: snap.hasTimer,
        allPlaced: snap.allPlaced,
        allJumpersDrawn: snap.allJumpersDrawn,
        jumperCount: snap.jumpersDrawn?.length ?? 0
      },
      ...extra
    };
    try {
      const res = await fetch('/api/diagnose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('diagnose failed (' + res.status + ')');
      const data = await res.json();
      state.coach = data.message || 'Gemini returned no analysis.';
      state.coachSource = data.source || 'error';
      return data;
    } catch (err) {
      const message = 'Gemini request failed: ' + (err?.message || 'network error');
      state.coach = message;
      state.coachSource = 'error';
      return { message, source: 'error', reason: 'network_error', error: String(err?.message || err) };
    }
  }

  global.Diagnose = {
    SYMPTOMS,
    EXPECTED,
    state,
    askCoach,
    processFault,
    measure,
    requestMeasure,
    nextNetAfter,
    suggestRepair,
    evaluateVerify,
    expectedFor,
    within,
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
