const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/game.js');

/** Small deterministic random number generator for repeatable games. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A game with nothing on the board yet, attackers to move. */
function emptyGame(overrides = {}) {
  const game = G.createGame({ rng: seeded(1), ...overrides });
  game.pieces.clear();
  game.current.entered = [];
  return game;
}

/** Put a unit straight onto the board. */
function put(game, owner, type, q, r) {
  const s = G.UNITS[type];
  const unit = { id: game.nextId++, owner, type, q, r, hp: s.hp, maxHp: s.hp, moved: false, fired: false };
  game.pieces.set(G.key(q, r), unit);
  return unit;
}

test('grid is roughly circular and 17 cells wide', () => {
  const game = G.createGame();
  const middleRow = [...game.cells.values()].filter((c) => c.r === 0);
  assert.equal(middleRow.length, 17);
  for (let r = -10; r <= 10; r++) {
    const top = [...game.cells.values()].filter((c) => c.r === r).length;
    const bottom = [...game.cells.values()].filter((c) => c.r === -r).length;
    assert.ok(top <= 17);
    assert.equal(top, bottom);
  }
  assert.ok(game.cells.get(G.key(8, 0)).isEdge);
  assert.ok(!game.cells.get(G.key(0, 0)).isEdge);
});

test('keep sits at the centre', () => {
  const game = G.createGame();
  assert.deepEqual([game.keep.q, game.keep.r], [0, 0]);
  assert.ok(G.isKeep(game, 0, 0));
});

test('the attackers have 3 artillery and 9 soldiers', () => {
  const game = G.createGame({ rng: seeded(2) });
  const all = [...game.pools.attacker, ...G.piecesOf(game, G.ATTACKER).map((u) => u.type)];
  assert.equal(all.length, 12);
  assert.equal(all.filter((t) => t === 'artillery').length, 3);
});

test('units enter at random: attackers on the edge, defenders near the keep', () => {
  const attackerCells = new Set();
  for (let seed = 1; seed <= 20; seed++) {
    const game = G.createGame({ rng: seeded(seed) });
    const a = G.piecesOf(game, G.ATTACKER);
    assert.equal(a.length, 1, 'one attacker enters on turn 1');
    assert.ok(game.cells.get(G.key(a[0].q, a[0].r)).isEdge);
    attackerCells.add(G.key(a[0].q, a[0].r));
    G.endTurn(game);
    const d = G.piecesOf(game, G.DEFENDER);
    assert.equal(d.length, 1, 'one defender enters on turn 2');
    assert.ok(G.hexDistance(d[0], game.keep) <= game.config.keepRadius);
  }
  assert.ok(attackerCells.size > 5, 'entry cells vary');
});

test('every unit may move once per turn; soldiers 2 cells, artillery 1', () => {
  const game = emptyGame();
  const s = put(game, G.ATTACKER, 'soldier', 8, 0);
  const a = put(game, G.ATTACKER, 'artillery', -8, 0);
  assert.equal(G.move(game, s, { q: 5, r: 0 }).ok, false, 'soldier cannot move 3');
  assert.ok(G.move(game, s, { q: 6, r: 0 }).ok);
  assert.equal(G.move(game, s, { q: 5, r: 0 }).ok, false, 'already moved');
  assert.equal(G.move(game, a, { q: -6, r: 0 }).ok, false, 'artillery cannot move 2');
  assert.ok(G.move(game, a, { q: -7, r: 0 }).ok);
});

test('units cannot move onto or through other units or the keep', () => {
  const game = emptyGame();
  const s = put(game, G.ATTACKER, 'soldier', 2, 0);
  put(game, G.DEFENDER, 'soldier', 3, 0);
  const targets = G.movesFor(game, 2, 0).map((t) => G.key(t.q, t.r));
  assert.ok(!targets.includes(G.key(3, 0)), 'no capturing by moving onto a unit');
  assert.ok(!targets.includes(G.key(0, 0)), 'cannot enter the keep');
  assert.equal(G.move(game, s, { q: 3, r: 0 }).ok, false);
});

test('attack radius: soldiers hit adjacent cells, artillery hits 2 to 4 away', () => {
  assert.ok(G.inAttackRange('soldier', 1));
  assert.ok(!G.inAttackRange('soldier', 2));
  assert.ok(!G.inAttackRange('artillery', 1));
  assert.ok(G.inAttackRange('artillery', 2));
  assert.ok(G.inAttackRange('artillery', 4));
  assert.ok(!G.inAttackRange('artillery', 5));
});

