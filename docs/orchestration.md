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

Awui injects them three ways, and none repeats a definition: the names, descriptions, and
parameter schemas come from `GET /tools` (or the catalogue served from it), so
`orchestration/tools.ts` is still the one definition.

| Harness | How | File |
|---|---|---|
| Pi, omp | an extension loaded with `-e`, one `registerTool` per catalogue entry | `extensions/orchestrate.ts` |
| Claude Code, Codex, DeepSeek Harness | awui's own HTTP MCP endpoint, mounted per chat | `POST /api/orchestration/mcp` |
| a DSH build whose ACP does not advertise `mcpCapabilities.http` | the stdio MCP server (`awui-orchestrate`), as a fallback | `extensions/orchestrate-mcp.mjs` |
| Grok Build | the same stdio MCP server, passed as an ACP stdio entry on `session/new` and `session/load`; Grok calls a tool as `<server>__<tool>` (or through its `use_tool` dispatcher), which the adapter renames to `mcp__awui-orchestrate__<tool>` for the card | `extensions/orchestrate-mcp.mjs` |
| OpenCode | a second server registered at runtime on OpenCode's shared server, `awui-o-<id>`, beside the chat's `awui-r-<id>` render server; its session allows only the chat's own pair and denies every other chat's | `extensions/orchestrate-mcp.mjs` |
| Hermes | not per chat yet: it mounts MCP servers only from its own config, so the user adds awui's bridge there once (`awui setup mcp`) | `extensions/orchestrate-mcp.mjs`, run as `awui mcp` |

Nothing is installed into a user's harness config by awui, and no adapter asks the user to add a
server: the harness gets its own entry per chat, from what the adapter already passes. The one
harness without a per-chat transport is Hermes: one gateway owns its whole profile, so awui cannot
put a chat's two variables in its environment, and `awui setup mcp` prints the single entry that
harness's own CLI adds (inert until that changes). `awui doctor` says whether it is there. Claude Code reads a
`{"type":"http","url","headers"}` server out of `--mcp-config` with
`Authorization: Bearer ${AWUI_ORCH_TOKEN}` — a reference the CLI expands from the child's
environment, which awui fills, so the token never sits in `ps`. Codex gets
`mcp_servers.awui-orchestrate.url` and `bearer_token_env_var` as `-c` overrides on its command
line, for the same reason. DSH is handed an ACP `mcpServers` entry with `type: "http"` in
`session/new`; ACP expands no variables, so there the header carries the token's value, and it
travels down the child's stdin rather than its command line. A harness that cannot do HTTP keeps
the bridge, which speaks the same messages against the same routes.

The extension refuses to load without both variables, so a stray copy in a project's
extensions folder stays inert; the MCP paths serve no tool without them.

Claude Code is also given the tools in `--allowedTools` (as `mcp__awui-orchestrate__<tool>`),
because its MCP tools need an allow rule to run without a prompt; Codex and DSH take the
server alone. OpenCode needs neither an allow list nor a config file: awui registers the two
servers on OpenCode's own shared server for that chat and gives the chat's session two glob
rules — deny `awui-*`, allow its own two — where the last matching rule wins, so a second chat
in the same project cannot call this one's tools with this one's token. Every injected name
comes from the catalogue, so an allow list cannot drift from what is served.

`awui doctor` prints one line for all of it:
`✓ Orchestration: on (max 4 children per chat, depth 2, 12 live tasks)`, `!` when the surface is
on but `extensions/orchestrate.ts` cannot be found (so Pi and omp chats would get no tools), and a
plain `off` when config.yml has turned it off.

## Endpoints

All are mounted before `requireAuth` (like `/api/render`): they authenticate by the
token header alone, never a cookie, so a signed-in device elsewhere cannot mint one.

```
GET  /api/orchestration/tools              → { tools: [{ name, description, parameters }] }
GET  /api/orchestration/prompts            → { prompts: [{ name, description, text }] }
POST /api/orchestration/call               → { ok: true, text, data }
     X-Awui-Orch-Token: <32 hex>              or { ok: false, code, message }
     { "tool": "list_profiles", "args": {} }
POST /api/orchestration/mcp                → one JSON-RPC answer, or 202 for a notification
     Authorization: Bearer <32 hex>            (streamable HTTP MCP; no session, no stream)
     { "jsonrpc": "2.0", "id": 1, "method": "tools/list" }
```

