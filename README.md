# Minesweeper XP

Windows XP Minesweeper in the browser, rebuilt from the original `WINMINE.EXE`.

**Play:** https://minesweeper.ozairkhan.com

The sprites, sounds, strings, menus and dialogs come straight from the executable's resources.
The game logic is a line-by-line port of the decompiled procedures: mine placement, the flood
fill, first-click mine relocation, chording, the mark cycle, the timer, best times, Custom Field
limits and the XYZZY cheat. [docs/REVERSE_ENGINEERING.md](docs/REVERSE_ENGINEERING.md) maps each
behaviour to its address in the binary.

## Controls

| Action | Mouse | Touch |
| --- | --- | --- |
| Uncover | Left click | Tap |
| Flag / ? / clear | Right click | Press and hold |
| Chord | Both buttons, middle button or Shift+click | Tap a number |
| New game | Smiley or F2 | Tap the smiley |

## Layout

```
index.html                 page and XP window chrome
css/xp.css                 Luna styling
js/winmine.js              game engine and renderer (port of WINMINE.EXE)
js/shell.js                menus, dialogs, input, settings
assets/                    resources extracted from WINMINE.EXE
tools/extract_resources.py regenerates assets/ from your own WINMINE.EXE
tests/                     engine tests (node --test tests/*.test.mjs)
```

## Development

No build step. Serve the folder and open it:

```sh
python3 -m http.server 8000
node --test tests/*.test.mjs
```

To regenerate the assets, put your own copy of `WINMINE.EXE` in `original/` (git-ignored) and run:

```sh
python3 -I tools/extract_resources.py original/WINMINE.EXE assets/
```

## Notice

Minesweeper and its artwork and sounds belong to Microsoft. This is a non-commercial fan
preservation project and is not affiliated with or endorsed by Microsoft. The original
binaries are not included in this repository. The port's code is released under the MIT
licence (see [LICENSE](LICENSE)); that licence does not cover the extracted assets.
