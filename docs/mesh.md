# Mesh

Running one awui's agent on another machine's, over SSH, Docker, or a direct TLS
link, without an HTTP port. **Phase 1** is live: a chat can hand a delegated task
to a paired peer, the peer's own awui opens the harness session on its own
machine, and the run streams back as an ordinary delegated task in your chat.
**Phase 1.5** is live on top of it: when the peer runs awui as a service, its
tasks survive the SSH session that started them (a dropped link reconnects and
replays what it missed), its approvals can be answered in its own UI, and the
leader can read and write files there. **Phase 2** adds a direct TLS transport
with pinned keys (no SSH hop, no Tailscale), ask-approvals answered on the
target, and pairing by invite code or QR through a Peers UI. **Phase 3** adds
remote terminals on a peer, handoff (move a chat's work to a peer and fetch the
result back), and a NixOS module with `awui peer bootstrap` for machines it does
not manage.

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

## Quick start (direct TLS)

Two machines that can already reach each other over the network, and one port
you choose to open. No SSH account, no shared shell: the link is TLS 1.3
carrying the same `awui-mesh/1` stream, and identity is a pinned Ed25519 key.
Nothing listens until `mesh.listen` is set, and the TLS port speaks only
awui-mesh/1 — a peer never reaches `/api/*` and never sees your web UI.

1. **Worker** (the machine that will run the agent), `~/.config/awui/config.yml`:

   ```yaml
   mesh:
     enabled: true
     listen:
       host: 192.168.1.20   # the address inbound links bind; required, no default
       port: 4784           # default; 0.0.0.0/:: work but the doctor warns
     policies:
       worker:
         roots: [~/code]
   ```

2. **Leader** (where you chat):

   ```yaml
   mesh:
     enabled: true
     peers:
       - name: lab-vm-3
         tls: 192.168.1.20:4784
   ```

3. **Pair.** Either way works:
   - `awui peer add lab-vm-3` on the leader, then `awui peer accept leader-box
     --policy worker` on the worker — the same TOFU-first-contact dance as SSH
     (compare node id and SAS, answer `y`), or
   - `awui peer invite` on the worker (the listener must be on), paste the
     printed `awui-invite:1:…` code — or scan its QR — into `awui peer join
     <code> --name lab-vm-3` on the leader. The key travels in the code, so
     there is no first-contact to trust; the worker still Accepts the joiner
     under a policy before anything runs.

The certificate the TLS listener presents is self-signed and not trusted by
anyone: the handshake against the pinned key is what a link stands or falls on.

## How it works

- **Transport.** The link is one `ssh -T`, one `docker exec -i`, or a direct
  TLS connection, carrying newline-delimited JSON-RPC 2.0 (`awui-mesh/1`) over
  stdio or the TLS stream. The local side never builds a shell command: the argv
  is assembled word by word, and the one string ssh hands to the remote shell is
  single-quoted token by token. The worker writes a `AWUI-MESH/1 READY`
  preamble first, so login MOTD noise is skipped, and everything it logs goes to
  stderr. The TLS link is raw TLS 1.3 — deliberately not WebSocket framing:
  node-to-node needs a byte stream, and raw TLS keeps the one NDJSON parser
  instead of adding a second one.
- **Handshake.** Mutual and signed before anything else: each side signs the
  other's fresh nonce under a distinct domain string, and each holds the other to
  its pin (a changed key is a close, never a warning). Both sides derive the same
  six-digit SAS from the two public keys for a person to compare on first contact.
- **Pins.** `$STATE/mesh/pins.json`, mode 0600, written atomically. Outbound pins
  are keyed by the peer's configured name, inbound pins by node id; pending
  requests (seen but not yet accepted) are capped at 16 and expire after an hour.
- **Policy, per call.** The worker resolves the caller's inbound policy on every
  request — pins re-read from disk, config re-read at most every 2 s — so
  revocation is immediate. A peer entry of the caller's name re-points the
  policy, from config.yml or from `peers.json` (config wins on a clash). The
  policy fixes the harness allowlist, the permission ceiling, the roots, and
  the task count.
