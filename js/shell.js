// Window chrome, menus, dialogs and input for the WINMINE.EXE port.
import { Minesweeper, LEVELS, CUSTOM, SOUND_TICK, SOUND_WIN, SOUND_LOSE } from './winmine.js';

// String table (RT_STRING block 1).
const STR = {
  title: 'Minesweeper',
  seconds: '%d seconds',
  anonymous: 'Anonymous',
  fastest: [
    'You have the fastest time\nfor beginner level.\nPlease enter your name.',
    'You have the fastest time\nfor intermediate level.\nPlease enter your name.',
    'You have the fastest time\nfor expert level.\nPlease enter your name.',
  ],
  credits: 'by Robert Donner and Curt Johnson',
};

// ---- preferences (registry values in HKCU\Software\Microsoft\winmine) ------

const STORAGE_KEY = 'winmine';
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function loadPrefs() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch { /* private mode or corrupt data: use defaults */ }
  // Defaults and ranges from sub_1002bc2.
  const num = (k, def, lo, hi) => (Number.isInteger(saved[k]) ? clamp(saved[k], lo, hi) : def);
  const name = (k) => (typeof saved[k] === 'string' ? saved[k].slice(0, 32) : STR.anonymous);
  return {
    difficulty: num('difficulty', 0, 0, 3),
    height: num('height', 9, 9, 25),
    width: num('width', 9, 9, 30),
    mines: num('mines', 10, 10, 999),
    mark: num('mark', 1, 0, 1),
    sound: num('sound', 0, 0, 1),
    color: num('color', 1, 0, 1),
    times: [num('time1', 999, 0, 999), num('time2', 999, 0, 999), num('time3', 999, 0, 999)],
    names: [name('name1'), name('name2'), name('name3')],
  };
}

function savePrefs(p) {
  const data = {
    difficulty: p.difficulty, height: p.height, width: p.width, mines: p.mines,
    mark: p.mark, sound: p.sound, color: p.color,
    time1: p.times[0], time2: p.times[1], time3: p.times[2],
    name1: p.names[0], name2: p.names[1], name3: p.names[2],
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch { /* ignore */ }
}

// ---- assets ----------------------------------------------------------------

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = src;
});

async function loadSprites() {
  const names = ['blocks', 'led', 'faces'];
  const [color, mono] = await Promise.all(['', '_mono'].map(async (suffix) => {
    const imgs = await Promise.all(names.map((n) => loadImage(`assets/${n}${suffix}.png`)));
    return Object.fromEntries(names.map((n, i) => [n, imgs[i]]));
  }));
  return { color, mono };
}

const sounds = {
  [SOUND_TICK]: new Audio('assets/tick.wav'),
  [SOUND_WIN]: new Audio('assets/win.wav'),
  [SOUND_LOSE]: new Audio('assets/lose.wav'),
};
function playSound(id) {
  // PlaySound(..., SND_ASYNC | SND_RESOURCE): a new sound cuts off the previous one.
  for (const a of Object.values(sounds)) a.pause();
  const a = sounds[id];
  a.currentTime = 0;
  a.play().catch(() => {});
}

// ---- elements --------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const win = $('#window');
const canvas = $('#board');
const desktopIcon = $('#desktop-icon');
const taskButton = $('#task-button');
const cheatPixel = $('#cheat-pixel');

const prefs = loadPrefs();
let game;

// ---- window management -----------------------------------------------------

let zoom = 1;
function fitWindow() {
  const chromeW = 8, chromeH = 30 + 20 + 4;   // frame, title bar, menu bar
  const availW = window.innerWidth - 16;
  const availH = window.innerHeight - 30 - 16; // taskbar
  const fit = Math.min(availW / (canvas.width + chromeW), availH / (canvas.height + chromeH));
  zoom = fit >= 1 ? clamp(Math.floor(fit), 1, 2) : Math.max(fit, 0.5);
  canvas.style.width = `${canvas.width * zoom}px`;
  canvas.style.height = `${canvas.height * zoom}px`;
  if (!win.dataset.moved) centerWindow();
  else keepOnScreen();
}

