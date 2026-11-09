/* Browser UI: renders the game as SVG, handles clicks, animates combat and runs the CPU. */
(function () {
  'use strict';

  const G = window.TDGame;
  const AI = window.TDAI;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const HEX_SIZE = 22; // centre to corner, in SVG units
  const SQRT3 = Math.sqrt(3);

  const HUMAN = G.DEFENDER;
  const CPU = G.ATTACKER;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const TIMING = reducedMotion
    ? { think: 600, step: 0, pause: 120, human: 0, shot: 0, afterShot: 250 }
    : { think: 1800, step: 200, pause: 260, human: 120, shot: 380, afterShot: 420 };

  const els = {
    board: document.getElementById('board'),
    banner: document.getElementById('turn-banner'),
    defCount: document.getElementById('def-count'),
    defNext: document.getElementById('def-next'),
    buildSoldier: document.getElementById('build-soldier'),
    buildArtillery: document.getElementById('build-artillery'),
    repeatBuild: document.getElementById('repeat-build'),
    buildQueue: document.getElementById('build-queue'),
    buildEmpty: document.getElementById('build-empty'),
    attCount: document.getElementById('att-count'),
    attReserve: document.getElementById('att-reserve'),
    keepHp: document.getElementById('keep-hp'),
    message: document.getElementById('message'),
    log: document.getElementById('log'),
    endBtn: document.getElementById('end-btn'),
    newBtn: document.getElementById('new-btn'),
  };

  let game;
  let selected = null; // { q, r } of the selected unit (yours or an enemy, for inspection)
  let message = '';
  let busy = false; // true while the CPU plays or an animation runs
  let thinking = false;
  let generation = 0; // bumps on New game so a running CPU turn stops
  let enteringIds = new Set(); // units to play the "enter" animation on

  // Persistent SVG layers: `scene` is redrawn on every render, `fx` holds transient effects.
  let scene;
  let fx;
  let previewLayer; // hover preview, inside `scene`

  const toPixel = ({ q, r }) => ({
    x: HEX_SIZE * SQRT3 * (q + r / 2),
    y: HEX_SIZE * 1.5 * r,
  });

  const wait = (ms) => new Promise((res) => setTimeout(res, ms));

  function hexPoints(cx, cy, size = HEX_SIZE) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 180) * (60 * i - 30);
      pts.push(`${(cx + size * Math.cos(angle)).toFixed(2)},${(cy + size * Math.sin(angle)).toFixed(2)}`);
    }
    return pts.join(' ');
  }

  function el(name, attrs = {}, parent) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }

  // ---------- game flow ----------

  function newGame() {
    generation += 1;
    game = G.createGame();
    selected = null;
    busy = false;
    thinking = false;
    message = '';
    setupBoard();
    if (game.turn === CPU) runCpuTurn();
    else render();
  }

  function markEntering() {
    enteringIds = new Set(game.current.entered.map((e) => e.id));
  }

  async function runCpuTurn() {
    const gen = generation;
    const alive = () => gen === generation;
    busy = true;
    selected = null;
    markEntering();
    thinking = true;
    message = 'The attackers are planning their move…';
    render();
    enteringIds = new Set();
    await wait(TIMING.think);
    if (!alive()) return;
    thinking = false;
    message = 'The attackers are moving.';
    render();

    let action;
    while (alive() && (action = AI.nextAction(game))) {
      await animatedMove(action.from, action.to, TIMING.step);
      if (!alive()) return;
      await wait(TIMING.pause);
    }
    if (!alive()) return;

    message = 'The attackers open fire.';
    await resolveCombat(alive);
    if (!alive()) return;

    if (!game.winner) {
      G.endTurn(game);
      markEntering();
    }
    busy = false;
    message = game.winner ? describeWinner() : yourTurnMessage();
    render();
    enteringIds = new Set();
  }

  async function endHumanTurn() {
    if (busy || game.winner || game.turn !== HUMAN) return;
    const gen = generation;
    const alive = () => gen === generation;
    busy = true;
    selected = null;
    message = 'Your units open fire.';
    await resolveCombat(alive);
    if (!alive()) return;
    if (game.winner) {
      busy = false;
      message = describeWinner();
      render();
      return;
    }
    G.endTurn(game);
    runCpuTurn();
  }

  /** Fire the current player's units one at a time, animating each shot. */
  async function resolveCombat(alive) {
    render();
    for (const unit of G.firingOrder(game)) {
      if (G.pieceAt(game, unit.q, unit.r) !== unit) continue; // destroyed earlier this volley
      const target = G.chooseTarget(game, unit);
      if (!target) {
        G.fire(game, unit);
        continue;
      }
      await animateShot(unit, target);
      if (!alive()) return;
      const event = G.fire(game, unit);
      render();
      if (event) showHit(event);
      await wait(TIMING.afterShot);
      if (!alive() || game.winner) return;
    }
  }

  // ---------- animation ----------

  /** Animate a unit along its path, then apply the move to the game. */
  async function animatedMove(from, to, stepMs) {
    const unit = G.pieceAt(game, from.q, from.r);
    const target = G.movesFor(game, from.q, from.r).find((t) => G.samePos(t, to));
    if (!unit || !target) return { ok: false, reason: 'That move is not allowed.' };
    if (stepMs > 0) {
      const node = scene.querySelector(`[data-id="${unit.id}"]`);
      if (node) await tween(node, toPixel(from), [from, ...target.path].map(toPixel), stepMs);
    }
    const res = G.move(game, from, to);
    render();
    return res;
  }

  function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  function tween(node, start, points, stepMs) {
    const segments = points.length - 1;
    if (segments <= 0) return Promise.resolve();
    const total = stepMs * segments;
    return new Promise((resolve) => {
      const t0 = performance.now();
      function frame(now) {
        const t = Math.min(1, (now - t0) / total);
        const f = easeInOut(t) * segments;
        const i = Math.min(segments - 1, Math.floor(f));
        const local = f - i;
        const a = points[i];
        const b = points[i + 1];
        const x = a.x + (b.x - a.x) * local - start.x;
        const y = a.y + (b.y - a.y) * local - start.y;
        node.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
        if (t < 1) requestAnimationFrame(frame);
        else resolve();
      }
      requestAnimationFrame(frame);
    });
  }

  function animate(duration, onFrame) {
    if (duration <= 0) {
      onFrame(1);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const t0 = performance.now();
      function frame(now) {
        const t = Math.min(1, (now - t0) / duration);
        onFrame(t);
        if (t < 1) requestAnimationFrame(frame);
        else resolve();
      }
      requestAnimationFrame(frame);
    });
  }

  /** Soldiers lunge at their target; artillery lobs a shell in an arc. */
  async function animateShot(unit, target) {
    const a = toPixel(unit);
    const b = toPixel(target);
    if (unit.type === 'soldier') {
      const node = scene.querySelector(`[data-id="${unit.id}"]`);
      if (!node) return;
      await animate(TIMING.shot, (t) => {
        const k = Math.sin(t * Math.PI) * 0.45;
        node.setAttribute('transform', `translate(${((b.x - a.x) * k).toFixed(2)} ${((b.y - a.y) * k).toFixed(2)})`);
      });
      node.removeAttribute('transform');
      return;
    }
    const shell = el('circle', { r: 3.6, class: `shell ${unit.owner}` }, fx);
    const height = Math.max(18, Math.hypot(b.x - a.x, b.y - a.y) * 0.45);
    await animate(TIMING.shot * 1.3, (t) => {
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t - Math.sin(t * Math.PI) * height;
      shell.setAttribute('cx', x.toFixed(2));
      shell.setAttribute('cy', y.toFixed(2));
    });
    shell.remove();
  }

  /** Flash the target and float the damage number above it. */
  function showHit(event) {
    const { x, y } = toPixel(event.to);
    const burst = el('circle', { cx: x, cy: y, r: HEX_SIZE * 0.5, class: `burst ${event.owner}` }, fx);
    const label = el('text', { x, y: y - HEX_SIZE * 0.7, class: `damage ${event.killed ? 'killed' : ''}` }, fx);
    label.textContent = event.killed && event.targetType !== 'keep' ? `−${event.damage} ✕` : `−${event.damage}`;
    setTimeout(() => {
      burst.remove();
      label.remove();
    }, 1100);
  }

  // ---------- rendering ----------

  function setupBoard() {
    const board = els.board;
    board.replaceChildren();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of game.cells.values()) {
      const { x, y } = toPixel(c);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const pad = HEX_SIZE + 4;
    board.setAttribute('viewBox', `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`);

    const defs = el('defs', {}, board);
    for (const kind of ['defender', 'cpu']) {
      const m = el('marker', {
        id: `arrow-${kind}`, viewBox: '0 0 10 10', refX: '6', refY: '5',
        markerWidth: '3.2', markerHeight: '3.2', orient: 'auto-start-reverse',
      }, defs);
      el('path', { d: 'M0,0 L10,5 L0,10 Z', class: `arrowhead ${kind}` }, m);
    }
    scene = el('g', { class: 'scene' }, board);
    fx = el('g', { class: 'fx' }, board);
  }

  /** Cells within `type`'s attack radius of `from`. */
  function rangeCells(type, from) {
    const set = new Set();
    for (const c of game.cells.values()) {
      if (G.inAttackRange(type, G.hexDistance(from, c))) set.add(G.key(c.q, c.r));
    }
    return set;
  }

  function render() {
    scene.replaceChildren();

    const myTurn = !busy && !game.winner && game.turn === HUMAN;
    const selectedUnit = selected && G.pieceAt(game, selected.q, selected.r);
    const mine = selectedUnit && myTurn && selectedUnit.owner === HUMAN;
    const moveTargets = new Set();
    const backTargets = new Set();
    if (mine) {
      for (const m of G.movesFor(game, selected.q, selected.r)) moveTargets.add(G.key(m.q, m.r));
      for (const c of G.stepBackCells(game, selectedUnit)) backTargets.add(G.key(c.q, c.r));
    }
    const inRange = selectedUnit ? rangeCells(selectedUnit.type, selectedUnit) : new Set();
    // Enemies the selected unit could attack instead (tap one to switch).
    const candidates = mine && G.canFire(selectedUnit) ? G.targetsInRange(game, selectedUnit) : [];

    const cellsLayer = el('g', { class: 'cells' }, scene);
    const markLayer = el('g', { class: 'marks' }, scene);
    const aimLayer = el('g', { class: 'aims' }, scene);
    const piecesLayer = el('g', { class: 'pieces' }, scene);
    const arrowLayer = el('g', { class: 'arrows' }, scene);
    const labelLayer = el('g', { class: 'labels' }, scene);
    previewLayer = el('g', { class: 'preview' }, scene);

    for (const cell of game.cells.values()) {
      const k = G.key(cell.q, cell.r);
      const { x, y } = toPixel(cell);
      const classes = ['cell'];
      if (cell.isEdge) classes.push('edge');
      if (G.hexDistance(cell, game.keep) <= game.config.keepRadius) classes.push('keep-zone');
      if (inRange.has(k)) classes.push(`in-range ${selectedUnit.owner}`);
      if (moveTargets.has(k)) classes.push('target');
      if (backTargets.has(k)) classes.push('target back');
      if (selected && G.samePos(selected, cell)) classes.push('selected');
      const hex = el('polygon', { points: hexPoints(x, y), class: classes.join(' '), 'data-key': k }, cellsLayer);
      hex.addEventListener('click', () => onCellClick(cell));
      if (moveTargets.has(k) || backTargets.has(k)) {
        hex.addEventListener('mouseenter', () => previewFrom(selectedUnit, cell));
        hex.addEventListener('mouseleave', () => previewFrom(selectedUnit, null));
      }
    }

    // Keep
    const kp = toPixel(game.keep);
    const keepGroup = el('g', { class: 'keep-piece' }, piecesLayer);
    el('polygon', { points: hexPoints(kp.x, kp.y), class: 'keep-hex' }, keepGroup);
    drawCastle(keepGroup, kp.x, kp.y);
    drawHpBar(keepGroup, kp.x, kp.y + HEX_SIZE * 0.62, game.keep.hp, game.keep.maxHp, 'keep', 30);
    keepGroup.addEventListener('click', () => onCellClick(game.keep));

    // Units
    for (const unit of game.pieces.values()) {
      const { x, y } = toPixel(unit);
      const classes = ['piece', unit.owner, unit.type];
      if (selected && G.samePos(selected, unit)) classes.push('selected');
      if (unit.owner === game.turn && unit.moved && !game.winner && !busy) classes.push('done');
      if (enteringIds.has(unit.id)) classes.push('entering');
      if (candidates.includes(unit)) classes.push('candidate');
      const g = el('g', { class: classes.join(' '), 'data-id': unit.id }, piecesLayer);
      const inner = el('g', { class: 'piece-inner', style: `transform-origin: ${x}px ${y}px` }, g);
      drawUnit(inner, unit, x, y);
      drawHpBar(g, x, y + HEX_SIZE * 0.66, unit.hp, unit.maxHp, unit.owner, 24);
      g.addEventListener('click', () => onCellClick(unit));
    }

    // Aim lines: who each of your units will fire at when you end the turn,
    // moved or not, with the damage each target can expect.
    if (myTurn) {
      const totals = new Map(); // target id -> { target, min, max }
      for (const unit of G.piecesOf(game, HUMAN)) {
        if (!G.canFire(unit)) continue;
        const target = G.chooseTarget(game, unit);
        if (!target) continue;
        const a = toPixel(unit);
        const b = toPixel(target);
        const isSel = selectedUnit === unit;
        el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: `aim${isSel ? ' selected' : ''}${target.picked ? ' picked' : ''}` }, aimLayer);
        const dmg = G.damageAgainst(game, unit, target);
        const id = target.keep ? 'keep' : target.unit.id;
        const t = totals.get(id) || { target, min: 0, max: 0 };
        t.min += dmg.min;
        t.max += dmg.max;
        totals.set(id, t);
      }
      for (const { target, min, max } of totals.values()) {
        const hp = target.keep ? game.keep.hp : target.unit.hp;
        const fate = min >= hp ? 'kill' : max >= hp ? 'maybe' : '';
        const b = toPixel(target);
        drawCrosshair(aimLayer, b.x, b.y, fate);
        drawDamageLabel(labelLayer, b.x, b.y, min, max, fate);
      }
    }

    // Arrows and entry markers. During your turn: your moves so far plus the
    // CPU's last turn in grey. During the CPU's turn: its moves as they happen.
    const records = [];
    if (game.current) records.push(game.current);
    if (game.turn === HUMAN && game.lastTurn && game.lastTurn.player === CPU) records.push(game.lastTurn);
    for (const rec of records) {
      const style = rec.player === CPU ? 'cpu' : 'defender';
      for (const cell of rec.entered) drawRing(markLayer, cell, `entry ${style}`);
      for (const mv of rec.moves) drawArrow(arrowLayer, mv, style);
    }

    renderPanel();
  }

  /**
   * While hovering a destination, show the attack radius from there and who
   * the unit would hit, with the damage. `cell` null restores the normal view.
   */
  function previewFrom(unit, cell) {
    if (!unit) return;
    const from = cell || unit;
    const set = rangeCells(unit.type, from);
    for (const node of scene.querySelectorAll('.cells .cell')) {
      node.classList.toggle('in-range', set.has(node.getAttribute('data-key')));
      node.classList.toggle(unit.owner, set.has(node.getAttribute('data-key')));
    }
    previewLayer.replaceChildren();
    if (!cell) return;
    const p = toPixel(cell);
    // Walking all the way back cancels the move, so artillery could fire again.
    const backToStart = unit.moved && G.stepBackCells(game, unit).some((c) => c.index === 0 && G.samePos(c, cell));
    const willMove = backToStart ? false : !G.samePos(cell, unit);
    if (willMove && !G.UNITS[unit.type].firesAfterMoving) {
      drawNote(previewLayer, p.x, p.y + HEX_SIZE * 0.05, "won't fire");
      return;
    }
    const target = G.chooseTarget(game, unit, cell);
    if (!target) return;
    const b = toPixel(target);
    el('line', { x1: p.x, y1: p.y, x2: b.x, y2: b.y, class: 'aim preview' }, previewLayer);
    const dmg = G.damageAgainst(game, unit, target);
    const hp = target.keep ? game.keep.hp : target.unit.hp;
    const fate = dmg.min >= hp ? 'kill' : dmg.max >= hp ? 'maybe' : '';
    drawCrosshair(previewLayer, b.x, b.y, fate);
    drawDamageLabel(previewLayer, b.x, b.y, dmg.min, dmg.max, fate);
  }

  function drawUnit(group, unit, x, y) {
    const s = HEX_SIZE;
    if (unit.owner === G.DEFENDER) {
      el('circle', { cx: x, cy: y, r: s * 0.56, class: 'body' }, group);
    } else {
      el('polygon', {
        points: `${x},${y - s * 0.66} ${x + s * 0.62},${y + s * 0.44} ${x - s * 0.62},${y + s * 0.44}`,
        class: 'body',
      }, group);
    }
    const gy = unit.owner === G.ATTACKER ? y + s * 0.06 : y;
    if (unit.type === 'soldier') {
      // Sword
      const k = s * 0.3;
      el('path', {
        d: `M${x},${gy - k * 1.15} L${x},${gy + k} M${x - k * 0.6},${gy + k * 0.35} L${x + k * 0.6},${gy + k * 0.35}`,
        class: 'glyph',
      }, group);
    } else {
      // Artillery: crosshair
      const k = s * 0.24;
      el('circle', { cx: x, cy: gy, r: k, class: 'glyph' }, group);
      el('path', {
        d: `M${x - k * 1.6},${gy} L${x - k * 0.5},${gy} M${x + k * 0.5},${gy} L${x + k * 1.6},${gy} M${x},${gy - k * 1.6} L${x},${gy - k * 0.5} M${x},${gy + k * 0.5} L${x},${gy + k * 1.6}`,
        class: 'glyph',
      }, group);
    }
  }

  function drawHpBar(group, x, y, hp, maxHp, owner, width) {
    const h = 3.6;
    el('rect', { x: x - width / 2, y, width, height: h, rx: 1.5, class: 'hp-track' }, group);
    const ratio = Math.max(0, hp / maxHp);
    const level = ratio > 0.6 ? 'high' : ratio > 0.3 ? 'mid' : 'low';
    el('rect', { x: x - width / 2, y, width: width * ratio, height: h, rx: 1.5, class: `hp-fill ${owner} ${level}` }, group);
  }

  function drawCrosshair(layer, x, y, fate = '') {
    const r = HEX_SIZE * 0.78;
    el('circle', { cx: x, cy: y, r, class: `crosshair ${fate}` }, layer);
  }

  /** Expected damage above a target, e.g. "−2–4". Red if it will die, amber if it might. */
  function drawDamageLabel(layer, x, y, min, max, fate) {
    const text = min === max ? `−${min}` : `−${min}–${max}`;
    const label = el('text', { x, y: y - HEX_SIZE * 0.88, class: `dmg-label ${fate}` }, layer);
    label.textContent = fate === 'kill' ? `${text} ✕` : text;
  }

  function drawNote(layer, x, y, text) {
    const note = el('text', { x, y, class: 'dmg-label note' }, layer);
    note.textContent = text;
  }

  function drawRing(layer, cell, cls) {
    const { x, y } = toPixel(cell);
    el('polygon', { points: hexPoints(x, y, HEX_SIZE * 0.86), class: `ring ${cls}` }, layer);
  }

  function drawArrow(layer, mv, style) {
    const pts = [mv.from, ...mv.path].map(toPixel);
    const trim = (a, b, amount) => {
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      return { x: a.x + (dx / len) * amount, y: a.y + (dy / len) * amount };
    };
    pts[0] = trim(pts[0], pts[1], HEX_SIZE * 0.55);
    const n = pts.length - 1;
    pts[n] = trim(pts[n], pts[n - 1], HEX_SIZE * 0.4);
    el('polyline', {
      points: pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
      class: `arrow ${style}`,
      'marker-end': `url(#arrow-${style})`,
    }, layer);
  }

  function drawCastle(group, x, y) {
    const w = HEX_SIZE * 1.0;
    const h = HEX_SIZE * 0.72;
    const left = x - w / 2;
    const top = y - h / 2 - 2;
    const m = w / 5; // merlon width
    const d = [
      `M${left},${top + h}`, `L${left},${top}`,
      `L${left + m},${top}`, `L${left + m},${top + m}`,
      `L${left + 2 * m},${top + m}`, `L${left + 2 * m},${top}`,
      `L${left + 3 * m},${top}`, `L${left + 3 * m},${top + m}`,
      `L${left + 4 * m},${top + m}`, `L${left + 4 * m},${top}`,
      `L${left + w},${top}`, `L${left + w},${top + h}`,
      `L${x + m * 0.6},${top + h}`, `L${x + m * 0.6},${top + h - m * 1.5}`,
      `Q${x},${top + h - m * 2.3} ${x - m * 0.6},${top + h - m * 1.5}`,
      `L${x - m * 0.6},${top + h}`, 'Z',
    ].join(' ');
    el('path', { d, class: 'castle' }, group);
  }

  function renderPanel() {
    if (game.winner) {
      els.banner.className = `turn-banner ${game.winner} winner`;
      els.banner.textContent = game.winner === HUMAN ? 'You held the keep!' : 'The keep has fallen';
    } else if (game.turn === CPU) {
      els.banner.className = `turn-banner attacker${thinking ? ' thinking' : ''}`;
      els.banner.innerHTML = `Turn ${game.turnNumber}: Attackers (CPU)<span class="dots"><span>.</span><span>.</span><span>.</span></span>`;
    } else {
      els.banner.className = 'turn-banner defender';
      els.banner.textContent = `Turn ${game.turnNumber}: Your move`;
    }
    els.defCount.textContent = G.piecesOf(game, G.DEFENDER).length;
    renderBuildQueue();
    els.attCount.textContent = G.piecesOf(game, G.ATTACKER).length;
    els.attReserve.textContent = game.pools[G.ATTACKER].length;
    els.keepHp.textContent = `${game.keep.hp} / ${game.keep.maxHp}`;
    els.message.textContent = message;
    els.endBtn.disabled = busy || !!game.winner || game.turn !== HUMAN;

    els.log.replaceChildren();
    for (const entry of [...game.log].reverse().slice(0, 120)) {
      const li = document.createElement('li');
      li.className = entry.player;
      const who = entry.player === CPU ? 'Attacker' : 'Defender';
      li.textContent = `T${entry.turn} ${who} ${entry.message}`;
      els.log.appendChild(li);
    }
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function renderBuildQueue() {
    const schedule = G.buildSchedule(game);
    const canEdit = !game.winner;
    els.buildSoldier.disabled = !canEdit;
    els.buildArtillery.disabled = !canEdit;
    els.repeatBuild.checked = game.repeatBuild;
    els.repeatBuild.disabled = !canEdit;
    els.buildEmpty.hidden = schedule.length > 0 || !!game.winner;
    els.defNext.textContent = schedule.length
      ? `next in ${plural(schedule[0].turnsLeft, 'turn')}`
      : 'queue empty';
    els.defNext.classList.toggle('warn', !schedule.length);

    els.buildQueue.replaceChildren();
    schedule.forEach(({ item, turnsLeft }, i) => {
      const s = G.UNITS[item.type];
      const li = document.createElement('li');
      li.className = `queue-item ${item.type}${i === 0 ? ' building' : ''}`;

      const name = document.createElement('span');
      name.className = 'queue-name';
      name.textContent = s.name;

      const bar = document.createElement('span');
      bar.className = 'queue-bar';
      const fill = document.createElement('span');
      fill.style.width = `${(item.progress / s.buildTurns) * 100}%`;
      bar.appendChild(fill);
      bar.title = `${item.progress} of ${plural(s.buildTurns, 'turn')} done`;

      const eta = document.createElement('span');
      eta.className = 'queue-eta';
      eta.textContent = item.progress >= s.buildTurns ? 'ready' : `in ${plural(turnsLeft, 'turn')}`;

      const controls = document.createElement('span');
      controls.className = 'queue-controls';
      const mk = (label, text, onClick, disabled) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        b.setAttribute('aria-label', `${label} ${s.name.toLowerCase()} (position ${i + 1})`);
        b.disabled = disabled || !canEdit;
        b.addEventListener('click', onClick);
        controls.appendChild(b);
      };
      mk('Move up', '↑', () => editQueue(() => G.moveInQueue(game, item.id, -1)), i === 0);
      mk('Move down', '↓', () => editQueue(() => G.moveInQueue(game, item.id, 1)), i === schedule.length - 1);
      mk('Remove', '✕', () => editQueue(() => G.removeFromQueue(game, item.id), item), false);

      li.append(name, bar, eta, controls);
      els.buildQueue.appendChild(li);
    });
  }

  function editQueue(change, removed) {
    const res = change();
    if (res && res.ok === false) message = res.reason;
    else if (removed && removed.progress > 0) message = `Removed ${G.UNITS[removed.type].name.toLowerCase()}; its build progress is lost.`;
    renderPanel();
  }

  function describeUnit(unit) {
    const s = G.UNITS[unit.type];
    const whose = unit.owner === HUMAN ? 'Your' : 'Enemy';
    const range = s.minRange === s.maxRange ? `${s.maxRange} cell` : `${s.minRange}–${s.maxRange} cells`;
    let text = `${whose} ${s.name.toLowerCase()}: ${unit.hp}/${unit.maxHp} HP, moves ${s.move}, ` +
      `attack ${s.attack}, defence ${s.defence}, hits targets ${range} away.`;
    if (!s.firesAfterMoving) text += ` It can't fire on a turn it moves.`;
    if (unit.owner === HUMAN && game.turn === HUMAN) {
      if (unit.moved) {
        text += G.stepBackCells(game, unit).length
          ? ' It has moved: tap a cell on its path to walk it back.'
          : ' It has moved this turn.';
      }
      text += ' ' + describeAttack(unit);
    }
    return text;
  }

  /** What the unit will attack at the end of the turn, for planning. */
  function describeAttack(unit) {
    if (!G.canFire(unit)) return "It moved, so it won't fire this turn.";
    const target = G.chooseTarget(game, unit);
    if (!target) return 'No enemies in range.';
    const dmg = G.damageAgainst(game, unit, target);
    const amount = dmg.min === dmg.max ? `${dmg.min}` : `${dmg.min}–${dmg.max}`;
    const what = target.keep
      ? `the keep (${game.keep.hp} HP)`
      : `the enemy ${G.UNITS[target.unit.type].name.toLowerCase()} (${target.unit.hp} HP)`;
    let text = `Will attack ${what} for ${amount} damage.`;
    const options = G.targetsInRange(game, unit).length;
    if (target.picked) text += ' You picked this target; tap it again to switch back to the default.';
    else if (options > 1) text += ` ${options} enemies are in range: tap another to attack it instead.`;
    return text;
  }

  /** Animate a moved unit back along its path to `cell`, then apply it. */
  async function walkBack(unit, cell) {
    const option = G.stepBackCells(game, unit).find((c) => G.samePos(c, cell));
    if (!option) return;
    busy = true;
    render();
    const node = scene.querySelector(`[data-id="${unit.id}"]`);
    if (node && TIMING.human > 0) {
      await tween(node, toPixel(unit), [unit, ...option.path].map(toPixel), TIMING.human);
    }
    const res = G.stepBack(game, unit, cell);
    busy = false;
    selected = { q: unit.q, r: unit.r };
    message = res.ok
      ? `${res.backToStart ? 'Back where it started; it can move again.' : 'Walked back.'} ${describeUnit(unit)}`
      : res.reason;
    render();
  }

  function yourTurnMessage() {
    const left = G.unmovedPieces(game).length;
    if (left === 0) return 'All your units have moved. Press End turn to fire.';
    const plural = left === 1 ? 'unit' : 'units';
    return `${left} ${plural} still to move. Tap a unit to see its moves, range and target. Numbers over enemies show the damage they'll take when you end the turn.`;
  }

  function describeWinner() {
    return game.winner === G.ATTACKER
      ? 'The attackers destroyed the keep. Press New game (top of the page) to try again.'
      : 'Every attacker has been destroyed. Well defended!';
  }

  // ---------- input ----------

  async function onCellClick({ q, r }) {
    if (busy || game.winner) return;
    const unit = G.pieceAt(game, q, r);
    const selectedUnit = selected && G.pieceAt(game, selected.q, selected.r);

    const mine = selectedUnit && selectedUnit.owner === HUMAN && game.turn === HUMAN;

    // Walk a moved unit back along its path.
    if (mine && !unit && G.stepBackCells(game, selectedUnit).some((c) => G.samePos(c, { q, r }))) {
      await walkBack(selectedUnit, { q, r });
      return;
    }

    // Pick a different enemy for the selected unit to attack (tap again to undo the pick).
    if (mine && unit && unit.owner !== HUMAN && G.canFire(selectedUnit) &&
        G.targetsInRange(game, selectedUnit).includes(unit)) {
      const current = G.chooseTarget(game, selectedUnit);
      const res = current && current.picked && current.unit === unit
        ? G.setTarget(game, selectedUnit, null)
        : G.setTarget(game, selectedUnit, unit);
      message = res.ok ? describeUnit(selectedUnit) : res.reason;
      render();
      return;
    }

    // Move the selected unit if this is one of its destinations.
    if (mine && !unit) {
      const legal = G.movesFor(game, selected.q, selected.r).some((t) => G.samePos(t, { q, r }));
      if (legal) {
        const from = selected;
        selected = null;
        busy = true;
        render();
        const res = await animatedMove(from, { q, r }, TIMING.human);
        busy = false;
        // Keep it selected so its new target and damage are visible straight away.
        selected = { q, r };
        message = res.ok ? describeUnit(selectedUnit) : res.reason;
        render();
        return;
      }
    }

    if (unit) {
      if (selected && G.samePos(selected, unit)) {
        selected = null;
        message = game.turn === HUMAN ? yourTurnMessage() : message;
      } else {
        selected = { q, r };
        message = describeUnit(unit);
      }
      render();
      return;
    }

    if (G.isKeep(game, q, r)) {
      selected = null;
      message = `The keep: ${game.keep.hp}/${game.keep.maxHp} HP, defence ${game.config.keepDefence}.`;
      render();
      return;
    }

    if (selectedUnit && selectedUnit.owner === HUMAN) {
      message = selectedUnit.moved
        ? 'That unit has already moved. Tap a cell on its path to walk it back.'
        : `That's out of reach. ${G.UNITS[selectedUnit.type].name} moves up to ${G.UNITS[selectedUnit.type].move} cells through empty spaces.`;
    } else {
      selected = null;
      message = yourTurnMessage();
    }
    render();
  }

  els.endBtn.addEventListener('click', endHumanTurn);
  els.buildSoldier.addEventListener('click', () => editQueue(() => G.queueUnit(game, 'soldier')));
  els.buildArtillery.addEventListener('click', () => editQueue(() => G.queueUnit(game, 'artillery')));
  els.repeatBuild.addEventListener('change', () => editQueue(() => G.setRepeatBuild(game, els.repeatBuild.checked)));
  // New game sits away from the turn controls and asks for a second click,
  // so a stray tap can't throw away a game in progress.
  let newGameTimer = null;
  function disarmNewGame() {
    clearTimeout(newGameTimer);
    newGameTimer = null;
    els.newBtn.classList.remove('armed');
    els.newBtn.textContent = 'New game';
  }
  els.newBtn.addEventListener('click', () => {
    const inProgress = !game.winner && game.turnNumber > 1;
    if (!inProgress || els.newBtn.classList.contains('armed')) {
      disarmNewGame();
      newGame();
      return;
    }
    els.newBtn.classList.add('armed');
    els.newBtn.textContent = 'Abandon this game? Click again';
    newGameTimer = setTimeout(disarmNewGame, 4000);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selected && !busy) {
      selected = null;
      message = game.turn === HUMAN ? yourTurnMessage() : '';
      render();
    }
  });

  newGame();
})();
