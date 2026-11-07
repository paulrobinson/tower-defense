const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/game.js');
const AI = require('../src/ai.js');

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function emptyGame(overrides = {}) {
  const game = G.createGame({ rng: seeded(1), ...overrides });
  game.pieces.clear();
  game.current.entered = [];
  return game;
}

function put(game, owner, type, q, r) {
  const s = G.UNITS[type];
  const unit = { id: game.nextId++, owner, type, q, r, hp: s.hp, maxHp: s.hp, moved: false, fired: false };
  game.pieces.set(G.key(q, r), unit);
  return unit;
}

/** Let the CPU make all its moves for the current turn. */
function playMoves(game, rng) {
  let action;
  let guard = 0;
  while ((action = AI.nextAction(game, rng))) {
    assert.ok(guard++ < 100, 'CPU turn must finish');
    const res = G.move(game, action.from, action.to);
    assert.ok(res.ok, `CPU chose an illegal move: ${JSON.stringify(action)} (${res.reason})`);
  }
}

test('CPU soldiers advance on the keep when unopposed', () => {
  const game = emptyGame();
  game.pools.attacker = []; // committed: nothing left to gather
  const s = put(game, G.ATTACKER, 'soldier', 8, 0);
  playMoves(game, seeded(2));
  assert.equal(G.hexDistance(s, game.keep), 6);
});

test('CPU artillery moves into range of the keep and stops short of it', () => {
  const game = emptyGame();
  game.pools.attacker = [];
  const a = put(game, G.ATTACKER, 'artillery', 6, 0);
  playMoves(game, seeded(3));
  const d = G.hexDistance(a, game.keep);
  assert.ok(d >= 2 && d <= 4, `artillery at distance ${d}`);
});

test('a CPU soldier next to a weak defender stays to finish it off', () => {
  const game = emptyGame();
  game.pools.attacker = [];
  put(game, G.ATTACKER, 'soldier', 6, 0);
  const d = put(game, G.DEFENDER, 'soldier', 5, 0);
  d.hp = 2;
  playMoves(game, seeded(4));
  G.endTurn(game);
  assert.equal(G.pieceAt(game, 5, 0), null);
});

test('while gathering, the CPU keeps a lone unit out of reach of defenders', () => {
  const game = emptyGame();
  const s = put(game, G.ATTACKER, 'soldier', 8, 0);
  for (const [q, r] of [[3, 0], [3, -1], [2, 1]]) put(game, G.DEFENDER, 'soldier', q, r);
  const reach = G.piecesOf(game, G.DEFENDER).map((e) => ({
    unit: e,
    cells: [{ q: e.q, r: e.r }, ...G.reachable(game, e.q, e.r)],
  }));
  playMoves(game, seeded(5));
  assert.equal(AI.expectedIncoming(game, s, s, reach), 0, `soldier ended at ${s.q},${s.r} in range`);
});

test('a full CPU-vs-CPU game always finishes with a winner', () => {
  for (const seed of [21, 22, 23]) {
    const rng = seeded(seed);
    const game = G.createGame({ rng });
    for (let t = 0; t < 300 && !game.winner; t++) {
      playMoves(game, rng);
      G.endTurn(game);
    }
    assert.ok(game.winner, `seed ${seed} has a winner`);
  }
});

test('CPU artillery already in range of the keep stays put and fires', () => {
  const game = emptyGame();
  game.pools.attacker = [];
  const a = put(game, G.ATTACKER, 'artillery', 4, 0);
  playMoves(game, seeded(6));
  assert.deepEqual([a.q, a.r], [4, 0]);
  G.endTurn(game);
  assert.ok(game.keep.hp < game.keep.maxHp);
});