test('units attack when their turn ends, not when they move', () => {
  const game = emptyGame();
  put(game, G.ATTACKER, 'soldier', 5, 0);
  const d = put(game, G.DEFENDER, 'soldier', 4, 0);
  assert.equal(d.hp, 10);
  G.endTurn(game);
  assert.ok(d.hp < 10, 'adjacent defender took damage when the attackers ended their turn');
  assert.equal(game.lastTurn.attacks.length, 1);
});

test('only the player who ends the turn fires', () => {
  const game = emptyGame();
  const a = put(game, G.ATTACKER, 'soldier', 5, 0);
  put(game, G.DEFENDER, 'soldier', 4, 0);
  G.endTurn(game); // attackers fire
  assert.equal(a.hp, 10, 'defender did not fire on the attackers turn');
});

test('artillery cannot hit adjacent targets but can hit from 4 away', () => {
  const game = emptyGame();
  put(game, G.ATTACKER, 'artillery', 6, 0);
  const near = put(game, G.DEFENDER, 'soldier', 7, 0); // distance 1
  const far = put(game, G.DEFENDER, 'soldier', 2, 0); // distance 4
  G.endTurn(game);
  assert.equal(near.hp, 10);
  assert.ok(far.hp < 10);
});

test('damage is random and scales with attack / defence', () => {
  const avg = (attacker, targetType) => {
    let total = 0;
    const N = 400;
    for (let i = 0; i < N; i++) {
      const game = emptyGame({ rng: seeded(100 + i) });
      // Far enough from the keep that the keep is never the target.
      put(game, G.ATTACKER, attacker, 8, 0);
      const t = put(game, G.DEFENDER, targetType, attacker === 'soldier' ? 7 : 5, 0);
      G.endTurn(game);
      total += 10 - t.hp;
    }
    return total / N;
  };
  const soldierVsSoldier = avg('soldier', 'soldier'); // 3 * 2/2 = 3
  const artilleryVsSoldier = avg('artillery', 'soldier'); // 3 * 5/2 = 7.5
  const soldierVsArtillery = avg('soldier', 'artillery'); // 3 * 2/1 = 6
  assert.ok(Math.abs(soldierVsSoldier - 3) < 0.5, `soldier vs soldier ${soldierVsSoldier}`);
  assert.ok(Math.abs(artilleryVsSoldier - 7.5) < 0.8, `artillery vs soldier ${artilleryVsSoldier}`);
  assert.ok(Math.abs(soldierVsArtillery - 6) < 0.8, `soldier vs artillery ${soldierVsArtillery}`);

  const rolls = new Set();
  for (let i = 0; i < 50; i++) {
    const game = emptyGame({ rng: seeded(500 + i) });
    put(game, G.ATTACKER, 'soldier', 4, 0);
    const t = put(game, G.DEFENDER, 'soldier', 3, 0);
    G.endTurn(game);
    rolls.add(10 - t.hp);
  }
  assert.ok(rolls.size > 1, 'damage varies');
});

test('a unit at 0 HP is destroyed, and later shooters pick another target', () => {
  const game = emptyGame();
  put(game, G.ATTACKER, 'artillery', 6, 0);
  put(game, G.ATTACKER, 'artillery', 6, -2);
  const weak = put(game, G.DEFENDER, 'soldier', 3, 0);
  weak.hp = 1;
  const other = put(game, G.DEFENDER, 'soldier', 3, -1);
  G.endTurn(game);
  assert.equal(G.pieceAt(game, 3, 0), null, 'weak unit destroyed');
  assert.ok(other.hp < 10, 'second shot went to the other unit');
});

test('attackers fire at the keep when it is in range; destroying it wins', () => {
  const game = emptyGame({ keepHp: 3 });
  put(game, G.ATTACKER, 'artillery', 3, 0);
  put(game, G.DEFENDER, 'soldier', 2, 0); // also in range, but the keep comes first
  G.endTurn(game);
  assert.ok(game.keep.hp < 3);
  const game2 = emptyGame({ keepHp: 1 });
  put(game2, G.ATTACKER, 'soldier', 1, 0);
  G.endTurn(game2);
  assert.equal(game2.winner, G.ATTACKER);
});

test('defenders win when every attacker is destroyed', () => {
  const game = emptyGame();
  game.pools.attacker = [];
  const a = put(game, G.ATTACKER, 'soldier', 5, 0);
  a.hp = 1;
  put(game, G.DEFENDER, 'soldier', 4, 0);
  G.endTurn(game); // attackers fire
  G.endTurn(game); // defenders fire
  assert.equal(game.winner, G.DEFENDER);
});

