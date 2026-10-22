// Engine tests: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { Minesweeper, MINE, REVEALED, LEVELS } from '../js/winmine.js';

// The engine drives its own 1s WM_TIMER; tests call onTimer() directly instead.
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

const fakeCanvas = () => ({
  width: 0,
  height: 0,
  getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }),
});

function makeGame(overrides = {}) {
  const events = { sounds: [], wins: [] };
  const prefs = { difficulty: 0, height: 9, width: 9, mines: 10, mark: 1, sound: 1, color: 1,
                  times: [999, 999, 999], names: ['', '', ''], ...overrides };
  const g = new Minesweeper(fakeCanvas(), { color: {}, mono: {} }, prefs, {
    sound: (id) => events.sounds.push(id),
    resized: () => {},
    won: (lvl, t) => events.wins.push([lvl, t]),
  });
  g.newGame();
  return { g, events };
}

// Replace the random layout with a known one.
function layMines(g, coords) {
  for (let y = 1; y <= g.height; y++)
    for (let x = 1; x <= g.width; x++) g.board[y * 32 + x] &= ~MINE;
  for (const [x, y] of coords) g.board[y * 32 + x] |= MINE;
  g.prefs.mines = coords.length;
  g.minesLeft = coords.length;
  g.toReveal = g.width * g.height - coords.length;
}

const px = (x) => (x << 4) - 4 + 8;   // centre of a cell in client pixels
const py = (y) => (y << 4) + 39 + 8;
const click = (g, x, y) => { g.leftDown(px(x), py(y), false); g.up(px(x), py(y)); };
const isOpen = (g, x, y) => (g.cell(x, y) & REVEALED) !== 0;

test('places exactly the configured number of mines inside the field', () => {
  for (const [mines, height, width] of LEVELS) {
    const { g } = makeGame({ mines, height, width });
    let n = 0;
    for (let y = 0; y < 27; y++)
      for (let x = 0; x < 32; x++)
        if (g.board[y * 32 + x] & MINE) {
          assert.ok(x >= 1 && x <= width && y >= 1 && y <= height);
          n++;
        }
    assert.equal(n, mines);
    assert.equal(g.canvas.width, width * 16 + 24);
    assert.equal(g.canvas.height, height * 16 + 67);
  }
});

test('first click on a mine moves it to the first free square from the top-left', () => {
  const { g } = makeGame();
  layMines(g, [[1, 1], [2, 1], [5, 5]]);
  click(g, 5, 5);
  assert.equal(g.cell(5, 5) & MINE, 0);
  assert.ok(g.cell(3, 1) & MINE, 'mine relocated to (3,1)');
  assert.ok(isOpen(g, 5, 5));
  assert.ok(g.playing);
  assert.equal(g.timer, 1, 'timer starts at 1 on the first click');
});

test('opening a zero floods to the numbered boundary', () => {
  const { g } = makeGame();
  layMines(g, [[9, 9]]);
  click(g, 1, 1);
  assert.equal(g.revealed, 80);
  assert.equal(g.cell(8, 8) & 0x1f, 1);
  assert.ok(!g.playing, 'all safe squares open -> game won');
  assert.equal(g.face, 3);
  assert.ok(g.cell(9, 9) & MINE);
  assert.equal(g.cell(9, 9) & 0x1f, 0xe, 'remaining mines are flagged on a win');
  assert.equal(g.minesLeft, 0);
});

test('clicking a mine after the first move loses and marks wrong flags', () => {
  const { g, events } = makeGame();
  layMines(g, [[1, 1], [9, 9], [5, 1]]);
  click(g, 2, 1);
  g.cycleMark(2, 9);   // wrong flag
  click(g, 1, 1);
  assert.ok(!g.playing);
  assert.equal(g.face, 2);
  assert.equal(g.cell(1, 1) & 0x1f, 0xc, 'clicked mine is red');
  assert.equal(g.cell(9, 9) & 0x1f, 0xa, 'other mines are shown');
  assert.equal(g.cell(2, 9) & 0x1f, 0xb, 'wrong flag is crossed out');
  assert.equal(events.sounds.at(-1), 3);
});

test('right-click cycles flag -> question -> blank and updates the counter', () => {
  const { g } = makeGame();
  g.rightDown(px(4), py(4), false);
  assert.equal(g.cell(4, 4) & 0x1f, 0xe);
  assert.equal(g.minesLeft, 9);
  g.rightDown(px(4), py(4), false);
  assert.equal(g.cell(4, 4) & 0x1f, 0xd);
  assert.equal(g.minesLeft, 10);
  g.rightDown(px(4), py(4), false);
  assert.equal(g.cell(4, 4) & 0x1f, 0xf);
  g.prefs.mark = 0;
  g.cycleMark(4, 4);
  g.cycleMark(4, 4);
  assert.equal(g.cell(4, 4) & 0x1f, 0xf, 'no ? when Marks is off');
});