function centerWindow() {
  const r = win.getBoundingClientRect();
  win.style.left = `${Math.max(0, Math.round((window.innerWidth - r.width) / 2))}px`;
  win.style.top = `${Math.max(0, Math.round((window.innerHeight - 30 - r.height) / 3))}px`;
}

function keepOnScreen() {
  const r = win.getBoundingClientRect();
  win.style.left = `${clamp(r.left, 0, Math.max(0, window.innerWidth - r.width))}px`;
  win.style.top = `${clamp(r.top, 0, Math.max(0, window.innerHeight - 30 - 24))}px`;
}

function makeDraggable(frame, handle, onMove) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const r = frame.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    handle.setPointerCapture(e.pointerId);
    const move = (ev) => {
      frame.style.left = `${clamp(ev.clientX - dx, -r.width + 60, window.innerWidth - 60)}px`;
      frame.style.top = `${clamp(ev.clientY - dy, 0, window.innerHeight - 50)}px`;
      onMove?.();
    };
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  });
}

makeDraggable(win, $('.title-bar', win), () => { win.dataset.moved = '1'; });

function setActive(active) {
  win.classList.toggle('inactive', !active);
}

function minimize() {
  closeMenus();
  win.hidden = true;
  game.pause();
  taskButton.classList.remove('active');
}

function restore() {
  win.hidden = false;
  game.resume();
  taskButton.classList.add('active');
  keepOnScreen();
}

function exitGame() {
  closeMenus();
  win.hidden = true;
  game.pause();
  taskButton.hidden = true;
  desktopIcon.focus();
}

function launch() {
  if (!win.hidden) return;
  taskButton.hidden = false;
  win.hidden = false;
  taskButton.classList.add('active');
  game.newGame();
  game.resume();
  fitWindow();
}

$('#btn-minimize').addEventListener('click', minimize);
$('#btn-close').addEventListener('click', exitGame);
taskButton.addEventListener('click', () => (win.hidden ? restore() : minimize()));
desktopIcon.addEventListener('dblclick', launch);
desktopIcon.addEventListener('keydown', (e) => { if (e.key === 'Enter') launch(); });
desktopIcon.addEventListener('click', () => desktopIcon.focus());
// Single tap opens on touch devices, where double-click is awkward.
desktopIcon.addEventListener('pointerup', (e) => { if (e.pointerType === 'touch') launch(); });

document.addEventListener('visibilitychange', () => {
  if (win.hidden) return;
  if (document.hidden) game.pause();
  else game.resume();
});

// ---- menus -----------------------------------------------------------------

const menuBar = $('.menu-bar', win);
let openMenu = null;

function closeMenus() {
  if (!openMenu) return;
  openMenu.classList.remove('open');
  openMenu = null;
}

function showMenu(item) {
  if (openMenu === item) return;
  closeMenus();
  item.classList.add('open');
  openMenu = item;
}

for (const item of menuBar.querySelectorAll('.menu')) {
  const label = $('.menu-label', item);
  label.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (openMenu === item) closeMenus();
    else showMenu(item);
  });
  label.addEventListener('pointerenter', () => { if (openMenu) showMenu(item); });
}

document.addEventListener('pointerdown', (e) => {
  if (openMenu && !e.target.closest('.menu')) closeMenus();
});

function updateMenus() {   // sub_1001516
  for (const el of menuBar.querySelectorAll('[data-level]'))
    el.classList.toggle('checked', Number(el.dataset.level) === prefs.difficulty);
  $('[data-cmd="marks"]').classList.toggle('checked', !!prefs.mark);
  $('[data-cmd="color"]').classList.toggle('checked', !!prefs.color);
  $('[data-cmd="sound"]').classList.toggle('checked', !!prefs.sound);
}