test('moves and attacks are recorded for the turn and kept as lastTurn', () => {
  const game = emptyGame();
  put(game, G.ATTACKER, 'soldier', 8, 0);
  G.move(game, { q: 8, r: 0 }, { q: 6, r: 0 });
  assert.deepEqual(game.current.moves[0].path, [{ q: 7, r: 0 }, { q: 6, r: 0 }]);
  G.endTurn(game);
  assert.equal(game.lastTurn.player, G.ATTACKER);
  assert.equal(game.lastTurn.moves.length, 1);
  assert.equal(game.current.moves.length, 0);
});

test('artillery that moved this turn does not fire; soldiers still do', () => {
  const game = emptyGame();
  const art = put(game, G.ATTACKER, 'artillery', 8, 0);
  const sol = put(game, G.ATTACKER, 'soldier', 6, -3);
  const target = put(game, G.DEFENDER, 'soldier', 5, 0); // in range of the artillery after it moves
  const target2 = put(game, G.DEFENDER, 'soldier', 4, -2); // next to where the soldier moves
  G.move(game, art, { q: 7, r: 0 });
  G.move(game, sol, { q: 5, r: -2 });
  assert.equal(G.canFire(art), false);
  assert.equal(G.canFire(sol), true);
  G.endTurn(game);
  assert.equal(target.hp, 10, 'moved artillery held its fire');
  assert.ok(target2.hp < 10, 'moved soldier still attacked');
  assert.ok(game.lastTurn.attacks.every((a) => a.attackerId !== art.id));
});

test('artillery that stays put fires', () => {
  const game = emptyGame();
  put(game, G.ATTACKER, 'artillery', 8, 0);
  const target = put(game, G.DEFENDER, 'soldier', 5, 0);
  G.endTurn(game);
  assert.ok(target.hp < 10);
});

test('a move can be undone before the turn ends', () => {
  const game = emptyGame();
  const s = put(game, G.ATTACKER, 'soldier', 8, 0);
  G.move(game, s, { q: 6, r: 0 });
  assert.ok(G.canUndo(game));
  const res = G.undoMove(game);
  assert.ok(res.ok);
  assert.deepEqual([s.q, s.r], [8, 0]);
  assert.equal(s.moved, false);
  assert.equal(G.pieceAt(game, 6, 0), null);
  assert.equal(game.current.moves.length, 0);
  assert.ok(G.move(game, s, { q: 7, r: 0 }).ok, 'it can move again');
});

test("undoing a unit's move lets artillery fire again", () => {
  const game = emptyGame();
  const art = put(game, G.ATTACKER, 'artillery', 8, 0);
  const target = put(game, G.DEFENDER, 'soldier', 5, 0);
  G.move(game, art, { q: 8, r: -2 });
  G.undoMove(game, art.id);
  assert.ok(G.canFire(art));
  G.endTurn(game);
  assert.ok(target.hp < 10);
});

test("any unit's move can be undone, unless another unit now stands where it started", () => {
  const game = emptyGame();
  const a = put(game, G.ATTACKER, 'soldier', 8, 0);
  const b = put(game, G.ATTACKER, 'soldier', -8, 0);
  G.move(game, a, { q: 7, r: 0 });
  G.move(game, b, { q: -7, r: 0 });
  assert.ok(G.undoMove(game, a.id).ok, 'undo the earlier move, not just the latest');
  assert.deepEqual([a.q, a.r], [8, 0]);
  assert.deepEqual([b.q, b.r], [-7, 0], 'other move untouched');

  const c = put(game, G.ATTACKER, 'soldier', 4, 0);
  const d = put(game, G.ATTACKER, 'soldier', 2, 0);
  G.move(game, c, { q: 3, r: 1 }); // c leaves (4,0)
  G.move(game, d, { q: 4, r: 0 }); // d steps into c's old cell
  assert.equal(G.canUndo(game, c.id), false);
  assert.equal(G.undoMove(game, c.id).ok, false);
  assert.ok(G.undoMove(game, d.id).ok);
  assert.ok(G.undoMove(game, c.id).ok, 'possible once the cell is free');
});

test('moves cannot be undone after the turn ends', () => {
  const game = emptyGame();
  const s = put(game, G.ATTACKER, 'soldier', 8, 0);
  G.move(game, s, { q: 6, r: 0 });
  G.endTurn(game);
  G.endTurn(game);
  assert.equal(G.undoMove(game, s.id).ok, false);
});

// ---------- build queue ----------

