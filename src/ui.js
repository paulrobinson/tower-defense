/* Browser UI: renders the game as SVG, handles clicks and runs the CPU. */
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
    ? { think: 600, place: 150, step: 60, pause: 120, human: 0 }
    : { think: 1800, place: 450, step: 220, pause: 280, human: 140 };

  const els = {
    board: document.getElementById('board'),
    banner: document.getElementById('turn-banner'),
    defCount: document.getElementById('def-count'),
    attCount: document.getElementById('att-count'),
    attReserve: document.getElementById('att-reserve'),
    keepHp: document.getElementById('keep-hp'),
    message: document.getElementById('message'),
    log: document.getElementById('log'),
    endBtn: document.getElementById('end-btn'),
    newBtn: document.getElementById('new-btn'),
  };

  let game;
  let selected = null; // { q, r } of the selected piece
  let message = '';
  let busy = false; // true while the CPU plays or an animation runs
  let generation = 0; // bumps on New game so a running CPU turn stops
  let enteringId = null; // piece to play the "enter" animation on
  let thinking = false; // CPU 'thinking' pause before it acts

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
    enteringId = null;
    message = '';
    sizeBoard();
    render();
    if (game.turn === CPU) runCpuTurn();
  }

  async function runCpuTurn() {
    const gen = generation;
    const alive = () => gen === generation;
    busy = true;
    selected = null;
    message = 'The attackers are planning their move…';
    thinking = true;
    render();
    await wait(TIMING.think);
    if (!alive()) return;
    thinking = false;
    message = 'The attackers are moving.';

    let action;
    while (alive() && (action = AI.nextAction(game))) {
      if (action.type === 'place') {
        const res = G.place(game, action.cell.q, action.cell.r);
        if (!res.ok) break;
        enteringId = res.piece.id;
        render();
        enteringId = null;
        await wait(TIMING.place + TIMING.pause);
      } else {
        await animatedMove(action.from, action.to, TIMING.step);
        if (!alive()) return;
        await wait(TIMING.pause);
      }
      if (!alive()) return;
      if (game.winner) break;
    }
    if (!alive()) return;

    if (!game.winner) G.endTurn(game);
    busy = false;
    message = game.winner ? describeWinner() : yourTurnMessage();
    render();
  }

  /** Animate a piece along its path, then apply the move to the game. */
  async function animatedMove(from, to, stepMs) {
    const piece = G.pieceAt(game, from.q, from.r);
    const target = G.movesFor(game, from.q, from.r).find((t) => G.samePos(t, to));
    if (!piece || !target) return { ok: false, reason: 'That move is not allowed.' };

    if (stepMs > 0) {
      const node = els.board.querySelector(`[data-id="${piece.id}"]`);
      const start = toPixel(from);
      let points = [from, ...target.path].map(toPixel);
      if (target.kind === 'attack-keep') {
        // Advance to the striking cell, lunge part-way into the keep, then settle back.
        const strikeFrom = toPixel(target.end);
        const keepPx = points[points.length - 1];
        const lunge = { x: strikeFrom.x + (keepPx.x - strikeFrom.x) * 0.45, y: strikeFrom.y + (keepPx.y - strikeFrom.y) * 0.45 };
        points = [...points.slice(0, -1), lunge, strikeFrom];
      }
      if (target.kind === 'capture') {
        const victim = els.board.querySelector(`[data-id="${G.pieceAt(game, to.q, to.r).id}"]`);
        if (victim) victim.classList.add('captured');
      }
      if (node) {
        node.classList.add('moving');
        await tween(node, start, points, stepMs);
      }
      if (target.kind === 'attack-keep') flashKeep();
    }
    const res = G.move(game, from, to);
    render();
    return res;
  }

  function tween(node, start, points, stepMs) {
    const segments = points.length - 1;
    if (segments <= 0) return Promise.resolve();
    const total = stepMs * segments;
    return new Promise((resolve) => {
      const t0 = performance.now();
      function frame(now) {
        const t = Math.min(1, (now - t0) / total);
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const f = eased * segments;
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

  function flashKeep() {
    const keep = els.board.querySelector('.keep-piece');
    if (!keep) return;
    keep.classList.remove('hit');
    void keep.getBoundingClientRect();
    keep.classList.add('hit');
  }

  function endHumanTurn() {
    if (busy || game.winner || game.turn !== HUMAN) return;
    G.endTurn(game);
    selected = null;
    if (game.turn === CPU) runCpuTurn();
    else render();
  }

  // ---------- rendering ----------

  function sizeBoard() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of game.cells.values()) {
      const { x, y } = toPixel(c);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const pad = HEX_SIZE + 4;
    els.board.setAttribute(
      'viewBox',
      `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`
    );
  }

  function defineMarkers(board) {
    const defs = el('defs', {}, board);
    for (const kind of ['defender', 'cpu']) {
      const m = el('marker', {
        id: `arrow-${kind}`,
        viewBox: '0 0 10 10',
        refX: '6',
        refY: '5',
        markerWidth: '3.2',
        markerHeight: '3.2',
        orient: 'auto-start-reverse',
      }, defs);
      el('path', { d: 'M0,0 L10,5 L0,10 Z', class: `arrowhead ${kind}` }, m);
    }
  }

  function render() {
    const board = els.board;
    board.replaceChildren();
    defineMarkers(board);

    const myTurn = !busy && !game.winner && game.turn === HUMAN;
    const moveTargets = new Map();
    if (selected && myTurn) {
      for (const m of G.movesFor(game, selected.q, selected.r)) moveTargets.set(G.key(m.q, m.r), m.kind);
    }

    const cellsLayer = el('g', { class: 'cells' }, board);
    const markLayer = el('g', { class: 'marks' }, board);
    const piecesLayer = el('g', { class: 'pieces' }, board);
    const arrowLayer = el('g', { class: 'arrows' }, board);

    for (const cell of game.cells.values()) {
      const k = G.key(cell.q, cell.r);
      const { x, y } = toPixel(cell);
      const classes = ['cell'];
      if (cell.isEdge) classes.push('edge');
      if (G.hexDistance(cell, game.keep) <= game.config.keepRadius) classes.push('keep-zone');
      if (moveTargets.has(k)) classes.push(`target ${moveTargets.get(k)}`);
      if (selected && G.samePos(selected, cell)) classes.push('selected');

      const hex = el('polygon', { points: hexPoints(x, y), class: classes.join(' ') }, cellsLayer);
      hex.addEventListener('click', () => onCellClick(cell));
    }

    // Keep
    const kp = toPixel(game.keep);
    const keepGroup = el('g', { class: `keep-piece${moveTargets.has(G.key(0, 0)) ? ' targetable' : ''}` }, piecesLayer);
    el('polygon', { points: hexPoints(kp.x, kp.y), class: 'keep-hex' }, keepGroup);
    drawCastle(keepGroup, kp.x, kp.y);
    const hpText = el('text', { x: kp.x, y: kp.y + HEX_SIZE + 12, class: 'keep-hp-label' }, keepGroup);
    hpText.textContent = `${Math.max(game.keep.hp, 0)} HP`;
    keepGroup.addEventListener('click', () => onCellClick(game.keep));

    // Pieces
    for (const piece of game.pieces.values()) {
      const { x, y } = toPixel(piece);
      const classes = ['piece', piece.owner];
      if (selected && G.samePos(selected, piece)) classes.push('selected');
      if (piece.owner === game.turn && piece.moved && !game.winner) classes.push('done');
      if (piece.id === enteringId) classes.push('entering');
      const g = el('g', { class: classes.join(' '), 'data-id': piece.id }, piecesLayer);
      const inner = el('g', { class: 'piece-inner', style: `transform-origin: ${x}px ${y}px` }, g);
      if (piece.owner === G.DEFENDER) {
        el('circle', { cx: x, cy: y, r: HEX_SIZE * 0.58, class: 'body' }, inner);
        el('path', { d: shieldPath(x, y), class: 'glyph' }, inner);
      } else {
        el('polygon', { points: trianglePoints(x, y), class: 'body' }, inner);
        el('path', { d: swordPath(x, y), class: 'glyph' }, inner);
      }
      g.addEventListener('click', () => onCellClick(piece));
    }

    // Arrows and entry markers.
    // During the human's turn: their own moves so far, plus the CPU's last turn in grey.
    // During the CPU's turn: the CPU's moves as they happen, in grey.
    const records = [];
    if (game.current) records.push(game.current);
    if (game.turn === HUMAN && game.lastTurn && game.lastTurn.player === CPU) records.push(game.lastTurn);
    for (const rec of records) {
      const style = rec.player === CPU ? 'cpu' : 'defender';
      for (const cell of rec.placed) drawRing(markLayer, cell, `entry ${style}`);
      for (const cell of rec.spawned) drawRing(markLayer, cell, `entry ${style}`);
      for (const mv of rec.moves) drawArrow(arrowLayer, mv, style);
    }

    renderPanel();
  }

  function drawRing(layer, cell, cls) {
    const { x, y } = toPixel(cell);
    el('polygon', { points: hexPoints(x, y, HEX_SIZE * 0.86), class: `ring ${cls}` }, layer);
  }

  function drawArrow(layer, mv, style) {
    const pts = [mv.from, ...mv.path].map(toPixel);
    // Trim both ends so the arrow sits between piece glyphs rather than on them.
    const trim = (a, b, amount) => {
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      return { x: a.x + (dx / len) * amount, y: a.y + (dy / len) * amount };
    };
    pts[0] = trim(pts[0], pts[1], HEX_SIZE * 0.55);
    const n = pts.length - 1;
    pts[n] = trim(pts[n], pts[n - 1], HEX_SIZE * (mv.kind === 'move' ? 0.35 : 0.7));
    el('polyline', {
      points: pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
      class: `arrow ${style} ${mv.kind}`,
      'marker-end': `url(#arrow-${style})`,
    }, layer);
  }

  function trianglePoints(x, y) {
    const s = HEX_SIZE * 0.68;
    return `${x},${y - s} ${x + s * 0.9},${y + s * 0.62} ${x - s * 0.9},${y + s * 0.62}`;
  }

  function shieldPath(x, y) {
    const s = HEX_SIZE * 0.3;
    return `M${x - s},${y - s} L${x + s},${y - s} L${x + s},${y} Q${x + s},${y + s} ${x},${y + s * 1.3} Q${x - s},${y + s} ${x - s},${y} Z`;
  }

  function swordPath(x, y) {
    const s = HEX_SIZE * 0.32;
    return `M${x},${y - s * 1.2} L${x},${y + s} M${x - s * 0.6},${y + s * 0.35} L${x + s * 0.6},${y + s * 0.35}`;
  }

  function drawCastle(group, x, y) {
    const w = HEX_SIZE * 1.0;
    const h = HEX_SIZE * 0.8;
    const left = x - w / 2;
    const top = y - h / 2;
    const m = w / 5; // merlon width
    const d = [
      `M${left},${top + h}`,
      `L${left},${top}`,
      `L${left + m},${top}`, `L${left + m},${top + m}`,
      `L${left + 2 * m},${top + m}`, `L${left + 2 * m},${top}`,
      `L${left + 3 * m},${top}`, `L${left + 3 * m},${top + m}`,
      `L${left + 4 * m},${top + m}`, `L${left + 4 * m},${top}`,
      `L${left + w},${top}`,
      `L${left + w},${top + h}`,
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
    els.attCount.textContent = G.piecesOf(game, G.ATTACKER).length;
    els.attReserve.textContent = game.reserves[G.ATTACKER];
    els.keepHp.textContent = `${Math.max(game.keep.hp, 0)} / ${game.config.keepHp}`;
    els.message.textContent = message;
    els.endBtn.disabled = busy || !!game.winner || game.turn !== HUMAN;

    els.log.replaceChildren();
    for (const entry of [...game.log].reverse()) {
      const li = document.createElement('li');
      li.className = entry.player;
      const who = entry.player === CPU ? 'Attackers' : 'Defenders';
      li.textContent = `T${entry.turn} ${who} ${entry.message}`;
      els.log.appendChild(li);
    }
  }

  function yourTurnMessage() {
    const left = G.unmovedPieces(game).length;
    if (left === 0) return 'All your pieces have moved. Press End turn.';
    const plural = left === 1 ? 'piece' : 'pieces';
    return `${left} ${plural} still to move. Click one of your pieces to see where it can go, or press End turn.`;
  }

  function describeWinner() {
    return game.winner === G.ATTACKER
      ? 'The attackers destroyed the keep. Press New game to try again.'
      : 'Every attacker has been destroyed. Well defended!';
  }

  // ---------- input ----------

  async function onCellClick({ q, r }) {
    if (busy || game.winner || game.turn !== HUMAN) return;
    const piece = G.pieceAt(game, q, r);

    if (piece && piece.owner === HUMAN) {
      if (piece.moved) {
        message = 'That piece has already moved this turn.';
      } else if (selected && G.samePos(selected, piece)) {
        selected = null;
        message = yourTurnMessage();
      } else {
        selected = { q, r };
        message = `Choose a highlighted cell (up to ${game.config.maxMove} away), or click the piece again to cancel.`;
      }
      render();
      return;
    }

    if (selected) {
      const legal = G.movesFor(game, selected.q, selected.r).some((t) => G.samePos(t, { q, r }));
      if (!legal) {
        message = `That piece can't reach there. Pieces move up to ${game.config.maxMove} cells through empty spaces.`;
        render();
        return;
      }
      const from = selected;
      selected = null;
      busy = true;
      render();
      const res = await animatedMove(from, { q, r }, TIMING.human);
      busy = false;
      message = game.winner ? describeWinner() : res.ok ? yourTurnMessage() : res.reason;
      render();
      return;
    }

    message = piece
      ? 'Select one of your pieces within reach of that attacker to capture it.'
      : 'Select one of your pieces first. New defenders appear by the keep at the start of each turn.';
    render();
  }

  els.endBtn.addEventListener('click', endHumanTurn);
  els.newBtn.addEventListener('click', newGame);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selected) {
      selected = null;
      message = yourTurnMessage();
      render();
    }
  });

  newGame();
})();
