# Install and run

## Install

A self-contained `awui` binary runs the whole thing with no Node on the machine — the server, the web bundle, and the harness extensions are all embedded. Take one from the [releases page](https://github.com/drishal/awui/releases), or build it from a checkout:

`./setup.sh` in a checkout does all of the below for you: it asks, builds (inside `devenv shell` when there is one), links `~/.local/bin/awui`, and enables the user service, with the desktop app only if you say so (`./setup.sh --desktop` adds or repairs it later). If `awui` is already on your PATH it stops and points you at `./setup.sh --update`, which pulls, rebuilds (with the desktop app when the install has it), puts the link back in place (a copied binary is moved aside to `awui.bak`), and restarts the service, asking first when chats are live, since a restart stops them. By hand:

```bash
git clone https://github.com/drishal/awui.git
cd awui
npm ci
npm run build:binary               # → dist/bin/<platform>/awui (inside devenv shell; no desktop app)
npm run build:desktop              # the same binary, carrying the desktop app too (~257 MB vs ~95 MB)
npm run build:desktop --electron   # the same, and package the desktop app from apps/desktop first
# a build links ~/.local/bin/awui when that folder exists; otherwise copy it:
cp dist/bin/linux-x64/awui ~/.local/bin/awui   # macOS: dist/bin/darwin-arm64/awui; Windows: dist/bin/windows-x64/awui.exe
awui                 # web UI + API on http://127.0.0.1:4783
awui tui             # the terminal client (also `awui install tui` for an `atui` command)
awui doctor          # check the setup (config, harnesses, state folder, port); --json for machines
awui tern            # in a Tern pane: awui drawn natively by Tern
```

The binary carries both terminal clients: `awui tui` is atui and `awui tern` is the Tern client, bundled at build time, so a binary needs no Bun and no fetched copy, and its clients always match its server. `awui install tui` puts an `atui` command on your PATH — a symlink to the binary, which acts as atui when run under that name.

`bun run scripts/build-binary.ts --all` cross-compiles every target. State goes to `$XDG_STATE_HOME/awui`, so a binary and source run share one config and one set of sessions. Build with `--no-link`, or set `AWUI_NO_LINK=1` / `CI`, to leave PATH links alone. `awui install desktop` links an already built desktop app; `awui desktop --install-icon` adds the XDG menu entry. The bundled terminal uses Bun's native PTY and doesn't load a module alongside the app. The optional agent-page screenshot preview needs an installed Chromium browser and its small `node_modules/playwright-core` runtime beside `awui` (included in `dist/bin/<platform>`), so keep that directory intact rather than copying only the executable. BiDi is not loaded for this preview transport and is not required by it.

`awui install service` puts the binary at `~/.local/bin/awui` and writes a systemd user unit, `~/.config/systemd/user/awui.service`, that runs it and starts with your session; a leftover `agent-web-ui.service` from before the rename is retired first, so the two never share the port. It also puts `atui` beside the binary. Add `--link` to symlink the binary instead of copying it — what a dev checkout wants, so a rebuild is live after `systemctl --user restart awui`. Running `bin/awui install service --link` from a checkout installs the binary the build wrote, not the node running the script.

## From source

Requirements: Node ≥ 22.19 (24 LTS recommended), npm, and `pi`, `omp`, `hermes`, `claude`, `codex`, `opencode`, `grok`, and/or `dsh` installed and logged in. A missing harness shows as unavailable instead of crashing the app. The build is the [install](install.md#install) flow above; `npm link` also puts `awui` (the server) and `atui` (the terminal client) on your PATH. From a checkout the terminal clients run from source under Bun (`atui`, or `awui tui`/`awui tern`); the compiled binary carries them instead.

### Windows

awui also runs natively on Windows (x64). The harnesses it drives — pi, omp's native `omp.exe`, Claude Code — run there too, and awui spawns them through the win32-aware launcher: npm-installed CLIs ship a `<name>.cmd` batch shim that Node cannot exec directly, so those are run through `cmd`, while a native `.exe` (omp) is spawned as-is. Differences from a POSIX host:

- Settings default to `%APPDATA%\awui` and state to `%LOCALAPPDATA%\awui` (an explicit `XDG_CONFIG_HOME`/`XDG_STATE_HOME` still wins).
- A stopping harness is killed with `taskkill /PID <pid> /T /F`, since Windows has no SIGTERM/SIGKILL, so a CLI shim's real `node.exe` tree dies too.
- `awui install service` installs awui and starts it with your session: on Linux/macOS it copies the binary to `~/.local/bin/awui` and writes a systemd user unit; on Windows it copies `awui.exe` to `%LOCALAPPDATA%\Programs\awui`, adds that dir to your PATH, and sets the per-user `HKCU\…\CurrentVersion\Run` value so it starts at logon (the mechanism Electron and node-auto-launch use). Re-run it after an update to refresh. `awui install tui` is Linux/macOS-only; on Windows run the terminal client as `awui tui` (an `atui` file symlink needs Developer Mode or admin).
- herdr and the web "Run" code-block shells are POSIX; on win32 the Run block's `sh`/`bash` fence maps to cmd/PowerShell.

The releases page has a Windows `.exe`; the build also cross-compiles, so you can produce one from Linux or macOS. Inside `devenv shell` (for the toolchain):

```bash
npm ci
bun run scripts/build-binary.ts --all         # cross-compile every target (no single-target flag)
# → dist/bin/windows-x64/awui.exe   (the linux/darwin binaries land beside it in dist/bin/)
```

Copy `dist/bin/windows-x64/awui.exe` onto the Windows machine and run `awui.exe` — the web UI and API come up on `http://127.0.0.1:4783`. The harnesses (`pi`, `omp`, `claude`) must be installed and signed in there first.

Open http://127.0.0.1:4783/ on this machine. No token and no sign-in: local use is open.

Settings live in `~/.config/awui/`: `config.yml` (start from [`config.example.yml`](../config.example.yml)) and, optionally, a base16 `theme.yml`. To use it from other devices (LAN and/or Tailscale Serve), set:

```yaml
host: 0.0.0.0          # prints LAN: http://<ip>:4783/ for each address
auth:
  username: you
  password: your-password
```

then restart. Other devices get a sign-in form; this machine still opens directly. If you would rather not keep the password in a file, leave it out and run `npm run set-password` instead (it stores only a scrypt hash).

| Script | What it does |
|---|---|
| `npm run dev` | Backend under `tsx watch` plus Vite on :5173, proxying `/api`. Prints a `Dev UI: http://127.0.0.1:5173/` link. |
| `npm run set-password` | Alternative to `auth.password`: sets the login for other devices, storing a salted scrypt hash only. Changing it signs every device out. |
| `npm run typecheck` | Strict TypeScript for server, web, tests, and atui (four projects) |
| `npm test` | Vitest integration plus scripts; `tests/smoke` opts itself out unless `SMOKE=1`. No model tokens by default. |
| `npm run test:e2e` | Builds, then runs Playwright (Chromium) against the fake harnesses (roughly 12 min, depends on host load) |
| `npm run test:e2e:fast` | The same suite in two shards with distinct ports and state folders (roughly 6 min under similar load) |
| `npm run smoke` | Opt-in checks against the real installed Pi, omp, Hermes, Claude Code, Grok Build, and DeepSeek Harness (see [Testing](testing.md)) |
| `npm run build` / `npm start` | Production build, then a single process serving UI and API |
| `npm run build:binary` / `npm run build:desktop` | Compile into `dist/bin/<platform>`. `build:desktop` carries the packaged AppImage. It refreshes a stale or missing shell from source automatically, reuses a source-matched AppImage otherwise, and pins the build toolchain if needed. `--electron` forces repackaging before append. Run inside devenv shell. |
| `npm run desktop` | The optional desktop app from a checkout (`apps/desktop`; `npm ci` there once first) |

## Desktop app (optional)

[`apps/desktop`](../apps/desktop/README.md) is an Electron shell over the same
server — a window, a tray, a menu, `awui://` links, and the title count in the
taskbar. It is a client like the browser: it loads the page the server serves, so
there is no second UI and no change to the security model. On launch it attaches
to an awui already running (a systemd unit, say) and only starts one — from the
binary shipped beside it, or `awui` on the PATH — when no port answers. Quitting
stops the server it started and never one it attached to.

```bash
cd apps/desktop
npm ci               # electron + electron-builder, this package's own toolchain
npm start            # build, then open the window
npm run dist:linux   # AppImage (dist:mac, dist:win); stage:bin embeds awui
```

Then, from anywhere:

```bash
awui install desktop   # link the built app as `awui-desktop` on the PATH
awui desktop           # start it — attaches to a running server, or starts one
```

`awui desktop --install-icon` puts it in the application menu: an entry at
`$XDG_DATA_HOME/applications/awui.desktop` (default `~/.local/share`) and the
icon under `icons/hicolor/512x512/apps`, running `awui desktop`. macOS and
Windows get theirs from the app bundle and the installer. To see this command and
which app it will choose, without launching anything, use `awui desktop --help`.

A running server writes its port into `$XDG_STATE_HOME/awui/server.json` (with
its pid), so a client that has the state folder but not the port can find it —
that is how the desktop app attaches to a server on a port `config.yml` chose
instead of starting a second one.

`awui desktop` looks for the app in `AWUI_DESKTOP_BIN`, then the copy this
binary carries, then the `awui-desktop` that `install desktop` linked, then any
`awui-desktop` on the PATH, then this checkout's `apps/desktop` (a development
run through Electron). A repeated launch
activates the existing window without reloading its chat. On Linux, the launcher
waits for the first native owner to register, then wakes that process; repeat
invocations do not create a second Electron app. The first launch waits until
that owner registration completes; subsequent launches return immediately.
Close and relaunch the desktop app itself after updating its shell: restarting
only the server cannot replace an already-running Electron process.

A binary can carry the app itself:

```bash
npm run build:desktop   # ~257 MB instead of ~95 MB
awui desktop            # "bundled with this awui"
```

`build:desktop` fingerprints desktop sources, scripts, and packaging config so a
changed shell or dependency layout repackages rather than leaving stale code. The
internal server and its sibling provider stay included together in the AppImage.

```bash
npm run build:desktop           # host binary + matching desktop app, linked as awui when ~/.local/bin exists
systemctl --user restart awui   # apply the newly built service binary; do this for your own running service
awui desktop                     # extract/run the app carried by this binary
```

If you change `apps/desktop/src`, use `npm run build:desktop --electron` instead —
it forces the desktop shell package to update too.

The payload is appended to the executable (the trick an AppImage plays with its
own filesystem) and extracted into the state folder on first use, so one binary
is the whole install. `--all` cannot carry it: each platform needs its own
Electron build.

Nothing here is needed for the server, atui or Tern, and `npm ci` at the root
does not install Electron.

## Developer environment

`devenv` gives the pinned toolchain (Node 22, the nixpkgs `bun` the binary build needs, the e2e browsers): `devenv shell` enters it, `devenv tasks run awui:binary` builds the binary, `devenv up` runs `npm run dev` as a process. The nixpkgs-built bun inside the shell is what makes the compiled binary run on this machine (the upstream bun binary segfaults here); build binaries only inside the shell. Without `devenv`, install Bun (≥ 1.3.14) yourself from [bun.sh](https://bun.sh/docs/installation) — macOS/Linux/WSL: `curl -fsSL https://bun.sh/install | bash`; Windows: `powershell -c "irm bun.sh/install.ps1 | iex"` (or `npm i -g bun`). From a checkout the terminal clients need Bun too (the doctor check flags a missing one; the binary carries them instead).

## Autostart (systemd user service)

[`contrib/systemd/awui.service`](../contrib/systemd/awui.service) runs the checkout's build as a systemd user service. Build first, then install it:

```bash
npm ci && npm run build
npm run service -- install      # writes ~/.config/systemd/user/awui.service, enables and starts it
npm run service -- print        # show the unit without installing
npm run service -- uninstall    # stop, disable, remove
```

The installed unit holds this checkout's path, the `node` that ran the install, and your shell's `PATH`, so `pi`, `omp`, `hermes`, `claude`, and the agents' own tools are found as in a terminal; after moving either, install again. It sets no app settings, so port, host, and the login come from `~/.config/awui/config.yml`. It is skipped (not restart-looped) until `dist/` is built, a stray kill brings it back (`Restart=always`), and bad settings (such as `HOST=0.0.0.0` without a login) stop it with exit code 78 and the reason in the journal instead of restarting it every 5 seconds. Under systemd the Settings dialog can restart the server. To keep it running while you are logged out: `loginctl enable-linger "$USER"`.

```bash
systemctl --user status awui
journalctl --user -u awui -n 20     # shows the Local:/LAN:/Serve: addresses
git pull && npm ci && npm run build && systemctl --user restart awui   # update
```

**home-manager:** [`contrib/home-manager/awui-service.nix`](../contrib/home-manager/awui-service.nix) declares the same unit (absolute `${pkgs.nodejs}`, no secrets); add it next to the theme module and rebuild. `npm run service` leaves a unit that home-manager manages alone.

**Coming from agent-web-ui** (the old name): the state folder moves itself to `$XDG_STATE_HOME/awui` and the settings folder to `~/.config/awui/` on the first start, so the sign-in, devices, pins, checkpoints, config.yml, and theme.yml carry over. `npm run service -- install` replaces the old `agent-web-ui` unit it installed with `awui`. A home-manager setup renames `systemd.user.services.agent-web-ui` to `awui` itself (stop the old unit first, or both will want the port).

`npm start` keeps working either way.