/** Advance to the start of the defender's next turn. */
function nextDefenderTurn(game) {
  G.endTurn(game);
  if (game.turn !== G.DEFENDER) G.endTurn(game);
}

test('the defender starts with a soldier queued, which arrives on their first turn', () => {
  const game = G.createGame({ rng: seeded(3) });
  assert.deepEqual(game.buildQueue.map((i) => i.type), ['soldier']);
  G.endTurn(game);
  assert.equal(G.piecesOf(game, G.DEFENDER).length, 1);
  assert.equal(game.buildQueue.length, 0);
});

test('soldiers take 1 turn to build and artillery 3', () => {
  const game = G.createGame({ rng: seeded(4), initialBuildQueue: [] });
  G.endTurn(game); // defender turn 2: nothing queued
  G.queueUnit(game, 'artillery');
  G.queueUnit(game, 'soldier');
  assert.deepEqual(G.buildSchedule(game).map((s) => s.turnsLeft), [3, 4]);

  const arrivals = [];
  for (let t = 0; t < 4; t++) {
    nextDefenderTurn(game);
    arrivals.push(G.piecesOf(game, G.DEFENDER).map((u) => u.type).sort().join('+'));
  }
  assert.deepEqual(arrivals, ['', '', 'artillery', 'artillery+soldier']);
});

test('only the front of the queue is built', () => {
  const game = G.createGame({ rng: seeded(5), initialBuildQueue: ['artillery', 'soldier'] });
  G.endTurn(game);
  assert.equal(game.buildQueue[0].progress, 1);
  assert.equal(game.buildQueue[1].progress, 0);
});

test('building is unlimited', () => {
  const game = G.createGame({ rng: seeded(6), initialBuildQueue: [] });
  for (let i = 0; i < 20; i++) G.queueUnit(game, 'soldier');
  for (let t = 0; t < 20; t++) nextDefenderTurn(game);
  assert.equal(G.piecesOf(game, G.DEFENDER).length, 20);
});

test('repeat puts each finished unit back at the end of the queue', () => {
  const game = G.createGame({ rng: seeded(7), initialBuildQueue: ['soldier', 'artillery'] });
  G.setRepeatBuild(game, true);
  G.endTurn(game); // soldier done
  assert.deepEqual(game.buildQueue.map((i) => i.type), ['artillery', 'soldier']);
  assert.equal(game.buildQueue[1].progress, 0);
});

test('queued items can be removed and reordered', () => {
  const game = G.createGame({ rng: seeded(8), initialBuildQueue: [] });
  const a = G.queueUnit(game, 'soldier').item;
  const b = G.queueUnit(game, 'artillery').item;
  assert.ok(G.moveInQueue(game, b.id, -1).ok);
  assert.deepEqual(game.buildQueue.map((i) => i.type), ['artillery', 'soldier']);
  assert.equal(G.moveInQueue(game, b.id, -1).ok, false, 'already at the front');
  assert.ok(G.removeFromQueue(game, a.id).ok);
  assert.deepEqual(game.buildQueue.map((i) => i.id), [b.id]);
});

test('a finished unit waits at the front if there is no room near the keep', () => {
  const game = G.createGame({ rng: seeded(9), initialBuildQueue: [] });
  for (const c of G.entryCells(game, G.DEFENDER)) put(game, G.DEFENDER, 'soldier', c.q, c.r);
  const before = G.piecesOf(game, G.DEFENDER).length;
  G.queueUnit(game, 'soldier');
  G.endTurn(game);
  assert.equal(G.piecesOf(game, G.DEFENDER).length, before);
  assert.equal(game.buildQueue.length, 1);
  assert.equal(game.buildQueue[0].progress, 1);
  assert.equal(G.buildSchedule(game)[0].turnsLeft, 1);
});

// ---------- walking back ----------

test('a moved unit can walk back one step along its path', () => {
  const game = emptyGame();
  const s = put(game, G.ATTACKER, 'soldier', 8, 0);
  G.move(game, { q: 8, r: 0 }, { q: 6, r: 0 });
  const cells = G.stepBackCells(game, s).map((c) => G.key(c.q, c.r));
  assert.deepEqual(cells, [G.key(7, 0), G.key(8, 0)], 'path cells, newest first');
  const res = G.stepBack(game, s, { q: 7, r: 0 });
  assert.ok(res.ok);
  assert.deepEqual([s.q, s.r], [7, 0]);
  assert.equal(s.moved, true, 'still counts as moved');
  assert.deepEqual(game.current.moves[0].path, [{ q: 7, r: 0 }], 'arrow shortened');
});

