(function () {
  const $ = (id) => document.getElementById(id);
  let mode = 'build'; // build | debug
  let processBusy = false;
  let geminiReady = false;
  const ANALYZE_LABEL = 'Analyze signal with Gemini';

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

  function updateCoach(message, source, tone) {
    if (message) {
      Diagnose.state.coach = message;
      Diagnose.state.coachSource = source || 'local';
    }
    const el = $('coach');
    const src = Diagnose.state.coachSource;
    el.innerHTML = '';
    el.className = 'coach' + (tone === 'error' ? ' error' : tone === 'warn' ? ' warn' : '');
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = 'Next action';
    const badge = document.createElement('span');
    if (src === 'gemini') {
      badge.className = 'badge live';
      badge.textContent = 'Gemini';
    } else if (src === 'error') {
      badge.className = 'badge off';
      badge.textContent = 'Error';
    } else {
      badge.className = 'badge';
      badge.textContent = 'Local';
    }
    tag.append(badge);
    const body = document.createElement('div');
    body.textContent = Diagnose.state.coach;
    el.append(tag, body);
  }

  function wiringReady(snap) {
    return snap.allPlaced && snap.allJumpersDrawn && snap.parts.length > 0;
  }

  function updateProcessFaultButtons(ready) {
    const buildBtn = $('processFaultBuild');
    const debugBtn = $('processFault');
    if (buildBtn) {
      buildBtn.disabled = !ready || processBusy;
      buildBtn.title = ready
        ? 'Send circuit + scope context to Gemini'
        : 'Draw all suggested jumpers first';
      buildBtn.textContent = processBusy ? 'Gemini analyzing…' : ANALYZE_LABEL;
    }
    if (debugBtn) {
      // Debug: always allow signal analysis (capture first if needed)
      debugBtn.disabled = processBusy;
      debugBtn.title = geminiReady
        ? 'Capture waveform and ask Gemini to diagnose the signal'
        : 'Gemini API key missing — click to see setup steps';
      debugBtn.textContent = processBusy ? 'Gemini analyzing…' : ANALYZE_LABEL;
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
        '. Run scope, then use Analyze signal with Gemini.';
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

  function fillArduinoPorts(arduino) {
    const sel = $('arduinoPort');
    if (!sel) return;
    const ports = arduino?.ports || [];
    const current = arduino?.port || '';
    const prev = sel.value;
    sel.replaceChildren();
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'Auto-detect';
    sel.append(auto);
    for (const p of ports) {
      const opt = document.createElement('option');
      opt.value = p.device;
      opt.textContent = `${p.device}${p.description ? ' — ' + p.description : ''}`;
      sel.append(opt);
    }
    if (current && ![...sel.options].some((o) => o.value === current)) {
      const opt = document.createElement('option');
      opt.value = current;
      opt.textContent = current + (arduino?.autodetected ? ' (auto)' : '');
      sel.append(opt);
    }
    sel.value = prev || current || '';
  }

  async function refreshHwStatus() {
    const el = $('hwStatus');
    if (!el) return;
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      geminiReady = !!data.gemini?.configured;
      const gem = geminiReady
        ? `Gemini ready (${data.gemini.model})`
        : 'Gemini off — add GEMINI_API_KEY to .env, then Refresh links';
      const ard = data.arduino || {};
      fillArduinoPorts(ard);
      let a;
      if (!ard.enabled) {
        a = 'Arduino off — plug in board or set ARDUINO_PORT (scope will not invent live data)';
      } else if (ard.connected) {
        a = `Arduino LIVE on ${ard.port}${ard.autodetected ? ' (auto)' : ''}`;
      } else {
        a = `Arduino ${ard.port} not connected${ard.lastError ? ' (' + ard.lastError + ')' : ''}`;
      }
      el.textContent = gem + ' · ' + a;
      el.className = 'hw-status ' + (ard.connected ? 'ok' : 'error');
      updateProcessFaultButtons(wiringReady(Board.snapshot()));
    } catch {
      geminiReady = false;
      el.textContent = 'Server status unavailable (is python/server.py running?)';
      el.className = 'hw-status error';
    }
  }

  function signalStats(samples) {
    if (!samples?.length) return null;
    let min = samples[0];
    let max = samples[0];
    let sum = 0;
    for (const v of samples) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    return {
      count: samples.length,
      min: Number(min.toFixed(3)),
      max: Number(max.toFixed(3)),
      avg: Number((sum / samples.length).toFixed(3)),
      pkpk: Number((max - min).toFixed(3)),
      last: Number(samples[samples.length - 1].toFixed(3))
    };
  }

  async function processFault() {
    processBusy = true;
    updateProcessFaultButtons(wiringReady(Board.snapshot()));
    updateCoach('Capturing signal and requesting Gemini analysis…', 'local');
    try {
      if (mode !== 'debug') {
        if (!wiringReady(Board.snapshot())) {
          updateCoach(
            'Finish placing parts and draw every suggested jumper, or open Debug and capture a waveform first.',
            'local',
            'warn'
          );
          return;
        }
        setMode('debug');
      }
      await refreshHwStatus();
      if (!geminiReady) {
        updateCoach(
          'Gemini is not analyzing because GEMINI_API_KEY is not set on the server. Create /workspace/.env with GEMINI_API_KEY=… (or add it as a Cursor Cloud Agent secret), restart python/server.py, then press Analyze signal with Gemini again.',
          'local',
          'error'
        );
        Board.status('Gemini unavailable — API key missing.');
        return;
      }

      const ch = $('scopeChannel').value || 'A0';
      Scope.highlightProbe(ch);
      let scopeData = null;
      try {
        scopeData = await Scope.once($('scopeCanvas'), $('scopeReadout'));
      } catch (e) {
        $('scopeReadout').textContent = 'Capture failed: ' + e.message;
        updateCoach('Could not capture scope signal: ' + e.message, 'local', 'error');
        return;
      }
      if (scopeData?.source !== 'arduino' || !Scope.state.samples.length) {
        updateCoach(
          'Cannot analyze — need a LIVE Arduino capture: ' +
            (scopeData?.arduinoError || scopeData?.note || 'not connected') +
            '. Pick the serial port, click Reconnect Arduino, Run scope until LIVE, then try again.',
          'error',
          'error'
        );
        return;
      }
      const samples = Scope.state.samples || [];
      const stats = signalStats(samples);
      const data = await Diagnose.processFault({
        channel: ch,
        net: Scope.netFor(ch),
        holes: Scope.holesForChannel(ch).holes,
        intent: 'analyze_signal',
        scope: {
          samples,
          lastVolts: Scope.state.lastVolts,
          source: Scope.state.source,
          note: scopeData?.note,
          live: scopeData?.live === true,
          port: scopeData?.port,
          stats
        }
      });

      if (data.source === 'gemini') {
        updateCoach(data.message, 'gemini');
        Board.status('Gemini signal analysis ready' + (data.model ? ` (${data.model})` : '') + '.');
      } else {
        const reason = data.reason || 'unknown';
        const detail = data.error || data.detail || '';
        updateCoach(
          (data.message || 'Gemini did not return an analysis.') +
            ` [reason: ${reason}${detail ? ' — ' + detail : ''}]`,
          'error',
          'error'
        );
        Board.status('Gemini analysis failed — see Coach.');
      }
    } catch (e) {
      updateCoach('Could not analyze signal: ' + e.message, 'local', 'error');
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
      const port = $('arduinoPort')?.value || '';
      try {
        const res = await fetch('/api/arduino/reconnect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port })
        });
        const data = await res.json();
        if (!data.ok) {
          updateCoach(
            'Arduino reconnect failed: ' + (data.arduino?.lastError || 'no port / not connected') +
              '. Scope will not show fake live waveforms until the board links.',
            'local',
            'error'
          );
        } else {
          updateCoach('Arduino linked on ' + (data.arduino?.port || port) + '. Run scope for LIVE samples.', 'local');
        }
      } catch (e) {
        updateCoach('Arduino reconnect error: ' + e.message, 'local', 'error');
      }
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
