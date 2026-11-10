# Hex Keep Defence

A turn-based, two-player (hot-seat) tower defence game played on a hex grid.

## Running

No build step is needed. Open `index.html` in a browser, or serve the folder:

```sh
npm start        # serves on http://localhost:8080
```

## Rules

You play the defenders. The CPU plays the attackers.

- The board is a roughly circular hex grid, 17 cells across at its widest.
- The defender's **keep** sits in the centre (40 HP, defence 4).
- Units are soldiers or artillery. The attackers have 12: 3 artillery and 9 soldiers.
  The defender builds as many as they like from a build queue.

| Unit      | Move | Attack | Defence | Attack radius | HP | Build time |
|-----------|------|--------|---------|---------------|----|------------|
| Soldier   | 2    | 2      | 2       | 1             | 10 | 1 turn     |
| Artillery | 1    | 5      | 1       | 2–4           | 10 | 3 turns    |

Artillery can't fire on a turn it moves.

Each turn:

1. New units enter on a random empty cell.
   - **Attackers:** one unit, picked at random from their remaining 12, enters on the edge.
   - **Defenders:** the unit at the front of the build queue gains a turn of progress. Once it has
     had its build time, it enters within 3 of the keep. You can add units to the queue, reorder
     them or remove them at any time. Removing an item loses its progress. With **Repeat** on,
     each finished unit goes back on the end of the queue. The queue starts with one soldier.
     If there's no room near the keep, a finished unit waits at the front of the queue.
2. The player moves any or all of their units once each, through empty cells.
   Units can't move onto other units or the keep.
   Until the turn ends, a moved unit can be walked back along its path: select it and tap a cell
   it passed through. Walking it all the way back cancels the move, so it can move again.
   It can't walk back through a cell another unit has since moved into.
3. When the turn ends, each of that player's units attacks one enemy within its attack radius.
   Attackers always prefer the keep; otherwise a unit targets the enemy closest to dying.
   The defender can pick a different target: select the unit and tap another enemy in range
   (tap it again to go back to the default).
   Damage is random: 3 × attack ÷ defence, scaled by a random factor between 0.5 and 1.5.
   A unit at 0 HP is destroyed. Artillery that moved this turn doesn't fire.

While planning:

- Each enemy you'll attack shows the damage it will take when you end the turn, against the HP it
  has left (e.g. "−2–4 of 7 HP"), summed over all your units aiming at it. Amber means it might be
  destroyed; red with ✕ means it will be.
- Each of your units within enemy reach shows "at risk": the most it could lose next turn if every
  enemy that can reach it picked it. This doesn't reveal which target an enemy will actually choose.
- HP bars mark the HP that will be lost (solid red) and might be lost (light red).
- Selecting a unit outlines in red any destination within enemy reach. Enemy reach accounts for
  their move and range, and for artillery not firing after it moves.
- Hovering a destination previews what the unit would hit from there and what it would risk.

**Attackers win** by destroying the keep. **Defenders win** by destroying all 12 attackers.

All the numbers are in `UNITS` and `CONFIG` in `src/game.js`.

## CPU attacker

`src/ai.js` moves one unit at a time, so the UI can animate each move. Each unit scores every cell it
can reach by the damage it could deal from there at the end of the turn, the damage enemies could do
to it there next turn, and its position: soldiers close in on the keep, artillery sits 2–4 cells away.

Artillery only counts the damage it could deal if it stays put, since it can't fire after moving.

Until 5 attackers are on the board it gathers, staying out of reach. Then it commits and
cares much less about losses. Each turn it goes without dealing damage makes it bolder,
so a defender who holds back can't stall it forever. The weights are in `WEIGHTS` in `src/ai.js`.

## Code layout

- `src/game.js`: game rules and state, with no DOM code, so tests can use it
- `src/ai.js`: the CPU attacker
- `src/ui.js`: SVG rendering, animation, click handling and running CPU turns
- `src/style.css`: styling, including dark mode
- `test/`: rule and CPU tests (`npm test`)
