// Game engine + renderer, ported from WINMINE.EXE (Windows XP, sha256 bcff8931...caaf41).
// Addresses in comments refer to the original procedures; see docs/REVERSE_ENGINEERING.md.

// Cell byte layout (board at 0x1005340, 32 bytes per row, 27 rows).
export const MINE = 0x80;
export const REVEALED = 0x40;
const SPRITE = 0x1f;
const BORDER = 0x10;
const BLK_BLANK = 0x0;      // revealed/pressed blank; 1..8 are numbers
const BLK_PRESSED_Q = 0x9;
const BLK_MINE = 0xa;
const BLK_WRONG = 0xb;      // flag on a non-mine, shown at game over
const BLK_BOOM = 0xc;       // the mine you clicked (red)
const BLK_QUESTION = 0xd;
const BLK_FLAG = 0xe;
const BLK_UP = 0xf;

const FACE_SMILE = 0, FACE_OOH = 1, FACE_DEAD = 2, FACE_COOL = 3, FACE_PRESSED = 4;

// Game state flags (0x1005000).
const ST_PLAYING = 0x1, ST_PAUSED = 0x2, ST_OVER = 0x10;

const ROW = 32;
const QUEUE_LEN = 100;      // flood-fill ring buffer size (0x10051a0 / 0x10057c0)

// Difficulty table at 0x1005010: mines, height, width.
export const LEVELS = [[10, 9, 9], [40, 16, 16], [99, 16, 30]];
export const CUSTOM = 3;

export const SOUND_TICK = 1, SOUND_WIN = 2, SOUND_LOSE = 3;

// Client-area geometry (sub_1001950, sub_1002a22).
const CXBORDER = 2;         // GetSystemMetrics(SM_CXBORDER) + 1, subtracted when placing the timer
export const clientWidth = (w) => w * 16 + 24;
export const clientHeight = (h) => h * 16 + 67;

export class Minesweeper {
  constructor(canvas, sprites, prefs, hooks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sprites = sprites;   // { color: {blocks, led, faces}, mono: {...} }
    this.prefs = prefs;
    this.hooks = hooks;       // { sound(id), resized(w, h), won(level, time) }

    this.board = new Uint8Array(27 * ROW);
    this.qx = new Int32Array(QUEUE_LEN);
    this.qy = new Int32Array(QUEUE_LEN);
    this.qw = 0;

    this.width = 0;
    this.height = 0;
    this.minesLeft = 0;       // counter display, can go negative (0x1005194)
    this.timer = 0;           // 0x100579c
    this.timerRunning = false;
    this.savedRunning = false;
    this.revealed = 0;        // 0x10057a4
    this.toReveal = 0;        // 0x10057a0
    this.state = 0;
    this.face = FACE_SMILE;   // resting face (0x1005160)

    this.tracking = false;    // mouse captured over the board (0x1005140)
    this.chord = false;       // both buttons / middle / shift (0x1005144)
    this.curX = -1;
    this.curY = -1;
    this.faceTracking = false;

    // MSVCRT rand(), seeded with GetTickCount() like sub_1003ab0.
    this.seed = Date.now() & 0xffff;

    this.interval = setInterval(() => this.onTimer(), 1000);
  }

  rand() {
    this.seed = (Math.imul(this.seed, 214013) + 2531011) >>> 0;
    return (this.seed >>> 16) & 0x7fff;
  }

  sound(id) {
    if (this.prefs.sound) this.hooks.sound(id);
  }

  // ---- board setup -------------------------------------------------------

  // sub_1002ed5
  clearBoard() {
    const b = this.board;
    b.fill(BLK_UP);
    for (let x = 0; x <= this.width + 1; x++) {
      b[x] = BORDER;
      b[(this.height + 1) * ROW + x] = BORDER;
    }
    for (let y = 0; y <= this.height + 1; y++) {
      b[y * ROW] = BORDER;
      b[y * ROW + this.width + 1] = BORDER;
    }
  }

  // sub_100367a
  newGame() {
    const p = this.prefs;
    const resized = p.width !== this.width || p.height !== this.height;
    this.timerRunning = false;
    this.width = p.width;
    this.height = p.height;
    this.clearBoard();
    this.face = FACE_SMILE;

    let n = p.mines;
    while (n) {
      const x = this.rand() % this.width + 1;
      const y = this.rand() % this.height + 1;
      const i = y * ROW + x;
      if (this.board[i] & MINE) continue;
      this.board[i] |= MINE;
      n--;
    }

    this.timer = 0;
    this.minesLeft = p.mines;
    this.revealed = 0;
    this.toReveal = this.width * this.height - p.mines;
    this.state = ST_PLAYING;
    this.tracking = false;
    this.faceTracking = false;

    if (resized || this.canvas.width !== clientWidth(this.width)) {
      this.canvas.width = clientWidth(this.width);
      this.canvas.height = clientHeight(this.height);
      this.hooks.resized(this.canvas.width, this.canvas.height);
    }
    this.paint();
  }

