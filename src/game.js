/*
 * Core game rules for the hex tower defence game.
 *
 * This file has no DOM dependencies so it can be used both in the browser
 * (exposed as the global `TDGame`) and in Node (via `require`) for tests.
 *
 * Coordinates are axial hex coordinates (q, r) with pointy-top hexes.
 *
 * Turn structure:
 *   - On their turn a player may move every one of their pieces once,
 *     each up to `maxMove` cells, then ends the turn.
 *   - Attackers may also place one piece per turn on an empty edge cell.
 *   - At the start of each defender turn a new defender piece is added
 *     automatically next to the keep (if there is room).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.TDGame = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFENDER = 'defender';
  const ATTACKER = 'attacker';

  const CONFIG = {
    width: 17, // number of cells across the widest row
    keepRadius: 3, // defenders spawn within this hex distance of the keep
    keepHp: 5,
    maxMove: 2, // cells a piece may move per turn
    attackerReserve: 12, // pieces the attacker can bring onto the board
    attackerPlacementsPerTurn: 1,
    defenderSpawnsPerTurn: 1,
  };

  const DIRECTIONS = [
    [1, 0], [1, -1], [0, -1],
    [-1, 0], [-1, 1], [0, 1],
  ];

  const key = (q, r) => `${q},${r}`;
  const samePos = (a, b) => a.q === b.q && a.r === b.r;
  const pos = (c) => ({ q: c.q, r: c.r });

  function hexDistance(a, b) {
    const dq = a.q - b.q;
    const dr = a.r - b.r;
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
  }

  /** Euclidean distance from the origin, in units of centre-to-centre spacing. */
  function euclideanFromCentre(q, r) {
    const x = q + r / 2;
    const y = (r * Math.sqrt(3)) / 2;
    return Math.sqrt(x * x + y * y);
  }

  /**
   * Build a roughly circular hex grid whose widest row is `width` cells.
   * A cell is included when its centre lies within a circle of radius
   * width / 2 (measured in cell spacings).
   */
  function buildGrid(width) {
    const radius = width / 2;
    const span = Math.ceil(radius) + 1;
    const cells = new Map();
    for (let r = -span; r <= span; r++) {
      for (let q = -span * 2; q <= span * 2; q++) {
        if (euclideanFromCentre(q, r) <= radius) {
          cells.set(key(q, r), { q, r });
        }
      }
    }
    for (const cell of cells.values()) {
      cell.isEdge = neighbours(cell).some((n) => !cells.has(key(n.q, n.r)));
    }
    return cells;
  }

  function neighbours(cell) {
    return DIRECTIONS.map(([dq, dr]) => ({ q: cell.q + dq, r: cell.r + dr }));
  }

  const KEEP_POS = { q: 0, r: 0 };

  function createGame(overrides = {}) {
    const config = { ...CONFIG, ...overrides };
    const game = {
      config,
      cells: buildGrid(config.width),
      keep: { ...KEEP_POS, hp: config.keepHp },
      pieces: new Map(), // key -> { id, owner, q, r, moved }
      reserves: { [ATTACKER]: config.attackerReserve },
      turn: ATTACKER,
      turnNumber: 1,
      winner: null,
      log: [],
      nextId: 1,
      // What has happened during the current turn (for arrows / markers).
      current: null,
      // The record of the previous turn, kept so the UI can show it.
      lastTurn: null,
    };
    startTurn(game);
    return game;
  }

  const other = (player) => (player === ATTACKER ? DEFENDER : ATTACKER);
  const isKeep = (game, q, r) => game.keep.q === q && game.keep.r === r;
  const inGrid = (game, q, r) => game.cells.has(key(q, r));
  const pieceAt = (game, q, r) => game.pieces.get(key(q, r)) || null;
  const piecesOf = (game, owner) => [...game.pieces.values()].filter((p) => p.owner === owner);

  function isEmpty(game, q, r) {
    return inGrid(game, q, r) && !isKeep(game, q, r) && !pieceAt(game, q, r);
  }

  function newTurnRecord(player) {
    return { player, moves: [], placed: [], spawned: [] };
  }

  function addPiece(game, owner, q, r) {
    const piece = { id: game.nextId++, owner, q, r, moved: false };
    game.pieces.set(key(q, r), piece);
    return piece;
  }

  function startTurn(game) {
    game.current = newTurnRecord(game.turn);
    for (const p of game.pieces.values()) p.moved = false;
    if (game.turn === DEFENDER) {
      for (let i = 0; i < game.config.defenderSpawnsPerTurn; i++) {
        const cell = chooseSpawnCell(game);
        if (!cell) break;
        addPiece(game, DEFENDER, cell.q, cell.r);
        game.current.spawned.push(pos(cell));
        addLog(game, `reinforced at (${cell.q}, ${cell.r})`);
      }
    }
  }

  /**
   * Where the automatic defender reinforcement appears: the empty cell in
   * the keep zone nearest the keep, breaking ties towards the closest
   * attacker so reinforcements face the threat.
   */
  function chooseSpawnCell(game) {
    const attackers = piecesOf(game, ATTACKER);
    const nearestAttacker = (c) =>
      attackers.length ? Math.min(...attackers.map((a) => hexDistance(a, c))) : 0;
    let best = null;
    let bestScore = Infinity;
    for (const c of game.cells.values()) {
      if (!isEmpty(game, c.q, c.r)) continue;
      const d = hexDistance(c, game.keep);
      if (d > game.config.keepRadius) continue;
      const score = d * 100 + nearestAttacker(c);
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  function canPlaceAt(game, player, q, r) {
    if (player !== ATTACKER) return false;
    if (!isEmpty(game, q, r)) return false;
    return game.cells.get(key(q, r)).isEdge;
  }

  function placementsLeft(game, player = game.turn) {
    if (game.winner || player !== ATTACKER || game.turn !== player) return 0;
    return Math.min(
      game.reserves[ATTACKER],
      game.config.attackerPlacementsPerTurn - game.current.placed.length
    );
  }

  function placementCells(game, player = game.turn) {
    if (placementsLeft(game, player) <= 0) return [];
    return [...game.cells.values()].filter((c) => canPlaceAt(game, player, c.q, c.r));
  }

  /**
   * Every destination the piece at (q, r) could reach this turn, ignoring
   * whose turn it is or whether it has already moved. Movement is up to
   * `maxMove` steps through empty cells. Each target carries:
   *   kind: 'move' (empty cell), 'capture' (enemy piece) or
   *         'attack-keep' (attackers only; the piece strikes the keep)
   *   path: cells stepped through after the start, ending at the target
   *   end:  where the piece finishes (for 'attack-keep', the cell it
   *         struck from)
   */
  function reachable(game, q, r, maxSteps = game.config.maxMove) {
    const piece = pieceAt(game, q, r);
    if (!piece) return [];
    const targets = new Map();
    const visited = new Set([key(q, r)]);
    let frontier = [{ cell: { q, r }, path: [] }];
    for (let step = 1; step <= maxSteps; step++) {
      const next = [];
      for (const { cell, path } of frontier) {
        for (const n of neighbours(cell)) {
          const k = key(n.q, n.r);
          if (!inGrid(game, n.q, n.r)) continue;
          const newPath = [...path, n];
          if (isKeep(game, n.q, n.r)) {
            if (piece.owner === ATTACKER && !targets.has(k)) {
              targets.set(k, { q: n.q, r: n.r, kind: 'attack-keep', path: newPath, end: pos(cell) });
            }
            continue;
          }
          if (visited.has(k)) continue;
          const occupant = pieceAt(game, n.q, n.r);
          if (occupant) {
            if (occupant.owner !== piece.owner && !targets.has(k)) {
              targets.set(k, { q: n.q, r: n.r, kind: 'capture', path: newPath, end: pos(n) });
            }
            continue;
          }
          visited.add(k);
          targets.set(k, { q: n.q, r: n.r, kind: 'move', path: newPath, end: pos(n) });
          next.push({ cell: n, path: newPath });
        }
      }
      frontier = next;
    }
    return [...targets.values()];
  }

  /** Legal moves for the piece at (q, r) right now. */
  function movesFor(game, q, r) {
    const piece = pieceAt(game, q, r);
    if (!piece || game.winner || piece.owner !== game.turn || piece.moved) return [];
    return reachable(game, q, r);
  }

  function fail(reason) {
    return { ok: false, reason };
  }

  function addLog(game, message) {
    game.log.push({ turn: game.turnNumber, player: game.turn, message });
  }

  function checkWinner(game) {
    if (game.winner) return;
    if (game.keep.hp <= 0) {
      game.winner = ATTACKER;
    } else if (game.reserves[ATTACKER] + piecesOf(game, ATTACKER).length === 0) {
      game.winner = DEFENDER;
    }
    if (game.winner) addLog(game, `— ${capitalise(game.winner)}s win!`);
  }

  function place(game, q, r) {
    if (game.winner) return fail('The game is over.');
    const player = game.turn;
    if (player !== ATTACKER) return fail('Defenders are reinforced automatically each turn.');
    if (game.reserves[ATTACKER] <= 0) return fail('No pieces left in reserve.');
    if (placementsLeft(game) <= 0) return fail('You have already placed a piece this turn.');
    if (!canPlaceAt(game, player, q, r)) return fail('Attackers may only place on empty edge cells.');
    const piece = addPiece(game, player, q, r);
    game.reserves[ATTACKER] -= 1;
    game.current.placed.push(pos(piece));
    addLog(game, `entered at (${q}, ${r})`);
    return { ok: true, piece };
  }

  function move(game, from, to) {
    if (game.winner) return fail('The game is over.');
    const piece = pieceAt(game, from.q, from.r);
    if (!piece) return fail('There is no piece there.');
    if (piece.owner !== game.turn) return fail("That isn't your piece.");
    if (piece.moved) return fail('That piece has already moved this turn.');
    const target = reachable(game, from.q, from.r).find((m) => samePos(m, to));
    if (!target) return fail(`Pieces can move up to ${game.config.maxMove} cells through empty spaces.`);

    let captured = null;
    if (target.kind === 'capture') {
      captured = pieceAt(game, to.q, to.r);
      game.pieces.delete(key(to.q, to.r));
    }
    game.pieces.delete(key(from.q, from.r));
    piece.q = target.end.q;
    piece.r = target.end.r;
    piece.moved = true;
    game.pieces.set(key(piece.q, piece.r), piece);

    if (target.kind === 'attack-keep') {
      game.keep.hp -= 1;
      addLog(game, `struck the keep — ${Math.max(game.keep.hp, 0)} HP left`);
    } else if (target.kind === 'capture') {
      addLog(game, `captured a piece at (${to.q}, ${to.r})`);
    } else {
      addLog(game, `moved (${from.q}, ${from.r}) → (${to.q}, ${to.r})`);
    }

    const record = {
      pieceId: piece.id,
      owner: piece.owner,
      from: pos(from),
      path: target.path.map(pos),
      end: pos(target.end),
      kind: target.kind,
      capturedId: captured ? captured.id : null,
    };
    game.current.moves.push(record);
    checkWinner(game);
    return { ok: true, kind: target.kind, record };
  }

  /** Pieces belonging to the current player that can still move. */
  function unmovedPieces(game) {
    return piecesOf(game, game.turn).filter((p) => !p.moved);
  }

  function endTurn(game) {
    if (game.winner) return fail('The game is over.');
    checkWinner(game);
    if (game.winner) return { ok: true };
    game.lastTurn = game.current;
    game.turn = other(game.turn);
    game.turnNumber += 1;
    startTurn(game);
    return { ok: true };
  }

  function capitalise(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  return {
    DEFENDER,
    ATTACKER,
    CONFIG,
    key,
    samePos,
    hexDistance,
    buildGrid,
    neighbours,
    createGame,
    pieceAt,
    piecesOf,
    isKeep,
    isEmpty,
    canPlaceAt,
    placementsLeft,
    placementCells,
    reachable,
    movesFor,
    unmovedPieces,
    place,
    move,
    endTurn,
    capitalise,
  };
});