const commands = {
  new: () => game.newGame(),
  level: (el) => {   // menu ids 0x209..0x20b
    const lvl = Number(el.dataset.level);
    if (lvl === CUSTOM) return customDialog();
    prefs.difficulty = lvl;
    [prefs.mines, prefs.height, prefs.width] = LEVELS[lvl];
    savePrefs(prefs);
    updateMenus();
    game.newGame();
  },
  marks: () => { prefs.mark ^= 1; savePrefs(prefs); updateMenus(); },
  color: () => { prefs.color ^= 1; savePrefs(prefs); updateMenus(); game.paint(); },
  sound: () => { prefs.sound ^= 1; savePrefs(prefs); updateMenus(); },
  best: () => bestTimesDialog(),
  exit: () => exitGame(),
  help: () => helpDialog('mine_object'),
  search: () => helpDialog('mine_play'),
  usinghelp: () => helpDialog('using_help'),
  about: () => aboutDialog(),
};

menuBar.addEventListener('click', (e) => {
  const el = e.target.closest('[data-cmd]');
  if (!el) return;
  closeMenus();
  commands[el.dataset.cmd](el);
});

// ---- dialogs ---------------------------------------------------------------

const dialogLayer = $('#dialogs');

function openDialog({ title, body, buttons, className = '', onClose }) {
  closeMenus();
  const frame = document.createElement('div');
  frame.className = `xp-window dialog ${className}`;
  frame.setAttribute('role', 'dialog');
  frame.setAttribute('aria-modal', 'true');
  frame.innerHTML = `
    <div class="title-bar"><span class="title-text"></span>
      <div class="title-controls"><button class="ctl close" aria-label="Close"></button></div>
    </div>
    <div class="dialog-body"></div>`;
  $('.title-text', frame).textContent = title;
  if (!title) frame.classList.add('untitled');
  $('.dialog-body', frame).append(body);

  const layer = document.createElement('div');
  layer.className = 'modal';
  layer.append(frame);
  dialogLayer.append(layer);
  setActive(false);

  const close = (result) => {
    layer.remove();
    if (!dialogLayer.children.length) setActive(true);
    onClose?.(result);
  };
  $('.ctl.close', frame).addEventListener('click', () => close(null));
  frame.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(null); }
  });
  if (buttons) {
    const row = document.createElement('div');
    row.className = 'dialog-buttons';
    for (const [label, handler, isDefault] of buttons) {
      const b = document.createElement('button');
      b.textContent = label;
      if (isDefault) b.classList.add('default');
      b.addEventListener('click', () => handler(close));
      row.append(b);
    }
    $('.dialog-body', frame).append(row);
    frame.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
        e.preventDefault();
        row.querySelector('.default')?.click();
      }
    });
  }

  const r = frame.getBoundingClientRect();
  const wr = win.hidden ? { left: 40, top: 40, width: 0, height: 0 } : win.getBoundingClientRect();
  frame.style.left = `${clamp(wr.left + (wr.width - r.width) / 2, 0, Math.max(0, window.innerWidth - r.width))}px`;
  frame.style.top = `${clamp(wr.top + (wr.height - r.height) / 2, 0, Math.max(0, window.innerHeight - r.height))}px`;
  makeDraggable(frame, $('.title-bar', frame));
  (frame.querySelector('input') || frame.querySelector('.default') || frame).focus();
  return close;
}

const h = (tag, props = {}, ...children) => {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
};

// Custom Field (dialog 80, handler sub_10015a6; caller sub_1001b49).
function customDialog() {
  const field = (label, value) => {
    const input = h('input', { type: 'text', inputMode: 'numeric', value: String(value), maxLength: 3 });
    return [h('label', {}, label, input), input];
  };
  const [hl, hi] = field('Height:', prefs.height);
  const [wl, wi] = field('Width:', prefs.width);
  const [ml, mi] = field('Mines:', prefs.mines);
  const body = h('div', { className: 'custom-fields' }, hl, wl, ml);
  // GetDlgItemInt returns 0 for non-numeric text, which the clamp then raises to the minimum.
  const read = (input, lo, hi) => clamp(/^\s*\d+\s*$/.test(input.value) ? parseInt(input.value, 10) : 0, lo, hi);
  const finish = () => {
    // The original switches to Custom and starts a new game even when cancelled.
    prefs.difficulty = CUSTOM;
    savePrefs(prefs);
    updateMenus();
    game.newGame();
  };
  openDialog({
    title: 'Custom Field',
    body,
    className: 'custom-dialog',
    buttons: [
      ['OK', (close) => {
        prefs.height = read(hi, 9, 24);
        prefs.width = read(wi, 9, 30);
        prefs.mines = read(mi, 10, Math.min(999, (prefs.height - 1) * (prefs.width - 1)));
        close(true);
      }, true],
      ['Cancel', (close) => close(false)],
    ],
    onClose: finish,
  });
}

