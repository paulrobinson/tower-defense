/*
 * CPU player.
 *
 * The CPU plays one move at a time so the UI can animate each one: call
 * `nextAction(game)` repeatedly, apply what it returns, and stop when it
 * returns null. Units fire automatically when the turn ends.
 *
 * It can play either side (the game uses it for the attackers; tests use it
 * for both). Each unit, nearest the keep first, scores every cell it can
 * reach plus staying put:
 *
 *   Offence: the average damage it could deal from there at the end of this
 *     turn (artillery only scores this by staying put, since it can't fire
 *     after moving). Damage to the keep counts extra for attackers, and a likely kill
 *     earns a bonus.
 *   Danger: the average damage enemy units could deal to it there next turn,
 *     given where they can move, measured against its remaining HP. Losing
 *     a unit outright costs extra.
 *   Position: attacking soldiers want to close in on the keep; attacking
 *     artillery wants to sit 2 to 4 cells from it, in firing range.
 *     Defenders want to stay near the keep.
 *
 * Attackers gather before committing: until enough units are on the board
 * (or the reserve is empty) they weigh danger heavily and hang back. Once
 * committed they care much less about losses and press the assault, and
 * every turn they go without dealing damage makes them bolder still, so a
 * defender who holds back can't stall them forever.
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
    damage: 3, // per point of expected damage dealt to a unit
    keepDamage: 6, // per point of expected damage dealt to the keep (attackers)
    kill: 15, // bonus when the shot is likely to destroy the target
    danger: 30, // per fraction of own HP expected to be lost
    death: 25, // extra when expected damage would destroy the unit
    advance: 4, // attackers: per cell away from where they want to be
    home: 4, // defenders: per cell beyond the guard ring
    guardRing: 4, // defenders: how far from the keep they like to roam
    gatherSize: 5, // attackers on board before they commit
    gatherCaution: 2.5, // danger multiplier while gathering
    assaultCaution: 0.25, // danger multiplier once committed
    idleBoldness: 1, // per turn without dealing damage, caution is divided by (1 + this × turns)
    jitter: 2,
  };

  /** Cells from which each enemy could fire next turn (their reach plus where they stand). */
  function enemyReach(game, owner) {
    return G.piecesOf(game, G.other(owner)).map((e) => ({
      unit: e,
      cells: [{ q: e.q, r: e.r }, ...G.reachable(game, e.q, e.r)],
    }));
  }

  function expectedIncoming(game, unit, cell, reach) {
    const defence = G.UNITS[unit.type].defence;
    let total = 0;
    for (const { unit: e, cells } of reach) {
      if (cells.some((c) => G.inAttackRange(e.type, G.hexDistance(c, cell)))) {
        total += G.expectedDamage(game, e.type, defence);
      }
    }
    return total;
  }

  function offenceScore(game, unit, cell) {
    const target = G.chooseTarget(game, unit, cell);
    if (!target) return 0;
    if (target.keep) {
      return G.expectedDamage(game, unit.type, game.config.keepDefence) * WEIGHTS.keepDamage;
    }
    const dmg = G.expectedDamage(game, unit.type, G.UNITS[target.unit.type].defence);
    let score = Math.min(dmg, target.unit.hp) * WEIGHTS.damage;
    if (dmg >= target.unit.hp) score += WEIGHTS.kill;
    return score;
  }

  function positionScore(game, unit, cell) {
    const d = G.hexDistance(cell, game.keep);
    if (unit.owner === G.ATTACKER) {
      if (unit.type === 'artillery') {
        const s = G.UNITS.artillery;
        return -WEIGHTS.advance * (Math.max(0, d - s.maxRange) + Math.max(0, s.minRange - d));
      }
      return -WEIGHTS.advance * Math.max(0, d - 1);
    }
    return -WEIGHTS.home * Math.max(0, d - WEIGHTS.guardRing);
  }

  function isGathering(game, owner) {
    if (owner !== G.ATTACKER) return false;
    const onBoard = G.piecesOf(game, G.ATTACKER).length;
    return onBoard < WEIGHTS.gatherSize && game.pools[G.ATTACKER].length > 0;
  }

  /** Turns in a row this side has ended without dealing any damage. */
  function idleTurns(game, owner) {
    const state = (game.ai = game.ai || {});
    const side = (state[owner] = state[owner] || { turn: null, total: 0, idle: 0 });
    if (side.turn !== game.turnNumber) {
      if (side.turn !== null) {
        side.idle = game.damageDealt[owner] > side.total ? 0 : side.idle + 1;
      }
      side.turn = game.turnNumber;
      side.total = game.damageDealt[owner];
    }
    return side.idle;
  }

  function scoreCell(game, unit, cell, reach, caution, rng) {
    const incoming = expectedIncoming(game, unit, cell, reach);
    let danger = (incoming / unit.hp) * WEIGHTS.danger;
    if (incoming >= unit.hp) danger += WEIGHTS.death;
    const staying = G.samePos(cell, unit);
    const canShoot = staying || G.UNITS[unit.type].firesAfterMoving;
    return (
      (canShoot ? offenceScore(game, unit, cell) : 0) +
      positionScore(game, unit, cell) -
      danger * caution +
      rng() * WEIGHTS.jitter
    );
  }

  /** The best destination for `unit`, or null to stay put. */
  function chooseMove(game, unit, rng = Math.random) {
    const reach = enemyReach(game, unit.owner);
    let caution = 1;
    if (unit.owner === G.ATTACKER) {
      caution = isGathering(game, unit.owner)
        ? WEIGHTS.gatherCaution
        : WEIGHTS.assaultCaution / (1 + WEIGHTS.idleBoldness * idleTurns(game, unit.owner));
    }
    let best = { option: null, score: scoreCell(game, unit, unit, reach, caution, rng) };
    for (const option of G.movesFor(game, unit.q, unit.r)) {
      const score = scoreCell(game, unit, option, reach, caution, rng);
      if (score > best.score) best = { option, score };
    }
    return best.option;
  }

  /**
   * The CPU's next move this turn, or null when it is done moving.
   * Returns { type: 'move', from, to }. Units that decide to hold their
   * position are marked `held` so they are not asked again this turn.
   */
  function nextAction(game, rng = Math.random) {
    if (game.winner) return null;
    const queue = G.unmovedPieces(game).filter((u) => !u.held).sort(
      (a, b) => G.hexDistance(a, game.keep) - G.hexDistance(b, game.keep) || a.id - b.id
    );
    for (const unit of queue) {
      const option = chooseMove(game, unit, rng);
      if (option) {
        return { type: 'move', from: { q: unit.q, r: unit.r }, to: { q: option.q, r: option.r } };
      }
      unit.held = true; // holding position (still free to fire)
    }
    return null;
  }

  return { WEIGHTS, chooseMove, nextAction, expectedIncoming };
});
