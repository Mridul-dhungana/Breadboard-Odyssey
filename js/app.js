(function () {
  const $ = (id) => document.getElementById(id);
  const stages = ['build', 'investigate', 'repair', 'verify'];

  function renderJourney() {
    const stage = Diagnose.state.stage;
    for (const s of stages) {
      const btn = $('stage-' + s);
      if (!btn) continue;
      btn.classList.toggle('active', s === stage);
      const idx = stages.indexOf(s);
      const cur = stages.indexOf(stage);
      btn.classList.toggle('done', idx < cur);
    }
    $('panel-build').hidden = stage !== 'build';
    $('panel-investigate').hidden = stage !== 'investigate';
    $('panel-repair').hidden = stage !== 'repair';
    $('panel-verify').hidden = stage !== 'verify';
    updateCoach();
    updateBuildChecklist();
    updateReadings();
    updateRepair();
  }

  function updateCoach() {
    const el = $('coach');
    const src = Diagnose.state.coachSource;
    el.innerHTML = '';
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = 'Next action';
    const badge = document.createElement('span');
    badge.className = 'badge ' + (src === 'gemini' ? 'live' : 'mock');
    badge.textContent = src === 'gemini' ? 'Gemini' : src === 'local' ? 'Local heuristics' : 'Mock coach';
    tag.append(badge);
    const body = document.createElement('div');
    body.textContent = Diagnose.state.coach;
    el.append(tag, body);
  }

  function updateBuildChecklist() {
    const snap = Board.snapshot();
    const items = [
      ['timer', snap.hasTimer, '555 TIMER_DEMO imported'],
      ['placed', snap.allPlaced, 'All parts placed'],
      ['jumpers', snap.allJumpersDrawn, 'Suggested jumpers drawn']
    ];
    const ul = $('buildChecklist');
    ul.replaceChildren();
    for (const [, ok, label] of items) {
      const li = document.createElement('li');
      li.textContent = (ok ? '✓ ' : '○ ') + label;
      li.className = ok ? 'ok' : 'muted';
      ul.append(li);
    }
    $('toInvestigate').disabled = !(snap.hasTimer && snap.allPlaced && snap.allJumpersDrawn);
  }

  function fillReadingsBox(box) {
    if (!box) return;
    box.replaceChildren();
    if (!Diagnose.state.readings.length) {
      box.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'No readings yet.' }));
      return;
    }
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (const h of ['Net', 'Hole', 'V', 'Expect', 'OK', 'Src']) head.append(Object.assign(document.createElement('th'), { textContent: h }));
    const body = table.createTBody();
    for (const r of Diagnose.state.readings.slice().reverse()) {
      const tr = body.insertRow();
      for (const v of [
        r.net,
        r.hole,
        r.volts.toFixed(2),
        r.expected == null ? '—' : r.expected.toFixed(2),
        r.ok == null ? '—' : r.ok ? 'yes' : 'no',
        r.source
      ]) {
        tr.append(Object.assign(document.createElement('td'), { textContent: v }));
      }
    }
    box.append(table);
  }

  function updateReadings() {
    fillReadingsBox($('readings'));
    fillReadingsBox($('verifyReadings'));
  }

  function updateRepair() {
    const guide = Diagnose.suggestRepair();
    $('repairTitle').textContent = guide.title;
    const ol = $('repairSteps');
    ol.replaceChildren();
    for (const step of guide.steps) {
      const li = document.createElement('li');
      li.textContent = step;
      ol.append(li);
    }
    $('fault').value = Diagnose.state.fault;
  }

  async function refreshCoach() {
    await Diagnose.askCoach();
    updateCoach();
  }

  function setStage(stage) {
    Diagnose.setStage(stage);
    if (stage === 'investigate' && Diagnose.state.symptom && !Diagnose.state.pending) {
      const net = Diagnose.state.symptom.firstNet;
      Diagnose.requestMeasure(net);
    }
    if (stage === 'verify') {
      Diagnose.clearReadings();
      Diagnose.requestMeasure('VCC');
    }
    renderJourney();
    refreshCoach();
  }

  async function captureReading(manual) {
    const pending = Diagnose.state.pending;
    if (!pending) {
      Board.status('No measurement requested yet.', true);
      return;
    }
    const volts = manual ? Number($('manualVolts').value) : null;
    const reading = await Diagnose.measure(pending.net, pending.hole, manual ? volts : null);
    updateReadings();
    updateCoach();
    Board.status(
      `Measured ${reading.net} at ${reading.hole}: ${reading.volts.toFixed(2)} V` +
        (reading.ok === false ? ' (off expected)' : reading.ok ? ' (ok)' : '')
    );

    if (Diagnose.state.stage === 'investigate') {
      if (reading.ok === false && (reading.net === 'VCC' || reading.net === '0' || (reading.net === 'OUT' && reading.volts < 0.3))) {
        $('toRepair').disabled = false;
      }
      const next = Diagnose.nextNetAfter(reading);
      if (next) {
        Diagnose.requestMeasure(next);
        await refreshCoach();
      } else {
        Board.setMeasureTargets([]);
        Diagnose.state.pending = null;
        $('toRepair').disabled = false;
        await refreshCoach();
      }
    }

    if (Diagnose.state.stage === 'verify') {
      if (reading.net === 'VCC') {
        Diagnose.requestMeasure('OUT');
        await refreshCoach();
      } else if (reading.net === 'OUT') {
        Diagnose.requestMeasure('CTRL');
        await refreshCoach();
      } else {
        const pass = Diagnose.evaluateVerify();
        Board.setMeasureTargets([]);
        Diagnose.state.pending = null;
        $('verifyResult').textContent = pass
          ? 'Verify passed. TIMER_DEMO rails look healthy.'
          : 'Verify failed. Return to Repair or set Mock fault to Healthy and re-measure.';
        $('verifyResult').className = 'status ' + (pass ? 'ok' : 'error');
        await refreshCoach();
      }
    }
    renderJourney();
  }

  function initUi() {
    const faultSel = $('fault');
    for (const [id, meta] of Object.entries(Diagnose.FAULTS)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = meta.label;
      faultSel.append(opt);
    }
    faultSel.value = Diagnose.state.fault;

    const symptomSel = $('symptom');
    for (const s of Diagnose.SYMPTOMS) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.label;
      symptomSel.append(opt);
    }

    for (const s of stages) {
      $('stage-' + s).onclick = () => {
        // Allow free navigation for demo, but encourage forward flow
        setStage(s);
      };
    }

    $('toInvestigate').onclick = () => setStage('investigate');
    $('startSymptom').onclick = async () => {
      Diagnose.setSymptom($('symptom').value);
      Diagnose.clearReadings();
      $('toRepair').disabled = true;
      const net = Diagnose.state.symptom.firstNet;
      Diagnose.requestMeasure(net);
      await refreshCoach();
      updateReadings();
      Board.status('Measure the highlighted hole for ' + net + '.');
    };
    $('captureMock').onclick = () => captureReading(false);
    $('captureManual').onclick = () => captureReading(true);
    $('captureVerify').onclick = () => captureReading(false);
    $('toRepair').onclick = () => setStage('repair');
    $('markRepaired').onclick = async () => {
      Diagnose.setFault('healthy');
      Diagnose.state.repairDone = true;
      $('fault').value = 'healthy';
      await refreshCoach();
      updateRepair();
      Board.status('Mock fault cleared. Continue to Verify.');
    };
    $('toVerify').onclick = () => setStage('verify');
    $('fault').onchange = async () => {
      Diagnose.setFault($('fault').value);
      await refreshCoach();
    };
    Board.onChange = () => {
      if (Diagnose.state.stage === 'build') updateBuildChecklist();
      refreshCoach();
    };
    Board.onMeasureClick = (hole, net) => {
      if (Diagnose.state.pending && Diagnose.state.pending.hole === hole) {
        captureReading(false);
      } else if (net) {
        Board.status('Clicked ' + hole + ' (' + net + '). Use Capture mock reading when it is the requested net.');
      }
    };
  }

  Board.init();
  initUi();
  renderJourney();
  refreshCoach();
})();
