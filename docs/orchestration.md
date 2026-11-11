# Orchestration

An awui chat's agent can hand a self-contained task to another agent — a fresh chat in the
same project, on any installed harness — and then watch it, wait for it, or stop it. The
surface is a small fixed set of tools, identical for every harness, served by the same
process that runs the chats.

This page describes the surface, its limits, and its error codes. Status: the token
surface, the tool catalogue, and `list_profiles` are live; the delegation tools are
defined and answer `unknown_tool` until the task store and the injections ship.

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
| `delegate_task` | `brief` (1–32 000 chars), `harness`, `profile`, `model`, `thinkingLevel`, `permissionMode`, `role`, `title`, `workspaceId`, `notify`, `clientRequestId` | not yet |
| `task_status` | `taskId` (omitted: every task this chat started) | not yet |
| `task_cancel` | `taskId` (idempotent) | not yet |
| `thread_send` | `taskId`, `text` | not yet |
| `thread_read` | `taskId`, `before`, `limit` (≤200) | not yet |
| `thread_wait` | `taskIds` (1–4), `waitMs` (default 55 000, max 110 000) | not yet |
| `list_profiles` | `workspaceId` | yes |

`list_profiles` lists the project's saved bot profiles and one entry per installed
harness at its default model — `{ id, source, name, harnessId, harnessName, available,
model, provider, thinkingLevel, permissionMode, role, note }` — with how many delegation
levels and tasks are left.

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
| `not_your_task` | 403 | the task belongs to another chat |
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