  inRange(x, y) {
    return x > 0 && y > 0 && x <= this.width && y <= this.height;
  }

  cell(x, y) {
    return this.board[y * ROW + x];
  }

  setSprite(x, y, blk) {   // sub_1002eab
    const i = y * ROW + x;
    this.board[i] = (this.board[i] & 0xe0) | blk;
    this.drawBlk(x, y);
  }

  // sub_1002f3b
  countMines(x, y) {
    let n = 0;
    for (let yy = y - 1; yy <= y + 1; yy++)
      for (let xx = x - 1; xx <= x + 1; xx++)
        if (this.board[yy * ROW + xx] & MINE) n++;
    return n;
  }

  // sub_1003119
  countFlags(x, y) {
    let n = 0;
    for (let yy = y - 1; yy <= y + 1; yy++)
      for (let xx = x - 1; xx <= x + 1; xx++)
        if ((this.board[yy * ROW + xx] & SPRITE) === BLK_FLAG) n++;
    return n;
  }

  // ---- revealing ---------------------------------------------------------

  // sub_1003008
  stepSquare(x, y) {
    const i = y * ROW + x;
    const c = this.board[i];
    if (c & REVEALED) return;
    const s = c & SPRITE;
    if (s === BORDER || s === BLK_FLAG) return;
    this.revealed++;
    const n = this.countMines(x, y);
    this.board[i] = n | REVEALED;
    this.drawBlk(x, y);
    if (n === 0) {
      this.qx[this.qw] = x;
      this.qy[this.qw] = y;
      if (++this.qw === QUEUE_LEN) this.qw = 0;
    }
  }

  // sub_1003084: breadth-first open using the original 100-entry ring buffer.
  stepBlock(x, y) {
    this.qw = 1;
    this.stepSquare(x, y);
    let r = 1;
    while (r !== this.qw) {
      const cx = this.qx[r], cy = this.qy[r];
      this.stepSquare(cx - 1, cy - 1);
      this.stepSquare(cx, cy - 1);
      this.stepSquare(cx + 1, cy - 1);
      this.stepSquare(cx - 1, cy);
      this.stepSquare(cx + 1, cy);
      this.stepSquare(cx - 1, cy + 1);
      this.stepSquare(cx, cy + 1);
      this.stepSquare(cx + 1, cy + 1);
      if (++r === QUEUE_LEN) r = 0;
    }
  }

  // sub_1003512
  clickSquare(x, y) {
    const i = y * ROW + x;
    if (this.board[i] & MINE) {
      if (this.revealed === 0) {
        // First click on a mine: move it to the first free square scanning from the
        // top-left. The original loops stop one short of the last row and column.
        for (let yy = 1; yy < this.height; yy++) {
          for (let xx = 1; xx < this.width; xx++) {
            const j = yy * ROW + xx;
            if (!(this.board[j] & MINE)) {
              this.board[i] = BLK_UP;
              this.board[j] |= MINE;
              this.stepBlock(x, y);
              return;
            }
          }
        }
      } else {
        this.setSprite(x, y, REVEALED | BLK_BOOM);
        this.gameOver(false);
      }
    } else {
      this.stepBlock(x, y);
      if (this.revealed === this.toReveal) this.gameOver(true);
    }
  }

  // sub_10035b7
  chordSquare(x, y) {
    const c = this.cell(x, y);
    if (!(c & REVEALED) || (c & SPRITE) !== this.countFlags(x, y)) {
      this.trackTo(-2, -2);
      return;
    }
    let lost = false;
    for (let yy = y - 1; yy <= y + 1; yy++) {
      for (let xx = x - 1; xx <= x + 1; xx++) {
        const v = this.board[yy * ROW + xx];
        if ((v & SPRITE) !== BLK_FLAG && (v & MINE)) {
          lost = true;
          this.setSprite(xx, yy, REVEALED | BLK_BOOM);
        } else {
          this.stepBlock(xx, yy);
        }
      }
    }
    if (lost) this.gameOver(false);
    else if (this.revealed === this.toReveal) this.gameOver(true);
  }