// Fastest Mine Sweepers (dialog 700, handler sub_10016fa).
function bestTimesDialog() {
  const rows = ['Beginner:', 'Intermediate:', 'Expert:'].map((label, i) => {
    const time = h('span', { className: 'time' });
    const name = h('span', { className: 'name' });
    return [h('div', { className: 'best-row' }, h('span', { className: 'level' }, label), time, name), time, name];
  });
  const refresh = () => rows.forEach(([, time, name], i) => {
    time.textContent = STR.seconds.replace('%d', prefs.times[i]);
    name.textContent = prefs.names[i];
  });
  refresh();
  const reset = h('button', { textContent: 'Reset Scores' });
  reset.addEventListener('click', () => {
    prefs.times = [999, 999, 999];
    prefs.names = [STR.anonymous, STR.anonymous, STR.anonymous];
    savePrefs(prefs);
    refresh();
  });
  const body = h('div', { className: 'best-times' },
    h('fieldset', {}, ...rows.map(([row]) => row)));
  openDialog({
    title: 'Fastest Mine Sweepers',
    body,
    className: 'best-dialog',
    buttons: [['OK', (close) => close(true), true]],
  });
  $('.best-dialog .dialog-buttons').prepend(reset);
}

// Name entry (dialog 600, handler sub_100181f), shown after a record time.
function nameDialog(level, then) {
  const input = h('input', { type: 'text', maxLength: 32, value: prefs.names[level] });
  const body = h('div', { className: 'name-entry' }, h('p', { textContent: STR.fastest[level] }), input);
  openDialog({
    title: '',
    body,
    className: 'name-dialog',
    buttons: [['OK', (close) => close(true), true]],
    onClose: () => {
      prefs.names[level] = input.value.slice(0, 32);
      savePrefs(prefs);
      then();
    },
  });
  input.select();
}

function aboutDialog() {   // sub_1003d1d -> ShellAbout
  const body = h('div', { className: 'about' },
    h('img', { src: 'assets/icon48.png', alt: '', width: 48, height: 48 }),
    h('div', {},
      h('p', {}, h('b', { textContent: STR.title })),
      h('p', { textContent: STR.credits }),
      h('hr'),
      h('p', { className: 'port-note', innerHTML: 'Browser port reverse-engineered from the original <code>WINMINE.EXE</code>. <a href="https://github.com/Ozdotdotdot/minesweeper-xp" target="_blank" rel="noopener">Source on GitHub</a>.' })));
  openDialog({ title: `About ${STR.title}`, body, className: 'about-dialog', buttons: [['OK', (close) => close(true), true]] });
}

