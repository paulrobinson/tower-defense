/*
 * CPU player for the attacking side.
 *
 * The CPU plays one action at a time so the UI can animate each one:
 * call `nextAction(game)` repeatedly, apply what it returns, and stop when
 * it returns null (then end the turn).
 *
 * Strategy, in short. Defenders capture anything that comes within reach
 * and are reinforced every turn, so attacking one piece at a time just
 * feeds them. The CPU therefore works in two phases:
 *
 *   Gather: bring pieces in on the edge where the route to the keep is
 *     least defended, then creep them towards the keep while staying out
 *     of every defender's reach and close to each other.
 *   Assault: once enough attackers are on the board (or the reserve is
 *     empty), every piece charges together. Losses are ignored; the
 *     survivors recapture and strike the keep.
 *
 * In both phases each piece, nearest the keep first, scores every cell it
 * can reach: striking the keep beats everything, captures are good
 * (especially next to the keep), and getting closer is good. If the
 * assault is broken (one attacker or fewer left with more in reserve),
 * the CPU goes back to gathering.
 */
(function (root, factory) {
  const api = factory(root.TDGame || (typeof require !== 'undefined' ? require('./game.js') : null));
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.TDAI = api;
  }
})(typeof self !== 'undefined' ? self : this, function (G) {
  'use strict';

  const WEIGHTS = {
    keepStrike: 1000,
    capture: 60,
    captureNextToKeep: 40,
    perStepCloser: 10,
    threatened: 45,
    supportedThreatFactor: 0.4, // threat penalty multiplier when a friend can recapture
    gatherThreatened: 200, // while gathering, avoid danger almost at any cost
    cohesion: 4, // while gathering, per cell away from the group's centre
    assaultSize: 5, // attackers on board needed to launch an assault
    jitter: 4,
    // Placement
    corridorDefender: 8,
    placementThreatened: 50,
    nearFriend: 6,
    placementJitter: 6,
  };

  /**
   * Would any piece of `byOwner` be able to land on `cell` on their next
   * turn? `board` is the game with hypothetical changes already applied.
   */
  function threatenedBy(board, cell, byOwner) {
    for (const p of G.piecesOf(board, byOwner)) {
      if (G.hexDistance(p, cell) > board.config.maxMove) continue;
      if (G.reachable(board, p.q, p.r).some((t) => G.samePos(t, cell) && t.kind !== 'attack-keep')) {
        return true;
      }
    }
    return false;
  }

  /** A shallow copy of the board with a different set of pieces. */
  function withPieces(game, mutate) {
    const pieces = new Map();
    for (const [k, p] of game.pieces) pieces.set(k, { ...p });
    const copy = { ...game, pieces };
    mutate(copy);
    return copy;
  }

  /**
   * Decide (and remember on the game) whether the CPU is gathering or
   * assaulting this turn.
   */
  function updatePhase(game) {
    const state = (game.ai = game.ai || { assault: false, turn: null });
    if (state.turn === game.turnNumber) return state;
    state.turn = game.turnNumber;
    const onBoard = G.piecesOf(game, G.ATTACKER).length;
    const reserve = game.reserves[G.ATTACKER];
    if (!state.assault && (onBoard >= WEIGHTS.assaultSize || (reserve === 0 && onBoard > 0))) {
      state.assault = true;
    } else if (state.assault && onBoard <= 1 && reserve > 0) {
      state.assault = false;
    }
    return state;
  }

  function centreOf(pieces) {
    if (!pieces.length) return null;
    const x = pieces.reduce((s, p) => s + p.q + p.r / 2, 0) / pieces.length;
    const y = pieces.reduce((s, p) => s + p.r, 0) / pieces.length;
    return { q: x - y / 2, r: y };
  }

  function axialEuclid(a, b) {
    const dx = a.q + a.r / 2 - (b.q + b.r / 2);
    const dy = ((a.r - b.r) * Math.sqrt(3)) / 2;
    return Math.hypot(dx, dy);
  }

  // ---------- placement ----------

  function scorePlacement(game, cell, rng) {
    const keep = game.keep;
    const toKeep = G.hexDistance(cell, keep);
    let score = -2 * toKeep;

    // Defenders sitting on (or near) the shortest route to the keep.
    for (const d of G.piecesOf(game, G.DEFENDER)) {
      if (G.hexDistance(cell, d) + G.hexDistance(d, keep) <= toKeep + 2) {
        score -= WEIGHTS.corridorDefender;
      }
    }

    const board = withPieces(game, (b) => {
      b.pieces.set(G.key(cell.q, cell.r), { id: -1, owner: G.ATTACKER, q: cell.q, r: cell.r });
    });
    if (threatenedBy(board, cell, G.DEFENDER)) score -= WEIGHTS.placementThreatened;

    // Join the existing group so pieces arrive together.
    const friends = G.piecesOf(game, G.ATTACKER);
    const centre = centreOf(friends);
    if (centre) score -= axialEuclid(cell, centre) * WEIGHTS.nearFriend * 0.5;

    return score + rng() * WEIGHTS.placementJitter;
  }

  function choosePlacement(game, rng = Math.random) {
    let best = null;
    for (const cell of G.placementCells(game, G.ATTACKER)) {
      const score = scorePlacement(game, cell, rng);
      if (!best || score > best.score) best = { cell, score };
    }
    return best && best.cell;
  }

  // ---------- movement ----------

  /** Score finishing a move at `option` (or staying put when option is null). */
  function scoreOption(game, piece, option, ctx, rng) {
    const end = option ? option.end : piece;
    let score = -WEIGHTS.perStepCloser * G.hexDistance(end, game.keep);

    if (option && option.kind === 'attack-keep') score += WEIGHTS.keepStrike;
    if (option && option.kind === 'capture') {
      score += WEIGHTS.capture;
      if (G.hexDistance(option, game.keep) === 1) score += WEIGHTS.captureNextToKeep;
    }

    const board = withPieces(game, (b) => {
      b.pieces.delete(G.key(piece.q, piece.r));
      if (option && option.kind === 'capture') b.pieces.delete(G.key(option.q, option.r));
      b.pieces.set(G.key(end.q, end.r), { ...piece, q: end.q, r: end.r });
    });

    if (threatenedBy(board, end, G.DEFENDER)) {
      // Could another attacker take the square back if we are captured?
      const supported = G.piecesOf(board, G.ATTACKER).some(
        (a) => a.id !== piece.id && G.hexDistance(a, end) <= game.config.maxMove + 1
      );
      if (!ctx.assault) {
        score -= supported ? WEIGHTS.threatened : WEIGHTS.gatherThreatened;
      } else if (!supported) {
        score -= WEIGHTS.threatened * WEIGHTS.supportedThreatFactor;
      }
    }

    // While gathering, keep the group together.
    if (!ctx.assault && ctx.centre) score -= axialEuclid(end, ctx.centre) * WEIGHTS.cohesion;

    return score + rng() * WEIGHTS.jitter;
  }

  function chooseMove(game, piece, rng = Math.random) {
    const state = updatePhase(game);
    const others = G.piecesOf(game, G.ATTACKER).filter((a) => a.id !== piece.id);
    const ctx = { assault: state.assault, centre: centreOf(others) };
    let best = { option: null, score: scoreOption(game, piece, null, ctx, rng) };
    for (const option of G.movesFor(game, piece.q, piece.r)) {
      const score = scoreOption(game, piece, option, ctx, rng);
      if (score > best.score) best = { option, score };
    }
    return best.option; // null means "stay where you are"
  }

  /**
   * The CPU's next action this turn, or null when it is done.
   * Returns { type: 'place', cell } or { type: 'move', from, to }.
   * Pieces that decide to hold their position are marked as having
   * moved so they are not asked again.
   */
  function nextAction(game, rng = Math.random) {
    if (game.winner || game.turn !== G.ATTACKER) return null;
    updatePhase(game);

    if (G.placementsLeft(game) > 0) {
      const cell = choosePlacement(game, rng);
      if (cell) return { type: 'place', cell: { q: cell.q, r: cell.r } };
    }

    // Nearest the keep first, so the front line clears space for followers.
    const queue = G.unmovedPieces(game).sort(
      (a, b) => G.hexDistance(a, game.keep) - G.hexDistance(b, game.keep)
    );
    for (const piece of queue) {
      const option = chooseMove(game, piece, rng);
      if (option) {
        return { type: 'move', from: { q: piece.q, r: piece.r }, to: { q: option.q, r: option.r } };
      }
      piece.moved = true; // holding position
    }
    return null;
  }

  return { WEIGHTS, choosePlacement, chooseMove, nextAction, threatenedBy, updatePhase };
});
