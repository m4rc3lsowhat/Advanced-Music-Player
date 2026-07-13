# Launching AMP

Quick ways to start the app.

| You're on | Do this |
|-----------|---------|
| **Windows** | Double-click **`bin/amp.cmd`** |
| **macOS** | Run **`bin/amp.sh`** (`chmod +x bin/amp.sh` once) |
| **Linux** | From the project root: `corepack pnpm dev` |
| **Any development terminal** | From the project root: `corepack pnpm dev` |

The Windows and macOS launchers build the packaged app when it is missing. The development command
starts Vite and Electron directly.

## Other helpers

- **`bin/rebuild.cmd`** (Windows) — force a fresh build, then launch. Use it after pulling new
  code or if something looks stale.
- **`pnpm dist`** (from the root) — build a proper Windows installer (`.exe`) under
  `apps/desktop/dist/`, if you'd rather install it like a normal app.

## Tip: pin it

On Windows you can right-click `bin/amp.cmd` → **Send to → Desktop (create shortcut)**, then
rename the shortcut to "AMP".
