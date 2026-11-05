# Adding or fixing a harness

How to give awui a new coding agent ("add support for <agent>"), or repair an
existing one, without breaking the promises in AGENTS.md. A harness is an
agent CLI that awui drives: the agent stays the source of truth for its models,
login, settings, and session files; awui only starts it, translates its events,
and draws them.

Everything harness-specific lives in `src/server/harness/<id>.ts`. The web UI,
atui, and the Tern client need no code for a new harness: they draw what the
adapter declares (name, colour, capabilities, setup command) in
`/api/bootstrap`. The exceptions are atui's optional mark and spinner tables
(section 4) and the built-in Awui harness, which has no project folder. If a
change seems to need `harnessId === "<id>"` in a client, it belongs on the
adapter instead.

Board rooms (`src/server/boards/`) consume this same contract: a bot is any
registered adapter driven through the ChatManager, its chat marked as
internally owned so ordinary surfaces keep its sessions out. A new harness
needs no Board work; native custom instructions or consult tools, if ever
added, would be optional capabilities an adapter declares.

## 1. Find out how the agent talks

Before writing code, run the real CLI in a scratch project (tmux, cheapest
model, torn down afterwards; never the session you are running in) and answer:

- **How is it driven?** JSON lines over stdio, ACP, an HTTP server, a daemon
  that owns its home? Which flags start that mode, and which ones must awui
  never pass (auto-approve, a shared leader, an auto-updater)?
- **Where are its sessions?** The directory, the file format, how a session id
  maps to a file, and whether a session belongs to a project folder.
- **What does a turn look like on the wire?** Record real frames for: a plain
  reply, a thought, a tool call and its result, an edit (does the result carry a
  diff?), an approval request, a cancelled run, an error, and the frame that
  says the run *settled*. Note the installed version next to them.
- **How strict is it?** Send it an unknown field. Hermes 0.22.2 refuses any key
  its contract does not declare, which is how one extra field broke every resume.

Then pick the adapter to copy, by transport:

| The agent speaks | Copy | Notes |
|---|---|---|
| ACP (Agent Client Protocol) over stdio | `grok.ts` + `grok-transcript.ts` | The generic path. ACP has no steer or follow-up: declare both false. An app that replays no history (DSH) also needs a reader for its own session files: see `dsh.ts` + `dsh-transcript.ts`. |
| Its own JSON lines over stdio, one child per chat | `pi.ts` (rpc mode), `claude.ts` (stream-json) | `omp.ts` is a Pi fork that strips Pi's `PI_*` variables from its child. |
| One HTTP server shared by every chat | `opencode.ts` + `opencode-server.ts` + `opencode-messages.ts` | Start the server once, route its event stream by session. |
| A gateway process that owns its home | `hermes.ts` + `hermes-gateway.ts` + `hermes-canonical.ts` | Attach to the owner; the stdio child is only the fallback. |

## 2. The contract (`src/server/harness/types.ts`)

`HarnessAdapter` is the harness; `LiveChat` is one open session. Read the doc
comments there: they are the specification. In short:

**HarnessAdapter, required:** `id`, `displayName`, `cliCommand`,
`capabilities`, `discover()` (available? version, warnings; never paths or
secrets in `reason`), `workspaceProblem(cwd)`, `resolveAgentDir()`,
`resolveSessionDir(cwd)`, `listModels`, `listThinkingLevels`, `listSessions(cwd)`
(the sidebar), `listRecentSessions(limit)`, `forkSession`, `seedChat` (handoff),
`openChat({ cwd, resumeNativeId? })`, `shutdown()`.

**HarnessAdapter, optional** (each one lights up a feature when present):

| Member | Gives |
|---|---|
| `accent` | Its colour, one of `HARNESS_ACCENTS`; otherwise the registry picks a free one. |
| `setupCommand` | The command the "No models are available" banner tells you to run (`grok login`). |
| `readTranscript` | Resume without waiting: the chat shows from the file while the harness starts. |
| `resumeCommand` | "Copy resume command" (with `supportsResumeCommand`). |
| `readUsage` | The chat's calls in Usage across chats. |
| `usageLimits` | Subscription limits in the sidebar's Usage row. |
| `subagentTranscriptFile`, `subagentTranscript` | Opening a subagent's own transcript. |

**LiveChat:** `nativeId` (see the pitfall below), `subscribe`, `history`,
`getConfig`, `getContextUsage`, `getUsage`, `getTodos`, `listCommands`,
`prompt`, `steer`, `followUp`, `abort`, `setConfig`, `refreshModels`, `rename`,
`compact`, `answer`, `dispose`; `rewind` and `replaceQueue` only with their
capabilities.

