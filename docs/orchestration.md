# Orchestration

An awui chat's agent can hand a self-contained task to another agent — a fresh chat in the
same project, on any installed harness — and then watch it, wait for it, or stop it. The
surface is a small fixed set of tools, identical for every harness, served by the same
process that runs the chats.

This page describes the surface, its limits, and its error codes. Status: the token
surface, the catalogue, `list_profiles`, and delegation itself (start, watch, wait, cancel)
are live; `thread_send` and `thread_read` are defined and answer `unknown_tool` until the
finish-delivery step, and the wake ledger is recorded but not yet delivered.

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
| `thread_send` | `taskId`, `text` | not yet |
| `thread_read` | `taskId`, `before`, `limit` (≤200) | not yet |
| `thread_wait` | `taskIds` (1–4), `waitMs` (default 55 000, max 110 000) | yes |
| `list_profiles` | `workspaceId` | yes |

`list_profiles` lists the project's saved bot profiles and one entry per installed
harness at its default model — `{ id, source, name, harnessId, harnessName, available,
model, provider, thinkingLevel, permissionMode, role, note }` — with how many delegation
levels and tasks are left.

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
`workspaceId` (an *open* project by id, never a path), `notify` (`wake` by default, recorded
for the delivery step), and `clientRequestId` (a repeat returns the same task instead of
spawning a second child).

A child inherits the caller's permission mode. An explicit one must rank at or below the
caller's own by the caller's own harness ordering (broadest last); a mode the caller does not
have cannot be ranked and is never granted. A read-only harness (`awui`) can neither
delegate nor host a child.

**How a task ends.** One watcher per running task follows the child's stream. A child that
goes idle (or errors) with nothing pending is finished: `done` or `failed`, with its last
answer bounded to 4 000 characters. A child that raises a **question** becomes
`waiting_for_user` and a parent's `thread_wait` returns at once with the question's title; an
**approval** does not end the wait, because the user already sees the approval card. A child
whose own delegates are still running is `waiting_for_children`, not finished. `task_cancel`
marks the task, stops its own delegates first, aborts the chat with a five-second cap, closes
it when nobody is watching, and is idempotent: a second cancel returns the same record. A
chat a user has open is never closed out from under them.

## The task record

Records live in `$XDG_STATE_HOME/awui/orchestration/tasks.json` (mode 0600, written whole
through a checked temp-and-rename: a write that fails rejects, so a delegation whose record
never landed cannot report success). At most 200 are kept; terminal rows older than a week
are pruned, then the oldest terminal rows. A malformed row is dropped rather than refusing
the file, because the child's harness session is the source of truth: losing a row loses the
parent's pointer to work that still exists. A task names its two chats both by chat id and
by harness session id, because a chat id is minted on every open: a reopened child keeps its
lineage chip and a reopened parent its panel. A server restart marks every unfinished task
`interrupted` with the reason; nothing is resumed automatically, and the child's session is
still there to resume by hand.

## Limits

| Limit | Default |
|---|---|
| Brief or follow-up | 32 000 characters |
| Tasks waited on at once | 4 |
| A wait's own duration | 55 000 ms (at most 110 000) |
| Delegation depth | 2 (a grandchild may not delegate) |
| Children per chat | 4 |
| Tasks per chat | 32 |
| Live tasks server-wide | 12 |
| Profiles listed | 64 |

The delegation caps are constants today; moving them into `config.yml` is a later step.

## Error codes

All are `ChatError`s with the status shown, answered in the bridges' envelope
(`{ ok: false, code, message }`):

| Code | Status | When |
|---|---|---|
| `orch_off` | 404 | this server is not wired for orchestration |
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
| `task_not_running` | 409 | the task is not in a state this call applies to |
| `cannot_send` | 409 | the child chat cannot take that message |
| `cancel_timeout` | 504 | the child would not settle in time |

## At-least-once, and what that means so far

Finish delivery is designed to be at-least-once: a report is written *pending* before the
parent is woken, so a crash in that window retries it on the next start, and a crash between
the send and the stamp can deliver the same report twice. That is the right trade for a
result the parent is waiting on, and it is why a report is one bounded message rather than a
stream. Today only the ledger field (`wake`) exists on the record; the coalescing send ships
with the delivery step, so nothing is delivered twice yet.
