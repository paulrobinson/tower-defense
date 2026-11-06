const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/game.js');

test('grid is roughly circular and 17 cells wide', () => {
  const game = G.createGame();
  const middleRow = [...game.cells.values()].filter((c) => c.r === 0);
  assert.equal(middleRow.length, 17);
  // Every row is at most 17 wide, and the shape is symmetric top/bottom.
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

test('attackers go first and turns alternate', () => {
  const game = G.createGame();
  assert.equal(game.turn, G.ATTACKER);
  assert.ok(G.place(game, 8, 0).ok);
  assert.equal(game.turn, G.DEFENDER);
  assert.ok(G.place(game, 1, 0).ok);
  assert.equal(game.turn, G.ATTACKER);
});

test('attackers may only place on edge cells', () => {
  const game = G.createGame();
  assert.equal(G.place(game, 3, 0).ok, false);
  assert.equal(game.turn, G.ATTACKER, 'failed action does not end turn');
  assert.ok(G.place(game, -8, 0).ok);
});

test('defenders may only place within the keep radius', () => {
  const game = G.createGame();
  G.place(game, 8, 0);
  assert.equal(G.place(game, 4, 0).ok, false);
  assert.equal(G.place(game, 0, 0).ok, false, 'cannot place on the keep');
  assert.ok(G.place(game, 3, 0).ok);
});

test('pieces move exactly one cell', () => {
  const game = G.createGame();
  G.place(game, 8, 0); // attacker
  G.place(game, 1, 0); // defender
  assert.equal(G.move(game, { q: 8, r: 0 }, { q: 6, r: 0 }).ok, false);
  assert.ok(G.move(game, { q: 8, r: 0 }, { q: 7, r: 0 }).ok);
  assert.ok(G.pieceAt(game, 7, 0));
  assert.equal(G.pieceAt(game, 8, 0), null);
});

test("players cannot move the opponent's pieces", () => {
  const game = G.createGame();
  G.place(game, 8, 0);
  G.place(game, 1, 0);
  assert.equal(G.move(game, { q: 1, r: 0 }, { q: 2, r: 0 }).ok, false);
});

test('moving onto an enemy captures it; defenders win when attackers are gone', () => {
  const game = G.createGame({ reserves: { attacker: 1, defender: 2 } });
  G.place(game, 8, 0); // attacker, reserve now 0
  G.place(game, 3, 0); // defender
  G.move(game, { q: 8, r: 0 }, { q: 7, r: 0 });
  G.move(game, { q: 3, r: 0 }, { q: 4, r: 0 });
  G.move(game, { q: 7, r: 0 }, { q: 6, r: 0 });
  G.move(game, { q: 4, r: 0 }, { q: 5, r: 0 });
  G.pass(game);
  const result = G.move(game, { q: 5, r: 0 }, { q: 6, r: 0 });
  assert.equal(result.kind, 'capture');
  assert.equal(game.winner, G.DEFENDER);
});

test('attackers win by destroying the keep', () => {
  const game = G.createGame({ keepHp: 1 });
  // Put an attacker next to the keep directly for brevity.
  game.pieces.set(G.key(1, 0), { id: 99, owner: G.ATTACKER, q: 1, r: 0 });
  const result = G.move(game, { q: 1, r: 0 }, { q: 0, r: 0 });
  assert.equal(result.kind, 'attack-keep');
  assert.equal(game.keep.hp, 0);
  assert.equal(game.winner, G.ATTACKER);
});