// Help viewer, content recovered from WINMINE.CHM.
const HELP = {
  mine_object: ['Minesweeper overview', `
    <h1>Minesweeper overview</h1>
    <p>The object of Minesweeper is to locate all the mines as quickly as possible without uncovering any of them. If you uncover a mine, you lose the game.</p>`],
  mine_play: ['Play Minesweeper', `
    <p class="proclabel">To play Minesweeper</p>
    <ol><li>On the <b>Game</b> menu, click <b>New</b>.</li>
    <li>To start the timer, click any square on the playing field.</li></ol>
    <p class="note">Notes</p>
    <ul><li>You can uncover a square by clicking it. If you uncover a mine, you lose the game.</li>
    <li>If a number appears on a square, it indicates how many mines are in the eight squares that surround the numbered one.</li>
    <li>To mark a square you suspect contains a mine, right-click it.</li>
    <li>The game area consists of the playing field, a mine counter, and a timer.</li></ul>`],
  mine_customize_field: ['Customize the playing field', `
    <p class="proclabel">To customize the playing field</p>
    <ol><li>On the <b>Game</b> menu, click <b>Custom</b>.</li>
    <li>Customize the size of the field by specifying the number of squares to display vertically and horizontally, and specify the number of mines to place on the field.</li></ol>`],
  mine_tips: ['Strategies and tips', `
    <h1>Strategies and tips</h1>
    <ul><li>If you are uncertain about a square, right-click it twice to mark it with a question mark (?). Later, you can either mark the square as a mine or remove the markings by right-clicking the square again once or twice.</li>
    <li>If you have marked all the mines around a numbered square, you can uncover the remaining squares around it by clicking the numbered square with the left and right mouse buttons simultaneously. If not all mines surrounding the numbered square have been marked, the remaining covered or unmarked squares will appear to be depressed (or flash) when the numbered square is clicked with both buttons simultaneously.</li>
    <li>Look for common patterns in numbers, which often indicate a corresponding pattern of mines. For example, the pattern 2-3-2 at the edge of a group of uncovered squares indicates a row of three mines next to the three numbers.</li></ul>`],
  using_help: ['Using the Help Viewer', `
    <h1>Using the Help Viewer</h1>
    <p>The Help viewer topics live in <code>nthelp.chm</code>, a shared Windows help file that was not part of this archive.</p>
    <p>Choose a topic on the left to read the Minesweeper help.</p>`],
  browser: ['Playing in the browser', `
    <h1>Playing in the browser</h1>
    <ul><li><b>Chord</b> (open the squares around a number): press both mouse buttons, the middle button, or Shift+click.</li>
    <li><b>Touch screens</b>: tap to uncover, press and hold to mark, tap a number to chord it.</li>
    <li><b>F2</b> starts a new game. Best times and settings are stored in this browser.</li></ul>`],
};

function helpDialog(topic) {
  const toc = h('ul', { className: 'help-toc' });
  const content = h('div', { className: 'help-content' });
  const show = (key) => {
    content.innerHTML = HELP[key][1];
    for (const li of toc.querySelectorAll('.page')) li.classList.toggle('selected', li.dataset.topic === key);
  };
  const book = (label, keys) => h('li', { className: 'book' }, h('span', { textContent: label }),
    h('ul', {}, ...keys.map((k) => {
      const li = h('li', { className: 'page', textContent: HELP[k][0] });
      li.dataset.topic = k;
      li.addEventListener('click', () => show(k));
      return li;
    })));
  toc.append(
    book('Minesweeper', ['mine_object', 'mine_play', 'mine_customize_field', 'mine_tips', 'browser']),
    book('Using the Help Viewer', ['using_help']));
  openDialog({ title: 'Minesweeper Help', body: h('div', { className: 'help-viewer' }, toc, content), className: 'help-dialog' });
  show(topic);
}

// ---- board input -----------------------------------------------------------

function boardPoint(e) {
  const r = canvas.getBoundingClientRect();
  return [Math.floor((e.clientX - r.left) * canvas.width / r.width),
          Math.floor((e.clientY - r.top) * canvas.height / r.height)];
}

const modalOpen = () => dialogLayer.children.length > 0;

let mouseCaptured = false;
canvas.addEventListener('mousedown', (e) => {
  if (modalOpen()) return;
  e.preventDefault();
  closeMenus();
  const [px, py] = boardPoint(e);
  if (e.button === 0) {
    // MK_RBUTTON | MK_SHIFT start a chord (0x1001fca).
    if (game.leftDown(px, py, (e.buttons & 2) !== 0 || e.shiftKey)) mouseCaptured = true;
  } else if (e.button === 2) {
    game.rightDown(px, py, (e.buttons & 1) !== 0);
    if (game.tracking) mouseCaptured = true;
  } else if (e.button === 1) {
    game.middleDown(px, py);
    if (game.tracking) mouseCaptured = true;
  }
});

