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
- running in the background: closing the window hides it to the tray (Settings →
  Desktop app, `desktop_background` in config.yml, on by default) and the app
  keeps going. Quit from the tray or with `Ctrl+Q`; with the setting off, closing
  the window quits. On a desktop with no tray, launching the app again brings
  the hidden window back;
- native notifications while the window is hidden or out of focus — a finished
  run, an error, an approval — read from the server's `/api/notifications`;
  clicking one opens that chat or room;
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
to — a systemd unit keeps running, as it would when a browser tab closes. Hiding
the window to the tray is not quitting: a server it started keeps running too.

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

A binary that carries the app extracts it into `$XDG_STATE_HOME/awui/app/<version>/`
once, then runs it from there; that binary is ~257 MB instead of ~100 MB.

A second `awui desktop` sends an activation signal to the existing app instead of
spawning another Electron process. Linux serializes cold starts until the native
PID owner is published, then reuses it; macOS and Windows use Electron's native
handoff. Repeat activation restores/focuses without reloading the current chat.
These changes do not affect an older Electron app already running, so quit and
relaunch it after rebuilding. The separate awui server and its runs outlive it.

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
npm test          # compile, then repeated real desktop-child spawn/activation checks
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

From the repo root, `npm run build:desktop --electron` runs all of it — the
server build, this package step (with `resources/awui` the binary it just
built), and the append of the resulting AppImage to the CLI's binary — so a
change under `apps/desktop/src` reaches `awui desktop` in one command. Plain
`npm run build:desktop` checks the shell-source/package fingerprint recorded with
an existing AppImage. It repackages when those changed, and otherwise reuses the
matching artifact. If necessary it installs the pinned toolchain automatically.
No first-time seed AppImage is required. `--electron` forces a fresh shell build
even when the recorded source still matches.

`stage:bin` is what makes the app self-contained; without it you get the *light*
build, which attaches to an awui that is already installed. The sibling
`resources/node_modules/playwright-core` is copied literally by `extraFiles`
into the packaged resource directory, not treated as Electron's own dependency.
Artifacts land in `release/`.

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
| `scripts/stage-binary.mjs` | Atomically stages the bare embedded server and its sibling `playwright-core` runtime. |
| `scripts/check-packaged.mjs` | Starts that resource-external packaged server from an unrelated working directory; catches missing external runtime paths before packaging. |
| `electron-builder.yml` | Targets, icons, the `awui://` scheme, the Linux `.desktop` entry. |
