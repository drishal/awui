# Mesh

Running one awui's agent on another machine's, over SSH or Docker, without opening
any port. **Phase 1** is live: a chat can hand a delegated task to a paired peer,
the peer's own awui opens the harness session on its own machine, and the run
streams back as an ordinary delegated task in your chat. **Phase 1.5** is live on
top of it: when the peer runs awui as a service, its tasks survive the SSH
session that started them (a dropped link reconnects and replays what it missed),
its approvals can be answered in its own UI, and the leader can read and write
files there.

## What it is

A `mesh:` block in `config.yml` names peer machines (how to reach them) and named
policies (what a peer may do *here*). A delegated task whose `peer` names a paired
machine runs there: the child chat is a relay to the peer's own awui, which opens
the harness session locally — with its own credentials, inside the roots its
policy allows. Approvals render on the leader, so you answer them in your own UI.
The task's row and board card carry an `@host` badge, so it is always plain which
machine is doing the work. Until `mesh.enabled: true` is set the whole feature is
inert — nothing listens, nothing spawns, and the block is still validated, so a
typo is caught at startup.

## Principles

- **Off by default.** `mesh.enabled` absent or false is off. `AWUI_MESH=0` forces
  it off; no environment variable forces it on.
- **Policy is enforced on the target.** The caller only requests; the worker's
  policy decides on every call, re-read from config each time, so an `accept`, a
  `remove`, or an edit bites on the very next request.
- **`max_hops` is exactly 1.** A peer's peer is not reachable through it; a remote
  child is opened without orchestration tools at all, so it cannot delegate, and
  an explicit hop check refuses anything that tries.
- **No `exec` capability exists.** The vocabulary is fixed and closed:
  `discover`, `task.run`, `task.approve`, `fs.read`, `fs.write`, `term.open`.
- **Discovery is never trust.** Identity is a pinned Ed25519 key, not a name.
- **The peer channel is never `/api/*`** and never relies on loopback trust
  (see [Security](security.md): a loopback request is not local when it arrives
  through a proxy, and the mesh gives peers no HTTP route at all).

## Quick start (SSH)

Two machines: **you** (the leader, where you chat) and **lab-vm-3** (the worker,
where the agent runs). Both need awui installed.

1. **Worker** — set the mesh on and give the leader a policy to arrive under
   (`~/.config/awui/config.yml` on lab-vm-3):

   ```yaml
   mesh:
     enabled: true
   policies:
     worker:
       roots: [~/code]      # the only folders a peer task may touch
   ```

   The built-in `worker` policy already allows task runs and approvals at origin,
   at an auto-edit ceiling, for the pi, claude, and codex harnesses; `roots` is
   what you must add, because every built-in ships with none.

2. **Leader** — name the peer and how to reach it (`config.yml` on your machine):

   ```yaml
   mesh:
     enabled: true
   peers:
     - name: lab-vm-3
       ssh: drishal@lab-vm-3
       # awui_path: /home/drishal/.local/bin/awui   # if `awui` is not on the remote PATH
   ```

3. **Pair the two.** On the leader:

   ```
   awui peer add lab-vm-3
   ```

   This connects once, prints the worker's **node id** and a six-digit **SAS**,
   and asks to pin the key. Compare the node id on both screens, then answer `y`.
   It then prints the line to run on the worker:

   ```
   awui peer accept leader-box --policy worker
   ```

   Run that on lab-vm-3. It shows the same numbers from its side; compare, answer
   `y`, and the pairing is complete. (`awui peer status` on either machine prints
   its own node id and public key whenever you want to re-check.)

4. **Use it.** In any chat on the leader, ask:

   > delegate this to lab-vm-3 in ~/code/app: fix the failing parser test

   The task appears as an ordinary delegated task with an `@lab-vm-3` badge, its
   approval cards open in your chat, and its result arrives like any other.

**Optional: authorized_keys forced command.** Without one, anyone who can SSH in
already has a shell, so `--policy` grants nothing extra. With one, the SSH key
itself is bound to the policy, and the worker pins the leader's key automatically
on first contact (no separate `accept` needed):

```
# lab-vm-3:~/.ssh/authorized_keys — one line, a key dedicated to the mesh
restrict,command="/home/drishal/.local/bin/awui peer serve-stdio --policy worker --peer leader-box" ssh-ed25519 AAAA... awui-mesh
```

## Quick start (Docker)

