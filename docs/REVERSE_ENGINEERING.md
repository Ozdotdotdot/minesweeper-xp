# Reverse-engineering notes

How the browser port was derived from the shipped Windows XP files. Everything here was read
from the binaries with [REA](https://github.com/morluto/rea) (Hopper backend), `llvm-objdump`
and 7-Zip. Nothing was executed on Windows.

## Inputs

| File | SHA-256 | Notes |
| --- | --- | --- |
| `WINMINE.EXE` | `bcff89311d792f6428468e813ac6929a346a979f907071c302f418d128eaaf41` | PE32 i386 GUI, 119,808 bytes, 90 procedures |
| `WINMINE.CHM` | `c326d5a2655d0ef7aba670b30fa1d67f00920cd679d39325ba83ed1688dca598` | HTML Help, compiled 2001-06-12 |
| `WINMINE.HLP` | `041cb3c2001e0b41a73a16b8c0e50f7983c9247bb3f23d3538c12f48ccaa76b1` | WinHelp 3.1 (not used) |

The original binaries are **not** redistributed in this repository. `tools/extract_resources.py`
regenerates `assets/` from your own copy and refuses any other build.

## Resources (`inspect_pe_resources`)

| Type | ID | Contents | Port |
| --- | --- | --- | --- |
| BITMAP | 410 / 411 | 16 × 16 cell sprites, colour / mono, 16 frames | `assets/blocks*.png` |
| BITMAP | 420 / 421 | 13 × 23 LED digits, 12 frames (0–9, blank, minus) | `assets/led*.png` |
| BITMAP | 430 / 431 | 24 × 24 faces, 5 frames | `assets/faces*.png` |
| WAVE | 432 / 433 / 434 | tick / win / lose (8-bit mono 22 kHz) | `assets/{tick,win,lose}.wav` |
| MENU | 500 | Game / Help menus | `index.html` |
| DIALOG | 80 / 600 / 700 | Custom Field / name entry / Fastest Mine Sweepers | `js/shell.js` |
| STRING | 1 | 12 strings (titles, "%d seconds", "Anonymous", record prompts, credits) | `js/shell.js` |
| GROUP_ICON | 100 | 8 images, 16–48 px, up to 32 bpp | `assets/winmine.ico`, `icon*.png` |

Sprite frames are stored bottom-up, so frame *i* sits at `y = (count − 1 − i) × height` in the PNGs.

## Data

| Address | Meaning |
| --- | --- |
| `0x1005010` | Level table `{mines, height, width}`: (10, 9, 9), (40, 16, 16), (99, 16, 30) |
| `0x1005340` | Board, 27 rows × 32 bytes; bit 7 mine, bit 6 revealed, bits 0–4 sprite; 0x10 = border |
| `0x1005330` / `0x1005194` | Mines to place / mine counter (can go negative) |
| `0x100579c` | Timer (capped at 999) |
| `0x10057a4` / `0x10057a0` | Squares revealed / squares to reveal for a win |
| `0x1005000` | State: 1 playing, 2 paused, 0x10 over |
| `0x1005140` / `0x1005144` | Mouse captured / chord mode |
| `0x1005154` | XYZZY cheat state |
| `0x10051a0`, `0x10057c0` | Flood-fill ring buffer, 100 entries |
| `0x10056a0`… | Saved preferences (registry `HKCU\Software\Microsoft\winmine`) |

Sprite values: 0 blank, 1–8 numbers, 9 pressed "?", 0xA mine, 0xB wrong flag, 0xC exploded mine,
0xD "?", 0xE flag, 0xF raised. Faces: 0 smile, 1 "ooh", 2 dead, 3 cool, 4 pressed.

## Procedures

| Address | Role | Port |
| --- | --- | --- |
| `0x1001bc9` | Window procedure | `js/shell.js` input handlers |
| `0x100367a` | New game: clear board, place mines with `rand() % w + 1` | `newGame()` |
| `0x1002ed5` | Clear board and border | `clearBoard()` |
| `0x1003008` / `0x1003084` | Reveal one square / breadth-first flood with 100-entry ring | `stepSquare()` / `stepBlock()` |
| `0x1003512` | Click; first-click mine relocation | `clickSquare()` |
| `0x10035b7` | Chord | `chordSquare()` |
| `0x100374f` | Right-click mark cycle | `cycleMark()` |
| `0x10031d4` | Pressed-square tracking (single and 3 × 3) | `trackTo()` |
| `0x10037e1` | Button release: starts timer, dispatches click or chord | `doButton()` |
| `0x100347c` | Game over, best-time check | `gameOver()` |
| `0x1002f80` | Reveal or flag remaining mines, mark wrong flags | `showBombs()` |
| `0x1002fe0` | One-second timer | `onTimer()` |
| `0x100140c` | Smiley button tracking | `leftDown()` / `up()` |
| `0x10038ed` | Sound: 1 → WAVE 432, 2 → 433, 3 → 434 (`push 0x1b0/0x1b1/0x1b2`) | `sound()` |
| `0x1002a22` / `0x1002971` | Frame bevels drawn with `MoveToEx`/`LineTo` | `drawBorders()` / `bevel()` |
| `0x1002785` / `0x1002825` / `0x10028d9` | Mine counter / timer / face | `drawCounter()` etc. |
| `0x10015a6` | Custom Field: height 9–24, width 9–30, mines 10–min(999, (h−1)(w−1)) | `customDialog()` |
| `0x100181f` / `0x10016fa` | Name entry / best times | `nameDialog()` / `bestTimesDialog()` |
| `0x1002bc2` | Load preferences with defaults and clamps | `loadPrefs()` |

Mouse buttons are dispatched through a jump table at `0x10021c2` (index bytes at `0x10021de`)
that Hopper did not decompile. It was disassembled with `llvm-objdump`:

- **Left down** (`0x1001fa6`): smiley first; otherwise capture and enter chord mode when
  `MK_RBUTTON` or `MK_SHIFT` is set.
- **Right down** (`0x100200f`): while the left button is captured, switch to chord mode;
  otherwise toggle the mark under the cursor.
- **Middle down** (`0x1001f7c`): chord.
- **Any up** (`0x1001fdf`): release capture and act on the square under the cursor.

## Behaviour kept on purpose

- Mines are placed with the MSVCRT `rand()` LCG seeded from the clock, like the original.
- A first click on a mine moves it to the first free square scanning from the top-left; the
  scan stops one short of the last row and column, as in the binary.
- The timer starts at 1 on the first click and never exceeds 999. It pauses while the window
  is minimised (or the browser tab is hidden).
- Cancelling Custom Field still switches to Custom and restarts the game.
- The mine counter can go negative.
- Placing a flag re-checks the win condition.
- XYZZY: type `xyzzy`, then hold Ctrl (or press Shift to latch it) and the top-left pixel of
  the screen turns white over a safe square and black over a mine.
- The timer box is positioned `SM_CXBORDER + 1` pixels left of the counter's mirror image.

## Additions for the browser

- Touch input: tap to uncover, long-press to mark, tap a number to chord.
- Settings and best times use `localStorage` instead of the registry.
- The whole window scales by an integer factor (up to 2×) to fit the screen.
- Help content is recovered from `WINMINE.CHM`; the shared `nthelp.chm` topics were not in the archive.
