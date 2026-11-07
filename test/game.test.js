const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/game.js');

/** Put a piece straight onto the board (bypassing placement rules). */
function put(game, owner, q, r) {
  const piece = { id: game.nextId++, owner, q, r, moved: false };
  game.pieces.set(G.key(q, r), piece);
  return piece;
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

test('attackers go first; turns alternate only when ended', () => {
  const game = G.createGame();
  assert.equal(game.turn, G.ATTACKER);
  assert.ok(G.place(game, 8, 0).ok);
  assert.equal(game.turn, G.ATTACKER, 'placing does not end the turn');
  G.endTurn(game);
  assert.equal(game.turn, G.DEFENDER);
  G.endTurn(game);
  assert.equal(game.turn, G.ATTACKER);
});

test('attackers place one piece per turn, on edge cells only', () => {
  const game = G.createGame();
  assert.equal(G.place(game, 3, 0).ok, false);
  assert.ok(G.place(game, -8, 0).ok);
  assert.equal(G.place(game, 8, 0).ok, false, 'second placement in one turn');
  assert.equal(game.reserves[G.ATTACKER], G.CONFIG.attackerReserve - 1);
});

test('defenders cannot place manually but get a new piece next to the keep each turn', () => {
  const game = G.createGame();
  G.place(game, 8, 0);
  G.endTurn(game);
  assert.equal(G.piecesOf(game, G.DEFENDER).length, 1);
  const spawned = G.piecesOf(game, G.DEFENDER)[0];
  assert.equal(G.hexDistance(spawned, game.keep), 1);
  assert.equal(G.place(game, 2, 0).ok, false);
  G.endTurn(game);
  G.endTurn(game);
  assert.equal(G.piecesOf(game, G.DEFENDER).length, 2);
});

test('the reinforcement appears on the side facing the nearest attacker', () => {
  const game = G.createGame();
  G.place(game, 8, 0);
  G.endTurn(game);
  const spawned = G.piecesOf(game, G.DEFENDER)[0];
  assert.deepEqual([spawned.q, spawned.r], [1, 0]);
});

test('every piece may move once per turn, up to two cells', () => {
  const game = G.createGame();
  const a = put(game, G.ATTACKER, 8, 0);
  const b = put(game, G.ATTACKER, -8, 0);
  assert.equal(G.move(game, { q: 8, r: 0 }, { q: 5, r: 0 }).ok, false, 'three cells is too far');
  assert.ok(G.move(game, { q: 8, r: 0 }, { q: 6, r: 0 }).ok);
  assert.equal(G.move(game, { q: 6, r: 0 }, { q: 5, r: 0 }).ok, false, 'already moved');
  assert.ok(G.move(game, { q: -8, r: 0 }, { q: -7, r: 0 }).ok, 'second piece can still move');
  assert.ok(a.moved && b.moved);
  assert.equal(game.turn, G.ATTACKER);
  G.endTurn(game);
  G.endTurn(game);
  assert.ok(!a.moved && !b.moved, 'moves reset at the start of the next turn');
});

test('pieces cannot pass through other pieces', () => {
  const game = G.createGame();
  put(game, G.ATTACKER, 5, 0);
  // Wall off every cell between (5,0) and (3,0).
  put(game, G.ATTACKER, 4, 0);
  put(game, G.ATTACKER, 4, 1);
  put(game, G.ATTACKER, 5, -1);
  put(game, G.ATTACKER, 4, -1); // not adjacent to (3,0) via empty path otherwise
  put(game, G.ATTACKER, 5, 1);
  put(game, G.ATTACKER, 6, -1);
  const targets = G.movesFor(game, 5, 0).map((t) => G.key(t.q, t.r));
  assert.ok(!targets.includes(G.key(3, 0)));
});

test("players cannot move the opponent's pieces", () => {
  const game = G.createGame();
  put(game, G.DEFENDER, 1, 0);
  assert.equal(G.move(game, { q: 1, r: 0 }, { q: 2, r: 0 }).ok, false);
});

test('moving onto an enemy captures it; defenders win when attackers are gone', () => {
  const game = G.createGame({ attackerReserve: 0 });
  put(game, G.ATTACKER, 3, 0);
  G.endTurn(game); // defender spawns at (1, 0)
  const res = G.move(game, { q: 1, r: 0 }, { q: 3, r: 0 });
  assert.equal(res.kind, 'capture');
  assert.equal(G.pieceAt(game, 3, 0).owner, G.DEFENDER);
  assert.equal(game.winner, G.DEFENDER);
});

test('attackers strike the keep from up to two cells away and stop beside it', () => {
  const game = G.createGame({ keepHp: 2 });
  put(game, G.ATTACKER, 2, 0);
  const res = G.move(game, { q: 2, r: 0 }, { q: 0, r: 0 });
  assert.equal(res.kind, 'attack-keep');
  assert.equal(game.keep.hp, 1);
  const p = G.piecesOf(game, G.ATTACKER)[0];
  assert.equal(G.hexDistance(p, game.keep), 1);
  assert.equal(game.winner, null);
});

test('attackers win by destroying the keep', () => {
  const game = G.createGame({ keepHp: 1 });
  put(game, G.ATTACKER, 1, 0);
  G.move(game, { q: 1, r: 0 }, { q: 0, r: 0 });
  assert.equal(game.winner, G.ATTACKER);
});

test('moves are recorded for the turn and kept as lastTurn afterwards', () => {
  const game = G.createGame();
  put(game, G.ATTACKER, 8, 0);
  G.place(game, -8, 0);
  G.move(game, { q: 8, r: 0 }, { q: 6, r: 0 });
  assert.equal(game.current.moves.length, 1);
  assert.deepEqual(game.current.moves[0].path, [{ q: 7, r: 0 }, { q: 6, r: 0 }]);
  assert.deepEqual(game.current.placed, [{ q: -8, r: 0 }]);
  G.endTurn(game);
  assert.equal(game.lastTurn.player, G.ATTACKER);
  assert.equal(game.lastTurn.moves.length, 1);
  assert.equal(game.current.moves.length, 0);
});