A container that has awui installed (`npm ci && npm run build`, or the binary
copied in) replaces the SSH hop:

```yaml
mesh:
  enabled: true
peers:
  - name: ci-box
    docker: awui-worker-1
    # engine: podman        # default docker
```

`awui peer add ci-box`, then inside the container `awui peer accept … --policy
worker`, exactly as over SSH. The container's awui needs its own config.yml with
`mesh.enabled: true` and the policy's `roots` set to paths inside the container.

## How it works

- **Transport.** The link is one `ssh -T` or `docker exec -i` carrying
  newline-delimited JSON-RPC 2.0 over stdio (`awui-mesh/1`). The local side never
  builds a shell command: the argv is assembled word by word, and the one string
  ssh hands to the remote shell is single-quoted token by token. The worker
  writes a `AWUI-MESH/1 READY` preamble first, so login MOTD noise is skipped,
  and everything it logs goes to stderr.
- **Handshake.** Mutual and signed before anything else: each side signs the
  other's fresh nonce under a distinct domain string, and each holds the other to
  its pin (a changed key is a close, never a warning). Both sides derive the same
  six-digit SAS from the two public keys for a person to compare on first contact.
- **Pins.** `$STATE/mesh/pins.json`, mode 0600, written atomically. Outbound pins
  are keyed by the peer's configured name, inbound pins by node id; pending
  requests (seen but not yet accepted) are capped at 16 and expire after an hour.
- **Policy, per call.** The worker resolves the caller's inbound policy on every
  request — pins re-read from disk, config re-read at most every 2 s — so
  revocation is immediate. The policy fixes the harness allowlist, the permission
  ceiling, the roots, and the task count.
- **Approvals at origin.** An approval card the worker's harness raises is relayed
  to the leader and answered there; the worker never decides for you.
- **One hop, structurally.** The remote child's harness session is opened without
  orchestration tools, so there is no `delegate_task` on the far side at all, and
  the wire's `hops` check refuses a second hop besides.

## Harness permissions

The policy's `permission_ceiling` is mapped to the harness's own permission mode:

| Ceiling | Claude Code | Codex | Harnesses with no modes (pi, omp, …) |
|---|---|---|---|
| `read-only` | `plan` | `read-only` | refused — say `auto-edit` |
| `default` | `default` | `read-only` | refused — say `auto-edit` |
| `auto-edit` | `acceptEdits` | `auto` | allowed, no mode to set |

A mapping the harness does not offer is a refusal, not a silent grant, and the
full-access modes (`bypassPermissions`, `full-access`) are never mapped for any
harness. Harnesses with no permission modes at all — pi, for one — cannot be held
to less than themselves: they run only under an `auto-edit` ceiling, and once
they do, they can run commands as the worker's user, on the worker's machine.
That is what the policy's roots bound, not the harness; choose the roots for a
pi-backed worker accordingly.

## CLI

```
awui peer status                       mesh on/off, this node's name, node id, public key, peers, pins
awui peer add <name> [--yes]           first contact: pin the peer's key (asks; --yes for scripts)
awui peer accept <name> --policy <p> [--yes]   on the target: pin a pending caller under a policy
awui peer list                         the configured peers and their pin state
awui peer test <name>                  handshake + peer.info, without opening a task
awui peer remove <name>                forget a peer: drop its outbound, inbound and pending pins
awui peer log [--peer <name>] [--tail N]   the audit log of decisions this node made
awui peer ls <name> <path>             a folder on a peer: names, types, sizes
awui peer cat <name> <path>            a peer file's bytes, raw to stdout (at most 4 MiB)
awui peer tasks <name>                 the peer's live tasks (its awui service runs them)
awui peer serve-stdio [--peer <name>] [--policy <p>] [--ephemeral] [--attach]   the worker end of a link
```

Exit codes: 0 ok, 1 failed, 2 usage, 78 mesh off or config.yml broken. `add` and
`accept` ask before they pin, and refuse without a terminal unless `--yes` is
given. `remove` is revocation: it takes effect on the peer's next call, no
restart needed on either side.

## Phase 1.5: the daemon, and files

### The attach socket