- **Approvals at origin by default.** With the built-in `worker` policy an
  approval card the worker's harness raises is relayed to the leader and
  answered there. A policy may move approvals to the target (`approvals_at:
  target` or `both`) or put a cap behind a target-side ask, in which case the
  target's own owner answers; see the pairing and approvals sections below,
  which supersede this default.
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
awui peer list                         config.yml's and saved peers, with their pin state
awui peer test <name>                  handshake + peer.info, without opening a task
awui peer remove <name>                forget a peer: drop its pins and saved entry (config.yml stays yours)
awui peer log [--peer <name>] [--tail N]   the audit log of decisions this node made
awui peer ls <name> <path>             a folder on a peer: names, types, sizes
awui peer cat <name> <path>            a peer file's bytes, raw to stdout (at most 4 MiB)
awui peer tasks <name>                 the peer's live tasks (its awui service runs them)
awui peer fetch <name> <remoteTaskId|worktree>   bring a peer's handed-off work home as one ref
awui peer approvals                    what this node's service is waiting for you to answer
awui peer approve <id> [--for-link]    answer one: allow once, or for this link's lifetime
awui peer deny <id>                    answer one: no
awui peer invite [--policy <p>] [--ttl 10m] [--address host:port ...]   a single-use pairing code, with a terminal QR
awui peer join <code> [--name <n>]     pin the key the code carries, redeem it over TLS, save the peer
awui peer serve-stdio [--peer <name>] [--policy <p>] [--ephemeral] [--attach]   the worker end of a link
awui peer bootstrap <ssh-dest> [--policy <p>] [--root <path>] [--pubkey <path>] [--run]
                                      the setup commands for a worker machine (with --run: over ssh, asked)
