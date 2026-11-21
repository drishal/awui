# Mesh

Running one awui's agent on another machine's, over SSH or Docker, without opening
any port. **Phase 1** is live: a chat can hand a delegated task to a paired peer,
the peer's own awui opens the harness session on its own machine, and the run
streams back as an ordinary delegated task in your chat.

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
awui peer serve-stdio [--peer <name>] [--policy <p>]   the worker end of a link
```

Exit codes: 0 ok, 1 failed, 2 usage, 78 mesh off or config.yml broken. `add` and
`accept` ask before they pin, and refuse without a terminal unless `--yes` is
given. `remove` is revocation: it takes effect on the peer's next call, no
restart needed on either side.

## What P1 does not do yet

- **Approvals on the target** (`approvals_at: target` policies): answering an
  approval needs the target's own awui service, which arrives in P1.5; such a
  policy refuses task opens for now.
- **Ask-capabilities** (`ask:` caps): a cap that needs an approval mid-run is
  refused with a clear error, not raised as a card.
- **Files and terminals** (`fs.read`/`fs.write`/`term.open` are named in policies
  but carry nothing over the link yet).
- **Persistent attach**: when the stdio link closes, every chat the worker opened
  for it is disposed; P1.5 adds attach-to-daemon so a run survives the SSH session.
- **Direct TLS** with pinned keys (P2).

## State files

Under the state folder, never in git, never in config:

- `mesh/identity.json` — `{v:1, publicKey, privateKey}` (Ed25519, base64url raw
  public key, PKCS8 PEM private key), mode 0600 in a 0700 directory. Created on
  first use, not at startup; a malformed file is never regenerated.
- `mesh/pins.json` — the peers this machine pins, inbound and outbound, mode 0600.
- `mesh/audit.jsonl` — append-only, one JSON object per line, mode 0600: who
  asked for what and what this node answered. Prompt text is never logged, only
  lengths.

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
- **The audit log is evidence.** Every decision (allow, deny, ask, error) is one
  bounded line in `mesh/audit.jsonl`.
- **Revocation is one command.** `awui peer remove <name>` drops every pin under
  that name; because the policy is resolved per call, the next request from that
  peer is refused — no restart on either side.

## Roadmap

- **Phase 1** — shipped: SSH and Docker stdio transports; `delegate_task(peer)`.
- **Phase 1.5** — persistent attach, approvals on the target, file transfer.
- **Phase 2** — direct TLS with pinned keys; a Peers UI; pairing.
- **Phase 3** — remote terminals, handoff, a NixOS module.

## Phone follow is separate

The phone's push approvals come through [Tailscale Serve](security.md#tailscale)
against this server's own UI. The mesh never serves `/api/*`: a peer gets a
policy-bound channel, not an HTTP client of this awui.