The token header is the bridges' own; the MCP endpoint takes it as `Authorization: Bearer`
because that is what an MCP client sends, and it is the one header a harness can point at a
variable in its own environment. Both are the same token from the same store, and neither is
ever echoed in a body, a header, or a log.

The tool catalogue is the one source of truth for names, descriptions, and parameter
schemas; a bridge fetches it once at startup and registers what it finds. `text` is the
line the model reads, composed on the server so the wording exists once.

## The HTTP MCP endpoint

`POST /api/orchestration/mcp` is the same surface spoken as MCP: `initialize`, `ping`,
`tools/list`, `tools/call`, `prompts/list`, `prompts/get`, and a notification (no id) answered
`202` with an empty body. It answers `application/json` and keeps no session, so a reconnecting
client starts clean and `initialize` may be repeated; `GET` and `DELETE` answer `405` with
`Allow: POST`, because awui never sends a request of its own. A method it does not serve is a
JSON-RPC error (`-32601`, never a crash), so a newer client's own probe can fall back to
`initialize`.

Nothing behind it is a second implementation: the tools are `orchestration/tools.ts`, the words
are the same ones the bridges use, every call is `orchestrator.run` (so `callsPerMinute`, the
caps, and the records are shared), and the refusal a tool answers — `code: message` — comes back
as an `isError` result instead of a JSON-RPC error, exactly as it does through the stdio bridge.
The catalogue is served with each tool's schema under `inputSchema`, which is what an MCP client
validates; the REST route keeps the catalogue's own field name (`parameters`).

The token rule is the sibling routes': a handshake, the catalogue, and the skills need only a
token this server minted (a starting child asks before its chat is stamped onto the token), while
`tools/call` needs the live chat itself. Both rules answer the same failures — `orch_off` 404,
`bad_orch_token` 401, `orch_token_expired` 401 — in the `{ ok: false, code, message }` envelope.


The browser reads and stops the same tasks behind `requireAuth`, as the chat whose panel shows them:

```
GET  /api/chats/:id/tasks                 → { tasks: DelegatedTaskView[] }
POST /api/chats/:id/tasks/:taskId/cancel  → { task: DelegatedTaskView }
```

The rows are the ones the chat's snapshot carries, bounded the same way; the cancel is the stop
`task_cancel` makes, refused with the same `unknown_task` and `not_your_task`, but answered with the
record instead of a `cancel_timeout` when the child is slow to settle. Both stay reachable with
`orchestration.enabled: false`, so a child that is already running can still be stopped.

## Tools

| Tool | Arguments | Serves |
|---|---|---|
| `delegate_task` | `brief` (1–32 000 chars), `harness`, `profile`, `model`, `thinkingLevel`, `permissionMode`, `role`, `title`, `workspaceId`, `isolation` (`worktree`), `notify`, `clientRequestId`, `writeScope` (≤8 globs of ≤128 chars) | yes |
| `plan_workers` | `action` = `save` (title, ≤16 tasks with id/prompt/harness/model/writeScope/dependsOn, `maxParallel` 1–4, optional planId), `confirm` or `cancel` (planId) | yes |
| `task_review` | `taskId` (isolated tasks only) | yes |
| `task_status` | `taskId` (omitted: every task this chat started) | yes |
| `task_cancel` | `taskId` (idempotent) | yes |
| `thread_send` | `taskId`, `text` (1–32 000 chars) | yes |
| `thread_read` | `taskId`, `before`, `limit` (≤200, default 40) | yes |
| `thread_wait` | `taskIds` (1–4), `waitMs` (default 55 000, max 110 000) | yes |
| `list_profiles` | `workspaceId` | yes |
| `set_status` | `status` (`working`/`blocked`/`review`/`done`), `comment` (≤200 chars, optional) | yes |
| `request_decision` | `question` (1–200 chars), `decisionId` (≤128 chars), `message` (≤2 000 chars, optional), `kind` (`confirm`/`select`), `options` (≤6, for select), `waitMs` (≤110 000, optional) | yes |

