# Orchestration

An awui chat's agent can hand a self-contained task to another agent — a fresh chat in the
same project, on any installed harness — and then watch it, wait for it, or stop it. The
surface is a small fixed set of tools, identical for every harness, served by the same
process that runs the chats.

This page describes the surface, its limits, and its error codes.

## How a chat's agent reaches it

A live chat's harness child is spawned with two variables, like the `render_html` tool:

| Variable | Meaning |
|---|---|
| `AWUI_ORCH_URL` | `http://127.0.0.1:<port>/api/orchestration`, loopback even when the server also serves the LAN |
| `AWUI_ORCH_TOKEN` | this chat's own 32-hex token, sent as the `X-Awui-Orch-Token` header |

The token names exactly one chat, so every call is authorized as that chat and can touch
nothing else: tasks and transcripts are filtered by their parent chat. It is minted with
the spawn, never written to disk, and dropped when the chat closes or the server
restarts. It is good for 12 hours; restarting the chat (a resume) mints a fresh one, and
a spent token answers `orch_token_expired` ("restart the chat"), never a silent failure.

A read-only harness (`awui`) is never given the token: a delegated child of it would be
handed the write and exec tools that chat exists to deny, so it is neither armed with the
tools nor accepted as a delegation target. Board-owned chats get no token either.

`orchestration: enabled: false` (or the Settings dialog's **Agents delegate to other agents**
switch) turns the whole surface off: the next chat is spawned with no token, so its agent never
sees the tools, and every call and catalogue request answers `orch_off`. Chats already open keep
their token until they restart, but their calls are refused too.

### How the tools reach the agent

Awui injects them two ways, and both repeat nothing: the names, descriptions, and
parameter schemas are fetched from `GET /tools` once at startup, so
`orchestration/tools.ts` is still the one definition.

| Harness | How | File |
|---|---|---|
| Pi, omp | an extension loaded with `-e`, one `registerTool` per catalogue entry | `extensions/orchestrate.ts` |
| Claude Code, Codex, DeepSeek Harness | a second stdio MCP server (`awui-orchestrate`) beside `render_html`'s `awui` | `extensions/orchestrate-mcp.mjs` |
| Hermes, OpenCode, Grok Build | not wired: none of them mounts an MCP server for awui today | — |

The extension refuses to load without both variables, so a stray copy in a project's
extensions folder stays inert; the MCP server registers no tool without them.

Claude Code is also given the tools in `--allowedTools` (as `mcp__awui-orchestrate__<tool>`),
because its MCP tools need an allow rule to run without a prompt; Codex and DSH take the
server alone. Every injected name comes from the catalogue, so an allow list cannot drift
from what is served.

## Endpoints

Both are mounted before `requireAuth` (like `/api/render`): they authenticate by the
token header alone, never a cookie, so a signed-in device elsewhere cannot mint one.

```
GET  /api/orchestration/tools              → { tools: [{ name, description, parameters }] }
POST /api/orchestration/call               → { ok: true, text, data }
     X-Awui-Orch-Token: <32 hex>              or { ok: false, code, message }
     { "tool": "list_profiles", "args": {} }
```

The tool catalogue is the one source of truth for names, descriptions, and parameter
schemas; a bridge fetches it once at startup and registers what it finds. `text` is the
line the model reads, composed on the server so the wording exists once.

## Tools

| Tool | Arguments | Serves |
|---|---|---|
| `delegate_task` | `brief` (1–32 000 chars), `harness`, `profile`, `model`, `thinkingLevel`, `permissionMode`, `role`, `title`, `workspaceId`, `notify`, `clientRequestId` | yes |
| `task_status` | `taskId` (omitted: every task this chat started) | yes |
| `task_cancel` | `taskId` (idempotent) | yes |
| `thread_send` | `taskId`, `text` (1–32 000 chars) | yes |
| `thread_read` | `taskId`, `before`, `limit` (≤200, default 40) | yes |
| `thread_wait` | `taskIds` (1–4), `waitMs` (default 55 000, max 110 000) | yes |
| `list_profiles` | `workspaceId` | yes |

`list_profiles` lists the project's saved bot profiles and one entry per installed
harness at its default model — `{ id, source, name, harnessId, harnessName, available,
model, provider, thinkingLevel, permissionMode, role, note }` — with how many delegation
levels and tasks are left.

## Reading a child's chat

`thread_read` answers with a page of the child's own chat: `{ task, items, truncated }`, its items
oldest first, plus the same page as the text a model reads. The page counts from the newest item
backwards — `limit` (default 40, at most 200) caps it, `before` skips that many of the newest — so a
parent pages back through a long run. Each item's text goes through the same 16 KB bound the server
puts on tool output, image references are dropped (the image count stays), and the page stops before
the rendered text passes 24 000 characters; `truncated` says more is left, and the text names the
`before` value that reads it. A child chat that was closed or reaped is read from the harness's own
session file when the harness can read one; otherwise the answer carries what the task record holds
and says the transcript needs the chat reopened.