  // sub_100374f: right-click cycles up -> flag -> ? (if Marks) -> up.
  cycleMark(x, y) {
    if (!this.inRange(x, y)) return;
    const c = this.cell(x, y);
    if (c & REVEALED) return;
    const s = c & SPRITE;
    let next;
    if (s === BLK_FLAG) {
      next = this.prefs.mark ? BLK_QUESTION : BLK_UP;
      this.addMines(1);
    } else if (s === BLK_QUESTION) {
      next = BLK_UP;
    } else {
      next = BLK_FLAG;
      this.addMines(-1);
    }
    this.setSprite(x, y, next);
    if ((this.cell(x, y) & SPRITE) === BLK_FLAG && this.revealed === this.toReveal) this.gameOver(true);
  }

  addMines(d) {   // sub_100346a
    this.minesLeft += d;
    this.drawCounter();
  }

  // sub_1002f80: reveal mines (loss) or flag them (win); mark wrong flags.
  showBombs(blk) {
    for (let y = 1; y <= this.height; y++) {
      for (let x = 1; x <= this.width; x++) {
        const i = y * ROW + x;
        const c = this.board[i];
        if (c & REVEALED) continue;
        const s = c & SPRITE;
        if (c & MINE) {
          if (s !== BLK_FLAG) this.board[i] = (c & 0xe0) | blk;
        } else if (s === BLK_FLAG) {
          this.board[i] = (c & 0xe0) | BLK_WRONG;
        }
      }
    }
    this.drawGrid();
  }

  // sub_100347c
  gameOver(win) {
    this.timerRunning = false;
    this.face = win ? FACE_COOL : FACE_DEAD;
    this.drawFace(this.face);
    this.showBombs(win ? BLK_FLAG : BLK_MINE);
    if (win && this.minesLeft !== 0) this.addMines(-this.minesLeft);
    this.sound(win ? SOUND_WIN : SOUND_LOSE);
    this.state = ST_OVER;
    if (win) this.hooks.won(this.prefs.difficulty, this.timer);
  }

  // sub_1002fe0
  onTimer() {
    if (this.timerRunning && this.timer < 999) {
      this.timer++;
      this.drawTimer();
      this.sound(SOUND_TICK);
    }
  }

  // sub_100341c / sub_100344c: pause while the window is minimised or hidden.
  pause() {
    if (!(this.state & ST_PAUSED)) this.savedRunning = this.timerRunning;
    if (this.state & ST_PLAYING) this.timerRunning = false;
    this.state |= ST_PAUSED;
  }

  resume() {
    if (this.state & ST_PLAYING) this.timerRunning = this.savedRunning;
    this.state &= ~ST_PAUSED;
  }

  get playing() {
    return (this.state & ST_PLAYING) !== 0;
  }

  // ---- mouse tracking ----------------------------------------------------

  static pressBlk(s) { return s === BLK_QUESTION ? BLK_PRESSED_Q : s === BLK_UP ? BLK_BLANK : s; }      // sub_100316b
  static releaseBlk(s) { return s === BLK_PRESSED_Q ? BLK_QUESTION : s === BLK_BLANK ? BLK_UP : s; }    // sub_10031a0

  mapCell(x, y, fn) {
    const i = y * ROW + x;
    const c = this.board[i];
    this.board[i] = (c & 0xe0) | fn(c & SPRITE);
  }

  // sub_10031d4: move the pressed-down square(s) to the cell under the cursor.
  trackTo(x, y) {
    if (x === this.curX && y === this.curY) return;
    const ox = this.curX, oy = this.curY;
    this.curX = x;
    this.curY = y;

    if (!this.chord) {
      if (this.inRange(ox, oy) && !(this.cell(ox, oy) & REVEALED)) {
        this.mapCell(ox, oy, Minesweeper.releaseBlk);
        this.drawBlk(ox, oy);
      }
      if (this.inRange(x, y)) {
        const c = this.cell(x, y);
        if (!(c & REVEALED) && (c & SPRITE) !== BLK_FLAG) {
          this.mapCell(x, y, Minesweeper.pressBlk);
          this.drawBlk(x, y);
        }
      }
      return;
    }

    const box = (cx, cy) => [Math.max(cx - 1, 1), Math.max(cy - 1, 1),
                             Math.min(cx + 1, this.width), Math.min(cy + 1, this.height)];
    const each = ([x0, y0, x1, y1], fn) => {
      for (let yy = y0; yy <= y1; yy++)
        for (let xx = x0; xx <= x1; xx++) fn(xx, yy);
    };
    const oldOk = this.inRange(ox, oy), newOk = this.inRange(x, y);
    const oldBox = box(ox, oy), newBox = box(x, y);
    if (oldOk) each(oldBox, (xx, yy) => { if (!(this.cell(xx, yy) & REVEALED)) this.mapCell(xx, yy, Minesweeper.releaseBlk); });
    if (newOk) each(newBox, (xx, yy) => { if (!(this.cell(xx, yy) & REVEALED)) this.mapCell(xx, yy, Minesweeper.pressBlk); });
    if (oldOk) each(oldBox, (xx, yy) => this.drawBlk(xx, yy));
    if (newOk) each(newBox, (xx, yy) => this.drawBlk(xx, yy));
  }