`set_status` writes this chat's status line: one word for where the work stands and one
sentence a person reads in the sidebar's row, the chat's header, and its hover card
without opening the chat (`$XDG_STATE_HOME/awui/agent-status.json`, the newest 500
sessions, comments collapsed to one line and cut at 200 characters). It replaces the
previous line, and a chat the harness has not named yet answers `no_session`.

`list_profiles` lists the project's saved bot profiles and one entry per installed
harness at its default model — `{ id, source, name, harnessId, harnessName, available,
model, provider, thinkingLevel, permissionMode, role, note }` — with how many delegation
levels and tasks are left.

## Decision gates

`request_decision` is how a delegated worker blocks on an explicit human decision. The question
goes on the worker's own chat as a regular request item — the same card, stream, and answer route
as any harness question — so the person answers it without knowing it came from the orchestrator,
and the parked call returns the recorded answer verbatim, a denial's corrective reason riding
beside it (`Their correction: …`). Only a live delegated task's worker may ask (`not_delegated`
otherwise): the tool binds to its calling task, and only the chat the question was raised on —
matched by its harness session too, so a resumed worker still answers its own — records the
answer; a cross-agent answer is denied (409), a second answer sees the first.

A retry with the caller's own stable `decisionId` never asks twice: an answered decision returns
its recorded verdict at once, a pending one parks again on it. A call whose `waitMs` passes
returns `state: "pending"` with the question still on the chat — the person can still answer it,
and the caller asks again with the same `decisionId`. Unresolved decisions persist in
`$XDG_STATE_HOME/awui/orchestration/decisions.json` (the newest 200, resolved rows pruned after a
week): a restart re-raises the question on the worker's chat when it opens and never auto-answers
it, because only the person may answer. The worker's task row reads *Waiting* with the question's
title while its decision stands, and the parent's `thread_wait` reports it, exactly as it does for
a harness question.

| `resident_agent` | optional `name` (1–80 lowercase chars; required to create/query a purpose), `profile`, `workspaceId`, `prompt` (≤32 000 chars, required on first use), `note` (`key`,`text` ≤4 000), `forget` | yes |

`resident_agent` names one ordinary native harness session for repeated responsibility. Its transcript stays with the harness; `residents.json` stores its id and bounded auxiliary notes. `note` adds a small fact for future continuity; `forget` removes it alone. Calls to a live busy session are refused rather than silently creating another writer.

`(calling session, purpose)` is the identity. A separate owner can also request `reviewer`; it opens a distinct native session and cannot read this owner's notes. When the original caller reopens or resumes after disposal or restart, the harness's actual native session comes back. No arbitrary session switch is selected merely from a declared name.

`completionGroup` on `delegate_task` (≤128 chars) delays the group's report until every named member settles. It is the same durable wake with bounded content, but holds earlier partial results until the last task; non-member reports keep their normal timing and semantics.

`tasks.json` and `residents.json` have identity/result pointers only: at most 24 notes per caller-purpose (≤4 KiB each), filtered for credential-shaped content on save and load. Redaction is a defensive filter, not a blanket secret-detection guarantee; never rely on it to safely input secrets. This supplement lives outside the native transcript, never replaces it.

## Skills
Three skills turn the tools into common habits. Each is plain markdown under `skills/` at the
repo root — `council`, `advisor`, `handoff` — and each is written for an agent in any harness to
follow using only the tools above. Nothing is installed into a harness's own skill folder.

| Skill | Asks for | What it does |
|---|---|---|
| `council` | "council this diff", "put three models on it" | `list_profiles` for three providers, three `delegate_task` calls in one turn (role `review`), `thread_wait` on all three, one merged verdict, and at most one more round carrying the briefs, the verdicts, and the objections. It stops when all three approve or round 2 ends, and its score table says "no score" rather than inventing one. |
| `advisor` | "ask an advisor", "what would another model say" | one `delegate_task` (role `review`) with a self-contained brief ending `Review only. Change nothing.`, then the answer reported with the model that gave it. |
| `handoff` | "hand this to a fresh agent" | a zero-context briefing built from the `task_status` and `thread_read` records plus the current state — goal, done, decisions, files, next steps, pitfalls — delegated as a new chat. |