`thread_send` talks back to that chat: `{ queued, state }`, where `queued` is `steered` when the
message went into the run the child was in (its harness supports steering) or `sent` when it became
a prompt of its own, a follow-up while the child is busy. A task that had reported its result goes
back to `working` with a fresh generation — so nothing from the old run can answer for the new one —
and is watched again: one result per settle. A child whose chat was closed answers
`task_not_running`; a harness that will not take the message answers `cannot_send`.

## A delegation

`delegate_task` returns at once with the task's id and the child chat's id; the work runs in
the background. The child is an **ordinary chat**: it is listed, openable, searchable, and
resumable like any other, and it shares the caller's working tree (the tool's description
says so, and the caller is told to keep its own edits out of the child's way). It carries a
*lineage*: which task started it, which chat started that, and its depth. A delegated child
of an agent is one level deeper than its parent; a grandchild is depth 2 and may not
delegate again, because depth is what multiplies cost.

`delegate_task` also takes a harness, a saved bot `profile` (its harness, model, and
permission mode), `model`, `thinkingLevel`, `permissionMode`, `role` (a label), `title`, a
`workspaceId` (an *open* project by id, never a path), `notify` (`wake` by default: the parent
is woken with the result), and `clientRequestId` (a repeat returns the same task instead of
spawning a second child).

A child inherits the caller's permission mode. An explicit one must rank at or below the
caller's own by the caller's own harness ordering (broadest last); a mode the caller does not
have cannot be ranked and is never granted. A read-only harness (`awui`) can neither
delegate nor host a child.

**How a task ends.** One watcher per running task follows the child's stream. A child that
goes idle (or errors) with nothing pending is finished: `done` or `failed`, with its last
answer bounded to 4 000 characters. A child that raises a **question** becomes
`waiting_for_user` and a parent's `thread_wait` returns at once with the question's title; an
**approval** does not end the wait, because the user already sees the approval card. A
child's ordinary `done` or `error` push note is suppressed — the parent agent is told instead — but
a question's note still goes out, since the user is the only one who can answer it. A child whose
own delegates are still running is `waiting_for_children`, not finished. `task_cancel`
stops the task's whole subtree: depth first, every live task its child chat started (and theirs,
down to the delegation cap) is stopped before the chat that started it, each awaited with the
same five-second cap, then the task's own chat is aborted and closed when nobody is watching. It
is idempotent — a second cancel returns the same record — and a child that will not stop in five
seconds answers `cancel_timeout` (504) while the record still says the task was cancelled, so a
partial stop is never reported as a clean one. A chat a user has open is never closed out from
under them.

**Finish delivery.** A parent agent that did not wait for its child is woken with the result. On a
terminal state (`done`, `failed`, or `interrupted` by a restart) with `notify: "wake"`, the task's
wake ledger gets a `pendingSince` — written to the record *before* anything is sent — and reports
queued for the same parent within 2 500 ms flush as **one** prompt, so a council's three results
arrive as one message. The prompt is bounded (6 000 characters in all, the child's final answer
4 000 of them) and looks like this:

```
[awui delegate ab12 · done · pi · 4m12s]
"Parser review"
Echo: the lexer table is fine; the parser's recovery path is not.
thread_read("ab12") for more; thread_send("ab12", …) to continue it.
```

It is delivered as a **steer** while the parent runs, a **follow-up** when the parent holds a
question of its own (a steer would be lost), and an ordinary prompt when the parent is idle. A
result the parent read itself — `thread_wait`, `task_status`, or `task_cancel` returned it — is
never delivered: the ledger records the read instead (`skipped`). A cancelled task is never
reported back, because the parent is the one who stopped it. A parent that is not open keeps its
reports: they are delivered when it next opens or resumes, once.

Delivery is **at-least-once**: a crash between the send and the stamp can deliver the same report
twice. That is the right trade for a result the parent waits on, and why a report is one bounded
message rather than a stream. A report the parent would not take is retried twice, then marked
`skipped` with the reason, so nothing spins.

## The task record

Records live in `$XDG_STATE_HOME/awui/orchestration/tasks.json` (mode 0600, written whole
through a checked temp-and-rename: a write that fails rejects, so a delegation whose record
never landed cannot report success). At most 200 are kept; terminal rows older than a week
are pruned, then the oldest terminal rows. A malformed row is dropped rather than refusing
the file, because the child's harness session is the source of truth: losing a row loses the
parent's pointer to work that still exists. A task names its two chats both by chat id and
by harness session id, because a chat id is minted on every open: a reopened child keeps its
lineage chip and a reopened parent its panel. A server restart marks every unfinished task
`interrupted` with the reason and queues its report again (`notify: "wake"`), so the parent learns
when it next opens; nothing is resumed automatically, and the child's session is still there to
resume by hand.

