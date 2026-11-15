(function () {
  const $ = (id) => document.getElementById(id);
  let mode = 'build'; // build | debug
  let processBusy = false;
  let chatBusy = false;
  let geminiReady = false;
  const ANALYZE_LABEL = 'Capture + ask chat';

  function setMode(next) {
    mode = next;
    document.body.classList.toggle('mode-debug', mode === 'debug');
    $('stage-build').classList.toggle('active', mode === 'build');
    $('stage-debug').classList.toggle('active', mode === 'debug');
    $('panel-build').hidden = mode !== 'build';
    $('panel-debug').hidden = mode !== 'debug';
    const hero = $('scopeHero');
    if (hero) hero.hidden = mode !== 'debug';
    if (mode === 'debug') {
      enterDebug();
      requestAnimationFrame(() => Scope.draw($('scopeCanvas'), Scope.state.samples));
    } else {
      Scope.stop();
      Board.setMeasureTargets([]);
      if ($('probeHint')) $('probeHint').textContent = '';
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
    if (!el) return;
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

  function renderChat() {
    const log = $('debugChat');
    if (!log) return;
    log.replaceChildren();
    for (const msg of Diagnose.state.history) {
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble ' + (msg.role || 'system');
      if (msg.pending) bubble.classList.add('pending');
      const meta = document.createElement('span');
      meta.className = 'chat-meta';
      meta.textContent =
        msg.role === 'user'
          ? 'You'
          : msg.role === 'assistant'
            ? msg.source === 'gemini'
              ? 'Coach · Gemini'
              : msg.source === 'error'
                ? 'Coach · Error'
                : 'Coach'
            : 'Note';
      const body = document.createElement('div');
      body.textContent = msg.text;
      bubble.append(meta, body);
      log.append(bubble);
    }
    log.scrollTop = log.scrollHeight;
  }

  function setChatBusy(busy) {
    chatBusy = busy;
    const send = $('debugChatSend');
    const done = $('debugStepsDone');
    const input = $('debugChatInput');
    if (send) send.disabled = busy;
    if (done) done.disabled = busy;
    if (input) input.disabled = busy;
    updateProcessFaultButtons(wiringReady(Board.snapshot()));
  }

  async function submitChat(userMessage, opts = {}) {
    const text = String(userMessage || '').trim();
    if (!text && !opts.markStepsDone && !opts.scope) return;
    setChatBusy(true);
    renderChat();
    try {
      await refreshHwStatus();
      if (!geminiReady && !opts.allowLocal) {
        Diagnose.pushMessage(
          'assistant',
          'Gemini is not linked. Add GEMINI_API_KEY to .env (or Cloud Agent secrets), restart the server, then send again.',
          { source: 'error' }
        );
        renderChat();
        return;
      }
      const data = await Diagnose.sendChat({
        userMessage: text,
        markStepsDone: !!opts.markStepsDone,
        intent: opts.intent || (opts.markStepsDone ? 'steps_done' : 'chat'),
        channel: opts.channel,
        net: opts.net,
        holes: opts.holes,
        scope: opts.scope
      });
      renderChat();
      if (data?.source === 'gemini') {
        Board.status('Coach replied' + (data.model ? ` (${data.model})` : '') + '.');
      } else if (data?.source === 'error') {
        Board.status('Coach error — see Debug chat.');
      }
    } catch (e) {
      Diagnose.pushMessage('assistant', 'Could not reach coach: ' + e.message, { source: 'error' });
      renderChat();
    } finally {
      setChatBusy(false);
      renderChat();
    }
  }

  function wiringReady(snap) {
    return snap.allPlaced && snap.allJumpersDrawn && snap.parts.length > 0;
  }

  function updateProcessFaultButtons(ready) {
    const buildBtn = $('processFaultBuild');
    const debugBtn = $('processFault');
    const busy = processBusy || chatBusy;
    if (buildBtn) {
      buildBtn.disabled = !ready || busy;
      buildBtn.title = ready
        ? 'Open Debug, capture scope, and ask in chat'
        : 'Place parts so jumpers can be fitted first';
      buildBtn.textContent = processBusy ? 'Capturing…' : ANALYZE_LABEL;
    }
    if (debugBtn) {
      debugBtn.disabled = busy;
      debugBtn.title = geminiReady
        ? 'Capture waveform and append it to Debug chat'
        : 'Gemini API key missing — click to see setup steps';
      debugBtn.textContent = processBusy ? 'Capturing…' : ANALYZE_LABEL;
    }
  }

  function updateBuildChecklist() {
    const snap = Board.snapshot();
    const items = [
      ['timer', snap.hasTimer || snap.parts.length > 0, 'Netlist imported'],
      ['placed', snap.allPlaced, 'All parts placed'],
      ['jumpers', snap.allJumpersDrawn, 'Wires fitted']
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
      renderChat();
      return;
    }
    await Diagnose.askCoach();
    updateCoach();
  }

  function enterDebug() {
    Diagnose.setStage('investigate');
    Diagnose.ensureOpening();
    renderChat();
    const ch = $('scopeChannel').value || 'A0';
    const { net, holes } = Scope.highlightProbe(ch);
    $('probeHint').textContent = holes.length
      ? `Probing ${ch}` + (net ? ` → net ${net}` : '') + ` at ${holes.join(', ')}`
      : `Probing ${ch}` + (net ? ` → net ${net}` : '') + '. Place parts so probe holes can be highlighted.';
    const canvas = $('scopeCanvas');
    Scope.draw(canvas, Scope.state.samples);
    $('scopeReadout').textContent = 'Ready — press Run scope';
    Board.status(`Debug: probe ${ch}` + (net ? ` (${net})` : '') + '. Tell the chat what’s not working.');
    requestAnimationFrame(() => {
      const input = $('debugChatInput');
      if (input) {
        input.focus();
        input.placeholder = "What's not working?";
      }
    });
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
    try {
      if (mode !== 'debug') {
        if (!wiringReady(Board.snapshot())) {
          updateCoach(
            'Finish placing parts so wires can fit, then open Debug and describe what’s wrong.',
            'local',
            'warn'
          );
          return;
        }
        setMode('debug');
      }
      await refreshHwStatus();
      if (!geminiReady) {
        Diagnose.pushMessage(
          'assistant',
          'Gemini is not analyzing because GEMINI_API_KEY is not set on the server. Create .env with GEMINI_API_KEY=…, restart python/server.py, then try Capture + ask chat again.',
          { source: 'error' }
        );
        renderChat();
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
        Diagnose.pushMessage('assistant', 'Could not capture scope signal: ' + e.message, {
          source: 'error'
        });
        renderChat();
        return;
      }
      if (scopeData?.source !== 'arduino' || !Scope.state.samples.length) {
        Diagnose.pushMessage(
          'assistant',
          'Need a LIVE Arduino capture before I can read the signal: ' +
            (scopeData?.arduinoError || scopeData?.note || 'not connected') +
            '. Pick the serial port, Reconnect Arduino, Run scope until LIVE, then try again.',
          { source: 'error' }
        );
        renderChat();
        return;
      }
      const samples = Scope.state.samples || [];
      const stats = signalStats(samples);
      const step = Math.max(1, Math.floor(samples.length / 12));
      const thinSamples = samples.filter((_, i) => i % step === 0).slice(0, 12);
      const probe = Scope.holesForChannel(ch);
      setChatBusy(true);
      const data = await Diagnose.processFault({
        channel: ch,
        net: probe.net,
        holes: probe.holes,
        intent: 'analyze_signal',
        scope: {
          samples: thinSamples,
          sampleCount: samples.length,
          lastVolts: Scope.state.lastVolts,
          source: Scope.state.source,
          live: scopeData?.live === true,
          port: scopeData?.port,
          stats
        }
      });
      renderChat();
      if (data.source === 'gemini') {
        Board.status('Scope note added to chat' + (data.model ? ` (${data.model})` : '') + '.');
      } else {
        Board.status('Gemini analysis failed — see Debug chat.');
      }
    } catch (e) {
      Diagnose.pushMessage('assistant', 'Could not analyze signal: ' + e.message, { source: 'error' });
      renderChat();
    } finally {
      processBusy = false;
      setChatBusy(false);
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
    window.addEventListener('resize', () => {
      if (mode === 'debug') Scope.draw($('scopeCanvas'), Scope.state.samples);
    });

    $('processFault').onclick = () => processFault();
    $('processFaultBuild').onclick = () => processFault();

    $('debugChatForm').onsubmit = (e) => {
      e.preventDefault();
      const input = $('debugChatInput');
      const text = input.value;
      input.value = '';
      submitChat(text);
    };
    $('debugStepsDone').onclick = () => {
      submitChat('I finished the last steps you suggested. What should I check next?', {
        markStepsDone: true,
        intent: 'steps_done'
      });
    };
    $('debugClearChat').onclick = () => {
      Diagnose.clearChat();
      renderChat();
      Board.status('Debug chat cleared.');
    };
    Diagnose.onHistoryChange = () => {
      if (mode === 'debug') renderChat();
    };

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
          const msg =
            'Arduino reconnect failed: ' +
            (data.arduino?.lastError || 'no port / not connected') +
            '. Scope will not show fake live waveforms until the board links.';
          if (mode === 'debug') {
            Diagnose.pushMessage('system', msg, { source: 'local' });
            renderChat();
          } else {
            updateCoach(msg, 'local', 'error');
          }
        } else {
          const msg = 'Arduino linked on ' + (data.arduino?.port || port) + '. Run scope for LIVE samples.';
          if (mode === 'debug') {
            Diagnose.pushMessage('system', msg, { source: 'local' });
            renderChat();
          } else {
            updateCoach(msg, 'local');
          }
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
          ? `Probing ${$('scopeChannel').value}` + (net ? ` → net ${net}` : '') + ` at ${holes.join(', ')}`
          : `Probing ${$('scopeChannel').value}` + (net ? ` → net ${net}` : '');
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
