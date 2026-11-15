(function () {
  const $ = (id) => document.getElementById(id);
  let mode = 'build'; // build | debug
  let processBusy = false;

  function setMode(next) {
    mode = next;
    $('stage-build').classList.toggle('active', mode === 'build');
    $('stage-debug').classList.toggle('active', mode === 'debug');
    $('panel-build').hidden = mode !== 'build';
    $('panel-debug').hidden = mode !== 'debug';
    if (mode === 'debug') {
      enterDebug();
    } else {
      Scope.stop();
      Scope.setExpanded(false, $('scopeCanvas'));
      Board.setMeasureTargets([]);
      $('probeHint').textContent = '';
      refreshCoach();
    }
    updateBuildChecklist();
  }

  function updateCoach(message, source) {
    if (message) {
      Diagnose.state.coach = message;
      Diagnose.state.coachSource = source || 'local';
    }
    const el = $('coach');
    const src = Diagnose.state.coachSource;
    el.innerHTML = '';
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = 'Next action';
    const badge = document.createElement('span');
    badge.className = 'badge ' + (src === 'gemini' ? 'live' : 'mock');
    badge.textContent = src === 'gemini' ? 'Gemini' : src === 'local' ? 'Local' : 'Mock coach';
    tag.append(badge);
    const body = document.createElement('div');
    body.textContent = Diagnose.state.coach;
    el.append(tag, body);
  }

  function wiringReady(snap) {
    return snap.allPlaced && snap.allJumpersDrawn && snap.parts.length > 0;
  }

  function updateProcessFaultButtons(ready) {
    for (const id of ['processFault', 'processFaultBuild']) {
      const btn = $(id);
      if (!btn) continue;
      btn.disabled = !ready || processBusy;
      btn.title = ready
        ? 'Send circuit + scope context to Gemini for a fault diagnosis'
        : 'Draw all suggested jumpers first';
      if (processBusy) btn.textContent = 'Gemini working…';
      else btn.textContent = 'Ask Gemini: process fault';
    }
  }

  function updateBuildChecklist() {
    const snap = Board.snapshot();
    const items = [
      ['timer', snap.hasTimer || snap.parts.length > 0, 'Netlist imported'],
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
    const ready = wiringReady(snap);
    $('toDebug').disabled = !ready;
    updateProcessFaultButtons(ready);
  }

  async function refreshCoach() {
    Diagnose.setStage(mode === 'debug' ? 'investigate' : 'build');
    if (mode === 'debug') {
      const ch = $('scopeChannel').value;
      const { net, holes } = Scope.holesForChannel(ch);
      Diagnose.state.coach =
        `Debug probe on ${ch} (net ${net}). Yellow holes mark probing points` +
        (holes.length ? ` (${holes.slice(0, 4).join(', ')}${holes.length > 4 ? '…' : ''})` : ' — place parts first') +
        '. Run scope to plot the waveform. When all wires are set, use Ask Gemini: process fault.';
      Diagnose.state.coachSource = 'local';
      updateCoach();
      return;
    }
    await Diagnose.askCoach();
    updateCoach();
  }

  function enterDebug() {
    const ch = $('scopeChannel').value || 'A0';
    const { net, holes } = Scope.highlightProbe(ch);
    $('probeHint').textContent = holes.length
      ? `Probing ${ch} → net ${net} at ${holes.join(', ')}`
      : `Probing ${ch} → net ${net}. Place parts so probe holes can be highlighted.`;
    const canvas = $('scopeCanvas');
    Scope.draw(canvas, Scope.state.samples);
    $('scopeReadout').textContent = 'Ready — press Run scope';
    refreshCoach();
    Board.status(`Debug: probe ${ch} (${net}). Yellow = probing points.`);
  }

  async function refreshHwStatus() {
    const el = $('hwStatus');
    if (!el) return;
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      const gem = data.gemini?.configured
        ? `Gemini ready (${data.gemini.model})`
        : 'Gemini off — set GEMINI_API_KEY in .env';
      const ard = data.arduino || {};
      let a;
      if (!ard.enabled) a = 'Arduino off — set ARDUINO_PORT for live A0';
      else if (ard.connected) a = `Arduino live on ${ard.port}`;
      else a = `Arduino ${ard.port} not connected${ard.lastError ? ' (' + ard.lastError + ')' : ''}`;
      el.textContent = gem + ' · ' + a;
      el.className = ard.connected && data.gemini?.configured ? 'status ok' : 'muted';
    } catch {
      el.textContent = 'Server status unavailable (is python/server.py running?)';
      el.className = 'status error';
    }
  }

  async function processFault() {
    const snap = Board.snapshot();
    if (!wiringReady(snap)) {
      updateCoach('Finish placing parts and draw every suggested jumper before asking Gemini.', 'local');
      return;
    }
    processBusy = true;
    updateProcessFaultButtons(true);
    updateCoach('Capturing scope context and asking Gemini to diagnose the fault…', 'local');
    try {
      if (mode !== 'debug') setMode('debug');
      const ch = $('scopeChannel').value || 'A0';
      Scope.highlightProbe(ch);
      let scopeData = null;
      try {
        scopeData = await Scope.once($('scopeCanvas'), $('scopeReadout'));
      } catch (e) {
        $('scopeReadout').textContent = 'Capture failed: ' + e.message;
      }
      const data = await Diagnose.processFault({
        channel: ch,
        net: Scope.netFor(ch),
        holes: Scope.holesForChannel(ch).holes,
        scope: {
          samples: Scope.state.samples,
          lastVolts: Scope.state.lastVolts,
          source: Scope.state.source,
          note: scopeData?.note
        }
      });
      updateCoach(data.message, data.source);
      Board.status(data.source === 'gemini' ? 'Gemini fault analysis ready.' : 'Fault analysis ready (mock/local).');
    } catch (e) {
      updateCoach('Could not process fault: ' + e.message, 'local');
    } finally {
      processBusy = false;
      updateProcessFaultButtons(wiringReady(Board.snapshot()));
    }
  }

  function initUi() {
    $('stage-build').onclick = () => setMode('build');
    $('stage-debug').onclick = () => setMode('debug');
    $('toDebug').onclick = () => setMode('debug');

    $('scopeChannel').onchange = () => {
      if (mode === 'debug') enterDebug();
    };
    // Scope tick stays local — Gemini only via Process fault button
    $('scopeRun').onclick = () => {
      Scope.highlightProbe($('scopeChannel').value);
      Scope.start($('scopeCanvas'), $('scopeReadout'));
    };
    $('scopeStop').onclick = () => {
      Scope.stop();
      $('scopeReadout').textContent = 'Stopped';
    };
    $('scopeOnce').onclick = async () => {
      Scope.highlightProbe($('scopeChannel').value);
      try {
        await Scope.once($('scopeCanvas'), $('scopeReadout'));
      } catch (e) {
        $('scopeReadout').textContent = 'Capture failed: ' + e.message;
      }
    };
    $('scopeExpand').onclick = () => Scope.setExpanded(true, $('scopeCanvas'));
    $('scopeCollapse').onclick = () => Scope.setExpanded(false, $('scopeCanvas'));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && Scope.state.expanded) {
        Scope.setExpanded(false, $('scopeCanvas'));
      }
    });
    window.addEventListener('resize', () => {
      if (mode === 'debug') Scope.draw($('scopeCanvas'), Scope.state.samples);
    });

    $('processFault').onclick = () => processFault();
    $('processFaultBuild').onclick = () => processFault();

    $('refreshHw').onclick = () => refreshHwStatus();
    $('reconnectArduino').onclick = async () => {
      try {
        await fetch('/api/arduino/reconnect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        });
      } catch {}
      await refreshHwStatus();
    };

    Board.onChange = () => {
      updateBuildChecklist();
      if (mode === 'debug') {
        Scope.highlightProbe($('scopeChannel').value);
        const { net, holes } = Scope.holesForChannel($('scopeChannel').value);
        $('probeHint').textContent = holes.length
          ? `Probing ${$('scopeChannel').value} → net ${net} at ${holes.join(', ')}`
          : `Probing ${$('scopeChannel').value} → net ${net}`;
      }
      if (mode === 'build') refreshCoach();
    };
  }

  Board.init();
  initUi();
  updateBuildChecklist();
  refreshHwStatus();
  refreshCoach();
  setInterval(refreshHwStatus, 15000);
})();
