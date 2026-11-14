/* Breadboard workbench core — preserved from prototype interactions. */
(function (global) {
  const $ = (id) => document.getElementById(id);
  const examples = {
    divider: '* 3.3 V divider\nV1 VIN 0 DC 3.3\nR1 VIN OUT 1k\nR2 OUT 0 1k\n.end',
    timer: '* 555 astable wiring example\nV1 VCC 0 DC 5\nR1 VCC DISCHARGE 10k\nR2 DISCHARGE TIMING 10k\nC1 TIMING 0 10u\nC2 CTRL 0 10n\nXU1 VCC 0 TIMING TIMING DISCHARGE CTRL OUT VCC TIMER_DEMO\n* Interface declaration only\n.SUBCKT TIMER_DEMO VCC GND TRIG THRES DISCH CONT OUT RESET\n.ENDS TIMER_DEMO\n.end'
  };
  const profile = { gnd: 1, trig: 2, out: 3, reset: 4, cont: 5, thres: 6, disch: 7, vcc: 8 };
  const rows = 'ABCDEFGHIJ';
  let parts = [], selected = null, placements = new Map(), flipped = new Set(), highlight = [];
  const rails = ['T+', 'T−', 'B+', 'B−'];
  const cell = (r, c) => (rows[r] ?? rails[r - 10]) + c;
  const strip = (r, c) => (r >= 10 ? 'rail' + r : (r < 5 ? 'upper' : 'lower') + c);
  const x = (c) => 54 + (c - 1) * 38;
  const y = (r) => [107, 132, 157, 182, 207, 275, 300, 325, 350, 375, 30, 53, 405, 430][r];

  function parse(input) {
    const lines = [];
    for (const raw of input.split(/\r?\n/)) {
      const line = raw.trim().split(';')[0].trim();
      if (!line || line.startsWith('*')) continue;
      if (line.startsWith('+')) {
        if (!lines.length) throw Error('Unexpected continuation line.');
        lines[lines.length - 1] += ' ' + line.slice(1).trim();
      } else lines.push(line);
    }
    const models = new Map(), top = [];
    let inModel = false;
    for (const line of lines) {
      const [name, ...args] = line.split(/\s+/);
      switch (name.toLowerCase()) {
        case '.subckt':
          if (inModel || args.length < 2) throw Error('Invalid .SUBCKT declaration.');
          models.set(args[0].toLowerCase(), args.slice(1).map((s) => s.toLowerCase()));
          inModel = true;
          break;
        case '.ends':
          if (!inModel) throw Error('Unexpected .ENDS.');
          inModel = false;
          break;
        case '.end':
          if (inModel) throw Error('Missing .ENDS.');
          break;
        default:
          if (!inModel) top.push([name, ...args]);
      }
    }
    if (inModel) throw Error('Missing .ENDS.');
    if (!top.length) throw Error('Enter a netlist with at least one part.');
    const names = new Set();
    return top.map(([name, ...args]) => {
      const id = name.toUpperCase(), kind = id[0];
      if (names.has(id)) throw Error('Duplicate part ' + name);
      names.add(id);
      if (kind === 'X') {
        const model = args.at(-1), terms = models.get(model?.toLowerCase());
        if (!terms) throw Error(name + ': add the matching .SUBCKT declaration.');
        if (
          model.toLowerCase() !== 'timer_demo' ||
          terms.length !== 8 ||
          args.length !== 9 ||
          new Set(terms).size !== 8 ||
          !terms.every((t) => Object.hasOwn(profile, t))
        ) {
          throw Error(name + ': no compatible pin profile. Use the 555 example terminal names.');
        }
        return {
          id,
          kind,
          value: model,
          pins: terms
            .map((term, i) => ({ term, pin: profile[term], net: args[i].toUpperCase() }))
            .sort((a, b) => a.pin - b.pin)
        };
      }
      const valid =
        ((kind === 'R' || kind === 'C') && args.length === 3) ||
        (kind === 'V' &&
          (args.length === 3 || (args.length === 4 && args[2].toUpperCase() === 'DC')) &&
          /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?[a-z]*$/i.test(args.at(-1)));
      if (!valid) throw Error('Unsupported statement: ' + [name, ...args].join(' '));
      return {
        id,
        kind,
        value: args.slice(2).join(' '),
        pins: args.slice(0, 2).map((net, i) => ({
          term: kind === 'V' ? ['+', '−'][i] : String(i + 1),
          pin: i + 1,
          net: net.toUpperCase()
        }))
      };
    });
  }

  function supply() {
    return parts.find(
      (p) =>
        p.kind === 'V' &&
        p.pins[1].net === '0' &&
        p.pins[0].net !== '0' &&
        Number(p.value.replace(/^DC\s+/i, '')) > 0
    );
  }

  function legs(part, r, c, flip) {
    if (part === supply()) return r === 10 ? part.pins.map((p, i) => ({ ...p, r: 10 + i, c })) : null;
    if (r >= 10) return null;
    if (part.kind === 'X') {
      if (r !== 4 || c > 15) return null;
      return part.pins.map((p) => {
        const upper = (p.pin <= 4) !== flip;
        const offset = p.pin <= 4 ? p.pin - 1 : 8 - p.pin;
        return { ...p, r: upper ? 4 : 5, c: c + (flip ? 3 - offset : offset) };
      });
    }
    if (c > 15) return null;
    return part.pins.map((p, i) => ({ ...p, r, c: c + ((i === 0) !== flip ? 0 : 2) }));
  }

  function validate(part, r, c, flip) {
    const pins = legs(part, r, c, flip);
    if (!pins) {
      throw Error(
        part === supply()
          ? 'Place the supply on the top + rail.'
          : part.kind === 'X'
            ? 'Place the DIP on E1–E15.'
            : 'Choose an anchor at column 15 or earlier.'
      );
    }
    const occupied = [...placements.entries()].filter(([id]) => id !== part.id).flatMap(([, value]) => value.pins);
    for (const pin of pins) {
      if (occupied.some((p) => p.r === pin.r && p.c === pin.c)) {
        throw Error(cell(pin.r, pin.c) + ' already has a leg.');
      }
      const conflict = occupied.find((p) => p.net !== pin.net && strip(p.r, p.c) === strip(pin.r, pin.c));
      if (conflict) {
        throw Error(
          'Short blocked: ' + pin.net + ' and ' + conflict.net + ' share a connected strip at ' + cell(pin.r, pin.c) + '.'
        );
      }
    }
    return pins;
  }

  function assign(part, r, c, flip = flipped.has(part.id)) {
    const pins = validate(part, r, c, flip);
    placements.set(part.id, { r, c, pins });
    if (flip) flipped.add(part.id);
    else flipped.delete(part.id);
  }

  const drawn = new Set();
  let measureTargets = [];

  function suggest(part) {
    const bands = part === supply() ? [10] : part.kind === 'X' ? [4] : [2, 7, 1, 8, 0, 9, 3, 6, 4, 5];
    for (const r of bands) {
      for (let c = 1; c <= 15; c++) {
        try {
          return { r, c, pins: validate(part, r, c, flipped.has(part.id)) };
        } catch {}
      }
    }
    return null;
  }

  function plan() {
    const pins = [...placements.values()].flatMap((q) => q.pins),
      nets = new Map(),
      result = [];
    const taken = new Set(pins.map((p) => cell(p.r, p.c)));
    const feed = supply(),
      powered = feed && placements.has(feed.id);
    function collect(net, r, c) {
      if (!nets.has(net)) nets.set(net, new Map());
      const start = r < 5 ? 0 : 5;
      nets
        .get(net)
        .set(
          strip(r, c),
          r >= 10 ? Array.from({ length: 17 }, (_, i) => [r, i + 1]) : Array.from({ length: 5 }, (_, i) => [start + i, c])
        );
    }
    if (powered) feed.pins.forEach((p, i) => {
      collect(p.net, 10 + i, 1);
      collect(p.net, 12 + i, 1);
    });
    for (const p of pins) if (p.r < 10) collect(p.net, p.r, p.c);
    for (const [net, groups] of nets) {
      const power = powered ? feed.pins.findIndex((p) => p.net === net) : -1;
      const pending = [...groups.values()],
        linked = [pending.shift()];
      for (const next of pending) {
        let best = null;
        for (const group of linked) {
          for (const a of group) {
            for (const b of next) {
              const labels = [cell(...a), cell(...b)];
              if (labels.some((label) => taken.has(label))) continue;
              const score = Math.abs(x(a[1]) - x(b[1])) + Math.abs(y(a[0]) - y(b[0]));
              if (!best || score < best.score) best = { a, b, labels, score };
            }
          }
        }
        if (!best) {
          result.push({ net, error: true });
          break;
        }
        for (const label of best.labels) taken.add(label);
        result.push({
          ...best,
          net,
          key: [net, ...best.labels].join('|'),
          color: power === 0 ? '#bf3434' : power === 1 ? '#265ac5' : ['#653cc5', '#0c795c', '#a55f12'][result.length % 3]
        });
        linked.push(next);
      }
    }
    return result;
  }

  function status(message, error = false) {
    $('status').textContent = message;
    $('status').classList.toggle('error', error);
  }

  function select(id) {
    selected = id;
    highlight = [];
    render();
    status('Selected ' + id + '. Choose an anchor hole.');
    Board.onChange?.();
  }

  function place(id, r, c) {
    const part = parts.find((p) => p.id === id);
    if (!part) {
      status('Select a part first.', true);
      return;
    }
    try {
      assign(part, r, c);
      drawn.clear();
      selected = id;
      highlight = [];
      render();
      status(id + ' placed at ' + cell(r, c) + '.');
      Board.onChange?.();
    } catch (e) {
      status(e.message, true);
    }
  }

  function el(tag, txt, cls) {
    const n = document.createElement(tag);
    if (txt !== undefined) n.textContent = txt;
    if (cls) n.className = cls;
    return n;
  }
  function positioned(n, left, top) {
    n.style.left = left + 'px';
    n.style.top = top + 'px';
    return n;
  }

  const boardHoles = new Map();
  const colors = { R: '#ffc174', C: '#7bd9ef', V: '#ff929b', X: '#c5a7ff' };
  const colorFor = (id) => colors[id[0]] ?? '#79e3c2';
  let held = null,
    touch = null,
    activeAnchor = null,
    previewHoles = [];

  function anchors(id) {
    const part = parts.find((p) => p.id === id);
    if (!part) return;
    for (let r = 0; r < 14; r++) {
      for (let c = 1; c <= 17; c++) {
        try {
          validate(part, r, c, flipped.has(id));
          boardHoles.get(cell(r, c))?.classList.add('target');
        } catch {}
      }
    }
  }

  function clearPreview() {
    for (const hole of previewHoles) hole.classList.remove('footprint', 'blocked');
    previewHoles = [];
    activeAnchor = null;
  }

  function preview(id, r, c) {
    const label = cell(r, c);
    if (activeAnchor?.label === label) return activeAnchor.valid;
    clearPreview();
    const part = parts.find((p) => p.id === id);
    if (!part) return false;
    let valid = false;
    try {
      const pins = validate(part, r, c, flipped.has(id));
      previewHoles = pins.map((pin) => boardHoles.get(cell(pin.r, pin.c))).filter(Boolean);
      for (const hole of previewHoles) hole.classList.add('footprint');
      valid = true;
    } catch {
      const hole = boardHoles.get(label);
      if (hole) {
        hole.classList.add('blocked');
        previewHoles = [hole];
      }
    }
    activeAnchor = { label, valid };
    return valid;
  }

  function beginHold(id) {
    if (held === id) return;
    endHold();
    held = id;
    $('board').classList.add('holding');
    anchors(id);
    status('Holding ' + id + '. Drop on an outlined anchor.');
  }

  function endHold() {
    if (!held) return;
    held = null;
    clearPreview();
    $('board').classList.remove('holding');
    for (const hole of boardHoles.values()) hole.classList.remove('target');
  }

  function inspect(id, on) {
    for (const pin of placements.get(id)?.pins ?? []) {
      boardHoles.get(cell(pin.r, pin.c))?.classList.toggle('inspect', on);
    }
  }

  function targetAt(px, py) {
    const hole = document.elementFromPoint(px, py)?.closest('.hole');
    if (!hole) return null;
    const [r, c] = hole.dataset.anchor.split(',').map(Number);
    return { r, c };
  }

  function drag(n, id) {
    n.style.setProperty('--part', colorFor(id));
    n.draggable = true;
    n.onpointerenter = () => inspect(id, true);
    n.onpointerleave = () => inspect(id, false);
    n.onfocus = () => inspect(id, true);
    n.onblur = () => inspect(id, false);
    n.onpointerdown = (e) => {
      if (e.button !== 0) return;
      beginHold(id);
      if (e.pointerType !== 'mouse') {
        touch = { x: e.clientX, y: e.clientY, moved: false };
        n.setPointerCapture(e.pointerId);
      }
    };
    n.onpointermove = (e) => {
      if (!touch || held !== id) return;
      if (Math.hypot(e.clientX - touch.x, e.clientY - touch.y) > 7) touch.moved = true;
      const target = targetAt(e.clientX, e.clientY);
      if (target) preview(id, target.r, target.c);
      else clearPreview();
    };
    n.onpointerup = (e) => {
      if (touch && held === id) {
        const target = targetAt(e.clientX, e.clientY);
        const valid = touch.moved && target && preview(id, target.r, target.c);
        touch = null;
        endHold();
        if (valid) place(id, target.r, target.c);
      } else endHold();
    };
    n.onpointercancel = () => {
      if (touch) {
        touch = null;
        endHold();
      }
    };
    n.ondragstart = (e) => {
      beginHold(id);
      e.dataTransfer.setData('text/plain', id);
      e.dataTransfer.effectAllowed = 'move';
    };
    n.ondragend = endHold;
  }

  window.addEventListener('pointerup', () => {
    touch = null;
    endHold();
  });
  window.addEventListener('blur', endHold);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      touch = null;
      endHold();
    }
  });

  function render() {
    const board = $('board');
    boardHoles.clear();
    board.replaceChildren(el('div', undefined, 'gap'));
    const active = parts.find((p) => p.id === selected);
    const hint = active && !placements.has(active.id) ? suggest(active) : null;
    const routes = plan();
    const occupied = [...placements.entries()].flatMap(([owner, p]) => p.pins.map((pin) => ({ ...pin, owner })));
    for (let c = 1; c <= 17; c++) board.append(positioned(el('span', c, 'label'), x(c), 77));
    for (let r = 0; r < 14; r++) {
      if (r >= 10) {
        const line = el('div', undefined, 'rail');
        line.style.top = y(r) + 'px';
        line.style.background = r % 2 ? '#265ac5' : '#bf3434';
        board.append(line);
      }
      board.append(positioned(el('span', rows[r] ?? rails[r - 10], 'label'), 20, y(r)));
      for (let c = 1; c <= 17; c++) {
        const label = cell(r, c),
          pin = occupied.find((p) => p.r === r && p.c === c);
        const measureHit = measureTargets.includes(label);
        const button = positioned(
          el(
            'button',
            undefined,
            'hole' +
              (pin ? ' pin' : '') +
              (highlight.includes(label) ? ' link' : '') +
              (hint?.pins.some((p) => p.r === r && p.c === c) ? ' ghost' : '') +
              (measureHit ? ' measure' : '')
          ),
          x(c),
          y(r)
        );
        button.title =
          label +
          (pin ? ' · ' + pin.owner + ' pin ' + pin.pin + ' · ' + pin.term + ' · ' + pin.net : '') +
          (measureHit ? ' · measure here' : '');
        button.setAttribute('aria-label', button.title);
        button.onclick = () => {
          if (measureHit && Board.onMeasureClick) Board.onMeasureClick(label, pin?.net);
          else place(selected, r, c);
        };
        boardHoles.set(label, button);
        if (pin) {
          button.style.setProperty('--part', colorFor(pin.owner));
          if (pin.owner.startsWith('X')) button.append(el('span', pin.pin, 'pin-number'));
        }
        button.onpointerenter = () => {
          if (held) preview(held, r, c);
        };
        button.ondragover = (e) => {
          if (held) {
            e.preventDefault();
            e.dataTransfer.dropEffect = preview(held, r, c) ? 'move' : 'none';
          }
        };
        button.ondrop = (e) => {
          e.preventDefault();
          const id = held;
          const valid = id && preview(id, r, c);
          endHold();
          if (valid) place(id, r, c);
        };
        button.dataset.anchor = r + ',' + c;
        board.append(button);
      }
    }

    for (const w of routes) {
      if (w.error || (!drawn.has(w.key) && highlight.join() !== w.labels.join())) continue;
      const dx = x(w.b[1]) - x(w.a[1]),
        dy = y(w.b[0]) - y(w.a[0]);
      const line = el('div', undefined, 'wire');
      line.style.left = x(w.a[1]) + 'px';
      line.style.top = y(w.a[0]) - 2 + 'px';
      line.style.width = Math.hypot(dx, dy) + 'px';
      line.style.transform = 'rotate(' + Math.atan2(dy, dx) + 'rad)';
      line.style.background = w.color;
      line.style.opacity = drawn.has(w.key) ? '.9' : '.4';
      board.append(line);
    }
    $('parts').replaceChildren();
    for (const p of parts) {
      const q = placements.get(p.id);
      const button = el('button', p.id + ' · ' + (p.kind === 'X' ? 'NE555P profile' : p.value) + (q ? ' ✓' : ''));
      button.setAttribute('aria-pressed', p.id === selected);
      button.onclick = () => select(p.id);
      drag(button, p.id);
      $('parts').append(button);
      if (q) {
        const chip = positioned(
          el('button', p.id + (p.kind === 'X' ? (flipped.has(p.id) ? ' ▸' : ' ◂') : ''), 'piece' + (p.kind === 'X' ? ' ic' : '')),
          x(q.c) + (p.kind === 'X' ? 57 : q.r >= 10 ? 0 : 38),
          p.kind === 'X' ? (y(4) + y(5)) / 2 : q.r >= 10 ? (y(10) + y(11)) / 2 : y(q.r)
        );
        chip.title = p.id + ' · ' + p.value;
        if (p.kind === 'X') chip.style.width = '142px';
        chip.setAttribute('aria-label', 'Select placed ' + p.id);
        chip.onclick = () => select(p.id);
        drag(chip, p.id);
        board.append(chip);
      }
    }
    const part = parts.find((p) => p.id === selected),
      mapping = $('mapping');
    mapping.replaceChildren();
    if (part) {
      if (part.kind === 'X') {
        const choice = el('select');
        choice.id = 'profile';
        choice.setAttribute('aria-label', 'Physical IC package');
        choice.append(el('option', 'NE555P · PDIP-8'));
        choice.title = 'Supported mapping for this demo';
        mapping.append(choice);
      } else mapping.append(el('p', part.id + ' · ' + part.value, 'muted'));
      const table = el('table'),
        head = table.createTHead().insertRow();
      for (const label of ['Terminal', 'Net', 'Pin', 'Hole']) head.append(el('th', label));
      const body = table.createTBody();
      for (const pin of part.pins) {
        const placed = placements.get(part.id)?.pins.find((p) => p.pin === pin.pin);
        const proposed = hint?.pins.find((p) => p.pin === pin.pin);
        const tr = body.insertRow();
        for (const value of [
          pin.term,
          pin.net,
          pin.pin,
          placed ? cell(placed.r, placed.c) : proposed ? cell(proposed.r, proposed.c) + ' (suggested)' : '—'
        ]) {
          tr.append(el('td', value));
        }
      }
      mapping.append(table);
    } else mapping.append(el('p', 'Choose a part to inspect its pin map.', 'muted'));

    const list = $('jumpers'),
      source = supply(),
      feed = source && placements.get(source.id);
    list.replaceChildren();
    if (feed) list.append(el('p', 'Supply leads: ' + cell(10, feed.c) + ' (+) and ' + cell(11, feed.c) + ' (−).', 'muted'));
    for (const w of routes) {
      if (w.error) {
        list.append(el('p', w.net + ': move parts to free holes for jumpers.', 'error'));
        continue;
      }
      const row = el('div', undefined, 'toolbar');
      const route = el('button', w.net + ' · ' + w.labels.join(' ↔ '));
      route.onclick = () => {
        highlight = w.labels;
        render();
        status('Connect ' + w.labels.join(' to ') + ' for ' + w.net + '.');
      };
      const toggle = el('button', drawn.has(w.key) ? 'Remove wire' : 'Add wire');
      toggle.setAttribute('aria-label', toggle.textContent + ' ' + w.labels.join(' to '));
      toggle.onclick = () => {
        const added = !drawn.delete(w.key);
        if (added) drawn.add(w.key);
        highlight = added ? w.labels : [];
        render();
        status(added ? 'Jumper added.' : 'Jumper removed.');
        Board.onChange?.();
      };
      row.append(route, toggle);
      list.append(row);
    }
    if (!routes.length) list.append(el('p', 'Place parts to see jumper suggestions.', 'muted'));
  }

  function load() {
    try {
      const parsed = parse($('source').value);
      parts = parsed;
      drawn.clear();
      placements.clear();
      flipped.clear();
      highlight = [];
      measureTargets = [];
      selected = parts.find((p) => p.kind === 'X')?.id ?? parts[0].id;
      $('importMessage').textContent = parts.length + ' parts imported.';
      $('importMessage').classList.remove('error');
      render();
      status('Select or drag a part to begin.');
      Board.onChange?.();
    } catch (e) {
      $('importMessage').textContent = e.message;
      $('importMessage').classList.add('error');
    }
  }

  function holeForNet(netName) {
    const net = String(netName).toUpperCase();
    for (const [, place] of placements) {
      const pin = place.pins.find((p) => p.net === net);
      if (pin) return { hole: cell(pin.r, pin.c), net, r: pin.r, c: pin.c, pin };
    }
    if (net === '0' || net === 'GND') {
      for (const [, place] of placements) {
        const pin = place.pins.find((p) => p.net === '0');
        if (pin) return { hole: cell(pin.r, pin.c), net: '0', r: pin.r, c: pin.c, pin };
      }
    }
    return null;
  }

  function snapshot() {
    const routes = plan();
    return {
      parts: parts.map((p) => ({ id: p.id, kind: p.kind, value: p.value, pins: p.pins })),
      placements: [...placements.entries()].map(([id, v]) => ({
        id,
        r: v.r,
        c: v.c,
        pins: v.pins.map((p) => ({ ...p, hole: cell(p.r, p.c) }))
      })),
      jumpersDrawn: [...drawn],
      routes: routes.map((w) =>
        w.error ? { net: w.net, error: true } : { net: w.net, key: w.key, labels: w.labels, drawn: drawn.has(w.key) }
      ),
      supply: (() => {
        const s = supply();
        return s ? { id: s.id, value: s.value, nets: s.pins.map((p) => p.net) } : null;
      })(),
      hasTimer: parts.some((p) => p.kind === 'X'),
      allPlaced: parts.length > 0 && parts.every((p) => placements.has(p.id)),
      allJumpersDrawn: routes.length > 0 && routes.every((w) => w.error || drawn.has(w.key))
    };
  }

  const Board = {
    examples,
    cell,
    strip,
    parse,
    plan,
    suggest,
    load,
    render,
    status,
    holeForNet,
    snapshot,
    setMeasureTargets(labels) {
      measureTargets = labels || [];
      render();
    },
    getMeasureTargets: () => measureTargets.slice(),
    get parts() {
      return parts;
    },
    get placements() {
      return placements;
    },
    get drawn() {
      return drawn;
    },
    get selected() {
      return selected;
    },
    onChange: null,
    onMeasureClick: null,
    init() {
      for (const key of Object.keys(examples)) {
        $(key).onclick = () => {
          $('source').value = examples[key];
          load();
        };
      }
      $('import').onclick = load;
      $('rotate').onclick = () => {
        const part = parts.find((p) => p.id === selected);
        if (!part) return;
        if (part === supply()) {
          status('Supply polarity is fixed to the marked rails.');
          return;
        }
        const q = placements.get(selected),
          flip = !flipped.has(selected);
        try {
          if (q) assign(part, q.r, q.c, flip);
          else if (flip) flipped.add(selected);
          else flipped.delete(selected);
          drawn.clear();
          highlight = [];
          render();
          status(part.id + ' rotated 180°.');
          Board.onChange?.();
        } catch (e) {
          status(e.message, true);
        }
      };
      $('remove').onclick = () => {
        if (placements.delete(selected)) {
          drawn.clear();
          highlight = [];
          render();
          status(selected + ' moved back to the tray.');
          Board.onChange?.();
        }
      };
      $('layout').onclick = () => {
        const previous = new Map(placements),
          oldFlips = new Set(flipped);
        placements.clear();
        flipped.clear();
        const ordered = [...parts].sort((a, b) => Number(b.kind === 'X') - Number(a.kind === 'X'));
        for (const part of ordered) {
          const next = suggest(part);
          if (!next) {
            placements.clear();
            for (const [k, v] of previous) placements.set(k, v);
            flipped.clear();
            for (const id of oldFlips) flipped.add(id);
            status('Auto-set ran out of space at ' + part.id + '.', true);
            return;
          }
          assign(part, next.r, next.c);
        }
        highlight = [];
        drawn.clear();
        const routes = plan();
        for (const w of routes) if (!w.error) drawn.add(w.key);
        render();
        status(
          routes.some((w) => w.error)
            ? 'Parts placed. Move parts to free holes for all jumpers.'
            : 'Placed ' + parts.length + ' parts and ' + drawn.size + ' jumpers.'
        );
        Board.onChange?.();
      };
      $('timer').click();
    }
  };

  global.Board = Board;
})(window);
