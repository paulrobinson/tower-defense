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
- The defender's **keep** sits in the centre (5 HP).
- Attackers go first. On a turn a player may move **every** one of their pieces once,
  each up to **2 cells** through empty spaces, then ends the turn.
- At the start of each defender turn a new defender appears next to the keep,
  on the side facing the nearest attacker.
- Each attacker turn, one new attacker enters on an edge cell (12 in total).
- Moving onto an enemy piece captures it. An attacker that reaches the keep strikes it for 1 damage
  and stops beside it.
- **Attackers win** by destroying the keep.
- **Defenders win** by destroying every attacking piece, both on the board and in reserve.
- Blue arrows show your moves this turn. Grey arrows and rings show the CPU's last turn.

All the numbers are in `CONFIG` in `src/game.js`.

## CPU attacker

`src/ai.js` plays one action at a time, so the UI can animate each one.

- **Gather:** bring pieces in on the edge where the route to the keep is least defended,
  then creep towards the keep, staying out of every defender's reach and close together.
- **Assault:** once 5 attackers are on the board (or the reserve is empty), charge together,
  striking the keep whenever possible and capturing defenders on the way.
  If the assault is broken, go back to gathering.

The scoring weights are in `WEIGHTS` in `src/ai.js`.

## Code layout

- `src/game.js`: game rules and state, with no DOM code, so tests can use it
- `src/ai.js`: the CPU attacker
- `src/ui.js`: SVG rendering, animation, click handling and running CPU turns
- `src/style.css`: styling, including dark mode
- `test/`: rule and CPU tests (`npm test`)