When the awui *service* starts with the mesh on, it also listens on a Unix
socket: `$XDG_RUNTIME_DIR/awui-mesh.sock` when that directory exists and is
owned by this user (mode 0700), else `<state dir>/mesh/attach.sock` (the
directory created 0700, the socket chmod 0600 after listen). `AWUI_MESH_SOCKET`
overrides the path (tests). A stale socket file is unlinked when nothing is
listening behind it; a non-socket file there is a refusal (logged, attach off).
Turning the mesh off at runtime closes the listener and every attached link.
Windows has no attach socket: workers there are ephemeral.

`awui peer serve-stdio` — the worker end — tries that socket first (1 s
connect timeout). On success the link lives inside the running service, which
already has the config, the harnesses, and the chat manager open. On failure
the command falls back to the P1 in-process serve and logs one line on stderr:

```
awui: mesh: no running awui service, serving this link in-process (tasks end with the link)
```

`--ephemeral` skips the socket and always serves in-process; `--attach` makes
the fallback an error (exit 75, `EX_TEMPFAIL`) instead of a silent downgrade.
Run the worker as a service (`awui install service`) and every link attaches
automatically.

### Tasks that outlive a link

In daemon mode a task is owned by the service, keyed by its remote id and the
peer's node id, and closing a link only drops that link's subscription — the
run keeps going. Any later link that authenticates as the same node id may
reattach: `task.attach {remoteTaskId, afterSeq}` replays the task's last 2000
buffered events from after that sequence number and then goes live, so the
leader's side of a dropped SSH session reconnects on a backoff schedule
(1, 2, 4, 8, 16, 30 s; give up after 2 minutes), reattaches with the last event
it saw, and folds the replay in order — no duplicates, no silent gaps. When the
buffer does not reach back (a long outage), the leader says so in one notice.
A task that no longer exists (`not_found`), or a worker that predates attach
(an ephemeral P1 peer, `-32601`), still ends the run as P1 did. A leader
restart still marks its peer tasks interrupted; in daemon mode the remote run
continues without it, and `awui peer tasks <name>` shows it.

The service counts a peer's live tasks per node id (not per link), so one key
holder across several SSH sessions no longer multiplies `max_tasks`. Tasks are
in memory: a service restart ends them, and the leader sees a link close or a
`not_found` on its next attach.

**Approvals on the target** now work in daemon mode. `approvals_at: target`
policies can open tasks: the approval cards show in the target's own awui UI,
on the chat the task opened, and the peer may not answer them (`task.answer`
is refused). `both` lets either side answer; first answer wins and the other
side is told the request is gone. `origin` is unchanged. Ephemeral workers
keep the P1 refusals for `target` and `both`.

### Files over the link