How an agent gets those words depends on the harness. Claude Code, Codex, and DeepSeek Harness
receive them as **MCP prompts** from the same `awui-orchestrate` server that carries the tools
(`prompts/list` and `prompts/get`), backed by `GET /api/orchestration/prompts`, which serves
`skills/<name>/SKILL.md` itself; the compiled binary embeds the same three files, so a packaged
awui offers them too. Grok Build gets that server too, as an ACP stdio entry on the session.
Whether a client shows MCP prompts as commands is **unverified** except for Claude Code, which
documents them; Codex, DSH, and Grok may only expose them programmatically. Pi and omp have a
tools-only extension API and no prompt mechanism, OpenCode gets the prompts from that same
server but shows them only where its own client does, and Hermes has no tools of awui's in a
chat yet — there the skill is a file: ask the agent to read `skills/council/SKILL.md` and
follow it, or paste the text in. The file and the prompt are one source, so they cannot drift.

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

## In the web UI

A parent's tasks are drawn above its composer, in the status stack (`DelegatedTasks.tsx`): one row per
task with a chip for how it stands (*Working*, *Waiting*, then the outcome), the title, the agent
running it (`harness · model · role`), a clock, **Open** (the child chat beside the parent, or in its
own tab on a phone) and **Cancel**. A task waiting on an answer says which question, by its title
only. The rows come from the chat's snapshot and are kept current by its `task` events, so nothing
polls; a reopened parent gets them back from the records, matched by its harness session.

A delegated child carries a *Delegated by …* chip in its header (`LineageChip.tsx`), which opens the
parent. The chip is the only mark of provenance: the child is an ordinary chat in every other way —
in the sidebar, in search, in the tab strip.

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
is woken with the result), `clientRequestId` (a repeat returns the same task instead of
spawning a second child), and `writeScope` (see below).

A child inherits the caller's permission mode. An explicit one must rank at or below the
caller's own by the caller's own harness ordering (broadest last); a mode the caller does not
have cannot be ranked and is never granted. A read-only harness (`awui`) can neither
delegate nor host a child.

## Write scopes

A delegated task can be held to a **write scope**: an optional list of project-relative globs
(`src/**`, `tests/**`, `**/*.test.*`) its file writes must match, plus a private scratch dir it
alone was given. The guard (`orchestration/scope.ts`) judges every tool write and every harness
permission request against it, so a worker's edits stay inside its assignment.

- **The scratch dir** is `<project>/.awui/scratch/<taskId>`, inside the control folder the
  agent's own file listings skip. A write there is always allowed, scoped or not.
- **A pattern holding `..`** is refused before any work starts (`bad_scope`): a resolved path
  never contains one, so such a pattern could only ever be dead weight the model trusts in vain.
  A relative path's `..` segments are still resolved against the project, so `src/../notes.md`
  is judged as `notes.md` — traversal cannot sneak past the glob.
- **With no globs**, the worker may write anywhere inside the project; a path resolving outside
  the project is still refused.

**How it is enforced.** The assignment contract travels inside the brief between the
hidden-envelope markers (the same markers Board consultations use, escaped in the brief first so
a quoted contract is read as quoted) — a machine-readable payload the worker reads as a contract
rather than prose. On top of that, two halves, declared honestly per harness:

- **Prevent** (a harness whose `supportsInteractiveRequests` is declared): the harness raises
  its own permission request before a write, and awui answers **Deny** on an ask the scope
  refuses — before the tool runs. The child is told what was blocked and why, so it can re-plan
  inside its assignment; the task's record counts the blocked write.
- **Detect** (every harness whose tool events awui watches): a write that landed (or errored)
  outside the scope is seen in the settled tool row and reported. The wording says
  *"reported, not blocked"*, because it was: the record never claims a universal guarantee
  across harnesses that cannot pre-empt writes.

