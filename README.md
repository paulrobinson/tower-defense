# Hex Keep Defence

A turn-based, two-player (hot-seat) tower defence game played on a hex grid.

## Running

No build step is needed. Open `index.html` in a browser, or serve the folder:

```sh
npm start        # serves on http://localhost:8080
```

## Rules (initial version)

- The board is a roughly circular hex grid, 17 cells across at its widest.
- The defender's **keep** sits in the centre (5 HP).
- Players take turns; attackers go first. On a turn a player does one thing:
  - **place** a piece from their reserve, or
  - **move** one of their pieces one cell to an adjacent cell.
- Defenders place within 3 cells of the keep. Attackers place on edge cells.
- Moving onto an enemy piece captures it. An attacker moving into the keep deals 1 damage.
- **Attackers win** by destroying the keep.
- **Defenders win** by destroying every attacking piece, both on the board and in reserve.
- A player can pass their turn.

Starting reserves: 12 attackers, 8 defenders. These and the other settings are in `CONFIG` in `src/game.js`.

## Code layout

- `src/game.js`: game rules and state, with no DOM code, so tests can use it
- `src/ui.js`: SVG rendering and click handling
- `src/style.css`: styling, including dark mode
- `test/game.test.js`: rule tests (`npm test`)
