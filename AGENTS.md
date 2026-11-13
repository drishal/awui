# AGENTS.md

Guidance for coding agents (Pi, omp, Hermes, Claude Code, Codex, OpenCode, …)
working in this repository. The README is the landing page and `docs/` is the
user-facing manual; this file is how to change the code without breaking what they promise. When the two
disagree, the code is the truth: fix whichever is stale.

## What this is

**awui** (agent web UI) is a local, private web UI for the **Pi**, **omp**
(oh-my-pi), **Hermes** (hermes-agent), **Claude Code**, **Codex**, **OpenCode**, **Grok Build**, and
**DeepSeek Harness** (dsh) coding-agent harnesses. **atui** is its terminal client, and **awui tern** draws it natively in a
Tern pane. All are thin clients of one Node server:

```
browser (src/web, React)  ─┐
                            ├─ HTTP + SSE ─▶ server (src/server, Express 5) ─▶ HarnessAdapter ─▶ pi / omp / hermes / claude / opencode / grok / dsh
atui    (src/atui, Solid) ─┤                 127.0.0.1:4783 by default             (one child process per live chat)
tern    (src/tern, TSP)   ─┘
```

The harness is always the agent and the source of truth: its own models, auth,
settings, tools, trust decisions, and session files. awui only drives it,
renders it, and adds a few things on the side (checkpoints, pins, review
comments, notifications), each kept in awui's own state folder.

## Start here

Match the task to a guide before opening code:

