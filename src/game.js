/*
 * Core game rules for the hex tower defence game.
 *
 * This file has no DOM dependencies so it can be used both in the browser
 * (exposed as the global `TDGame`) and in Node (via `require`) for tests.
 *
 * Coordinates are axial hex coordinates (q, r) with pointy-top hexes.
 *
 * Turn structure:
 *   1. At the start of a turn, new units enter for the player whose turn it is,
 *      on a random empty cell: attackers on the edge, defenders near the keep.
 *        Attackers: one unit per turn, drawn at random from a fixed pool of
 *          12 (3 artillery, 9 soldiers).
 *        Defenders: build units from a queue, without limit. The unit at the
 *          front of the queue gains one turn of progress at the start of each
 *          defender turn, and enters once it has had its build time
 *          (soldier 1 turn, artillery 3). With "repeat" on, each finished
 *          unit is put back at the end of the queue.
 *   2. The player may move every one of their units once, up to the unit's
 *      move distance, through empty cells.
 *      Moves can be undone until the turn ends.
 *   3. When the turn ends, each of that player's units attacks one enemy in
 *      its attack radius (attackers may target the keep). Damage is random,
 *      scaled by attack power / defence power. Units at 0 HP die.
 *      Artillery that moved this turn does not fire.
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

  const UNITS = {
    soldier: { name: 'Soldier', move: 2, attack: 2, defence: 2, minRange: 1, maxRange: 1, hp: 10, firesAfterMoving: true, buildTurns: 1 },
    artillery: { name: 'Artillery', move: 3, attack: 5, defence: 1, minRange: 2, maxRange: 4, hp: 10, firesAfterMoving: false, buildTurns: 3 },
  };

  const CONFIG = {
    width: 17, // number of cells across the widest row
    keepRadius: 3, // defenders enter within this hex distance of the keep
    keepHp: 40,
    keepDefence: 4,
    attackerUnits: 12,
    attackerArtillery: 3, // the rest are soldiers
    attackerEntriesPerTurn: 1,
    initialBuildQueue: ['soldier'], // what the defender starts out building
    damageBase: 3, // average damage when attack power equals defence power
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

  function shuffle(list, rng) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function makePool(config, rng) {
    const pool = [];
    for (let i = 0; i < config.attackerUnits; i++) {
      pool.push(i < config.attackerArtillery ? 'artillery' : 'soldier');
    }
    return shuffle(pool, rng);
  }

  const KEEP_POS = { q: 0, r: 0 };

  /**
   * Create a game. `overrides` may change any CONFIG value, and may pass
   * `rng` (a function returning [0, 1)) to make games repeatable.
   */
  function createGame(overrides = {}) {
    const { rng = Math.random, ...rest } = overrides;
    const config = { ...CONFIG, ...rest };
    const game = {
      config,
      rng,
      cells: buildGrid(config.width),
      keep: { ...KEEP_POS, hp: config.keepHp, maxHp: config.keepHp },
      pieces: new Map(), // key -> unit
      pools: { [ATTACKER]: makePool(config, rng) },
      buildQueue: [], // defender: [{ id, type, progress }], front first
      repeatBuild: false,
      nextBuildId: 1,
      turn: ATTACKER,
      turnNumber: 1,
      winner: null,
      log: [],
      nextId: 1,
      damageDealt: { [ATTACKER]: 0, [DEFENDER]: 0 }, // running totals, for the CPU
      current: null, // what has happened during the current turn
      lastTurn: null, // the record of the previous turn
    };
    for (const type of config.initialBuildQueue) queueUnit(game, type);
    startTurn(game);
    return game;
  }

  const other = (player) => (player === ATTACKER ? DEFENDER : ATTACKER);
  const isKeep = (game, q, r) => game.keep.q === q && game.keep.r === r;
  const inGrid = (game, q, r) => game.cells.has(key(q, r));
  const pieceAt = (game, q, r) => game.pieces.get(key(q, r)) || null;
  const piecesOf = (game, owner) => [...game.pieces.values()].filter((p) => p.owner === owner);
  const stats = (unit) => UNITS[unit.type];

  function isEmpty(game, q, r) {
    return inGrid(game, q, r) && !isKeep(game, q, r) && !pieceAt(game, q, r);
  }

  function addUnit(game, owner, type, q, r) {
    const s = UNITS[type];
    const unit = { id: game.nextId++, owner, type, q, r, hp: s.hp, maxHp: s.hp, moved: false, fired: false };
    game.pieces.set(key(q, r), unit);
    return unit;
  }

  function newTurnRecord(player) {
    return { player, moves: [], entered: [], attacks: [] };
  }

  /** Empty cells where `player`'s new units may enter. */
  function entryCells(game, player) {
    return [...game.cells.values()].filter((c) => {
      if (!isEmpty(game, c.q, c.r)) return false;
      return player === ATTACKER ? c.isEdge : hexDistance(c, game.keep) <= game.config.keepRadius;
    });
  }

  function startTurn(game) {
    const player = game.turn;
    game.current = newTurnRecord(player);
    for (const p of game.pieces.values()) {
      p.moved = false;
      p.fired = false;
      p.held = false;
    }
    if (player === ATTACKER) {
      for (let i = 0; i < game.config.attackerEntriesPerTurn; i++) {
        if (!game.pools[ATTACKER].length) break;
        if (!enter(game, ATTACKER, game.pools[ATTACKER][game.pools[ATTACKER].length - 1])) break;
        game.pools[ATTACKER].pop();
      }
    } else {
      advanceBuild(game);
    }
  }

  /** Put a new unit on a random entry cell. Returns the unit, or null if there's no room. */
  function enter(game, player, type) {
    const cells = entryCells(game, player);
    if (!cells.length) return null;
    const cell = cells[Math.floor(game.rng() * cells.length)];
    const unit = addUnit(game, player, type, cell.q, cell.r);
    game.current.entered.push({ id: unit.id, q: cell.q, r: cell.r });
    addLog(game, `${UNITS[type].name} entered at (${cell.q}, ${cell.r})`);
    return unit;
  }

  // ---------- defender build queue ----------

  /**
   * Progress the front of the build queue by one turn, and deploy it if it's
   * finished. A finished unit with nowhere to go waits at the front.
   */
  function advanceBuild(game) {
    const item = game.buildQueue[0];
    if (!item) return;
    item.progress = Math.min(item.progress + 1, UNITS[item.type].buildTurns);
    if (item.progress < UNITS[item.type].buildTurns) return;
    if (!enter(game, DEFENDER, item.type)) {
      addLog(game, `${UNITS[item.type].name} is ready but there is no room near the keep`);
      return;
    }
    game.buildQueue.shift();
    if (game.repeatBuild) queueUnit(game, item.type);
  }

  /** Add a unit to the end of the defender's build queue. */
  function queueUnit(game, type) {
    if (!UNITS[type]) return fail(`Unknown unit type: ${type}`);
    if (game.winner) return fail('The game is over.');
    const item = { id: game.nextBuildId++, type, progress: 0 };
    game.buildQueue.push(item);
    return { ok: true, item };
  }

  /** Remove an item from the build queue. Any progress on it is lost. */
  function removeFromQueue(game, itemId) {
    const index = game.buildQueue.findIndex((i) => i.id === itemId);
    if (index < 0) return fail('That item is not in the queue.');
    const [item] = game.buildQueue.splice(index, 1);
    return { ok: true, item };
  }

  /** Move a queued item up (-1) or down (+1). */
  function moveInQueue(game, itemId, delta) {
    const q = game.buildQueue;
    const index = q.findIndex((i) => i.id === itemId);
    const to = index + delta;
    if (index < 0 || to < 0 || to >= q.length) return fail("That item can't move there.");
    [q[index], q[to]] = [q[to], q[index]];
    return { ok: true };
  }

  function setRepeatBuild(game, on) {
    game.repeatBuild = !!on;
  }

  /**
   * Defender turns until each queued item enters, counting from now. The
   * front item gains progress at the start of each defender turn; the next
   * item starts only after the one ahead of it is done.
   */
  function buildSchedule(game) {
    let turns = 0;
    return game.buildQueue.map((item) => {
      turns += UNITS[item.type].buildTurns - item.progress;
      return { item, turnsLeft: Math.max(1, turns) };
    });
  }

  /**
   * Every empty cell the unit at (q, r) could reach, moving up to its move
   * distance through empty cells. Each target has `path`: the cells stepped
   * through after the start, ending at the target.
   */
  function reachable(game, q, r, maxSteps) {
    const unit = pieceAt(game, q, r);
    if (!unit) return [];
    const steps = maxSteps === undefined ? stats(unit).move : maxSteps;
    const targets = [];
    const visited = new Set([key(q, r)]);
    let frontier = [{ cell: { q, r }, path: [] }];
    for (let step = 1; step <= steps; step++) {
      const next = [];
      for (const { cell, path } of frontier) {
        for (const n of neighbours(cell)) {
          const k = key(n.q, n.r);
          if (visited.has(k) || !isEmpty(game, n.q, n.r)) continue;
          visited.add(k);
          const newPath = [...path, n];
          targets.push({ q: n.q, r: n.r, path: newPath });
          next.push({ cell: n, path: newPath });
        }
      }
      frontier = next;
    }
    return targets;
  }

  /** Legal moves for the unit at (q, r) right now. */
  function movesFor(game, q, r) {
    const unit = pieceAt(game, q, r);
    if (!unit || game.winner || unit.owner !== game.turn || unit.moved) return [];
    return reachable(game, q, r);
  }

  function inAttackRange(type, distance) {
    const s = UNITS[type];
    return distance >= s.minRange && distance <= s.maxRange;
  }

  /** Average damage `attackerType` does to a target with `defence`. */
  function expectedDamage(game, attackerType, defence) {
    return (game.config.damageBase * UNITS[attackerType].attack) / defence;
  }

  /** Random damage: the average scaled by a factor between 0.5 and 1.5, at least 1. */
  function rollDamage(game, attackerType, defence) {
    const avg = expectedDamage(game, attackerType, defence);
    return Math.max(1, Math.round(avg * (0.5 + game.rng())));
  }

  /**
   * What the unit would attack if it fired now, or null. Attackers always
   * prefer the keep. Otherwise target the enemy most likely to die: lowest
   * HP left after an average hit, then lowest id.
   */
  function chooseTarget(game, unit, from = unit) {
    if (unit.owner === ATTACKER && inAttackRange(unit.type, hexDistance(from, game.keep))) {
      return { keep: true, q: game.keep.q, r: game.keep.r };
    }
    let best = null;
    let bestScore = Infinity;
    for (const enemy of piecesOf(game, other(unit.owner))) {
      if (!inAttackRange(unit.type, hexDistance(from, enemy))) continue;
      const left = enemy.hp - expectedDamage(game, unit.type, stats(enemy).defence);
      const score = left * 1000 + enemy.id;
      if (score < bestScore) {
        bestScore = score;
        best = enemy;
      }
    }
    return best && { keep: false, unit: best, q: best.q, r: best.r };
  }

  /** Can this unit fire this turn? Artillery that has moved cannot. */
  function canFire(unit) {
    return !(unit.moved && !UNITS[unit.type].firesAfterMoving);
  }

  /** The current player's units that will attack when the turn ends, in firing order. */
  function firingOrder(game) {
    return piecesOf(game, game.turn)
      .filter((u) => !u.fired && canFire(u))
      .sort((a, b) => a.id - b.id);
  }

  /**
   * Fire one unit. Returns the attack event, or null if it had no target.
   * Used by `endTurn`, and directly by the UI to animate one shot at a time.
   */
  function fire(game, unit) {
    if (game.winner || unit.fired || unit.owner !== game.turn) return null;
    unit.fired = true;
    if (!canFire(unit)) return null;
    const target = chooseTarget(game, unit);
    if (!target) return null;

    const event = {
      attackerId: unit.id,
      attackerType: unit.type,
      owner: unit.owner,
      from: pos(unit),
      to: pos(target),
      targetId: target.keep ? null : target.unit.id,
      targetType: target.keep ? 'keep' : target.unit.type,
      damage: 0,
      hpAfter: 0,
      killed: false,
    };
    if (target.keep) {
      event.damage = rollDamage(game, unit.type, game.config.keepDefence);
      game.keep.hp = Math.max(0, game.keep.hp - event.damage);
      event.hpAfter = game.keep.hp;
      event.killed = game.keep.hp === 0;
      addLog(game, `${stats(unit).name} hit the keep for ${event.damage} (${game.keep.hp} HP left)`);
    } else {
      const victim = target.unit;
      event.damage = rollDamage(game, unit.type, stats(victim).defence);
      victim.hp = Math.max(0, victim.hp - event.damage);
      event.hpAfter = victim.hp;
      if (victim.hp === 0) {
        event.killed = true;
        game.pieces.delete(key(victim.q, victim.r));
      }
      addLog(
        game,
        `${stats(unit).name} hit ${stats(victim).name.toLowerCase()} for ${event.damage}` +
          (event.killed ? ' and destroyed it' : ` (${victim.hp} HP left)`)
      );
    }
    game.damageDealt[unit.owner] += event.damage;
    game.current.attacks.push(event);
    checkWinner(game);
    return event;
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
    } else if (game.pools[ATTACKER].length + piecesOf(game, ATTACKER).length === 0) {
      game.winner = DEFENDER;
    }
    if (game.winner) addLog(game, `— ${capitalise(game.winner)}s win!`);
  }

  function move(game, from, to) {
    if (game.winner) return fail('The game is over.');
    const unit = pieceAt(game, from.q, from.r);
    if (!unit) return fail('There is no unit there.');
    if (unit.owner !== game.turn) return fail("That isn't your unit.");
    if (unit.moved) return fail('That unit has already moved this turn.');
    const target = reachable(game, from.q, from.r).find((m) => samePos(m, to));
    if (!target) {
      return fail(`${stats(unit).name} can move up to ${stats(unit).move} cells through empty spaces.`);
    }

    const start = pos(unit); // copy before moving: `from` may be the unit itself
    game.pieces.delete(key(start.q, start.r));
    unit.q = to.q;
    unit.r = to.r;
    unit.moved = true;
    game.pieces.set(key(to.q, to.r), unit);

    const record = { unitId: unit.id, owner: unit.owner, from: start, path: target.path.map(pos) };
    game.current.moves.push(record);
    return { ok: true, record };
  }

  /**
   * Undo a move made this turn: the given unit's move, or the most recent
   * move if no unit id is given. The unit goes back where it started and
   * may move (and, for artillery, fire) again. Fails if another unit is now
   * standing where it started.
   */
  function undoMove(game, unitId) {
    if (game.winner) return fail('The game is over.');
    const moves = game.current.moves;
    const index = unitId === undefined ? moves.length - 1 : moves.findIndex((m) => m.unitId === unitId);
    if (index < 0) return fail(unitId === undefined ? 'There are no moves to undo.' : "That unit hasn't moved this turn.");
    const record = moves[index];
    const end = record.path[record.path.length - 1];
    const unit = pieceAt(game, end.q, end.r);
    if (!unit || unit.id !== record.unitId) return fail('That move can no longer be undone.');
    const blocker = pieceAt(game, record.from.q, record.from.r);
    if (blocker) return fail('Another unit is standing where this one started. Undo that unit first.');

    game.pieces.delete(key(end.q, end.r));
    unit.q = record.from.q;
    unit.r = record.from.r;
    unit.moved = false;
    game.pieces.set(key(unit.q, unit.r), unit);
    moves.splice(index, 1);
    return { ok: true, record, unit };
  }

  /** Can the given unit's move (or the latest move) be undone right now? */
  function canUndo(game, unitId) {
    const moves = game.current.moves;
    const record = unitId === undefined ? moves[moves.length - 1] : moves.find((m) => m.unitId === unitId);
    return !!record && !pieceAt(game, record.from.q, record.from.r);
  }

  /** Units belonging to the current player that can still move. */
  function unmovedPieces(game) {
    return piecesOf(game, game.turn).filter((p) => !p.moved);
  }

  /** Fire every unit that hasn't fired yet, then pass the turn. */
  function endTurn(game) {
    if (game.winner) return fail('The game is over.');
    for (const unit of firingOrder(game)) {
      if (game.pieces.get(key(unit.q, unit.r)) === unit) fire(game, unit);
      if (game.winner) return { ok: true };
    }
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
    UNITS,
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
    entryCells,
    reachable,
    movesFor,
    unmovedPieces,
    inAttackRange,
    expectedDamage,
    chooseTarget,
    firingOrder,
    fire,
    move,
    undoMove,
    queueUnit,
    removeFromQueue,
    moveInQueue,
    setRepeatBuild,
    buildSchedule,
    canUndo,
    canFire,
    endTurn,
    capitalise,
    other,
  };
});
