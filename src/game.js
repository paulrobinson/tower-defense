/*
 * Core game rules for the hex tower defence game.
 *
 * This file has no DOM dependencies so it can be used both in the browser
 * (exposed as the global `TDGame`) and in Node (via `require`) for tests.
 *
 * Coordinates are axial hex coordinates (q, r) with pointy-top hexes.
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
    keepRadius: 3, // defenders may place within this hex distance of the keep
    keepHp: 5,
    reserves: { [DEFENDER]: 8, [ATTACKER]: 12 },
  };

  const DIRECTIONS = [
    [1, 0], [1, -1], [0, -1],
    [-1, 0], [-1, 1], [0, 1],
  ];

  const key = (q, r) => `${q},${r}`;

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
    const config = { ...CONFIG, ...overrides, reserves: { ...CONFIG.reserves, ...(overrides.reserves || {}) } };
    return {
      config,
      cells: buildGrid(config.width),
      keep: { ...KEEP_POS, hp: config.keepHp },
      pieces: new Map(), // key -> { id, owner, q, r }
      reserves: { ...config.reserves },
      turn: ATTACKER,
      turnNumber: 1,
      winner: null,
      log: [],
      nextId: 1,
    };
  }

  const other = (player) => (player === ATTACKER ? DEFENDER : ATTACKER);
  const isKeep = (game, q, r) => game.keep.q === q && game.keep.r === r;
  const inGrid = (game, q, r) => game.cells.has(key(q, r));
  const pieceAt = (game, q, r) => game.pieces.get(key(q, r)) || null;

  function isEmpty(game, q, r) {
    return inGrid(game, q, r) && !isKeep(game, q, r) && !pieceAt(game, q, r);
  }

  function canPlaceAt(game, player, q, r) {
    if (!isEmpty(game, q, r)) return false;
    if (player === DEFENDER) {
      return hexDistance({ q, r }, game.keep) <= game.config.keepRadius;
    }
    return game.cells.get(key(q, r)).isEdge;
  }

  function placementCells(game, player = game.turn) {
    if (game.winner || game.reserves[player] <= 0) return [];
    return [...game.cells.values()].filter((c) => canPlaceAt(game, player, c.q, c.r));
  }

  /**
   * Legal one-step moves for the piece at (q, r). Each target is tagged with
   * the kind of move: 'move' into an empty cell, 'capture' an enemy piece,
   * or 'attack-keep' (attackers only).
   */
  function movesFor(game, q, r) {
    const piece = pieceAt(game, q, r);
    if (!piece || game.winner) return [];
    const result = [];
    for (const n of neighbours(piece)) {
      if (!inGrid(game, n.q, n.r)) continue;
      if (isKeep(game, n.q, n.r)) {
        if (piece.owner === ATTACKER) result.push({ ...n, kind: 'attack-keep' });
        continue;
      }
      const occupant = pieceAt(game, n.q, n.r);
      if (!occupant) result.push({ ...n, kind: 'move' });
      else if (occupant.owner !== piece.owner) result.push({ ...n, kind: 'capture' });
    }
    return result;
  }

  function fail(reason) {
    return { ok: false, reason };
  }

  function addLog(game, message) {
    game.log.push({ turn: game.turnNumber, player: game.turn, message });
  }

  function checkWinner(game) {
    if (game.keep.hp <= 0) {
      game.winner = ATTACKER;
      return;
    }
    const attackersLeft =
      game.reserves[ATTACKER] + [...game.pieces.values()].filter((p) => p.owner === ATTACKER).length;
    if (attackersLeft === 0) game.winner = DEFENDER;
  }

  function endTurn(game) {
    checkWinner(game);
    if (game.winner) {
      addLog(game, `${capitalise(game.winner)}s win!`);
      return;
    }
    game.turn = other(game.turn);
    game.turnNumber += 1;
  }

  function place(game, q, r) {
    if (game.winner) return fail('The game is over.');
    const player = game.turn;
    if (game.reserves[player] <= 0) return fail('No pieces left in reserve.');
    if (!canPlaceAt(game, player, q, r)) {
      return fail(
        player === DEFENDER
          ? `Defenders may only place on empty cells within ${game.config.keepRadius} of the keep.`
          : 'Attackers may only place on empty edge cells.'
      );
    }
    const piece = { id: game.nextId++, owner: player, q, r };
    game.pieces.set(key(q, r), piece);
    game.reserves[player] -= 1;
    addLog(game, `placed a piece at (${q}, ${r})`);
    endTurn(game);
    return { ok: true };
  }

  function move(game, from, to) {
    if (game.winner) return fail('The game is over.');
    const piece = pieceAt(game, from.q, from.r);
    if (!piece) return fail('There is no piece there.');
    if (piece.owner !== game.turn) return fail("That isn't your piece.");
    const target = movesFor(game, from.q, from.r).find((m) => m.q === to.q && m.r === to.r);
    if (!target) return fail('Pieces can only move one cell to an adjacent space.');

    if (target.kind === 'attack-keep') {
      game.keep.hp -= 1;
      addLog(game, `struck the keep from (${from.q}, ${from.r}) — keep HP ${Math.max(game.keep.hp, 0)}`);
    } else {
      if (target.kind === 'capture') {
        game.pieces.delete(key(to.q, to.r));
      }
      game.pieces.delete(key(from.q, from.r));
      piece.q = to.q;
      piece.r = to.r;
      game.pieces.set(key(to.q, to.r), piece);
      addLog(
        game,
        target.kind === 'capture'
          ? `captured an enemy at (${to.q}, ${to.r})`
          : `moved (${from.q}, ${from.r}) → (${to.q}, ${to.r})`
      );
    }
    endTurn(game);
    return { ok: true, kind: target.kind };
  }

  /** Skip the current turn (useful when a player has nothing sensible to do). */
  function pass(game) {
    if (game.winner) return fail('The game is over.');
    addLog(game, 'passed');
    endTurn(game);
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
    hexDistance,
    buildGrid,
    neighbours,
    createGame,
    pieceAt,
    isKeep,
    canPlaceAt,
    placementCells,
    movesFor,
    place,
    move,
    pass,
    capitalise,
  };
});