A harness that can only detect reports alone and honestly; the parent's `task_status` and
`thread_read` answers carry the counts either way:

```
[write scope: src/** · 1 out-of-scope write (1 blocked, 0 landed)]
```

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

**Wakes are budgeted.** `wakeParents: false` turns delivery off: a finished task's report is marked
`skipped` as `wakes are off` and nothing is sent. With wakes on, `maxWakesPerHour` caps the wake
prompts one parent receives in an hour (a prompt carrying three reports counts once); past it, its
reports are marked `skipped` as `wake budget used up`. Neither silences the result itself:
`task_status`, `thread_wait`, and `thread_read` answer exactly as before, and the task's record says
why the parent was not woken.

**Calls are budgeted too.** `callsPerMinute` is a sliding one-minute window per calling chat on
`POST /api/orchestration/call`, whatever the tool. Over it, the call answers `too_many_calls` (429)
with how long to wait, so a looping agent gets a clear answer instead of an unbounded run of
delegations.

## Review-gated integration

"Completed" is not "reviewed". `delegate_task` with `isolation: "worktree"` runs the child in its
own managed worktree of the project (`.awui/worktrees/task-…`, seeded like any managed tree, on
its own `awui/…` branch) instead of the caller's shared working tree, so its edits cannot collide
with the caller's. The fork point — the project's HEAD when the worktree was created — is recorded
on the task. A task that shared the tree (the default) has nothing to review: its edits landed in
the caller's own working tree, where the caller already sees them.

When an isolated worker settles `done`, its work becomes a review record
(`$XDG_STATE_HOME/awui/orchestration/integration.json`, mode 0600): the worktree, its branch, the
fork point, and the lead checkout's HEAD as it stood then. The task's row and the `task_review`
tool answer say **unreviewed** until a person decides. The person applies or discards from the
chat's task panel (`POST /api/chats/:id/tasks/:taskId/review` with `decision`, `note`, and the
project's `workspaceId`); `POST .../unreview` puts a decision back so a mis-taken discard can be
decided again — only an applied review is final, because the work has already moved.

An **apply** puts the worker's diff against the fork point into the lead checkout's working tree,
unstaged, and only while both recorded heads still stand: the lead checkout at the recorded head,
and the worker's branch at the fork. It is the same patch a race's apply writes — a clean lead
checkout, fixed diff options (so the checkout's own `diff.noprefix` or a textconv driver cannot
move a new file), and the patch carried as bytes. Nothing is committed, pushed, or moved; the
branch stays as it was. A **mismatched head refuses before anything is written** (`lead_moved`,
`worker_changed`) and keeps the worktree with an actionable sentence: merge or cherry-pick by
hand, then discard the record. No work is ever erased by a stale state.

**Cleanup refuses unreviewed modifications.** `POST .../review/cleanup` takes a settled worker's
worktree and branch only after a decision exists on the record — an unreviewed worktree answers
`unreviewed` and stays, however clean or dirty it is. A reviewed tree's uncommitted work is
exactly what the person reviewed (the panel's diff route shows it), so a settled record removes
behind that guard; git's own refusals (a lock, a nested checkout) keep the tree, and `-d` refuses
a branch whose commits the lead lacks, so no committed work is lost.

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
(`{ ok: false, code, message }`). The codes are one typed union
(`OrchDenialCode`, in `orchestration/types.ts`), so a typo in a code is a
compile error; the human sentence always rides beside the code. Over the HTTP
MCP endpoint a refusal is a JSON-RPC result with `isError: true`, the text
reading `code: message`, and the same pair as `structuredContent`
(`{ ok: false, code, message }`) for an agent that tests the code rather than
parsing the words:

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
| `bad_scope` | 400 | a `writeScope` pattern holds `..`; name paths inside the project |
| `caller_read_only` | 403 | a read-only harness may not delegate |
| `mode_escalation_denied` | 403 | a permission mode broader than the caller's own |
| `max_depth` | 429 | the caller is already as deep as delegation goes |
| `too_many_tasks` | 429 | a per-chat, per-server, or depth cap |
| `too_many_calls` | 429 | this chat went past `callsPerMinute`; the message says when to retry |
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