**Events** (`HarnessEvent`): translate the agent's frames into these and
nothing else. The order the reducer (`chats/chat.ts`) expects:

```
session(nativeId)                     as soon as the harness names its session
busy                                  a run started
assistant_start → assistant_delta* → assistant_end   per model message (text and thinking)
tool_start → tool_update* → tool_end  per tool call; details carry structured results (diffs)
request / request_cancelled           approvals and questions (answered through LiveChat.answer)
config, title, queue, notice, extension_status, limits, compacting   whenever they change
settled                               only when the agent says the run is over
fatal                                 the child died or the session cannot continue
```

## 3. Capabilities: declare only what works

Each flag hides or shows something; declaring one the agent cannot honour
leaves a button that fails. Gate any server route on the flag too.

| Flag | What it turns on | Read in |
|---|---|---|
| `supportsSteer` | Sending while a run is going (steer) | `Composer.tsx`, `chat.ts` |
| `supportsFollowUp` | Queueing a message for after the run | `Composer.tsx`, `App.tsx`, `chat.ts` |
| `supportsQueueEdit` | Editing or removing a queued message | `Composer.tsx`, `chat.ts` |
| `supportsModelSelection` | The model pill and picker | `ComposerControls.tsx`, `App.tsx`, `chat.ts` |
| `supportsThinkingLevel` | The thinking/effort pill | `ComposerControls.tsx`, `App.tsx`, `chat.ts` |
| `supportsPermissionMode` | The permission pill, switchable mid-run | `ComposerControls.tsx`, `App.tsx`, `chat.ts` |
| `supportsCompact` | Compact, and the full-context chip | `Composer.tsx`, `App.tsx`, `chat.ts` |
| `supportsRename` | Renaming the chat | `App.tsx`, `chat.ts`, `app.ts` |
| `supportsFork` | Fork from a finished turn | `App.tsx`, `app.ts` |
| `supportsHandoff` | Being the target of a cross-harness handoff | `App.tsx`, `ComposerControls.tsx`, `app.ts` |
| `supportsRewind` | Edit/Retry a past prompt in place | `App.tsx`, `SidePane.tsx`, `chat.ts` |
| `supportsResumeCommand` | Copy resume command | `Sidebar.tsx`, `App.tsx`, `app.ts` |
| `supportsHtmlRender` | awui's render tool is wired into the child | `chats/manager.ts` |
| `supportsExtensions`, `supportsInteractiveRequests` | Declared for honesty; no client reads them today | — |

## 4. Every file a new harness touches

From the commits that added OpenCode (`9708e6a`) and Grok (`7bd583b`).
Required:

| File | Change |
|---|---|
| `src/server/harness/<id>.ts` | The adapter. Wire and SDK types never leave it (AGENTS rule 3). |
| `src/server/harness/<id>-transcript.ts` | When the agent's history lives in its own files (Grok, DSH): the pure reader, fold, and usage parser, tested without a process. |
| `src/server/harness/registry.ts` | One line in `factories`: `<id>: (config) => new XAdapter({ home: config.home, ...config.launch.<id> })`. |
| `src/server/config.ts` | Add `<id>` to the default `harnesses` list (and the doc comment above it). |
| `src/server/user-config.ts` | `harnesses.<id>` in the schema (`launchSchema` if it takes `command` and `args`), and `<ID>_BIN` in `BIN_ENV`. |
| `tests/fixtures/fake-<id>.mjs` | A scripted stand-in speaking the recorded wire (section 5). |
| `tests/unit/<id>-adapter.test.ts` | The adapter against the fake. |
| `tests/unit/config-events.test.ts` | The default harness list. |
| `tests/smoke/real-harness.test.ts` | One row in `harnesses`, a `SMOKE_<ID>_MODEL` if its model names differ, and its live-children counter. |
| `config.example.yml` | The `<ID>_BIN` line and an example under `harnesses:`. |
| `README.md` | The intro's list, the architecture diagram, Requirements, the `harnesses.<…>` and `AWUI_HARNESSES` / `*_BIN` rows, a `### <Name>` section (how it is driven, sessions, runs, decisions, config), the Config dirs table, Resume without waiting, and Testing. |
| `AGENTS.md` | The adapter list in the code map and the fixture list in Testing. |

As needed, when the agent's tools or results look different from the others:

