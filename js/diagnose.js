/* Closed-loop diagnostics for TIMER_DEMO (expected rails/nets + Gemini/mock coach). */
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

  const FAULTS = {
    healthy: { label: 'Healthy (mock)', offsets: {} },
    open_vcc: { label: 'Open VCC jumper (mock)', offsets: { VCC: 0.05, OUT: 0.02, CTRL: 0.02, TIMING: 0.02, DISCHARGE: 0.02 } },
    open_gnd: { label: 'Open ground return (mock)', offsets: { '0': 1.8, OUT: 1.1, CTRL: 4.2 } },
    out_short: { label: 'OUT shorted to GND (mock)', offsets: { OUT: 0.04 } },
    timing_open: { label: 'Timing cap open (mock)', offsets: { TIMING: 4.9, OUT: 0.1 } }
  };

  const state = {
    stage: 'build', // build | investigate | repair | verify
    symptom: null,
    fault: 'open_vcc',
    readings: [],
    pending: null, // { net, hole, expected }
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
    const { stage, pending, lastReading, snap, symptom } = ctx;
    if (stage === 'build') {
      if (!snap.hasTimer) return 'Load the 555 timer example, then place every part and draw the suggested jumpers.';
      if (!snap.allPlaced) return 'Place all parts on the board (Auto-set is fine for the demo).';
      if (!snap.allJumpersDrawn) return 'Add every suggested jumper so the nets are connected.';
      return 'Build looks complete. Advance to Investigate and report a symptom.';
    }
    if (stage === 'investigate') {
      if (!symptom) return 'Pick a symptom to start the measurement loop.';
      if (pending && !lastReading) {
        return `Probe ${pending.hole} on net ${pending.net}. Expected about ${pending.expected.nom.toFixed(2)} V (${pending.expected.label}).`;
      }
      if (lastReading) {
        const ok = within(lastReading.volts, expectedFor(lastReading.net));
        if (lastReading.net === 'VCC' && !ok) {
          return `VCC read ${lastReading.volts.toFixed(2)} V — far from 5 V. Likely an open supply jumper or unpowered rail. Move to Repair.`;
        }
        if (lastReading.net === '0' && !ok) {
          return `Ground read ${lastReading.volts.toFixed(2)} V. Check the ground return jumper and supply − rail.`;
        }
        if (lastReading.net === 'OUT' && lastReading.volts < 0.3) {
          return 'OUT is stuck near 0 V. Confirm VCC/GND first, then look for a short on the output net.';
        }
        if (ok) {
          return `${lastReading.net} looks plausible at ${lastReading.volts.toFixed(2)} V. Capture the next highlighted net or continue diagnosing.`;
        }
        return `${lastReading.net} is off (${lastReading.volts.toFixed(2)} V vs ~${expectedFor(lastReading.net)?.nom ?? '?'} V). Use that clue in Repair.`;
      }
      return 'Capture the highlighted measurement to continue.';
    }
    if (stage === 'repair') {
      if (state.fault === 'healthy') return 'Fault cleared in the mock. Re-measure in Verify.';
      return `Mock fault: ${FAULTS[state.fault]?.label || state.fault}. Apply the suggested fix (or set fault to Healthy), then Verify.`;
    }
    if (stage === 'verify') {
      if (state.verified) return 'Verify passed — supply and key nets match expected rails for TIMER_DEMO.';
      return 'Re-measure VCC and OUT (and CTRL if needed). Healthy mock readings should land near expected rails.';
    }
    return 'Follow the journey stages.';
  }

  async function askCoach(extra = {}) {
    const snap = Board.snapshot();
    const payload = {
      stage: state.stage,
      symptom: state.symptom,
      fault: state.fault,
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
      state.coachSource = data.source || 'mock';
      return data;
    } catch {
      state.coach = fallback;
      state.coachSource = 'local';
      return { message: fallback, source: 'local' };
    }
  }

  async function measure(net, hole, manualVolts, opts = {}) {
    const exp = expectedFor(net);
    let volts = manualVolts;
    let source = 'manual';
    let meta = {};
    if (volts == null || Number.isNaN(volts)) {
      try {
        const res = await fetch('/api/measure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ net, hole, fault: state.fault, forceMock: !!opts.forceMock })
        });
        const data = await res.json();
        volts = data.voltage;
        source = data.source || 'mock';
        meta = {
          channel: data.channel,
          arduinoError: data.arduinoError,
          note: data.note
        };
        if (typeof data.ok === 'boolean') {
          /* prefer server ok when present */
        }
      } catch {
        // Offline fallback mirrors server mock
        const base = FAULTS[state.fault]?.offsets?.[net];
        volts = base != null ? base : exp?.nom ?? 0;
        if (base == null && exp) volts = exp.nom + (Math.random() - 0.5) * 0.08;
        source = 'local-mock';
      }
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
    if (reading.net === 'VCC' && reading.ok === false) return null; // go repair
    if (reading.net === 'VCC') return '0';
    if (reading.net === '0') return 'OUT';
    if (reading.net === 'OUT') return 'CTRL';
    if (reading.net === 'CTRL') return 'TIMING';
    return null;
  }

  function suggestRepair() {
    const last = state.readings[state.readings.length - 1];
    if (!last) {
      return { title: 'No readings yet', steps: ['Return to Investigate and capture VCC.'] };
    }
    if (last.net === 'VCC' && !last.ok) {
      return {
        title: 'Restore the 5 V rail',
        steps: [
          'Confirm the DC supply part sits on the top + / − rails.',
          'Add the red VCC jumper from the supply strip to the IC VCC net.',
          'In this demo, set Mock fault → Healthy after “fixing”, then Verify.'
        ]
      };
    }
    if (last.net === '0' && !last.ok) {
      return {
        title: 'Fix the ground return',
        steps: [
          'Check the blue ground jumper to the IC GND pin.',
          'Ensure the supply − lead is on the top − rail.',
          'Set Mock fault → Healthy, then Verify.'
        ]
      };
    }
    if (last.net === 'OUT' && last.volts < 0.3) {
      return {
        title: 'Clear the output short / stuck-low path',
        steps: [
          'Inspect OUT wiring for an accidental short to ground.',
          'Confirm RESET is tied to VCC in the TIMER_DEMO fixture.',
          'Set Mock fault → Healthy, then Verify.'
        ]
      };
    }
    return {
      title: 'General TIMER_DEMO repair',
      steps: [
        'Revisit jumpers for VCC, GND, TIMING, and OUT.',
        'Reseat the NE555P profile (XU1) if pins look misaligned.',
        'Set Mock fault → Healthy for a clean verify pass.'
      ]
    };
  }

  function evaluateVerify() {
    const byNet = {};
    for (const r of state.readings) byNet[r.net] = r;
    const vcc = byNet.VCC;
    const gnd = byNet['0'];
    const out = byNet.OUT;
    const live = Object.values(byNet).some((r) => r.source === 'arduino');
    // Live Arduino: trust measured ok flags. Mock path: also require healthy fault model.
    const railsOk =
      vcc &&
      vcc.ok &&
      (!gnd || gnd.ok !== false) &&
      (!out || out.ok !== false || out.volts > 0.2);
    const pass = !!railsOk && (live || state.fault === 'healthy');
    state.verified = !!pass;
    return pass;
  }

  function localProcessFault(ctx) {
    const repair = suggestRepair();
    const scope = ctx.scope || {};
    const last = state.readings[state.readings.length - 1];
    const faultLabel = FAULTS[state.fault]?.label || state.fault;
    const volts =
      scope.lastVolts != null
        ? `${Number(scope.lastVolts).toFixed(2)} V on ${ctx.channel || 'A0'}`
        : last
          ? `${last.volts.toFixed(2)} V on ${last.net}`
          : 'no capture yet';
    return (
      `Likely issue: ${faultLabel}. Latest reading ${volts}. ` +
      `${repair.title}: ${repair.steps.slice(0, 2).join(' ')} ` +
      '(Set GEMINI_API_KEY for a live Gemini diagnosis.)'
    );
  }

  async function processFault(extra = {}) {
    state.stage = 'process_fault';
    const snap = Board.snapshot();
    const payload = {
      stage: 'process_fault',
      intent: extra.intent || 'analyze_signal',
      symptom: state.symptom,
      fault: state.fault,
      readings: state.readings,
      circuit: {
        hasTimer: snap.hasTimer,
        allPlaced: snap.allPlaced,
        allJumpersDrawn: snap.allJumpersDrawn,
        jumperCount: snap.jumpersDrawn?.length ?? 0,
        parts: snap.parts,
        jumpers: snap.routes,
        nets: snap.placements.flatMap((p) => p.pins.map((pin) => pin.net))
      },
      ...extra
    };
    const fallback = localProcessFault(extra);
    try {
      const res = await fetch('/api/diagnose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('diagnose failed (' + res.status + ')');
      const data = await res.json();
      state.coach = data.message || fallback;
      state.coachSource = data.source || 'mock';
      return data;
    } catch (err) {
      const message = 'Gemini request failed: ' + (err?.message || 'network error');
      state.coach = message;
      state.coachSource = 'local';
      return { message, source: 'local', reason: 'network_error', error: String(err?.message || err) };
    }
  }

  global.Diagnose = {
    SYMPTOMS,
    FAULTS,
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
    setFault(fault) {
      state.fault = fault;
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