## Limits

One call's own bounds are fixed (they are what a model can ask for in one message); the delegation
caps come from `config.yml` and are read again while the server runs, so a change applies without a
restart. The Settings dialog's **Agents delegate to other agents** switch is `enabled`.

```yaml
orchestration:
  enabled: true             # false: no agent is given the tools at all
  maxChildrenPerChat: 4     # tasks one chat may run at once
  maxTasksPerChat: 32       # tasks one chat may ever start (finished ones count)
  maxLiveTasks: 12          # tasks this server runs at once, across chats
  maxDepth: 2               # 2 lets a child delegate once, and stops at grandchildren
  taskWallClockMs: 2700000  # 45 min: a task still working is stopped and recorded failed
  wakeParents: true         # wake a parent's agent with a finished child's result
  maxWakesPerHour: 20       # wake prompts one parent may receive in an hour
  callsPerMinute: 60        # tool calls one chat may make in a minute
```

| Limit | Default | Where |
|---|---|---|
| Brief or follow-up | 32 000 characters | fixed |
| Tasks waited on at once | 4 | fixed |
| A wait's own duration | 55 000 ms (at most 110 000) | fixed |
| Profiles listed | 64 | fixed |
| Delegation depth | 2 (a grandchild may not delegate) | `maxDepth` |
| Children per chat | 4 | `maxChildrenPerChat` |
| Tasks per chat | 32 | `maxTasksPerChat` |
| Live tasks server-wide | 12 | `maxLiveTasks` |
| A task's wall clock | 45 minutes | `taskWallClockMs` |
| Tool calls per chat per minute | 60 | `callsPerMinute` |
| Wake prompts per parent per hour | 20 | `maxWakesPerHour` |

A number out of range, or an unknown key in the block, stops the server with the key named, like
every other setting.

**The wall clock.** A task still `working` after `taskWallClockMs` is stopped the way a cancel stops
it — its subtree first, then its own chat with the five-second cap — and recorded `failed` with the
error `wall clock exceeded (45m)`, so the parent can tell it from a cancel it asked for; a
wake-notified parent is told. The timer is per task, unref'd, cleared when the task settles, and
started again by a `thread_send` that revives it. A task a restart marked interrupted is not
running, so it is never timed, and one waiting on you or on its own children is not the clock's
business.

## Error codes

All are `ChatError`s with the status shown, answered in the bridges' envelope
(`{ ok: false, code, message }`):

| Code | Status | When |
|---|---|---|
| `orch_off` | 404 | this server is not wired for orchestration, or `orchestration.enabled` is false |
| `bad_orch_token` | 401 | no live chat holds that token |
| `orch_token_expired` | 401 | the chat's 12 hours are up; restart the chat |
| `unknown_tool` | 400 | no tool by that name (or not served yet on this server) |
| `invalid_request` | 400 | arguments failed the tool's schema |
| `unknown_workspace` | 404 | `workspaceId` is not an opened project |
| `unknown_task` | 404 | no task with that id |
| `not_your_task` | 403 | the task belongs to another chat |
| `store_failed` | 500 | the task record could not be written, so nothing started |
| `unsupported` | 400 | that harness has no permission modes |
| `caller_read_only` | 403 | a read-only harness may not delegate |
| `mode_escalation_denied` | 403 | a permission mode broader than the caller's own |
| `max_depth` | 429 | the caller is already as deep as delegation goes |
| `too_many_tasks` | 429 | a per-chat, per-server, or depth cap |
| `unknown_harness` | 422 | no such harness |
| `harness_unavailable` | 422 | that harness cannot start right now |
| `unknown_profile` | 422 | no such bot profile |
| `workspace_unsupported` | 422 | the harness cannot open that project |
| `task_not_running` | 409 | the task is not in a state this call applies to, or its chat is closed |
| `cannot_send` | 409 | the child chat cannot take that message |
| `cancel_timeout` | 504 | a cancelled task's chat did not settle within five seconds; the record still says cancelled |

## At-least-once

A report is written *pending* before the parent is woken, so a crash in that window retries it on
the next start, and a crash between the send and the stamp can deliver the same report twice. A
reopened parent gets whatever is still queued once. That is the trade for a result the parent is
waiting on, and it is why a report is one bounded message rather than a stream. `task_status` and
`thread_wait` are always the exact answer; a repeated wake only repeats what they would say.