  static cellAt(px, py) {
    return [(px + 4) >> 4, (py - 39) >> 4];
  }

  faceRect() {
    return [(this.canvas.width - 24) >> 1, 16, 24, 24];
  }

  inFace(px, py) {
    const [fx, fy, fw, fh] = this.faceRect();
    return px >= fx && px < fx + fw && py >= fy && py < fy + fh;
  }

  // Left button down (0x1001fa6). Returns true if the event was consumed.
  leftDown(px, py, chord) {
    if (this.inFace(px, py)) {   // sub_100140c
      this.faceTracking = true;
      this.drawFace(FACE_PRESSED);
      return true;
    }
    if (!this.playing) return false;
    this.chord = chord;
    this.beginTracking(px, py);
    return true;
  }

  // Right button down (0x100200f).
  rightDown(px, py, leftHeld) {
    if (!this.playing) return;
    if (this.tracking) {
      this.trackTo(-3, -3);
      this.chord = true;
      this.curX = this.curY = -1;
      this.move(px, py);
    } else if (leftHeld) {
      this.beginTracking(px, py);
    } else {
      const [x, y] = Minesweeper.cellAt(px, py);
      this.cycleMark(x, y);
    }
  }

  // Middle button down (0x1001f7c).
  middleDown(px, py) {
    if (!this.playing) return;
    this.chord = true;
    this.beginTracking(px, py);
  }

  beginTracking(px, py) {   // 0x100205f
    this.curX = this.curY = -1;
    this.tracking = true;
    this.drawFace(FACE_OOH);
    this.move(px, py);
  }

  move(px, py) {
    if (this.faceTracking) {
      this.drawFace(this.inFace(px, py) ? FACE_PRESSED : this.face);
      return;
    }
    if (!this.tracking) return;
    if (this.playing) {
      const [x, y] = Minesweeper.cellAt(px, py);
      this.trackTo(x, y);
    } else {
      this.trackTo(-2, -2);
    }
  }

  // Any button up (0x1001fdf) -> sub_10037e1.
  up(px, py) {
    if (this.faceTracking) {
      this.faceTracking = false;
      if (this.inFace(px, py)) {
        this.face = FACE_SMILE;
        this.newGame();
      } else {
        this.drawFace(this.face);
      }
      return;
    }
    if (!this.tracking) return;
    this.tracking = false;
    if (!this.playing) {
      this.trackTo(-2, -2);
      return;
    }
    this.doButton();
  }

  doButton() {
    let x = this.curX, y = this.curY;
    if (this.inRange(x, y)) {
      if (this.revealed === 0 && this.timer === 0) {
        this.sound(SOUND_TICK);
        this.timer++;
        this.drawTimer();
        this.timerRunning = true;
        clearInterval(this.interval);   // SetTimer restarts the 1s period
        this.interval = setInterval(() => this.onTimer(), 1000);
      }
      if (!this.playing) x = y = this.curX = this.curY = -2;
      if (this.chord) {
        this.chordSquare(x, y);
      } else {
        const c = this.cell(x, y);
        if (!(c & REVEALED) && (c & SPRITE) !== BLK_FLAG) this.clickSquare(x, y);
      }
    }
    this.drawFace(this.face);
  }

  // Touch convenience (not in the original): tap a number to chord it.
  tap(px, py) {
    if (!this.playing) return;
    const [x, y] = Minesweeper.cellAt(px, py);
    if (!this.inRange(x, y)) return;
    this.chord = (this.cell(x, y) & REVEALED) !== 0;
    this.curX = this.curY = -1;
    this.trackTo(x, y);
    this.tracking = false;
    this.doButton();
  }