```

Exit codes: 0 ok, 1 failed, 2 usage, 78 mesh off or config.yml broken. `add` and
`accept` ask before they pin, and refuse without a terminal unless `--yes` is
given. `remove` is revocation: it drops the pins and a saved peer's peers.json
entry (a `mesh.peers` entry in config.yml is yours to edit), and it takes effect
on the peer's next call, no restart needed on either side.

### Adding a machine from a chat

The same add/accept dance is available conversationally, for a lead chat on a
mesh-enabled node:

1. The machine is already running awui with `mesh.enabled: true` and a policy
   root (Quick start above), and its address is reachable.
2. Ask: *"Add the VM at 192.168.1.20:4784 as lab-vm."* The agent calls
   `mesh_peer_add {name, tls}`; the peer is saved in peers.json and first
   contact returns its node id and six-digit SAS.
3. Compare the SAS with `awui peer status` on that machine. If they match, say
   so; the agent calls `mesh_peer_pair {name, sas}` and the key is pinned. A
   mismatch is refused and the link closed, and a key that changes later is a
   pin mismatch until someone runs `awui peer remove` and pairs again.
4. On the target its owner runs `awui peer accept <this node> --policy worker`
   (the tool prints the exact line).
5. If you version config.yml, ask *"put lab-vm in config.yml"*:
   `mesh_peer_sync_config` appends it under `mesh.peers`, keeping comments and
   key order, and removes the peers.json copy. It writes only a plain,
   writable config.yml whose mesh is already enabled; a symlinked or rendered
   config is refused and peers.json stays the source.

`mesh_peer_add` never pins on its own: the key is pinned only after a person
confirms the digits. All three tools are lead-chat only.

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

In daemon mode a task's chat is a real chat in the target's own awui, so its
folder must also be inside that server's workspace roots (`WORKSPACE_ROOTS`);
a mesh root outside them is refused at `task.open`. One file call carries at
most 512 KiB: base64 inside one JSON-RPC line must fit the 1 MiB wire bound.

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
to `ask` waits for the target's owner when the worker is a service, and is
refused with `needs_approval` on an ephemeral one). Both ephemeral and daemon
workers answer them. Every path is resolved inside the policy's roots on every call
(`..` refused, and the result's realpath must stay in a root after resolution):

| Method | Shape | Bound |
|---|---|---|
| `fs.stat` | `{type: file\|dir\|symlink\|other, size, mtimeMs, mode}` | lstat: the final symlink is never followed |
| `fs.list` | `{entries: [{name, type, size}], truncated}` | at most 1000 names (default 500), one folder, dotfiles in, sorted |
| `fs.read` | `{data: base64, size, eof}` | regular files only, at most 512 KiB per call (the default); page larger files with `offset` |
| `fs.write` | `{size, mtimeMs}` | at most 512 KiB decoded and at most the policy's `max_file_bytes`; `create` refuses an existing file; `overwrite` replaces only a regular file |

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
at most 512 KiB of text, and a file longer than one read says so, for the agent
to continue with an offset. The same lead-only rules a peer delegation passes
apply (mesh on, `mesh.chats`, one hop, a configured peer) — the peer's own
policy, its roots and caps, is what actually decides.

## Phase 2: direct TLS, ask approvals, invites, the Peers UI

### The direct TLS transport

- **What it is.** TLS 1.3 only, then the exact same newline-delimited
  `awui-mesh/1` stream the SSH link carries. The certificate is a minimal
  self-signed one (Ed25519, its own key at `mesh/tls-key.pem`, mode 0600,
  regenerated when less than 30 days of validity remain), built for the
  transport and not for trust: the client does not verify it and does not check
  the server name.
- **Why trust does not come from the certificate.** The mesh handshake already
  signs the transcript under a pinned key. Over TLS, that transcript gains a
  channel binding: both sides derive `exportKeyingMaterial` from the TLS
  session itself and fold it into what is signed. A machine in the middle can
  terminate TLS on both sides and relay the JSON, and every message passes —
  but the binding differs per TLS session, so the signatures do not verify, and
  the link dies at the handshake. The pin is the identity; the certificate only
  carries the channel.
- **Why no WebSocket framing.** Node-to-node needs a byte stream, and raw TLS
  already is one; a WS parser would add a layer, upgrade machinery, and an
  origin model this protocol has no use for. The listener speaks only
  awui-mesh/1 — a browser pointed at the port gets a TLS-then-JSON stream it
  cannot make sense of, and the mesh port never serves `/api/*`.
- **Bounds.** The handshake must finish within 10 s; at most 16 concurrent
  unauthenticated sockets (at most 4 per remote IP); at most 30 new connections
  a minute per IP (excess is closed); an authenticated link idle 10 minutes is
  closed (a ping keeps it alive — and the bound counts traffic in both
  directions, so a link that only streams the target's own frames is never
  idle, with the leader sending a quiet keepalive ping every few minutes on
  links with live tasks or terminals). An authenticated link whose caller
  never pairs is bounded too: at most 16 concurrent unpaired links (4 per IP),
  and a one-shot 60 s grace that no amount of pinging lifts.
- **Firewall.** `mesh.listen` binds an address; the port stays closed until the
  firewall opens it. The NixOS module's `mesh.openFirewall` is that switch, and
  it defaults to false.

### Ask approvals on the target

A cap whose decision is `ask` (a built-in `worker` policy's `fs.write` and
`term.open`) no longer fails in daemon mode. The target raises a mesh approval —
id, peer name and node id, method, cap, a summary of the call (path or cwd and
harness, at most 300 characters, never file content or prompt text) — and the
call waits, up to 6 minutes. The target's own UI shows the card next to its
other approvals, and the CLI answers them: `awui peer approvals` lists them,
`awui peer approve <id> [--for-link]` allows once or for this link's lifetime
(same node, same cap, same root), `awui peer deny <id>` refuses. No answer in 5
minutes expires the request and the call is denied ("no one answered on the
target"). The queue holds at most 32 pending (at most 4 per node); overflow is a
refusal, not a silent wait. Ephemeral workers (plain `serve-stdio`, no daemon)
keep the P1 refusal — there is no one on the target to ask. Every decision, and
every expiry, lands in the audit log.

### Invites, QR, and the Peers UI

`awui peer invite [--policy worker] [--ttl 10m] [--address host:port …]` on the
target (the listener must be on) prints a code — `awui-invite:1:` followed by a
base64url blob holding the target's name, addresses, public key, and a
single-use secret — and draws it as a terminal QR. On the joiner,
`awui peer join <code> [--name lab-vm-3]` decodes it, pins the key it carries
(no first-contact guessing: the key came in the code), tries the addresses over
TLS in order, and redeems the secret. The redeem is the one method an
unpaired-but-authenticated link may call besides `ping`; a bad secret is a
constant-time compare that increments an attempt counter, five bad attempts burn
the invite, expiry burns it, and success burns it. A redeemed joiner is a
pending inbound request the target still Accepts (`awui peer accept`, which
pre-fills the invite's policy), so a person on the target has the last word.

The same work is in the web UI: **Settings → Peers** shows this node (name,
node id, listen), the peers with their status dot, transport and address
(Test, Remove), pending inbound requests with their SAS and a policy select,
the invite maker (policy, TTL, code + QR SVG + copy), a join box for a pasted
code, and the pending ask approvals with their three answers (Allow once /
Allow for link / Deny). Peers added here live in `$STATE/mesh/peers.json`
(mode 0600, atomic writes, at most 64 entries, the same entry schema as
config.yml); a config.yml peer wins on a name clash, and both sources are
listed. Nothing in that UI is reachable from the TLS port — it is the local
owner's authenticated `/api`, exactly like the rest of the Settings.

## Phase 3: remote terminals, handoff, the NixOS module

### Remote terminals

A peer that may open a terminal here (`term.open`, `ask` in the built-in
`worker` policy) answers `term.open {cwd, cols, rows}` with a terminal id: the
cwd resolved through the policy's roots, the shell taken from the worker user's
own login shell on the worker's machine (never from the caller), the
environment built by the target (never the caller's). `term.input` (base64, at
most 64 KiB), `term.resize`, `term.close`, `term.attach` (replay from the
scrollback ring, 1 MiB, daemon mode) and `term.list` follow, and the PTY's
output comes back coalesced (at most one frame per 16 ms, 64 KiB a frame). At
most 4 open terminals per peer node, counting the ones still opening so
concurrent opens cannot all slip past the cap, and never more than the
policy's task ceiling; one node id may open at most 30 a minute. In daemon
mode terminals are owned by the node, so they outlive a
dropped link (reaped after an hour detached); an ephemeral worker's terminals
close with the link. What the target controls, plainly: the shell, the
environment, the cwd, and the per-call cap decision — the leader only names a
size and a folder. The worker answers a listing with `term.list` and closes one
on `term.close`. Input content is never audited (byte counts per minute only).

On the leader, the terminal panel gains a **"New terminal on…"** menu listing
the configured peers whose resolved policy advertised `term.open` — `peer.info`
answers with the caller's `caps: {allow, ask}`, the leader caches the last
answer per peer (its Test button and a quiet background probe both refresh it),
and a peer with no cached answer or nothing granted never appears. A tab strip
whose peer tabs read `@<peer>` (the same mark a delegated task carries), and a
disconnected state with a Retry that reopens the terminal through the same
create route. Picking a peer asks for the folder it should run in, and the
create request carries `peer` and `peerCwd` together (the worker resolves that
folder through its own policy roots); everything else — the frame, the stream,
resize, close — is the ordinary terminal panel.

On the target, the Peers view lists every terminal a peer opened here, read
only, with a kill action that runs the peer's own close.

### Handoff: move a chat's work to a peer

A lead chat whose workspace is a git repo can hand itself to a peer — the
`peer_handoff {peer, peerRepo, brief?}` tool — and nothing on the leader's
tree changes:

1. The working tree (tracked and untracked, `.gitignore` respected) is committed
   onto a temporary ref `refs/awui/handoff/<id>` through a temporary index, so
   the user's index and worktree are untouched; the commit's parent is HEAD.
2. `git bundle create` packs it, at most 256 MiB (larger is a refusal with a
   clear message). The size is checked once git has written the bundle — git
   has no "stop at N bytes" switch, so a repo with a giant history first
   writes the full bundle into the leader's own scratch dir; a bounded
   local-disk cost of the leader's own tool call, never a peer's lever.
3. The bundle travels in at most 512 KiB chunks through `handoff.begin` /
   `handoff.chunk` / `handoff.finish` — the worker checks size and sha256, runs
   `git bundle verify`, fetches into `refs/awui/handoff/<id>` of the repo at
   `peerRepo` (inside its policy's roots and a git repo), and adds a detached
   worktree `<repo>/.awui/handoff-<id>`. Every git call is argv-only (no shell)
   with hooks disabled (`core.hooksPath=/dev/null`), protocol writes refused,
   and `GIT_CONFIG_NOSYSTEM=1`; incomplete uploads are reaped after 15
   minutes (on the worker's own periodic sweep, not only when a later handoff
   happens to run), and a peer runs at most 2 concurrent uploads.
4. The leader opens a remote task in that worktree with a brief made of the
   user's words plus a compact digest of the chat (the last at most 20 turns, at
   most 32 KiB, tool outputs elided), linked as a delegated task with the
   `@host` badge. The local chat gets a note saying where the work went.

The peer's own policy gates a handoff on arrival: it needs both `task.run` and
`fs.write` (the built-in `worker` policy asks for `fs.write`, so the target's
owner sees one approval card before anything lands).

Bringing work back: `awui peer fetch <peer> <remoteTaskId>` reads the
worktree's HEAD back through
`handoff.export` and the same chunked download, and the leader fetches it into
`refs/awui/from-peer/<peer>/<id>` — a ref to inspect, diff, or cherry-pick. It
never merges, never checks out, and never touches the user's tree on either
side.

The way back is bounded like the way in: the leader refuses an export that
claims more than the 256 MiB cap before reading a chunk, and stops the moment
the delivered bytes pass it — the peer's claimed size is never trusted.

### Limits that remain

- **Host tasks across a target restart**: they are in memory, not persisted.

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
  share a root with a hostile writer. `fs.read` closes the gap (no-follow
  open, then the opened file's device/inode is checked against the resolved
  path). `fs.write` narrows it: the parent directory's device/inode is checked
  again right before the atomic rename, and a change refuses the write; a
  writer racing inside that last instant is the remaining window.
- **Overwrites drop setuid/setgid/sticky bits**: a file a peer wrote keeps only
  its permission bits.
- **The audit log is bounded**: successful `peer.ping`s are not logged, the log
  rolls to `audit.jsonl.1` past 16 MiB, and `awui peer log` reads only its tail.

## NixOS, home-manager, and bootstrap

### The NixOS module

`contrib/nixos/awui.nix` is a system-level `services.awui` (enable, package,
user, stateDir, port, host, readWritePaths, extraConfig) whose `mesh`
submodule renders the mesh block into config.yml with `pkgs.formats.yaml` —
`enable`, `name`, `listen` (host required, port default 4784) with an
`openFirewall` that defaults to false, `policies`, and `peers`. The unit is
hardened to what the mesh needs: `ProtectSystem=strict` with
`ReadWritePaths` for the state folder and every configured root (mesh policy
roots are picked up automatically; workspace roots go in `readWritePaths`),
`PrivateTmp`, `RestrictAddressFamilies AF_UNIX AF_INET AF_INET6`,
`NoNewPrivileges`, and an `XDG_RUNTIME_DIR` (`/run/awui`, 0700) for the attach
socket. Because config.yml is rendered, the Settings dialog cannot write it:
user settings belong in `extraConfig` and a rebuild.

### home-manager

`contrib/home-manager/awui-service.nix` declares the same user unit it always
did (the app stays a checkout under `appDir`) and gains the same mesh options
plus `extraConfig`; declaring either renders `~/.config/awui/config.yml` as a
home-manager symlink, which the Settings dialog reads but never edits. Leave
both empty to keep managing that file by hand. The NixOS firewall is NixOS's:
the module's `openFirewall` warns under home-manager instead of pretending.

### bootstrap, for machines neither module manages

`awui peer bootstrap <ssh-dest> [--policy worker] [--root <path>]` prints —
exactly, argv-safe, nothing run — the commands that turn an ssh destination
into a mesh worker: awui cloned and built, the mesh block appended to its
config.yml (the step appends nothing when a mesh block is already there), and
an authorized_keys forced-command line binding one ssh key to
`peer serve-stdio --policy worker --peer <leader>`, idempotent by its
`awui-mesh <leader>` marker. With `--run`, the commands are shown first, a
`y/N` asks, and then each step runs over ssh as one argv word — the local side
never builds a shell line, and `BatchMode` means the key must already be
accepted on the target. Then add the peer to the leader's config.yml and run
`awui peer add <name>`; with the forced command the worker pins the leader's
key on first contact, so no `accept` is needed over there.

### A two-machine example, nixos-work ⇄ nixos-desktop, over direct TLS

**nixos-desktop** (the worker; agents run here):

```nix
services.awui = {
  enable = true;
  readWritePaths = [ "/srv/code" ];
  mesh = {
    enable = true;
    listen = { host = "192.168.1.20"; };   # inbound links; the port stays firewalled until…
    openFirewall = true;                    # …this, off by default, set on purpose
    policies.worker.roots = [ "/srv/code" ];
  };
};
```

**nixos-work** (the leader; you chat here):

```nix
services.awui = {
  enable = true;
  mesh = {
    enable = true;
    # No listen block: this node only calls out, nothing accepts inbound links.
    peers = [ { name = "nixos-desktop"; tls = "192.168.1.20:4784"; } ];
  };
};
```

Pair them once: `awui peer invite` on nixos-desktop (in a terminal there), and
`awui peer join <code> --name nixos-desktop` on nixos-work, then `awui peer
accept nixos-work --policy worker` on nixos-desktop (the invite pre-fills the
policy). Or pin the long way with `awui peer add` / `awui peer accept`,
comparing the node id and SAS. The keys, pins, and audit log live in each
machine's state folder (`/var/lib/awui/mesh` under the NixOS module); the
rendered config.yml never carries them. A machine that is not running NixOS —
a lab VM, a laptop — gets the same end state through `awui peer bootstrap` from
nixos-work.

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
- `mesh/tls-key.pem`, `mesh/tls-cert.pem` — the direct TLS listener's dedicated
  Ed25519 key and its self-signed certificate, mode 0600. The key is never the
  node identity; it is only the TLS envelope. A malformed key file is a hard
  error, never regenerated.
- `mesh/peers.json` — the peers added from the Peers UI, a chat (`mesh_peer_add`), or `awui peer join`,
  mode 0600, atomic writes; config.yml's own peers win on a name clash. `mesh_peer_sync_config`
  (or a later `awui peer` ask) moves them into config.yml when that file is a plain writable
  file, and then removes their peers.json copy.

## Security notes

- **The peer channel is never `/api/*`.** A peer gets a stdio protocol with a
  closed method table, not an HTTP client of this awui, and nothing in the mesh
  trusts loopback.
- **No shell on the local side.** The leader spawns `ssh`/`docker exec` from argv;
  destinations are validated host/container shapes, `ssh_opts` entries are
  checked for newlines and NULs, and nothing is re-parsed by a shell here.
- **TLS carries the channel, not the trust.** The direct-TLS listener presents a
  self-signed certificate nobody verifies; a client that does not hold the
  pinned key cannot finish the handshake, because both sides fold the TLS
  session's own keying material into what is signed. A TLS-terminating relay
  re-derives a different binding and fails.
- **Keys are the identity.** A peer whose key changes is closed with a pin
  mismatch until a person runs `awui peer remove` and re-pins; names never stand
  in for keys.
- **The TLS certificate is never the trust.** awui's direct TLS link pins the
  node key and binds the handshake to the one TLS session it rode in on, so a
  proxy terminating TLS on both sides fails the pin even with a perfectly
  relayed handshake. The listener is bounded (handshake deadline, per-IP caps
  and rate, idle timeout) and speaks only `awui-mesh/1` — never `/api/*`.
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
- **Phase 2** — shipped: direct TLS with pinned keys and channel binding; ask
  approvals answered on the target; invites, QR, and the Peers UI with peers.json.
- **Phase 3** — shipped: remote terminals (`term.*`, with caps, ask approvals,
  and the target's own shell and environment); handoff and fetch (a bundle over
  the link into a peer worktree, back as a ref); the NixOS module and
  home-manager mesh options, and `awui peer bootstrap`.

## Phone follow is separate

The phone's push approvals come through [Tailscale Serve](security.md#tailscale)
against this server's own UI — an optional convenience for following a run from
a phone, never a mesh transport: no mesh peer connects through Tailscale, no
mesh code reads a Tailscale identity, and the TLS peer transport's trust is its
own pinned keys. The mesh never serves `/api/*`: a peer gets a policy-bound
channel, not an HTTP client of this awui.