| File | When |
|---|---|
| `harness/agent-events.ts` | `toolCategory()` misfiles its tool names; `PATH_KEYS` misses its path argument (Grok's `target_file`). |
| `harness/tool-diff.ts` | Its edit results carry a diff in a new shape. |
| `harness/subagents.ts` | It delegates to subagents. |
| `harness/plans.ts` | It hands plans over for review. |
| `herdr.ts` | herdr reports its panes' sessions in a shape `paneSessionId` does not know (the pane's `agent` must be awui's harness id). |
| `src/atui/neat.ts`, `src/atui/fx.ts` | atui's one-character mark and spinner frames for it; without them it gets its initial and the default spinner. |

## 5. Tests

- **The fake CLI is the main tool.** Model it on `fake-grok.mjs`: a header
  comment listing the prompt words that pick a scenario (`tool`, `ask`, `diff`,
  `think`, `slow`, `fail`), `--version` answered like the real CLI, every
  prompt, answer, and cancel recorded in `$FAKE_<ID>_STATE` so a test can see
  what went out, and session files written in the agent's own layout under a
  temp home. **Record frames from the real CLI rather than inventing them**, and
  name the version they came from.
- **Be as strict as the real thing.** If the agent refuses unknown fields, the
  fake must too (`fake-hermes.mjs` refuses unknown `session.resume` keys, as
  0.22.2 does); a lenient fake passes the very bug users hit.
- **The adapter test** opens chats through the adapter, drives them with
  `Chat`, and checks in `afterEach` that the adapter's live-children counter is
  back to zero. Cover: new chat, streaming, a tool with a diff, an approval
  round trip, stop, model and level changes, listing, and resume — including
  that `live.nativeId` is the resumed id.
- `npm run typecheck && npm test` must pass; run the smoke test against the real
  CLI (`SMOKE=1`, with a model only when you mean to spend tokens).

## 6. Check it on the real server

Unit tests prove the adapter against the fake; this proves it against the
agent on this machine:

1. Build the binary inside `devenv shell` (`npm run build:binary`). The user's
   `awui.service` runs it: check for live chats and ask before restarting it
   (AGENTS.md, Environment).
2. `curl -s http://127.0.0.1:4783/api/bootstrap` lists the harness as
   `available`, with no warnings.
3. Open a scratch project (`POST /api/workspaces/open {"path": …}`), start a
   chat (`POST /api/chats {"harnessId","workspaceId"}`), and resume a real
   session **twice** (`POST /api/chats/resume {"harnessId","workspaceId","sessionId":"<id>:<native>"}`):
   both calls must return the same `chatId` with a `sessionId`, and only one
   child process may run.
4. Dispose every chat you made (`POST /api/chats/<id>/dispose`) and check that
   no child of the server is left.

## Pitfalls already paid for

- **Version skew.** Users run the stable release, which can trail the main
  branch by weeks. Send only fields the installed version declares, and test
  against the version users have. (Hermes: `display_projection` on resume.)
- **The stored id must be known at once.** `ChatManager` keys the single-writer
  rule on `LiveChat.nativeId`. If it is null after a resume, a second resume
  starts a second child on the same session. When the agent's reply does not
  name the session, take the id you resumed. (Hermes 0.22.2 names it only as
  `resumed`.)
- **Find the real executable.** Installers write wrapper scripts of every
  shape; prefer a launcher's own "print your command" flag over parsing it, and
  never fall back silently to a system interpreter. (Hermes: the installer's
  launcher.)
- **Settled means settled.** A message end is not the end of a run; tool calls
  and follow-ups can still come. Emit `settled` only on the agent's own signal.
- **Keep the child's environment its own.** Strip variables that belong to a
  different harness (omp and `PI_*`), set the ones that keep it quiet
  (`GROK_DISABLE_AUTOUPDATER=1`), and never pass flags that loosen its
  permissions.
- **Never write the agent's session files.** Forks and handoffs add new
  sessions through the agent's own store; everything else is read-only.
- **An ACP app may replay nothing.** DSH's ACP surface deliberately sends no
  history on resume, so `history()`, the sidebar, and usage must come from the
  app's own store — DSH writes one zstd frame per append inside a single
  `session.v4.jsonl.zstd`, which Node's one-shot decompressor stops reading at
  the first frame. `dsh-transcript.ts` scans frame headers and decodes each
  frame itself. Test the reader against real files, including a torn last
  append.
- **An optional transport is a setup step, not an install.** DSH's `acp` bundle
  is not in every installation (the Nix package ships only the web and
  headless bundles). Discovery must name the pinned install command and report
  the harness unavailable, never start a chat that cannot answer; the profile
  itself is DSH's own store and lives under `~/.dsh`.
- **Resume needs the session's providers.** DSH refuses a session whose
  recorded model route has no registered adapter. A profile that mounts fewer
  providers than the one that wrote the session can list it but not resume it;
  say so in the setup docs rather than rewriting the session.