test('walking back to the start cancels the move', () => {
  const game = emptyGame();
  const art = put(game, G.ATTACKER, 'artillery', 8, 0);
  const target = put(game, G.DEFENDER, 'soldier', 5, 0);
  G.move(game, art, { q: 7, r: 0 });
  assert.equal(G.canFire(art), false);
  const res = G.stepBack(game, art, { q: 8, r: 0 });
  assert.ok(res.ok && res.backToStart);
  assert.equal(art.moved, false);
  assert.equal(game.current.moves.length, 0);
  G.endTurn(game);
  assert.ok(target.hp < 10, 'artillery fires again once back at its start');
});

test('units can only walk back along their own path, and not through other units', () => {
  const game = emptyGame();
  const a = put(game, G.ATTACKER, 'soldier', 4, 0);
  const b = put(game, G.ATTACKER, 'soldier', 3, 2);
  G.move(game, { q: 4, r: 0 }, { q: 2, r: 0 }); // via (3, 0), the only route
  assert.equal(G.stepBack(game, a, { q: 2, r: 1 }).ok, false, 'not on its path');
  assert.ok(G.move(game, b, { q: 3, r: 0 }).ok); // b now stands on a's path
  assert.equal(G.stepBackCells(game, a).length, 0);
  assert.equal(G.stepBack(game, a, { q: 4, r: 0 }).ok, false, 'blocked by b');
  assert.ok(G.stepBack(game, b, { q: 3, r: 2 }).ok);
  assert.ok(G.stepBack(game, a, { q: 4, r: 0 }).ok, 'free once b walks back');
});

test('unmoved units have nowhere to walk back to', () => {
  const game = emptyGame();
  const s = put(game, G.ATTACKER, 'soldier', 8, 0);
  assert.deepEqual(G.stepBackCells(game, s), []);
});

// ---------- choosing targets ----------

test('the player can pick which enemy in range a unit attacks', () => {
  const game = emptyGame();
  const sol = put(game, G.ATTACKER, 'soldier', 6, 0);
  const weak = put(game, G.DEFENDER, 'soldier', 5, 0);
  weak.hp = 2; // the default target
  const strong = put(game, G.DEFENDER, 'artillery', 7, 0);
  assert.equal(G.chooseTarget(game, sol).unit, weak);
  assert.ok(G.setTarget(game, sol, strong).ok);
  assert.equal(G.chooseTarget(game, sol).unit, strong);
  G.endTurn(game);
  assert.equal(weak.hp, 2);
  assert.ok(strong.hp < 10);
});

test('a picked target must be an enemy in range, and lapses if out of range', () => {
  const game = emptyGame();
  const sol = put(game, G.ATTACKER, 'soldier', 6, 0);
  const near = put(game, G.DEFENDER, 'soldier', 5, 0);
  const far = put(game, G.DEFENDER, 'soldier', 2, 0);
  const friend = put(game, G.ATTACKER, 'soldier', 7, 0);
  assert.equal(G.setTarget(game, sol, far).ok, false);
  assert.equal(G.setTarget(game, sol, friend).ok, false);
  assert.ok(G.setTarget(game, sol, near).ok);
  G.move(game, sol, { q: 6, r: -2 }); // now out of range of `near`
  assert.equal(G.chooseTarget(game, sol), null);
  G.stepBack(game, sol, { q: 6, r: 0 });
  assert.equal(G.chooseTarget(game, sol).unit, near, 'the pick applies again once back in range');
  assert.ok(G.setTarget(game, sol, null).ok);
  assert.equal(sol.aim, null);
});

test('picked targets reset each turn', () => {
  const game = emptyGame();
  const sol = put(game, G.ATTACKER, 'soldier', 6, 0);
  const d = put(game, G.DEFENDER, 'soldier', 5, 0);
  G.setTarget(game, sol, d);
  G.endTurn(game);
  G.endTurn(game);
  assert.equal(sol.aim, null);
});

test('damage range matches what can actually be rolled', () => {
  const game = emptyGame();
  for (const [atk, def] of [['soldier', 2], ['artillery', 2], ['soldier', 1], ['artillery', 4]]) {
    const range = G.damageRange(game, atk, def);
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      const g = emptyGame({ rng: seeded(9000 + i) });
      const avg = G.expectedDamage(g, atk, def);
      seen.add(Math.max(1, Math.round(avg * (0.5 + g.rng()))));
    }
    assert.equal(Math.min(...seen), range.min, `${atk} vs defence ${def} min`);
    assert.equal(Math.max(...seen), range.max, `${atk} vs defence ${def} max`);
  }
});
