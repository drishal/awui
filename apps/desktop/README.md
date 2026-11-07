# awui desktop

The optional desktop app for [awui](../../README.md): one window over the awui
server this machine already runs, or one it starts itself.

It is a **client**, not a second implementation. The window loads the page the
server serves — the same bundle a browser gets — with no preload and no Node in
the renderer, so awui's security model (loopback Host, loopback peer, no proxy
headers, strict CSP) is exactly what it is in a tab. What it adds is desktop
plumbing:

- a window that survives a reload, with external links opened in your browser;
- a tray (Open, New chat, Sessions, Quit);
- no menu bar over the window — the window is the app. The menu still exists for
  its accelerators (`Cmd/Ctrl+N`, `Cmd/Ctrl+Shift+O`, `Cmd/Ctrl+R`, zoom,
  fullscreen) and Alt reveals it on Linux and Windows; macOS keeps its usual
  system menu bar;
- `awui://` links: `awui://new`, `awui://sessions`, `awui://prompt?text=…`,
  mapped onto the query grammar the web app already reads;
- a title count (`(2) awui`) reflected in the tray tooltip, the taskbar flash and
  the macOS dock badge;
- the screen-capture source awui's screenshot button asks for.

## Attach or start

On launch it asks the ports from 4783 upward who they are (`/api/health`). An
awui that answers is **attached to**; a free port gets a **new server**, run from
the binary shipped beside the app (or the checkout's build, or `awui` on the
PATH). Attaching always wins over a free port, because two servers over one state
folder would both hold the same session files.

Quitting stops a server this app started and **never** touches one it attached
to — a systemd unit keeps running, as it would when a browser tab closes.

## Run it

From the CLI, once a build exists (see Package it below):

```bash
awui install desktop          # ~/.local/bin/awui-desktop → the built app
awui desktop                  # start it; attaches to a running server, or starts one
awui desktop --install-icon   # add it to the application menu (XDG desktops)
```

`--install-icon` writes `$XDG_DATA_HOME/applications/awui.desktop` and
`icons/hicolor/512x512/apps/awui.png` (default `~/.local/share`), with `Exec`
pointing at `awui desktop` — so the launcher entry keeps working wherever the
binary lives.

`awui desktop` tries `AWUI_DESKTOP_BIN`, then the copy the `awui` binary itself
carries (`npm run build:desktop` from the repo root), then
the installed link, any `awui-desktop` on the PATH, and finally this checkout's
`apps/desktop` through Electron — and starts the app detached, so the command
returns.

A binary that carries the app extracts it into `$XDG_STATE_HOME/awui/desktop/`
once, then runs it from there; that binary is ~257 MB instead of ~100 MB.

From the package itself:

```bash
cd apps/desktop
npm ci                           # electron + electron-builder (its own toolchain)
npm run build && npx electron .   # or: npm run start
```

If Electron's own binary is missing (`Electron failed to install correctly`, from
a policy that skips install scripts), run `node node_modules/electron/install.js`
once — it downloads the runtime for this platform.

`npm start` rebuilds first. `AWUI_DESKTOP_PORT=4790` picks a different base port;
`AWUI_BIN=/path/to/awui` forces the binary to start.

## Check it

```bash
npm run smoke     # needs a display, or Xvfb: DISPLAY=:99 npm run smoke
```

Playwright drives the real Electron binary and checks the whole contract: a
window that mounts the served app, a server started when none is running and
stopped on quit, and a running server left alone when the app only attached.
The decisions behind it are unit-tested with the rest of the repo
(`tests/unit/desktop.test.ts`, `src/shared/desktop.ts`).

## Package it

```bash
npm run stage:bin    # copy dist/bin/<platform>-<arch>/awui into resources/
npm run dist:linux   # AppImage   (dist:mac → dmg+zip, dist:win → nsis)
```

`stage:bin` is what makes the app self-contained; without it you get the *light*
build, which attaches to an awui that is already installed. Artifacts land in
`release/`.

The `.deb` leg is off by default: electron-builder's fpm does not run on NixOS.
`npx electron-builder --linux deb` builds one where fpm works.

Signing and notarization are not configured. macOS will need `xattr -cr` for an
unsigned build, and on NixOS the upstream Electron binary wants
`--no-sandbox` unless you package it with nixpkgs' `electron` (which is the
recommended Linux route — an AppImage is not).

## Files

| File | What it is |
|---|---|
| `src/main.ts` | The whole shell: attach-or-start, window, tray, menu, links, quit. |
| `../../src/shared/desktop.ts` | What it decides without a window (health, ports, URLs, title count) — pure, unit-tested. |
| `scripts/smoke.mjs` | The Playwright check above. |
| `scripts/stage-binary.mjs` | Copies the platform binary into `resources/` for packaging. |
| `electron-builder.yml` | Targets, icons, the `awui://` scheme, the Linux `.desktop` entry. |
