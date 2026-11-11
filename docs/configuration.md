# Configuration

**`config.yml`** (YAML, so it can carry comments; every key optional). It is read at startup; `theme`, `text_scale`, `chat_width`, `density`, `tool_style`, `font`, `autocollapse_sidebar`, `show_status_bar`, and `herdr` are re-read on every page load. An unknown key or a wrong type stops the server with the key named (exit 78, which the autostart unit does not retry), rather than being guessed at.

The **Settings** dialog (gear left of the collapse button) edits the same file: the shared look (theme, chat text size, chat width, density), pairing and sign-out, and every key below but `harnesses`. The server checks a save exactly as startup checks the file, so it can never leave a server that will not start; port, host, login, roots, and allowed hosts/users wait for a restart (with a Restart button when systemd supervises). Any signed-in device may change them, except a change that would shut that device out once it applies (a LAN phone switching `host` to `127.0.0.1`, a Tailscale Serve device dropping its own host name or login from the allow lists): that one is refused and has to be made on the machine running the server. A setting an environment variable overrides is shown as such and cannot be changed from the file.

| Key | Default | Meaning |
|---|---|---|
| `port` | `4783` | 1024–65535. |
| `host` | `127.0.0.1` | `127.0.0.1` (this machine only, no sign-in) or `0.0.0.0` (LAN; other devices sign in). Nothing else is accepted. |
| `auth.username`, `auth.password` | — | Login for other devices. `host: 0.0.0.0` and `allowed_hosts` need a login (this or `set-password`), otherwise the server refuses to start. A `config.yml` holding a password is kept at mode 0600, and the password never enters the server's environment, so the agents' shells never see it. |
| `workspace_roots` | home dir | Projects must be inside a root, checked by realpath, so symlink and `..` escapes are refused. |
| `allowed_hosts` | — | Extra `Host` values (e.g. your `*.ts.net` Serve name). |
| `allowed_tailscale_users` | — | Optional Tailscale logins; when set, Serve requests must also carry one of them. |
| `theme` | — | Shared look on every device: `system`, `light`, `dark`, or `base16` (`theme.yml`; `custom` is accepted as the old name). Unset: `theme.yml` when there is one, else `system`. |
| `text_scale` | `1` | Shared chat text size (a scale on the 14.5px base, 0.5–2). |
| `chat_width` | `comfortable` | How wide the conversation and composer run: `comfortable` (960 px), `wide` (1400 px), or `full` (the whole pane). Review drawers keep their own width. |
| `density` | `comfortable` | How tight the web UI sits: `comfortable` (the default look) or `compact` (tighter sidebar rows, turn gaps, tool rows, composer, and tab strip). Phones keep their comfortable touch sizes. |
| `tool_style` | `cards` | How a turn's work is drawn: `cards` (a run's calls grouped as one card, with an icon stack and a mark per call) or `lines` (the flat list older versions drew: no card surface, the header names what the run ran — "Worked for 11s · 4 commands" — and each call's facts follow its words). The folds, the collapse after a turn, and the motion are the same either way. |
| `font` | `bundled` | The web UI's type: `bundled` (Inter for text and JetBrains Mono for code, shipped with awui so every device reads the same) or `system` (each device's own sans and monospace fonts). A `theme.yml` `fonts:` entry goes first either way. |
| `autocollapse_sidebar` | `true` | Fold the sidebar away below 1200 px wide (phones use the drawer anyway); a sidebar collapsed with its button stays collapsed at any width. |
| `show_status_bar` | `true` | Show the bar under the conversation (connection, harness, model, folder, version); `false` hides it, as phones do already. |
| `desktop_background` | `true` | The [desktop app](install.md): closing its window hides it to the tray and it keeps running, showing native notifications for finished runs, errors, and approvals (clicking one opens that chat or room); quit from the tray or with Ctrl+Q. `false` makes closing the window quit the app (and stop a server it started). Read each time the window closes, so a change needs no restart. |
| `herdr` | `true` | Work with [herdr](#with-herdr): mark the sessions open in its panes (and show one there rather than start a second harness on it), and let atui in a herdr pane report its chats. Nothing happens where herdr does not run. |
| `herdr_socket` | herdr's default session's | herdr's API socket (`~/` is expanded), for a named herdr session: `~/.config/herdr/sessions/<name>/herdr.sock`. File-only, read at startup. |
| `harnesses.<pi\|omp\|claude\|codex\|hermes\|opencode\|grok\|dsh>.command` | the name on `PATH` | The harness's executable (`~/` is expanded), e.g. a dev build. The Awui harness runs Pi's. |
| `harnesses.<pi\|omp\|claude\|codex\|grok\|dsh>.args` | — | Arguments added to each chat's command line, before the ones awui must set last (`--session-dir`, `--cwd`, `--resume`): `[--add-dir, /srv/docs]` for Claude Code, or `[--allow-dangerously-skip-permissions]` to offer its Bypass mode in the permission picker. For Grok they go before the mode name `stdio`; for Codex they land after `app-server`; for DeepSeek Harness they land after `--profile acp`. Model probes and listings do not get them, and the Awui harness never does (they could loosen its read-only lock). Hermes and OpenCode take no `args`: Hermes's chats run its gateway from its Python package, and OpenCode's share one server. This block is file-only, read at startup: the Settings dialog does not show it, because a command is a program the server runs and any signed-in device can save settings. |

**`theme.yml`**: a base16/base24 scheme (see [Theme](theme.md)); the dotfiles' stylix module writes it.

**Environment variables** win over `config.yml`, for services and tests:

| Variable | Meaning |
|---|---|
| `PORT`, `HOST`, `AUTH_USERNAME`, `AUTH_PASSWORD` | As the keys above. |
| `WORKSPACE_ROOTS`, `ALLOWED_HOSTS`, `ALLOWED_TAILSCALE_USERS` | As the lists above (`:`-separated roots, comma-separated hosts and users). |
| `AWUI_CONFIG_DIR` | Another settings folder; empty ignores `config.yml` (the tests do this). |
| `AWUI_HARNESSES` | Comma list of harness adapters to enable; default `pi,omp,hermes,claude,codex,opencode,grok,dsh,awui` (the tests use `fake`). |
| `PI_BIN`, `OMP_BIN`, `HERMES_BIN`, `CLAUDE_BIN`, `CODEX_BIN`, `OPENCODE_BIN`, `GROK_BIN`, `DSH_BIN` | A harness's executable, over `harnesses.<id>.command`; default its name on `PATH`. |
| `AWUI_HERDR` | `1` or `0`: over `herdr`. |
| `AWUI_DSH_FLOW` | `0` keeps DeepSeek Harness chats on its stock ACP bridge, so text arrives a model step at a time instead of live (see [DeepSeek Harness](architecture.md#deepseek-harness)). |
| `HERDR_SOCKET_PATH` | Set by herdr in its panes: a server started in one asks that herdr session (over `herdr_socket`). The server keeps herdr's pane variables from its harness children, so their own herdr hooks do not claim its pane. |
| `AWUI_WEB_DIR` | Serve the built UI from here instead of `dist/web`. |
| `AWUI_HEARTBEAT_MS` | Keep-alive interval for open event streams; default `20000`. |
| `THEME_FILE` | Another theme file. |
| `AUTH_CREDENTIALS_FILE` | Login written by `npm run set-password` (default `$XDG_STATE_HOME/awui/credentials.json`); used when no password is configured. |
| `OMP_AGENT_DIR`, `OMP_SESSION_DIR` | Overrides for omp only (see [Config dirs](#config-dirs)). |
| `XDG_STATE_HOME` | The cookie-signing secret lives in `awui/cookie-secret` (mode 0600). |

## Config dirs

| | Pi | omp | Hermes | Claude Code | Codex | Grok Build |
|---|---|---|---|---|---|---|
| Agent dir | `PI_CODING_AGENT_DIR` or `~/.pi/agent` (via `getAgentDir()`) | `~/.omp/agent` (or `OMP_AGENT_DIR`) | `HERMES_HOME` or `~/.hermes` | `CLAUDE_CONFIG_DIR` or `~/.claude` | `CODEX_HOME` or `~/.codex` | `GROK_HOME` or `~/.grok` |
| Sessions | `PI_CODING_AGENT_SESSION_DIR` > `sessionDir` setting > `<agentDir>/sessions` | `~/.omp/agent/sessions` (or `OMP_SESSION_DIR`) | `~/.hermes/sessions` (jsonl; the `state.db` row is the source of truth) | `<config>/projects/<cwd as dashes>/` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `~/.grok/sessions/<encoded cwd>/<id>/` |

omp is a Pi fork and reads the **same variable names** (`PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`). Any `PI_*` value in this server's environment belongs to Pi and is stripped from omp children. `OMP_AGENT_DIR` and `OMP_SESSION_DIR` are mapped onto omp's names for the child only. Overrides are reported as set/unset only. The app writes inside `~/.pi` or `~/.omp` only to add a new session file for a fork or handoff, inside `~/.claude` only for a fork's new file, never inside `~/.hermes`, `~/.codex`, or `~/.grok`, and the browser never sees agent dirs or session file paths.

## Routines

A routine (the palette's *Routines…*) is stored in `routines.json` in the state folder, not in `config.yml`: a prompt, a project, a harness, a cadence, an optional precheck, the next run, and how the last slot ended.

The precheck is one command line (at most 500 characters) run through the host's shell in the routine's project folder, before a due run and instead of it when it fails. It gets the environment a harness spawned in that project gets, so an allowed `.envrc` applies ([Project environment](usage.md)), and its arguments are the user's own line: awui hands the line to the shell as one argument and adds nothing to it. Exit 0 lets the run start. A non-zero exit skips that slot — no chat opens, no harness starts — recording the exit code and the first line of its output (the output awui keeps is bounded to 4 KB, and the list shows one line). A precheck still running after 30 s is cut short and skips the slot, as does a shell that cannot start, each with its reason. Either way the slot is used up as a normal run's would be, so the next attempt waits for the cadence.

awui records `lastRunOutcome` (`launched`, `skipped`, or `failed`) and a bounded `lastRunDetail` beside the routine, and the dialog's list shows both; a file written before these fields existed still loads, with no outcome. Editing a routine keeps them.

## With herdr

[herdr](https://herdr.dev) is a terminal workspace manager for coding agents: workspaces, tabs, and panes, with each pane's agent and whether it is working, blocked on you, or done (herdr's own hooks for Pi, omp, Claude Code, and Hermes tell it, and `herdr integration install <harness>` sets them up). awui works with it both ways, through herdr's JSON socket, and does nothing where herdr does not run. `herdr: false` in `config.yml`, or the Settings dialog's checkbox, turns it off.

- **One writer per session.** A session that herdr says one of its panes runs is marked so in the session list, and the server refuses to resume it (409 `open_in_herdr`) unless the client says that was chosen: its harness already has the session file open there, so a resume here would be a second writer on it. omp is asked the same thing itself: a session that `omp session lease` says another omp holds (one in a terminal) is refused too (409 `session_held`) until that omp exits.
- **In the browser** such a session is marked *herdr* in the sidebar, in the accent while that agent works and in the warn colour while it waits for you. Opening it asks first: **Show in herdr** (herdr switches to that pane; this machine only), **Open here anyway**, or Cancel.
- **In atui and Tern** it is marked ◆ in atui's session list, and Tern's session picker says *in herdr*. The first open shows the pane in herdr; opening it again within ten seconds opens it here.
- **atui in a herdr pane** reports its chats to herdr the way herdr's own hooks report an agent: working while a chat in its tabs runs, blocked (with the question) while one asks, idle otherwise, the shown chat's title in herdr's sidebar, and, when `atui` is on `PATH`, `atui --resume <session>` as the command herdr runs to bring the pane back after it restarts. So herdr's status dots, *Done* badges, and notifications, and clients such as [herdr-gpui](https://github.com/penso/herdr-gpui), follow awui's chats too. `atui --no-herdr` keeps one atui quiet.
