const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/game.js');
const AI = require('../src/ai.js');

/** Small deterministic random number generator for repeatable games. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function put(game, owner, q, r) {
  const piece = { id: game.nextId++, owner, q, r, moved: false };
  game.pieces.set(G.key(q, r), piece);
  return piece;
}

/** Play the CPU's whole turn, returning the actions it took. */
function playCpuTurn(game, rng) {
  const actions = [];
  let action;
  let guard = 0;
  while ((action = AI.nextAction(game, rng))) {
    assert.ok(guard++ < 100, 'CPU turn must finish');
    const res = action.type === 'place'
      ? G.place(game, action.cell.q, action.cell.r)
      : G.move(game, action.from, action.to);
    assert.ok(res.ok, `CPU chose an illegal action: ${JSON.stringify(action)} (${res.reason})`);
    actions.push(action);
    if (game.winner) break;
  }
  return actions;
}

test('the CPU enters a piece on the edge on its first turn', () => {
  const game = G.createGame();
  const actions = playCpuTurn(game, seeded(1));
  assert.equal(actions[0].type, 'place');
  assert.ok(game.cells.get(G.key(actions[0].cell.q, actions[0].cell.r)).isEdge);
});

test('the CPU always strikes the keep when it can', () => {
  const game = G.createGame({ attackerReserve: 0 });
  put(game, G.ATTACKER, 2, 0);
  const actions = playCpuTurn(game, seeded(2));
  assert.equal(game.keep.hp, G.CONFIG.keepHp - 1);
  assert.deepEqual(actions[0].to, { q: 0, r: 0 });
});

test('the CPU captures an exposed defender', () => {
  const game = G.createGame({ attackerReserve: 0 });
  put(game, G.ATTACKER, 6, 0);
  put(game, G.DEFENDER, 4, 0);
  playCpuTurn(game, seeded(3));
  assert.equal(G.piecesOf(game, G.DEFENDER).length, 0);
});

test('the CPU avoids entering where a defender can capture it straight away', () => {
  const game = G.createGame();
  // Defenders guarding the whole east side of the board.
  for (const [q, r] of [[7, 0], [6, 2], [5, -3], [7, -2], [4, 4]]) put(game, G.DEFENDER, q, r);
  const cell = AI.choosePlacement(game, seeded(4));
  const board = { ...game, pieces: new Map(game.pieces) };
  board.pieces.set(G.key(cell.q, cell.r), { id: -1, owner: G.ATTACKER, q: cell.q, r: cell.r });
  assert.equal(AI.threatenedBy(board, cell, G.DEFENDER), false);
});

test('the CPU advances towards the keep when unopposed', () => {
  const game = G.createGame({ attackerReserve: 0 });
  const p = put(game, G.ATTACKER, 8, 0);
  playCpuTurn(game, seeded(5));
  assert.equal(G.hexDistance(p, game.keep), 6);
});

test('against a defender who never moves, the CPU eventually wins', () => {
  for (const seed of [11, 12, 13]) {
    const game = G.createGame();
    const rng = seeded(seed);
    for (let turn = 0; turn < 200 && !game.winner; turn++) {
      if (game.turn === G.ATTACKER) playCpuTurn(game, rng);
      if (!game.winner) G.endTurn(game);
    }
    assert.equal(game.winner, G.ATTACKER, `seed ${seed}`);
  }
});