`fs.stat`, `fs.list`, `fs.read`, and `fs.write` carry the policy's `fs.read`
and `fs.write` capabilities, decided per call like every other cap (a cap set
to `ask` is refused with `needs_approval`). Both ephemeral and daemon workers
answer them. Every path is resolved inside the policy's roots on every call
(`..` refused, and the result's realpath must stay in a root after resolution):

| Method | Shape | Bound |
|---|---|---|
| `fs.stat` | `{type: file\|dir\|symlink\|other, size, mtimeMs, mode}` | lstat: the final symlink is never followed |
| `fs.list` | `{entries: [{name, type, size}], truncated}` | at most 1000 names (default 500), one folder, dotfiles in, sorted |
| `fs.read` | `{data: base64, size, eof}` | regular files only, at most 4 MiB per call (default 1 MiB) |
| `fs.write` | `{size, mtimeMs}` | at most 4 MiB decoded; `create` refuses an existing file; `overwrite` replaces only a regular file |

A write is atomic: a temp file in the destination's own directory
(`.<name>.awui-<rand>.tmp`, 0600 then the file's mode), fsync, rename. With
`expectMtimeMs`, a file that changed since it was read is refused with
"changed since read" instead of overwritten. A link may write at most 32
times a minute. A read or write never follows the final component through a
symlink (`O_NOFOLLOW` where the OS offers it, else an lstat/open/fstat
dev-and-inode check). The audit log records the method, the path, and byte
counts — never content.

### peer_files

In a lead chat on a mesh-enabled server with a peer configured, the agent has
`peer_files`: one file operation per call — `stat`, `list`, `read`, or
`write` — against the same link a delegated task uses. It is text in and out:
a read that is not utf8 is refused rather than handed to the model, a write is
at most 1 MiB of text, and a file longer than one read says so, for the agent
to continue with an offset. The same lead-only rules a peer delegation passes
apply (mesh on, `mesh.chats`, one hop, a configured peer) — the peer's own
policy, its roots and caps, is what actually decides.

### Still missing

- **Ask-capabilities** (`ask:` caps): a cap that needs an approval mid-run is
  refused with a clear error (`-33003 needs_approval`), not raised as a card.
- **Terminals** (`term.open` is named in policies but carries nothing).
- **Host tasks across a target restart**: they are in memory, not persisted.
- **Direct TLS** with pinned keys (P2).

### Limits that remain

- **Ephemeral workers still count `max_tasks` per link** — one `serve-stdio`
  process per SSH/docker session. Only a daemon counts per peer. With a
  forced-command key, also set `MaxSessions` and keep the policy's ceiling low.
- **Pin writes are last-writer-wins across processes.** The server, the CLI
  and each `serve-stdio` process write `pins.json` atomically (temp + rename),
  so the file never corrupts, but two writes at the same instant can drop one.
  A lost write always fails closed (a peer reads as not paired); re-run the
  command.
- **cwd is checked, then used.** The path is realpath-checked against the
  roots and then handed to the harness; someone who can already write inside a
  root could race a symlink swap in between. Harnesses with no permission modes
  (pi) can run commands anyway, so this matters only for read-only peers that
  share a root with a hostile writer. The file methods above do not have this
  gap: each one resolves, checks, and opens under the check.

## State files

Under the state folder, never in git, never in config:

- `mesh/identity.json` — `{v:1, publicKey, privateKey}` (Ed25519, base64url raw
  public key, PKCS8 PEM private key), mode 0600 in a 0700 directory. Created on
  first use, not at startup; a malformed file is never regenerated.
- `mesh/pins.json` — the peers this machine pins, inbound and outbound, mode 0600.
- `mesh/audit.jsonl` — append-only, one JSON object per line, mode 0600: who
  asked for what and what this node answered. Prompt text is never logged, only
  lengths; the file methods record paths and byte counts, never content.
- `mesh/attach.sock` — the attach socket, when `$XDG_RUNTIME_DIR` is not usable
  (the usual place is there; see the attach socket above), mode 0600.

## Security notes

- **The peer channel is never `/api/*`.** A peer gets a stdio protocol with a
  closed method table, not an HTTP client of this awui, and nothing in the mesh
  trusts loopback.
- **No shell on the local side.** The leader spawns `ssh`/`docker exec` from argv;
  destinations are validated host/container shapes, `ssh_opts` entries are
  checked for newlines and NULs, and nothing is re-parsed by a shell here.
- **Keys are the identity.** A peer whose key changes is closed with a pin
  mismatch until a person runs `awui peer remove` and re-pins; names never stand
  in for keys.
- **The attach socket's trust is this uid.** Only the same user can open the
  socket (0600, in a 0700 directory), and that user could already edit
  `pins.json` and run the CLI — so the one-line prologue a worker sends it is
  trusted exactly as much as the CLI is, and no more.
- **Files never follow a final symlink.** `fs.read` and `fs.write` hold the
  last component to a regular file (lstat, then `O_NOFOLLOW`, then an fstat
  dev-and-inode check), so a link inside a root cannot name a file outside it.
- **Writes are atomic and rate-limited.** Temp file in the destination's own
  directory, fsync, rename — a reader never sees a half-written file — and at
  most 32 writes a minute per link.
- **The audit log is evidence.** Every decision (allow, deny, ask, error) is one
  bounded line in `mesh/audit.jsonl`; the file methods record paths and byte
  counts, never content.
- **Revocation is one command.** `awui peer remove <name>` drops every pin under
  that name; because the policy is resolved per call, the next request from that
  peer is refused — no restart on either side.

## Roadmap

- **Phase 1** — shipped: SSH and Docker stdio transports; `delegate_task(peer)`.
- **Phase 1.5** — shipped: the attach socket and daemon-mode tasks (a dropped link
  reconnects and replays), approvals on the target, files over the link (`fs.*`,
  `peer_files`, the `peer ls/cat/tasks` commands).
- **Phase 2** — direct TLS with pinned keys; a Peers UI; pairing.
- **Phase 3** — remote terminals, handoff, a NixOS module.

## Phone follow is separate

The phone's push approvals come through [Tailscale Serve](security.md#tailscale)
against this server's own UI. The mesh never serves `/api/*`: a peer gets a
policy-bound channel, not an HTTP client of this awui.