  // XYZZY cheat (0x10020c1): is there a mine under this pixel?
  mineAt(px, py) {
    const [x, y] = Minesweeper.cellAt(px, py);
    if (!this.inRange(x, y)) return null;
    return (this.cell(x, y) & MINE) !== 0;
  }

  // ---- drawing -----------------------------------------------------------

  get set() {
    return this.prefs.color ? this.sprites.color : this.sprites.mono;
  }

  drawBlk(x, y) {   // sub_1002646
    const s = this.cell(x, y) & SPRITE;
    if (s > BLK_UP) return;
    this.ctx.drawImage(this.set.blocks, 0, (15 - s) * 16, 16, 16, (x << 4) - 4, (y << 4) + 39, 16, 16);
  }

  drawGrid() {   // sub_10026a7
    for (let y = 1; y <= this.height; y++)
      for (let x = 1; x <= this.width; x++) this.drawBlk(x, y);
  }

  drawLed(x, digit) {   // sub_1002752; 10 = blank, 11 = minus
    this.ctx.drawImage(this.set.led, 0, (11 - digit) * 23, 13, 23, x, 16, 13, 23);
  }

  drawCounter() {   // sub_1002785
    let hundreds, rest;
    if (this.minesLeft < 0) {
      hundreds = 11;
      rest = (-this.minesLeft) % 100;
    } else {
      hundreds = Math.floor(this.minesLeft / 100);
      rest = this.minesLeft % 100;
    }
    this.drawLed(17, hundreds);
    this.drawLed(30, Math.floor(rest / 10));
    this.drawLed(43, rest % 10);
  }

  drawTimer() {   // sub_1002825
    const t = this.timer, right = this.canvas.width - CXBORDER;
    this.drawLed(right - 56, Math.floor(t / 100));
    this.drawLed(right - 43, Math.floor((t % 100) / 10));
    this.drawLed(right - 30, t % 10);
  }

  drawFace(f) {   // sub_10028d9
    this.ctx.drawImage(this.set.faces, 0, (4 - f) * 24, 24, 24, (this.canvas.width - 24) >> 1, 16, 24, 24);
  }

  // sub_1002971: GDI MoveTo/LineTo bevel. mode 1 = raised, 0 = sunken, 2 = flat shadow.
  bevel(x1, y1, x2, y2, width, mode) {
    const ctx = this.ctx;
    const shadow = this.prefs.color ? '#808080' : '#000000';
    let px = 0, py = 0;
    const moveTo = (x, y) => { px = x; py = y; };
    const lineTo = (x, y) => {   // GDI excludes the end point
      if (py === y) {
        if (x > px) ctx.fillRect(px, y, x - px, 1);
        else if (x < px) ctx.fillRect(x + 1, y, px - x, 1);
      } else if (x > px) {
        // not used by the original drawing code
      } else if (y > py) ctx.fillRect(x, py, 1, y - py);
      else ctx.fillRect(x, y + 1, 1, py - y);
      px = x; py = y;
    };
    ctx.fillStyle = mode & 1 ? '#ffffff' : shadow;
    for (let i = 0; i < width; i++) {
      y2--;
      moveTo(x1, y2);
      lineTo(x1, y1);
      x1++;
      lineTo(x2, y1);
      x2--;
      y1++;
    }
    if (mode < 2) ctx.fillStyle = (mode ^ 1) & 1 ? '#ffffff' : shadow;
    for (let i = 0; i < width; i++) {
      y2++;
      moveTo(x1, y2);
      x1--;
      x2++;
      lineTo(x2, y2);
      y1--;
      lineTo(x2, y1);
    }
  }

  drawBorders() {   // sub_1002a22
    const w = this.canvas.width, h = this.canvas.height;
    this.bevel(0, 0, w - 1, h - 1, 3, 1);
    this.bevel(9, 52, w - 10, h - 10, 3, 0);
    this.bevel(9, 9, w - 10, 45, 2, 0);
    this.bevel(16, 15, 56, 39, 1, 0);
    const t = w - CXBORDER - 57;
    this.bevel(t, 15, t + 40, 39, 1, 0);
    const f = ((w - 24) >> 1) - 1;
    this.bevel(f, 15, f + 25, 40, 1, 2);
  }

  paint() {   // sub_1002ac3
    const ctx = this.ctx;
    ctx.fillStyle = '#c0c0c0';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawBorders();
    this.drawCounter();
    this.drawFace(this.face);
    this.drawTimer();
    this.drawGrid();
  }
}
