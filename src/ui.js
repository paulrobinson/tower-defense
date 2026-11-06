/* Browser UI: renders the game state as SVG and handles clicks. */
(function () {
  'use strict';

  const G = window.TDGame;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const HEX_SIZE = 22; // centre to corner, in SVG units
  const SQRT3 = Math.sqrt(3);

  const els = {
    board: document.getElementById('board'),
    banner: document.getElementById('turn-banner'),
    defReserve: document.getElementById('def-reserve'),
    attReserve: document.getElementById('att-reserve'),
    keepHp: document.getElementById('keep-hp'),
    message: document.getElementById('message'),
    log: document.getElementById('log'),
    passBtn: document.getElementById('pass-btn'),
    newBtn: document.getElementById('new-btn'),
  };

  let game;
  let selected = null; // { q, r } of the selected piece
  let message = '';

  const toPixel = ({ q, r }) => ({
    x: HEX_SIZE * SQRT3 * (q + r / 2),
    y: HEX_SIZE * 1.5 * r,
  });

  function hexPoints(cx, cy) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 180) * (60 * i - 30);
      pts.push(`${(cx + HEX_SIZE * Math.cos(angle)).toFixed(2)},${(cy + HEX_SIZE * Math.sin(angle)).toFixed(2)}`);
    }
    return pts.join(' ');
  }

  function el(name, attrs = {}, parent) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }

  function newGame() {
    game = G.createGame();
    selected = null;
    message = 'Attackers, place your first piece on the edge of the board.';
    sizeBoard();
    render();
  }

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

  function render() {
    const board = els.board;
    board.replaceChildren();

    const placeable = new Set(G.placementCells(game).map((c) => G.key(c.q, c.r)));
    const moveTargets = new Map();
    if (selected) {
      for (const m of G.movesFor(game, selected.q, selected.r)) moveTargets.set(G.key(m.q, m.r), m.kind);
    }

    const cellsLayer = el('g', { class: 'cells' }, board);
    const piecesLayer = el('g', { class: 'pieces' }, board);

    for (const cell of game.cells.values()) {
      const k = G.key(cell.q, cell.r);
      const { x, y } = toPixel(cell);
      const classes = ['cell'];
      if (cell.isEdge) classes.push('edge');
      if (G.hexDistance(cell, game.keep) <= game.config.keepRadius) classes.push('keep-zone');
      if (!selected && placeable.has(k)) classes.push(`placeable ${game.turn}`);
      if (moveTargets.has(k)) classes.push(`target ${moveTargets.get(k)}`);
      if (selected && selected.q === cell.q && selected.r === cell.r) classes.push('selected');

      const hex = el('polygon', { points: hexPoints(x, y), class: classes.join(' ') }, cellsLayer);
      hex.addEventListener('click', () => onCellClick(cell));
    }

    // Keep
    const kp = toPixel(game.keep);
    const keepGroup = el('g', { class: 'keep-piece' }, piecesLayer);
    el('polygon', { points: hexPoints(kp.x, kp.y), class: 'keep-hex' }, keepGroup);
    drawCastle(keepGroup, kp.x, kp.y);
    const hpText = el('text', { x: kp.x, y: kp.y + HEX_SIZE + 12, class: 'keep-hp-label' }, keepGroup);
    hpText.textContent = `${Math.max(game.keep.hp, 0)} HP`;
    keepGroup.addEventListener('click', () => onCellClick(game.keep));

    // Pieces
    for (const piece of game.pieces.values()) {
      const { x, y } = toPixel(piece);
      const g = el('g', { class: `piece ${piece.owner}${isSelected(piece) ? ' selected' : ''}` }, piecesLayer);
      if (piece.owner === G.DEFENDER) {
        el('circle', { cx: x, cy: y, r: HEX_SIZE * 0.58 }, g);
        el('path', { d: shieldPath(x, y), class: 'glyph' }, g);
      } else {
        el('polygon', { points: trianglePoints(x, y), class: 'body' }, g);
        el('path', { d: swordPath(x, y), class: 'glyph' }, g);
      }
      g.addEventListener('click', () => onCellClick(piece));
    }

    renderPanel();
  }

  function isSelected(p) {
    return selected && selected.q === p.q && selected.r === p.r;
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
    const turnName = G.capitalise(game.turn);
    if (game.winner) {
      els.banner.className = `turn-banner ${game.winner} winner`;
      els.banner.textContent = `${G.capitalise(game.winner)}s win!`;
    } else {
      els.banner.className = `turn-banner ${game.turn}`;
      els.banner.textContent = `Turn ${game.turnNumber}: ${turnName}s to play`;
    }
    els.defReserve.textContent = game.reserves[G.DEFENDER];
    els.attReserve.textContent = game.reserves[G.ATTACKER];
    els.keepHp.textContent = `${Math.max(game.keep.hp, 0)} / ${game.config.keepHp}`;
    els.message.textContent = message;
    els.passBtn.disabled = !!game.winner;

    els.log.replaceChildren();
    for (const entry of [...game.log].reverse()) {
      const li = document.createElement('li');
      li.className = entry.player;
      li.textContent = `${G.capitalise(entry.player)} ${entry.message}`;
      els.log.appendChild(li);
    }
  }

  function onCellClick({ q, r }) {
    if (game.winner) return;
    const piece = G.pieceAt(game, q, r);

    // Clicking one of your own pieces selects / deselects it.
    if (piece && piece.owner === game.turn) {
      selected = isSelected(piece) ? null : { q, r };
      message = selected ? 'Choose a highlighted cell to move to, or click the piece again to cancel.' : '';
      render();
      return;
    }

    if (selected) {
      const result = G.move(game, selected, { q, r });
      if (result.ok) {
        selected = null;
        message = describeNext();
      } else {
        message = result.reason;
      }
      render();
      return;
    }

    if (G.isKeep(game, q, r)) {
      message = game.turn === G.DEFENDER ? 'The keep cannot move.' : 'Select one of your pieces next to the keep to attack it.';
      render();
      return;
    }

    if (piece) {
      message = "That's an enemy piece. Select one of yours next to it to capture it.";
      render();
      return;
    }

    const result = G.place(game, q, r);
    message = result.ok ? describeNext() : result.reason;
    render();
  }

  function describeNext() {
    if (game.winner) {
      return game.winner === G.ATTACKER ? 'The keep has fallen!' : 'Every attacker has been destroyed!';
    }
    return `${G.capitalise(game.turn)}s: place a piece or move one of yours.`;
  }

  els.passBtn.addEventListener('click', () => {
    const result = G.pass(game);
    selected = null;
    message = result.ok ? describeNext() : result.reason;
    render();
  });

  els.newBtn.addEventListener('click', newGame);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selected) {
      selected = null;
      message = '';
      render();
    }
  });

  newGame();
})();
