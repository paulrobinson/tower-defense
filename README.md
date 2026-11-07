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
- Each side has 12 units: 3 artillery and 9 soldiers.

| Unit      | Move | Attack | Defence | Attack radius | HP |
|-----------|------|--------|---------|---------------|----|
| Soldier   | 2    | 2      | 2       | 1             | 10 |
| Artillery | 3    | 5      | 1       | 2–4           | 10 |

Artillery can't fire on a turn it moves.

Each turn:

1. One unit, picked at random from the player's remaining units, enters the board:
   attackers on a random empty edge cell, defenders on a random empty cell within 3 of the keep.
2. The player moves any or all of their units once each, through empty cells.
   Units can't move onto other units or the keep.
   Any move can be undone until the turn ends (Undo button, or Ctrl/⌘+Z for the latest move),
   as long as no other unit has since moved into the cell it started from.
3. When the turn ends, each of that player's units attacks one enemy within its attack radius.
   Attackers always prefer the keep; otherwise a unit targets the enemy closest to dying.
   Damage is random: 3 × attack ÷ defence, scaled by a random factor between 0.5 and 1.5.
   A unit at 0 HP is destroyed. Artillery that moved this turn doesn't fire.

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
