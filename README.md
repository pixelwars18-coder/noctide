# Noctide

A small multi-language IDE that takes its colours from your **Noctalia** palette
(`~/.config/noctalia/colors.json` or the newest file in `~/.config/noctalia/palettes/`).
It re-themes itself within a few seconds when the palette changes.

```
noctide ~/code/myproject     # or pick Noctide from the app menu
noctide                      # reopens the last folder
```

Settings (Ctrl+,) are saved to `~/.config/noctide/settings.json`.

## Error checking

For each file Noctide uses the best tool it can find:

1. **Language server (LSP)**: clangd, pyright, gopls, rust-analyzer, qmlls…
2. **Compiler, check-only**: `gcc/g++ -fsyntax-only`, `rustc --emit=metadata`, `go vet`, `javac`,
   Python's `compile()`, `bash -n`/`shellcheck`, `qmllint`.

JavaScript/TypeScript are checked by the editor's built-in TypeScript service.
Settings → Compilers lists which tools are installed and lets you set each language's compiler,
standard, flags, program arguments, language server and formatter.

### Libraries via pkg-config (gtkmm, GTK, SDL…)

Settings → Compilers → C++ → **pkg-config packages**: add e.g. `gtkmm-4.0`. Noctide then passes
`pkg-config --cflags` to the checker and to clangd (so `#include <gtkmm.h>` resolves), and
`--cflags --libs` when building to run. If your project has a `compile_commands.json`
(from CMake or Meson), clangd uses that instead.

## Keys
| | |
|---|---|
| Ctrl+Shift+P / F1 | Command palette |
| Ctrl+P | Go to file |
| Ctrl+G | Go to line |
| Ctrl+S / Ctrl+Alt+S | Save / save all |
| Ctrl+Enter | Run |
| Shift+Alt+F | Format document |
| F7 | Check now · F8 next problem |
| Ctrl+Shift+F | Search in files |
| Ctrl+B / Ctrl+J | Toggle sidebar / bottom panel |
| Ctrl+, | Settings |
| Ctrl+= / Ctrl+- / Ctrl+0 | Editor zoom |
| Alt+N | New file · Ctrl+W close tab · Ctrl+Shift+T reopen |
| Alt+1…9 | Jump to tab |

## Notes
- Server binds to 127.0.0.1 only; every API call needs a per-launch token.
- Deleting from the explorer moves files to the Trash.
- Run captures output only; it isn't an interactive terminal. Put program input in the **Input** tab.
- The editor (Monaco) and fonts load from a CDN, so it needs an internet connection.