| The task | Read first | Then |
|---|---|---|
| "Add support for <agent>"; one harness fails to start, resume, stream, or answer approvals | [docs/harnesses.md](docs/harnesses.md) | `src/server/harness/<id>.ts` and its stand-in `tests/fixtures/fake-<id>.mjs` |
| A part of the web UI is broken or "looks off"; restyle or move one | [docs/ui.md](docs/ui.md) | Its region table: the component and `src/web/styles/<area>.css` |
| Messages wrong or out of order in every harness | [docs/ui.md](docs/ui.md), section 1 | `src/server/chats/chat.ts` (the reducer), `src/web/turns.ts` |
| A new route, setting, or tool rendering; an atui feature | [Making common changes](#making-common-changes) | The files it lists |

## Commands

| Command | What it does |
|---|---|
| `npm ci` | Install. Never `npm -g`, never `npx playwright install` (see Environment). |
| `npm run dev` | Backend under `tsx watch` plus Vite on http://127.0.0.1:5173 (proxies `/api` to the backend's port). |
| `npm run build` | `vite build` → `dist/web`, then `tsc -p tsconfig.server.json` → `dist/server`. The server entry is `dist/server/server/index.js`. |
| `npm run build:binary` / `npm run build:desktop` | The compiled binary in `dist/bin/<platform>`; `build:desktop` appends this platform's packaged desktop app, creating the AppImage when missing (installing its locked toolchain if necessary). It uses a matching-sidecar binary rather than nesting the previous app. `--electron` explicitly refreshes both, for `apps/desktop/src` changes. Run inside `devenv shell`. |
| `npm start` / `bin/awui` | Run the built server. |
| `bin/atui` (`npm run atui`) | Run the terminal client under Bun (from a checkout; the binary runs it as `awui tui`). Needs a running server. |
| `npm run typecheck` | Four projects: server, web, tests, atui. **Run it before every commit.** |
| `npm test` | Vitest: `tests/unit/**` (and `tests/smoke/**`, which skips itself unless `SMOKE=1`). |
| `npm run test:e2e` | Build, then Playwright (`tests/e2e`) against the built server with fake harnesses on port 4791. ~12 min. |
| `npm run test:e2e:fast` | The same suite as two shards at once (`scripts/e2e-parallel.mjs`): one server per shard, on ports 4801 and 4811, output in `test-results/shard-N`. ~6 min. A spec that starts its own server (remote-login) takes the suite's port plus one and two. |
| `npm run test:atui` | Build, then `bun test tests/atui` (atui in OpenTUI's test renderer, and the Tern client against a stand-in Tern, both against a real server). |
| `npm run desktop` | The optional desktop app from a checkout (`apps/desktop`, after `npm ci` there). It attaches to a running server or starts one; `npm run smoke` in that folder drives it under Playwright (needs a display or Xvfb). |
| `awui doctor [--json]` | Checks config.yml, Node/Bun, each harness, workspace roots, the state folder's mode, the port, remote sign-in, herdr; prints ✓/!/✗ lines, exit 1 on a ✗ (`src/server/doctor.ts`). |
| `awui setup mcp [--json] [--apply [harness]] [--yes]` | How awui's own tools reach each harness's chats (`src/server/mcp-setup.ts`); read-only unless `--apply`, which runs the harness's own command (Hermes's `mcp add`) after asking. |
| `awui desktop` / `awui install desktop` | Start the optional Electron app (detached; it attaches to a running server) and link a built one as `awui-desktop` (`src/server/desktop-app.ts`). |
| `awui tern` | The Tern client in a Tern pane (from a checkout: `bun --conditions=browser src/tern/main.ts`; Solid's default Bun build is its server one, where effects never run; the binary runs it built in). |
| `npm run smoke` | Opt-in tests against the real installed harnesses. No model is called unless `SMOKE_MODEL` (and `SMOKE_CLAUDE_MODEL`, `SMOKE_GROK_MODEL`, `SMOKE_DSH_MODEL`) name one. |
| `node scripts/ui-shot.mjs <url> <selector> <out.png>` | Screenshot one element of a running UI and print every control's size, radius, padding, and font (`--phone`, `--narrow`, `--light`). See docs/ui.md. |
| `npm run set-password` | Store an scrypt login for other devices. |
| `npm run service -- install\|uninstall\|print` | The systemd user unit (`contrib/systemd/awui.service`). |

A change is done when `npm run typecheck`, `npm test`, and the relevant one of
`npm run test:e2e` (web changes) or `npm run test:atui` (atui or Tern client changes) pass.
Server changes that the browser sees need e2e too.

## Map of the code

```
src/shared/protocol.ts        Wire types and Zod request schemas: the only contract between server and clients.
src/shared/html-render.ts     Agent-rendered pages: bootstrap markup, theme payload, frame-height math (no harness types).
src/shared/awui-mcp.ts        awui's tool servers and tools as OpenCode names them (`awui-r-<id>`, `<server>_<tool>`); one scheme for server and clients.
src/shared/approval.ts        Which requests are plain approvals, and their Approve/Deny answers (the card and push notes).
src/shared/review.ts         Review pins (a line's hash, following it through later edits), the one prompt a batch of open
                              threads becomes, and the attribution rule (which lines a chat's own diffs wrote, and which
                              the file has since changed under).
src/shared/unified-diff.ts   Bounded unified-diff parsing shared by server and browser diffs.
src/shared/breakdown.ts      A changed file's pile (source, tests, generated) by glob, and the lines each pile holds: the
                              worktree/race card's chip, with the globs config.yml's `breakdown:` can replace.
src/server/
  index.ts                    Startup: config, state-folder migration, registry, routes, listen, shutdown. A running server
                              writes server.json (port, pid) into the state folder for clients that have no port. Subcommands: `desktop`, `tui`, `tern`, `doctor`, `setup mcp`, `mcp`, `install tui|desktop|service`.

  app.ts                      Every route (Express 5), SSE, error mapping. All /api routes but health/login/logout need auth. POST /api/render additionally requires AWUI_RENDER_TOKEN; trusted /terminal-shell.html is a web entry that reuses those origin/message checks for the PTY iframe.
  embedded.ts                 The binary's baked-in assets: embedded web bundle, extension sources, version; materializes extensions into state dir for `-e`.
  compress.ts, static-web.ts  Text assets as brotli/gzip, compressed once and kept (compress.ts also gzips large `/api` JSON per request, and a chat's event stream when the client passes `?z=1`); static-web.ts serves the web folder and the binary's embedded copy through it (hashed /assets files immutable, index.html and sw.js never cached).
  clients.ts                  The terminal clients behind the command line: `awui tui` (or the binary symlinked as `atui`) runs atui, `awui tern` the Tern client. In the binary they run in-process (the `awui:clients` module); from source under Bun.
  clients-module.d.ts         The `awui:clients` module's types: the binary's bundled terminal clients (scripts/build-binary.ts bundles src/atui/embed.ts as it).
  cli-run.ts                  The headless CLI: `awui run|send|wait|chats` drives a server that is already running (found by `$AWUI_URL`, else server.json in the state folder), through the same JSON API the browser uses; it starts no harness and writes nothing.
  install-tui.ts              `awui install tui`: the `~/.local/bin/atui` symlink (to the binary, which carries atui, or the checkout's bin/atui); retires the old fetched copy.
  mcp-setup.ts                `awui setup mcp`: which harness gets awui's own tools per chat, and the one harness
                              (Hermes) whose single entry only its own CLI can make. Reads a harness's own `mcp list`,
                              never edits its config; `--apply` runs that command after asking.
  mcp-bridge.ts               `awui mcp`: the orchestration bridge on stdio for a harness config that names a program,
                              the embedded `extensions/orchestrate-mcp.mjs` (inert without a chat's variables).
  platform-win.ts             Native Windows process/env rules (shared by harness adapters and PTY lifecycle).
  install-service.ts          `awui install service`: the binary + systemd unit (or Windows Run key), plus the `atui` link beside it.
  desktop-app.ts              `awui desktop` / `awui install desktop` / `awui desktop --install-icon`: finds the optional Electron
                              app (env, the copy the binary carries, ~/.local/bin link, PATH, a checkout's apps/desktop), starts it
                              detached, links it, or writes the XDG menu entry + icon.
  desktop-embed.ts            The app a binary can carry: `--with-desktop` appends [payload][len u64][magic] after the
                              executable image; this reads it back and extracts it into the state folder once.
  assets.gen.ts               Checked-in stub replaced by the generated embed map at binary-build time.
  config.ts, user-config.ts   Environment + ~/.config/awui/config.yml → ServerConfig. settings.ts edits config.yml for the Settings dialog.
  security.ts, auth.ts        Host/Origin/Tailscale checks, local vs remote, scrypt logins, signed cookies, lockout.

  chats/chat.ts               One live chat: the EventReducer folds HarnessEvents into ChatItems, the event log, SSE fan-out, commands.
  chats/manager.ts            Chat registry; one live writer per native session; idle reaping. An internal owner (Board rooms) marks a chat as driven, not the user's.
  boards/                     Board rooms, web-only: store.ts (strict atomic persistence, JSONL room records), manager.ts (CRUD + the ownership oracle ordinary surfaces filter by), events.ts (room SSE), scheduler.ts (one active turn per room, serial), turn-runner.ts (direct responders, one bounded consultation round), sessions.ts (bot session pool over ChatManager-owned chats), context.ts/consult.ts/budget.ts (pure envelope, control-document parser, caps).
  harness/types.ts            HarnessAdapter / LiveChat contract and the normalized HarnessEvent union.
  harness/registry.ts         One factory per harness; AWUI_HARNESSES selects them.
  harness/{pi,omp,hermes,claude,codex,opencode,grok,dsh}.ts   The eight adapters; codex-transcript.ts folds Codex's rollout files for a resumed chat and Usage across chats; hermes-gateway.ts is the attach to Hermes's own gateway (its control socket's public contract: rendezvous, `resolve-profile`/`identify` verdict, `session-ticket`) and hermes-canonical.ts the canonical session wire presented as the dialect the chat speaks; grok-transcript.ts folds Grok's ACP session updates (live and on disk), and dsh-transcript.ts decodes DeepSeek Harness's concatenated-zstd session log and folds its ACP updates. acp-client.ts is the one ACP transport (Grok, DSH, and config.yml's own agents share it), acp.ts the adapter config.yml's `harnesses.acp` entries become, and acp-updates.ts the generic ACP update fold. fake.ts is the deterministic test adapter.
  harness/opencode-server.ts  OpenCode's one shared `opencode serve`: started when needed, awui's password, events by session.
  harness/opencode-messages.ts  OpenCode's messages, models, forms, permissions as awui's (pure, against recorded shapes).
  harness/opencode-tools.ts   awui's render and orchestration MCP servers registered per chat on the shared server, and the session rules that scope them.
  harness/awui.ts              The Awui chat harness: a read-only `pi` child (subclass), own agent dir, write/exec tools denied; loads render_html + eval_python, not rewind. Web-only; its Settings can link the user's pi login into that dir (awui-settings.ts).
  awui-settings.ts             The Awui harness's provider settings: edit its isolated agent dir's models.json (keys never echoed; pi-shaped fields survive saves), plus the opt-in that links the user's pi auth.json in and seeds Pi's providers once.
  harness/agent-events.ts     Pi-family event and transcript normalization (Pi and omp share it); historyToItems.
  harness/session-files.ts    Pi/omp session JSONL: active branch by parentId, fork and seed writers.
  harness/claude-sessions.ts  Claude Code's session files.
  harness/jsonl.ts            Streaming JSONL reads (never a whole session as one string) and `foldJsonlFile`: a listing's metadata folded once, then resumed from the saved byte offset as the append-only file grows; `FoldStore` keeps that progress in the state folder (`fold-<name>.json`) so a restart only stats each file.
  harness/tool-diff.ts        Every harness's edit result → one DiffLine[] shape.
  harness/subagents.ts        Delegation calls (omp task, pi-subagents, Claude Task) → SubagentRun[].
  harness/render-extension.ts The render_html and orchestration extensions' files, the -e args that load them (Pi/omp), and the orchestration MCP server's file.
  harness/render-token.ts     render and orchestration tool names (MCP names from the catalogue); a render result's details.htmlRender → HtmlRenderRef, spoof-guarded.
  html-render.ts              Agent-rendered pages under the state folder, addressed by id, one owner chat each.
  harness/handoff.ts          Cross-harness handoff: portable seed transcript and the briefing prompt.
  harness/deferred.ts         Resume-without-waiting: show the file's transcript while the harness starts.
  checkpoints.ts             Per-prompt work-tree snapshots in a shadow git repo; turn undo.
  workspaces.ts              Realpath confinement for folder browse and every project lookup, refusing outside-root replacements.
  envelope.ts                 The hidden envelope: markers, escaping, and the visible remainder of a send that is one contract; Board consultations are the first user.
  worktrees.ts               Managed isolated Git checkouts under `<project>/.awui/worktrees`, with per-workspace lock root and atomic metadata; prune refuses a dirty tree, `checkout-pr` checks out an existing PR's head branch isolated, and `archiveMerged` archives a checkout only when its PR merged, the tree is clean, and identity matches.
  handover.ts                Sessions handed to a native CLI: an exact quoted resume line and lock, reclaimed once no native lease holds it; never a second writer.
  orchestration/scope.ts     The write-scope guard for a delegated task: glob-normalized assignment, a private scratch dir under `<project>/.awui/scratch`, and the verdict for a tool call or a harness permission request; pure, so the counts and rows read one wording.
  orchestration/residents.ts Per-caller native-session/purpose identities plus bounded redacted memory; resume through same ordinary chat never transcripts; grouped results wait for all members before one durable wake.
  races.ts                   A comparison recorded: each worktree member's fork point, live status, counts and one file's diff; picking a winner (keep, or apply into a clean checkout at the fork point, never committing) and cleaning up a loser git agrees to drop.
  terminal.ts, terminal-backend.ts  Bounded project PTYs: real @lydell/node-pty for source/Node, Bun.Terminal in the compiled app. Validated cwd, process-tree kill on last disconnect/server exit, 1 MiB replay, 60 s exit retention. Never a shell-pipe wrapper; only explicit interactive shells.
  binary-runtime.ts          Browser preview's CommonJS package beside the executable. The trusted PTY page is src/web/terminal-shell.html, not a server module.
  render-preview.ts          Authenticated bounded Chromium capture of an agent's own stored page; in-memory fixed-origin rendering, no other network/fetch/cookies/storage, timeout, console cap and certainly no app frame sharing.
  render-browser.ts          Per-chat saved-page actions through `browser_action`: bounded selectors and read/mutate/screen actions, fixed in-memory origin and serialized scopes; owner-disposed tabs, never arbitrary URLs, eval scripts or resource may open remote cookie state.

  stacks.ts                  Stacked pull requests per project: "stack above #N" makes the PR below's head the target, the ordered stack saved in the state folder, merge-through bottom-up with `gh pr merge --merge` only; per-layer status and checks from the same bounded gh calls.
  pr-watches.ts              Opt-in PR poller keyed by one chat's native session; dedupe, retries, actual gh check/run logs and per-session repair markers. Polling never invents a transcript; uses real workspace IDs.
  github.ts                  Bounded local gh/git workflows: existing-PR lookup, explicit push, PR create, PR detail by number, normalized checks; never reads or sends credentials to a browser.
  pr-tour.ts                  Bounded `gh pr diff` reading order and in-memory head-aware tour cache; no review/approve verdict or harness writer.
  overview-events.ts          Bounded live metadata-only stream for chat status and room summaries (500 events max, no transcripts). UI shares one EventSource per tab with fallback full refresh; native IDs remain harness-scoped and disposed clear live/asking status.
  paste-store.ts             1 MiB file-backed large pastes in /tmp, seven-day retention, delete-on-unsent and bounded expiry sweep; agent reads actual retained file paths.
  routines.ts, routines-timer.ts, routine-runner.ts, routine-runs.ts  Server-owned scheduled prompts: bounded store, one due claim before launch, next-slot retry across overlap failures; a run is quiet (its verdict is posted, quiet, or failed, kept in the run history, and its session is hidden from the user's list).
  direnv.ts                  Project .envrc evaluation for harness spawns and explicit terminal semantics, isolated/cached by validated project directory.
  git-actions.ts, checkouts.ts, session-order.ts   Stage/unstage/commit action guards, branch/worktree grouping, hand-ordered session arrays.
  project-upload.ts          One new file into a validated workspace root, exclusive create, 8 MB route cap.
  harness/jobs.ts, child-process.ts, event-hub.ts   Background worker state, bounded child RPC lifecycle and event buffering.
  git.ts, git-status.ts       Hardened git runner; the composer's git row.
  image-store.ts, notify.ts, limits.ts, accounts.ts, run-command.ts, state-file.ts   Side features (see their header comments).
  agent-status.ts             The status line an agent sets for its chat (the orchestration `set_status` tool): one
                              word plus one bounded sentence, per native session, drawn in the sidebar and header.
  orchestration/decisions.ts  The decision gate behind a delegated worker's `request_decision` tool: a recorded
                              question and answer per task (caller-stable `decisionId`, a denial's corrective reason),
                              pending across a restart, never auto-answered; the parked call and the ledger are the
                              orchestrator's, the transcript item and the answer route are Chat's.
  project-config.ts           A project's checked-in `awui.yml` (base ref, shared symlinks, one setup command) as
                              untrusted input: its hash, the trust recorded in the state folder, and its status.
  resume-intent.ts            Sessions that were running when the process stopped: one "Resume working." on their next open, never a harness started by a restart.
  idempotency.ts             An `Idempotency-Key` on a mutating request: one answer per key, ten minutes, in memory.
  review-threads.ts           Review threads per chat in the state folder (pins, notes, resolve, line moves), bounded and pruned.
  attribution.ts              A chat's edited files as they are on disk now, hashed line by line (bounded, through the file
                              viewer's confinement), for the review panel's "written by the agent" marks.
  second-opinions.ts          One turn sent to another harness, recorded per chat in the state folder (bounded), plus the
                              reply's opening words read back from that chat each time it is listed.
  guests.ts                   Expiring single-chat guest links: SHA-256-hashed token and browser binding, one
                              browser per link, a text-only history, and an owner-reviewed message queue; the web
                              view is `src/web/guest-view.tsx` (standalone /guest/:token, outside the app shell).
  device-host.ts              Device hosts (G13's interface): an emulator/simulator farm a future terminal surface
                              could drive; one read-only listing route (`GET /api/devices`), the fake host
                              (tests/helpers/fake-device-host.ts) is the only implementation, real adb/xcrun
                              integration and device verification are outstanding.
  project-files.ts            A project's files for @mention pickers (git ls-files, else a bounded walk).
  project-search.ts           Search in project: bounded `git grep -F` (else a scan of project-files' walk).
  file-view.ts                The file viewer: one of the project's own files (project-files' list), realpath-confined, bounded.
  saved-prompts.ts            Saved prompts: the server's list for every device, names unique, bounded, in the state folder.
  usage-report.ts             Usage across chats: each session's calls (adapter.readUsage), added up by day, harness, model, chat.
  model-catalog.ts            The start screen's models, levels, and default per harness and project: served at once, refreshed behind, saved across restarts.
  chat-search.ts              Search every chat: the sidebar's sessions read (never started), matched, bounded, cached per version.
  herdr.ts                    herdr's JSON socket: its panes by session (sidebar marks, the resume guard), focusing one; atui reports through it.
  harness/plans.ts            A plan call's plan (ExitPlanMode, plan_mode_complete) onto its tool item, bounded.
src/web/                      React 19 + Vite client. App.tsx is the shell; components/ the pieces; styles.css imports
                              styles/*.css (one file per area) in cascade order. docs/ui.md maps which part is where.
  api.ts, stream.ts           fetch wrapper (ApiError) and the reconnecting SSE stream.
  turns.ts                    Items → turns (prompt, process fold, answer); shared with atui.
  rotation.ts                 Free context rotation: the 80 % offer, its words, and the read of a chat's own context figure.
  attribution.ts              The review panel's attribution hook: the server's present-line read over shared/review.ts's rule,
                              grouped per edit and counted per file. Only the review panel asks (the transcript's diffs would
                              re-index the chat on every streaming event).
  tool-sentence.ts            A tool call worded as a sentence ("Read src/app.ts", "Couldn't run npm test") with the facts it holds (pure).
  tool-facts.ts               Facts read from a call's output (test runs, tsc/eslint, rg, git, installs, JSON arrays); claims an output only when sure (pure).
  tool-kinds.ts               The kinds of tool a run used (the card header's icon stack, an MCP server's monogram) (pure).
  gestures.ts, launch.ts      Phones: edge swipe, sheet drag, long press (pure deciders + hooks); the installed
                              app's shortcuts, shares, and prompt links (?new, ?sessions, ?share, ?prompt).
                              public/sw.js: push, Approve/Deny from a notification, the share target, the
                              offline page (it never caches the app).
  turn-time.ts                A turn's time and speed as hover text: the prompt's clock time, the answer row's "24s · first token 1.2s" (pure; nothing unknown is shown).
  waterfall.ts                A turn's time as rows on a nice axis (steps, calls, subagent runs, the slowest call), for the Timing dialog (pure).
  sticky-prompt.ts            The sticky prompt bar: which turn's prompt has scrolled out above the view (pure; StickyPrompt.tsx measures and draws).
  toast-stack.ts              The notice stack: order, the cap of three plus "+N", merging a chat's repeats, timers that hold while hovered (pure; ToastStack.tsx draws it).
  sidebar-filter.ts           The sidebar's filters: the quick chips (Running, Needs you, Today) and the hide menu (sleeping, default
                              branch, started by a routine or an agent): matching, counts, provenance text, and the narrowed overview.
  turn-markdown.ts            Copy turn as Markdown: the prompt, one line per tool call with the replies between, the answer (pure; no diffs or output, bounded; export.ts is the whole chat).
  find.ts                     Find in chat: matches and the folds to open (Conversation walks and paints the DOM).
  prompt-history.ts           ↑/↓ recall of a chat's sent prompts in the composer.
  list-continue.ts            Markdown lists in the composer: Shift+Enter continues one, Tab indents it.
  prompt-link.ts              Prompt links (?prompt=): hidden characters taken out, a link made.
  stash.ts                    The prompt stash: drafts parked in browser storage, images within a budget.
  token-estimate.ts           The draft's size in tokens while typed (a rough estimate) and its share of the context; the ring draws it.
  limit-stop.ts               A run stopped on a usage limit, and when the limit resets.
  limit-words.ts              Subscription limits in words (whose account, window usage level, reset timing); pure, shared by limits.ts and the Tern client.
  attention.ts                What needs you: the title and favicon count, and the chime.
  saved-prompts.ts, prompt-blanks.ts   The # menu's list (the server's, kept in step) and its {{blanks}} (pure; atui uses them).
  chat-actions.ts             A pane's chat actions (send, stop, answer, configure, handoff), for the chat beside the main one.
  usage.ts                    Usage across chats, for drawing: short numbers, the cache's share, day labels, bars by harness.
  dashboard.ts                The agent dashboard's board: columns (needs you / working / done), delegated children nesting
                              under their parent, the project and pull-request filters (pure; Dashboard.tsx draws it).
  session-preview.ts          One session's hover-card preview, fetched once per version and shared by the sidebar's card
                              and the dashboard's cards; the one-line clamp a card shows.
  highlight.ts, file-bus.ts   The file viewer's colours (a small tokenizer, no dependency); opening it from any path on the page.
  shortcuts.ts                Every key the app answers: the shortcut sheet's table, and the palette's hints.
  split-layout.ts             Main/side width ratio and pointer/keyboard separator. Saved only when settled; preserves editor and attached-file identity during Make main, not a transcript store.
  overview-stream.ts          One EventSource per tab (reference-counted) for lightweight session statuses and room summaries; reconnect/full-refresh on gap.
  context-panel.ts             Dedupe actual subagents by native reported run identity; count background jobs, unfinished delegated workers and valid per-browser folds from the existing snapshot, not session-shared new state.
  components/ContextPanel.tsx  Borderless per-chat right rail and ~280 px detail for workers, runs, jobs, pending human questions, project races/opinions/review and usage. Links open true child/tool/review views; activates no agent nor approval.
  shared/overview-events.ts  Shared reconciliation: known rows patched in place, unknown ids cause full refresh; asking cleared only by a current snapshot/delta.
  components/WorktreePicker.tsx, CompareDialog.tsx  Git-checkout creation/reopen/dirty-safe prune, and one-prompt isolated fan-out with independent chat streams.
  styles/worktrees.css, terminal.css, github.css  Project work panels and native GitHub action styles.
  terminal-shell.ts (document entry)  An isolated xterm document under a separate intentional inline-style CSP: builds a real PTY and uses direct origin messages for lifecycle and resize, never command forwarding.
  components/TerminalPanel.tsx  Bounded child iframe header/status only; server always uses TerminalManager, and makeTestApp's terminal creation needs explicit withTerminal:true.
  components/GitHubPanel.tsx  Existing/current PR display, explicit push and bounded PR create/checks.
  components/PrTour.tsx       File-by-file PR reader: current diff, source/tests/generated/mechanical navigation, stale-head warning and explicit rebuild.
  components/HtmlRenderFrame.tsx  Agent-page theme, explicit bounded caller-owned preview screenshot, and capped console text served by server/render-preview.ts.
src/atui/                     The terminal client (Bun + OpenTUI + Solid). state.ts is the app state; ui/ the components.
  format.ts, neat.ts, vim.ts  Pure formatting and key logic, unit-tested from tests/unit.
  herdr.ts                    In a herdr pane: what the pane reports (pure) and the reporter main.tsx feeds.
  fx.ts, minimap.ts, words.ts, markdown.ts, assist.ts, images.ts   Pure logic for the look: shimmer, paced
                              streaming, meters, eased scrolls, the turn gutter, word-level diffs, task boxes,
                              @mentions, ghost text, toasts, desktop notifications, image protocol and drops.
src/tern/                     The Tern client (`awui tern`): atui's state (atui/state.ts) drawn as one inline Tern surface
                              through the Tern Surface Protocol (@stencil-hq/tern). app.ts: the controller (effect → view,
                              keys, menus); view.ts the conversation (web/turns.ts as Tern nodes); dock.ts the composer card,
                              requests, status strip; overlays.ts the picker sheets and caret menus; draft.ts the composer's
                              text (pure, Tern never edits it); usage.ts the Usage overlay (figures from web/usage.ts, then its nodes);
                              timing.ts the Timing overlay (web/waterfall.ts rows); context.ts the context panel (the ring, its
                              categories, web/sparkline.ts growth, session usage); find.ts find in chat (web/find.ts matching,
                              the node ids to reveal); look.ts the palette and the one stylesheet (awui.* roles).
extensions/rewind-to.ts       A Pi/omp extension the server loads into its children (-e) for in-place Edit/Retry.
extensions/render-html.ts     A Pi/omp extension registering render_html, which publishes an HTML page into the chat.
extensions/render-html-mcp.mjs  The same tool as an MCP server (stdio JSON-RPC, no dependencies), for Claude Code.
extensions/orchestrate.ts     A Pi/omp extension registering the orchestration tools from the server's catalogue (delegate_task, thread_wait, …).
extensions/orchestrate-mcp.mjs  The same tools as an MCP server, for Claude Code, Codex, and DSH.
extensions/eval-python.ts     An awui-harness extension registering eval_python: runs a snippet in a scratch tmp dir (no workspace).
extensions/acp-flow.mjs       A DSH Cordis plugin, loaded per chat by a --patch overlay: runs the stock ACP bridge inside it and streams live text as _acp-flow/assistant_stream.
contrib/                      systemd unit and home-manager modules (templates; users copy them).
apps/desktop/                 The optional desktop app: an Electron shell that attaches to a running server or starts one.
                              src/main.ts publishes its native PID via src/activation.ts; server/desktop-instance.ts
                              holds the CLI launch mutex through that publication: repeat Linux invocations
                              wake the existing window instead of spawning again. Other platforms use native handoff.
                              test/activation.mjs asserts concurrent CLI child spawn counts, signal focus and restart.
                              It loads the served page — never a second copy of the UI. Its bundled server needs
                              resources/node_modules/playwright-core staged by scripts/stage-binary.mjs, included
                              explicitly in electron-builder.yml's extraResources. check-packaged.mjs starts it standalone.
tests/unit                    Vitest. tests/helpers/app.ts builds a real app with fake adapters (makeTestApp).
tests/evals                   Deterministic real-tool orchestration failure/repair replays: same-request dedup, scope guard, cancellation interrupt, blocked group wake, recovered interrupted once-only report.
tests/fixtures                Scripted stand-ins: fake-omp.mjs, fake-hermes.mjs, fake-claude.mjs, fake-codex.mjs, fake-grok.mjs, fake-dsh.mjs, fake-acp.mjs, themes/.
tests/e2e                     Playwright. global-setup.ts starts the built server with AWUI_HARNESSES=fake,fake-b.
tests/atui                    bun:test against a real server; helpers.tsx mounts atui in the test renderer;
                              tern-fake.tsx is a stand-in Tern (handshake, frames applied to a document, acks).
docs/harnesses.md             Adding or fixing a harness: the contract, capabilities, every file a new one touches, tests, pitfalls.
docs/ui.md                    Finding and fixing a part of the web UI: regions → components → styles → e2e specs, tokens, a sandbox, measuring.
docs/install.md, configuration.md, usage.md, terminal.md, architecture.md, security.md, theme.md, testing.md, credits.md
                             The user guide the README points at: install (release, source, desktop, service), settings, the interface, the terminal clients, the harnesses, security, theming, tests, credits.
scripts/                      dev.mjs (npm run dev), build-binary.ts, service.mjs, set-password.mjs, ui-shot.mjs (see Commands).
design/                       App icon drafts. .todo/ is gitignored: private notes, never committed.
```

Every source file opens with a comment saying what it is for and why it is
shaped that way. Read it before changing the file.

## Rules that must hold

These are product promises (most are in the README). Breaking one is a bug even
if every test passes.

1. **Never edit an existing harness session file.** Forks, handoffs, and seeds
   only *add* new sessions in the harness's own store. In-place Edit/Retry goes
   through the harness itself (`/rewind-to` on Pi/omp, Hermes's own RPC), never
   by rewriting its JSONL. awui keeps no second transcript database for
   ordinary chats; Board rooms (`src/server/boards/`) own only their
   cross-harness portable projection and control records, never a mirror of a
   harness's native stream.
2. **One live writer per session, in this process.** `ChatManager` maps a native
   session to one chat; a second tab or device attaches as another SSE
   subscriber. Never spawn a second child for a session that is already open.
   A Board membership's native session is created and resumed only through the
   Board manager, and one room runs one turn at a time with its bots serial —
   parallel room execution is a later, separately designed feature.
3. **Normalize at the adapter boundary.** SDK and wire types never leave
   `src/server/harness/<name>.ts`; everything else sees `HarnessEvent`,
   `ChatItem`, and `protocol.ts` types. The browser never names a file path
   (transcripts, images, and checkpoints are looked up server-side by id).
4. **Declare capabilities honestly** (`supportsSteer`, `supportsFollowUp`,
   `supportsThinkingLevel`, `supportsCompact`, `supportsExtensions`,
   `supportsInteractiveRequests`, `supportsRename`, `supportsModelSelection`,
   `supportsFork`, `supportsHandoff`, `supportsRewind`, `supportsQueueEdit`,
   `supportsProjectFolders`, `webOnly`). The UIs hide or disable
   what is not declared; gate server routes on them too.
5. **A run is finished only when the harness says it settled** (Pi's
   `agent_settled`, omp's `session_settled`, Hermes's and Claude's equivalents),
   not at a message end. Sends return once accepted; output streams.
6. **Bounded payloads.** Tool output is cut to head and tail (16 KB), args to
   4 KB, diffs to 800 lines / 40 KB, transcripts read as head and tail past 8 MB.
   Anything new that carries harness output gets a bound.
7. **Security model** (`security.ts`, `docs/security.md`): local means loopback
   peer *and* loopback Host *and* no proxy headers. Every new route goes under
   `/api` behind `requireAuth`; validate bodies with a Zod schema from
   `protocol.ts` via `body(schema, req)`; throw `ChatError(status, code, message)`.
   Never read, return, or log harness credentials. No CDNs, no inline script or
   style (strict CSP). Raster images only (an SVG from this origin could run
   script). Git runs through `git.ts` (no `GIT_*` from the environment, no hooks,
   no fsmonitor, no gc); pass `--literal-pathspecs` when paths come from files.
8. **State lives in the state folder** (`$XDG_STATE_HOME/awui`, mode 0700),
   written through `state-file.ts` (`writeJson`: temp file + rename, mode 0600).
   User settings live in `~/.config/awui/` and are edited only through
   `settings.ts`, which checks a save the way startup checks the file.
9. **Runs outlive clients.** Closing a browser or quitting atui never stops a
   run; only an idle chat with no viewers is reaped (its session file stays).

## House style

- **TypeScript is strict** (`strict`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`). Indexing returns `T | undefined`: handle it, or
  assert with `as` only where the index is provably in range.
- **No formatter is configured, and the code is not prettier-shaped.** Lines run
  long (up to ~180 columns) rather than wrap early. Do **not** run prettier or
  any formatter over a file: it rewrites every line and buries the change. Match
  the surrounding code by hand.
- **Comments say why, in plain sentences.** A file header explains the module;
  a comment above a non-obvious line explains the reason (a harness quirk, a
  security reason, a measured trade-off), not what the code literally does.
  Doc comments (`/** … */`) on exported functions and on protocol fields.
- **Names** read as English: `rememberImage`, `runsFromDetails`,
  `snapshotSoon`. Booleans and helpers are short and literal.
- **Small pure modules for logic, thin components for drawing.** Wording,
  parsing, and key handling go in pure functions (`tool-diff.ts`,
  `subagents.ts`, `atui/neat.ts`, `atui/vim.ts`) with unit tests; components
  stay mostly layout.
- **No new runtime dependencies** without a strong reason. The server needs
  only express, helmet, yaml, and zod; the clients add React, react-markdown,
  and remark-gfm (web), OpenTUI with Solid (atui), and Stencil's
  `@stencil-hq/tern` SDK, pinned (the Tern client). Prefer `node:` built-ins.
- **Web UI:** colours are CSS custom properties on `:root`; a base16 theme
  overrides the base tokens and everything else derives from them with
  `color-mix`, so never hard-code a colour. Motion is short and eased out, and
  `prefers-reduced-motion` turns all of it off (a rule at the end of
  `styles/tokens.css`). Browser storage goes through `storage.ts` (`awui.` prefix);
  requests through `api.ts`. Every interactive element works by keyboard and
  has an accessible name: the e2e tests select by role and name.
- **atui:** the theme comes from the server's tokens (`theme.ts`); mouse and
  keyboard both work; new keys go into the palette and the help strings.

## Review guidance

- **Reverse every one-way door.** When reviewing a change, every state
  transition it adds must have an inverse (snooze↔unsnooze, settle↔unsettle,
  pin↔unpin): if a new action can only go one way, flag it as a bug.

## Testing

- **Fake harnesses are the main tool.** `FakeAdapter` (`src/server/harness/fake.ts`)
  answers deterministic scripts chosen by words in the prompt: `tool`, `big`,
  `ask`, `twice`, `quiz`, `described`, `edit`, `showcase` (one call of every tool
  kind, an MCP-like one with JSON arguments and result among them), `subagents` (a parallel pi-subagents run with live progress and
  transcripts), `evalagents` (an omp eval cell spawning two agents, live rows and `yield` answers), `recall`, `todo`, `bloat`, `slow` (many small chunks, to act
  mid-run), `fail`, `planned` (an ExitPlanMode plan), `ratelimit` (a stop on a
  usage limit), `silent` (an empty answer, for a quiet routine run) and `quietrun`
  (an answer that begins QUIET), `wait` (a provider wait on the harness's status line),
  `interleaved` (a reply, a command, then the answer), `ticking` (a command
  whose output arrives a line at a time), `afterreply` (the answer, then a tool
  call after it), `unfinished` (a call whose result never comes: the run
  settles with it open), `midcompact` (compact inside a run, then carry on),
  `contended` (refuse a prompt while a run is going), `testrun` (a command
  printing a Vitest summary with one failure), `toolfail` (a command call that
  errors), `imagecall` (a read of a picture, its result an image block), `manycalls`
  (twelve quick reads, a run long enough to fold),
  `widethought` (two calls with narrated thinking between, a code line in it
  far wider than the column), `moaref` (a MoA turn's reference advice as
  Markdown folds, with the fan-out on the status line), `delegate` (delegate a
  task through the real orchestration endpoint, then wait for it: a child chat
  appears; with `slow`, the child runs on, so a panel's Cancel has a live row),
  `unsafe` (a real write to `unsafe-outside.ts` in the project root, which a
  delegated child's write scope refuses; with `edit`, the tracked in-scope
  edit beside it), and the Board scenarios
  `consult` (a valid control document on the first invocation, a plain answer
  once its consultation result comes back), `consult-bad`, `consult-unknown`,
  `consult-self`, `consult-dup` (malformed, off-allowlist, self, repeated),
  `consult-slow`, `consult-fail`, `consult-ask` (an approval raised inside a
  consultant), `roomtwice` (distinguishable output per member), `roomwork` (a thought and two calls before the reply), `usagevary`
  (different token counts, one call unpriced), and `coldcache` (a 260k-token session whose
  prompt cache expired half an hour ago, for the composer's cold-resume hint). Add a word there when a
  feature needs a new scenario,
  rather than mocking deeper.
- **herdr** is a stand-in socket (`tests/helpers/fake-herdr.ts`): unit tests give
  `makeTestApp({ herdr })` their own; the e2e server asks one whose panes are the
  `agents.json` in `$AWUI_E2E_HERDR` (calls land in `calls.jsonl`); the atui test
  server runs with `AWUI_HERDR=0`. Never point a test at the developer's herdr.
- **Scripted CLIs** (`tests/fixtures/fake-omp.mjs`, `fake-hermes.mjs`,
  `fake-claude.mjs`, `fake-codex.mjs`, `fake-opencode.mjs`, `fake-grok.mjs`, `fake-dsh.mjs`, `fake-hermes-attach.mjs`, `fake-hermes-gateway.mjs`, `fake-acp.mjs`) speak each harness's real wire protocol
  (OpenCode's is an HTTP server with OpenCode 2's routes and event stream, including the runtime
  MCP add/remove routes and its last-match-wins session permission rules, and it keeps its own pid
  in the state file so a test can end it and watch a chat register again; DSH's writes
  v4 concatenated-zstd session logs). Adapter changes
  get a test against one of them; record new frames from the real CLI rather
  than inventing them.
- **Unit tests** build a real server with `makeTestApp()` (tests/helpers/app.ts)
  and drive it with supertest and SSE; they never touch the developer's config
  (`AWUI_CONFIG_DIR=""`, temp state folders).
- **e2e** runs one worker against one server; tests share it, so a test must not
  depend on another's sessions, and long ones get their own project folder or
  chat. Select by role and accessible name, not CSS classes, where you can.
- **Real data checks.** When parsing a harness's files or events, check the
  parser against real sessions on the machine (`~/.pi/agent/sessions`,
  `~/.omp/agent/sessions`, `~/.claude/projects`, `~/.dsh/sessions`) with a
  throwaway script, read only. Never open the session the current agent is itself running in.
- **Screenshots** for visual work: `node scripts/ui-shot.mjs` for one element
  and its controls' sizes against a sandbox server (docs/ui.md, sections 4–5);
  `AWUI_SCREENSHOTS=<dir> npx playwright test screenshots` writes frames; for atui, render frames in `tests/atui` and read
  them; for the Tern client, run a headless `tern serve --control <port>` (in
  tmux) and drive it in real time with `tern ctl --control <port> run|type|key|shot`
  (a `tern shot` scenario's `wait` is virtual time, too short for the server's
  replies; ctl's Ctrl chords arrive as ⌘, which the client reads as Ctrl).
  Delete throwaway specs before committing.
- A flaky test is a bug to find (a race in the code or the test), not something
  to retry until green.

## Environment

- **Node ≥ 22.19 and npm; Bun ≥ 1.3.14 for the terminal clients from source** (the compiled binary carries them). On the maintainer's NixOS
  machine every tool comes from the system configuration (`~/dotfiles/NixOS`).
  Do not install anything globally or imperatively (`npm -g`, `pip install`,
  ad-hoc venvs). If something is missing, use it temporarily with
  `nix shell nixpkgs#<pkg>` and say what should be added to the dotfiles.
- **Playwright's browsers come from nixpkgs** through `PLAYWRIGHT_BROWSERS_PATH`,
  and `@playwright/test` is pinned to the matching `playwright-driver` version.
  Never run `npx playwright install`.
- **A real awui server may be running** on 127.0.0.1:4783 as a systemd user
  unit, with live chats in it. Tests use other ports (e2e 4791; unit tests pick
  free ones). Do not stop or restart it without checking for live chats
  (`GET /api/sessions`, entries with a `liveChatId`) and asking.
- **Long jobs** (the e2e suite, a real-harness probe) go in a named `tmux`
  session so a human can watch (`tmux attach -r -t <name>`), and are torn down
  when they finish: no tmux session, no leftover harness process, no busy port.
- When probing a real harness, use a scratch project folder and a scratch
  session directory where the harness allows one, and the cheapest model.

## Making common changes

**A new route.** Add the request schema to `protocol.ts`, the route to
`app.ts` under `/api` (after `requireAuth`), throw `ChatError` for failures, and
a supertest case in `tests/unit`. If a remote device must not be able to do it,
say why in the route's comment and test the 401/403.

**A new harness.** Follow [docs/harnesses.md](docs/harnesses.md): which
existing adapter to copy for the agent's transport, the `HarnessAdapter` /
`LiveChat` contract (`src/server/harness/types.ts`), what each capability turns
on, the full list of files a new harness touches (registry, config, README,
tests), and the pitfalls earlier harnesses hit. Clients need no code for a new
harness: they draw what the adapter declares (atui's optional mark and spinner
aside).

**A new tool rendering.** Tool calls arrive as `ToolItem` (category from
`toolCategory()` in agent-events.ts). Structured extras (a diff, subagent runs)
are worked out server-side from `tool_start` args and `tool_end` details and put
on the item; the web (`ToolBody.tsx`, `Conversation.tsx`) and atui
(`neat.ts`, `transcript.tsx`) only draw them. Handle the live path (chat.ts)
and history (`historyToItems`) both.

**A new setting.** Add it to `user-config.ts` (schema), `config.ts` (effective
value), `settings.ts` (read/write, and whether it needs a restart),
`SettingsDialog.tsx`, `config.example.yml`, and `docs/configuration.md`.

**atui features.** State and server calls in `src/atui/state.ts`; keys in
`ui/app.tsx` (the palette, the Ctrl+X leader, `LEADER_HELP`, `KEYS_HELP`, and
vim's NORMAL mode in `vim.ts` all need to agree); pure logic in a module with a
unit test; a `tests/atui` case that drives it by keys or clicks.

## Commits and docs

- **Atomic commits, one topic each**: a feature, a fix, a refactor, a docs
  change. Stage per topic and check `git diff --cached` before committing. Each
  commit builds and passes on its own.
- **The subject is `type(scope): description`**: lowercase, imperative, no
  trailing period, about 72 characters at most. The type says what kind of
  change it is:
  - `feat`: a new capability someone can use (a feature, a setting, a route,
    a harness). `feat(web): add a sticky prompt bar`
  - `fix`: something broken now works. `fix(server): remove a half-written upload`
  - `refactor`: a change of shape with no change of behaviour.
    `refactor(web): split App.tsx's palette into a hook`
  - `perf`: the same behaviour, faster or lighter.
    `perf(server): keep only the newest snapshot in a chat's event log`
  - `test`: tests only. `test(e2e): hover a tab before looking for its close button`
  - `docs`: README, AGENTS.md, docs/ only. `docs: describe the density tokens`
  - `chore`: maintenance with no behaviour change (dependency bumps, build
    scripts, CI). `chore: bump @playwright/test to 1.56`

  The scope is the part it changes: `web`, `atui`, `tern`, `server`, a
  harness (`pi`, `omp`, `hermes`, `claude`, `opencode`, `grok`, `dsh`, `awui`), or a
  narrower area when that reads better (`composer`, `sidebar`, `tabs`,
  `security`, `doctor`, `e2e`). Leave it out (`docs: …`) when the change is
  not about one part. Tests and docs that ship with a change go in its commit
  under its type: a `feat` carries its own tests and README lines.

  The body says what changed and why, wrapped at ~76 columns; it can be left
  out when the subject says it all. Older commits use present-tense sentences
  ("Checkpoint restore takes file names literally"); new ones use this form.
- **Update the docs in the same commit** as the behaviour they describe
  (features in `docs/usage.md`, atui keys in `docs/terminal.md`, routes and
  limits in `docs/security.md`, tests in `docs/testing.md`; the README keeps
  only the pitch, install, and a docs index).
- Never commit `.todo/`, `dist/`, `test-results/`, secrets, or exported session
  transcripts.