window.addEventListener('mousemove', (e) => {
  const [px, py] = boardPoint(e);
  if (mouseCaptured) game.move(px, py);
  updateCheat(px, py, e.ctrlKey);
});

window.addEventListener('mouseup', (e) => {
  if (!mouseCaptured) return;
  mouseCaptured = false;
  const [px, py] = boardPoint(e);
  game.up(px, py);
});

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('auxclick', (e) => e.preventDefault());

// Touch: tap to uncover, long-press to mark.
const LONG_PRESS_MS = 400;
let touch = null;
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' || modalOpen()) return;
  e.preventDefault();   // suppress the compatibility mouse events
  closeMenus();
  const [px, py] = boardPoint(e);
  if (game.inFace(px, py)) {
    game.leftDown(px, py, false);
    touch = { id: e.pointerId, face: true };
    return;
  }
  touch = { id: e.pointerId, px, py, timer: setTimeout(() => {
    if (!touch) return;
    touch.flagged = true;
    const [x, y] = Minesweeper.cellAt(touch.px, touch.py);
    if (game.playing) {
      game.cycleMark(x, y);
      navigator.vibrate?.(15);
    }
  }, LONG_PRESS_MS) };
});
canvas.addEventListener('pointermove', (e) => {
  if (!touch || touch.id !== e.pointerId || touch.face) return;
  const [px, py] = boardPoint(e);
  if (Math.abs(px - touch.px) > 8 || Math.abs(py - touch.py) > 8) {
    clearTimeout(touch.timer);
    touch = null;
  }
});
const endTouch = (e) => {
  if (!touch || touch.id !== e.pointerId) return;
  const t = touch;
  touch = null;
  const [px, py] = boardPoint(e);
  if (t.face) {
    game.up(px, py);
    return;
  }
  clearTimeout(t.timer);
  if (!t.flagged && e.type === 'pointerup') game.tap(t.px, t.py);
};
canvas.addEventListener('pointerup', endTouch);
canvas.addEventListener('pointercancel', endTouch);

// ---- keyboard: accelerators and the XYZZY cheat (WM_KEYDOWN, 0x1001c9a) ----

const XYZZY = 'XYZZY';
let xyzzy = 0;   // 0x1005154: 0..5 while typing, 5 = armed, 0x11 = always on

function updateCheat(px, py, ctrl) {
  if (xyzzy !== 0x11 && !(xyzzy === 5 && ctrl)) {
    cheatPixel.hidden = true;
    return;
  }
  const mine = game.mineAt(px, py);
  if (mine === null) return;   // the original leaves the pixel as it was
  cheatPixel.hidden = false;
  cheatPixel.style.background = mine ? '#000' : '#fff';
}

document.addEventListener('keydown', (e) => {
  if (modalOpen()) return;
  if (e.key === 'F2') {
    e.preventDefault();
    if (!win.hidden) game.newGame();
  } else if (e.key === 'F1') {
    e.preventDefault();
    helpDialog('mine_object');
  } else if (e.key === 'Escape') {
    closeMenus();
  } else if (e.key === 'Shift') {
    if (xyzzy >= 5) xyzzy ^= 0x14;
  } else if (xyzzy < 5 && e.key.length === 1) {
    xyzzy = e.key.toUpperCase() === XYZZY[xyzzy] ? xyzzy + 1 : 0;
  }
});

// ---- start -----------------------------------------------------------------

(async () => {
  const sprites = await loadSprites();
  game = new Minesweeper(canvas, sprites, prefs, {
    sound: playSound,
    resized: () => fitWindow(),
    won: (level, time) => {
      if (level !== CUSTOM && time < prefs.times[level]) {   // sub_100347c
        prefs.times[level] = time;
        savePrefs(prefs);
        nameDialog(level, bestTimesDialog);
      }
    },
  });
  updateMenus();
  game.newGame();
  win.hidden = false;
  taskButton.classList.add('active');
  fitWindow();
  window.addEventListener('resize', fitWindow);
})();