test('flagged squares cannot be opened', () => {
  const { g } = makeGame();
  layMines(g, [[9, 9]]);
  g.cycleMark(1, 1);
  click(g, 1, 1);
  assert.ok(!isOpen(g, 1, 1));
  assert.equal(g.timer, 1, 'the click still starts the timer');
});

test('chording opens neighbours when the flag count matches', () => {
  const { g } = makeGame();
  layMines(g, [[1, 1], [9, 9], [9, 1]]);
  click(g, 2, 2);
  assert.equal(g.cell(2, 2) & 0x1f, 1);
  g.cycleMark(1, 1);
  g.leftDown(px(2), py(2), true);
  g.up(px(2), py(2));
  for (const [x, y] of [[2, 1], [3, 1], [1, 2], [3, 2], [1, 3], [2, 3], [3, 3]]) assert.ok(isOpen(g, x, y));
});

test('chording with a wrong flag explodes the unflagged mine', () => {
  const { g } = makeGame();
  layMines(g, [[1, 1], [9, 9], [9, 1]]);
  click(g, 2, 2);
  g.cycleMark(3, 1);   // wrong
  g.middleDown(px(2), py(2));
  g.up(px(2), py(2));
  assert.ok(!g.playing);
  assert.equal(g.cell(1, 1) & 0x1f, 0xc);
});

test('chording with too few flags only releases the pressed squares', () => {
  const { g } = makeGame();
  layMines(g, [[1, 1], [9, 9], [9, 1]]);
  click(g, 2, 2);
  g.leftDown(px(2), py(2), true);
  assert.equal(g.cell(1, 1) & 0x1f, 0, 'neighbours look pressed while held');
  g.up(px(2), py(2));
  assert.equal(g.cell(1, 1) & 0x1f, 0xf);
  assert.ok(g.playing);
});

test('both buttons: right-press while left is held switches to a chord', () => {
  const { g } = makeGame();
  layMines(g, [[1, 1], [9, 9], [9, 1]]);
  click(g, 2, 2);
  g.cycleMark(1, 1);
  g.leftDown(px(2), py(2), false);
  g.rightDown(px(2), py(2), true);
  assert.ok(g.chord);
  g.up(px(2), py(2));
  assert.ok(isOpen(g, 3, 3));
});

test('pressed square follows the cursor and is released when leaving the field', () => {
  const { g } = makeGame();
  g.leftDown(px(3), py(3), false);
  assert.equal(g.cell(3, 3) & 0x1f, 0);
  g.move(px(4), py(3));
  assert.equal(g.cell(3, 3) & 0x1f, 0xf);
  assert.equal(g.cell(4, 3) & 0x1f, 0);
  g.move(2, 2);
  g.up(2, 2);
  assert.equal(g.cell(4, 3) & 0x1f, 0xf);
  assert.equal(g.revealed, 0);
  assert.equal(g.timer, 0);
});

test('timer ticks once per second, caps at 999 and pauses', () => {
  const { g, events } = makeGame();
  layMines(g, [[9, 9], [8, 9]]);
  click(g, 7, 9);
  g.onTimer();
  assert.equal(g.timer, 2);
  assert.deepEqual(events.sounds.slice(-2), [1, 1]);
  g.pause();
  g.onTimer();
  assert.equal(g.timer, 2);
  g.resume();
  g.timer = 999;
  g.onTimer();
  assert.equal(g.timer, 999);
});

test('a win reports the level and time for best-time handling', () => {
  const { g, events } = makeGame();
  layMines(g, [[9, 9]]);
  click(g, 1, 1);
  assert.deepEqual(events.wins, [[0, 1]]);
  assert.equal(events.sounds.at(-1), 2);
});

test('face click starts a new game', () => {
  const { g } = makeGame();
  layMines(g, [[9, 9]]);
  click(g, 1, 1);
  assert.ok(!g.playing);
  const fx = (g.canvas.width >> 1), fy = 28;
  g.leftDown(fx, fy, false);
  g.up(fx, fy);
  assert.ok(g.playing);
  assert.equal(g.revealed, 0);
});

test('negative mine counter is allowed', () => {
  const { g } = makeGame();
  for (let x = 1; x <= 9; x++) for (let y = 1; y <= 2; y++) g.cycleMark(x, y);
  assert.equal(g.minesLeft, -8);
});

test('rand() matches the MSVCRT linear congruential generator', () => {
  const { g } = makeGame();
  g.seed = 1;
  assert.deepEqual([g.rand(), g.rand(), g.rand()], [41, 18467, 6334]);
});
