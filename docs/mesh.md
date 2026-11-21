# Mesh

Running one awui's agent on another machine's, over SSH or Docker, without opening
any port. This is **phase 0**: configuration, identity and policy exist; nothing
listens, and no tool reaches a chat yet.

## What it is

A `mesh:` block in `config.yml` names peer machines (how to reach them) and named
policies (what a peer may do *here*). Once phase 1 lands, a chat can hand a delegated
task to a paired peer: the peer's own awui opens the harness session on its own
machine, with its own credentials, inside the roots its policy allows, and streams
the run back as an ordinary delegated task. Until `mesh.enabled: true` is set the
whole feature is inert — the block is still validated, so a typo is caught at
startup.

## Principles

- **Off by default.** `mesh.enabled` absent or false is off. `AWUI_MESH=0` forces
  it off; no environment variable forces it on.
- **Policy is enforced on the target.** The caller only requests.
- **`max_hops` is exactly 1.** A peer's peer is not reachable through it; the
  schema rejects any other value, so there is no task relaying.
- **No `exec` capability exists.** The vocabulary is fixed and closed:
  `discover`, `task.run`, `task.approve`, `fs.read`, `fs.write`, `term.open`.
- **Discovery is never trust.** Identity is a pinned Ed25519 key, not a name.
- **The peer channel is never `/api/*`** and never relies on loopback trust
  (see [Security](security.md): a loopback request is not local when it arrives
  through a proxy, and the mesh gives peers no HTTP route at all).

## Config reference

```yaml
mesh:
  enabled: false            # default false; the only switch that turns it on
  name: my-box              # optional, 1..64 chars [A-Za-z0-9._-], default = os.hostname() sanitized
  max_hops: 1               # literal 1 only
  max_remote_tasks: 8       # 1..64, outbound concurrent remote tasks
  chats: lead-only          # lead-only | all  (which chats get mesh tools; phase 1)
  policies:                 # record name -> partial policy (snake_case keys), merged over the
                            # built-in of the same name, or over `none` for a new name
    worker:
      caps: [discover, task.run]
      ask: [fs.write]
      roots: [~/code]
      harnesses: [pi]
      permission_ceiling: auto-edit
      max_tasks: 4
      max_file_bytes: 52428800
      approvals_at: origin
  peers:                    # outbound inventory; max 64; names unique case-insensitively
    - name: lab-vm-3        # [A-Za-z0-9._-], 1..64
      ssh: drishal@lab-vm-3 # exactly one of ssh | docker (direct comes in phase 2)
      ssh_opts: ["-p", "2222"]   # optional, max 16 strings, each 1..256 chars, no newline/NUL
      awui_path: /home/drishal/.local/bin/awui   # optional remote binary path
      inbound_policy: none  # what THIS peer may do on THIS machine; default "none"
    - name: ci-box
      docker: awui-worker-1
      engine: docker        # docker | podman, default docker
```

Policy names are `[a-z0-9_-]`, 1..32. `inbound_policy` must name a built-in or a
configured policy. A cap listed in both `caps` and `ask` resolves to `ask`
(stricter wins).

## Built-in policies

Cannot be overridden under the name `none`; `worker` and `peer` may be.

| Policy | caps (no ask) | ask | ceiling | maxTasks | approvalsAt |
|---|---|---|---|---|---|
| `none` | — | — | read-only | 1 | target |
| `worker` | discover, task.run, task.approve, fs.read | fs.write, term.open | auto-edit | 4 | origin |
| `peer` | discover | task.run, fs.read, fs.write, term.open | read-only | 2 | target |

All three have empty `roots` (filesystem access must be configured), the
harnesses `["pi", "claude", "codex"]`, and a `maxFileBytes` of 50 MiB. `none`
admits nothing: only handshakes.

## State files

Under the state folder, never in git, never in config:

- `mesh/identity.json` — `{v:1, publicKey, privateKey}` (Ed25519, base64url raw
  public key, PKCS8 PEM private key), mode 0600 in a 0700 directory. Created on
  first use, not at startup.
- `mesh/audit.jsonl` — append-only, one JSON object per line, mode 0600.

## Roadmap

- **Phase 1** — SSH and Docker stdio transports; `delegate_task(peer)`.
- **Phase 1.5** — persistent attach and file transfer.
- **Phase 2** — direct TLS with pinned keys; a Peers UI; pairing.
- **Phase 3** — remote terminals, handoff, a NixOS module.

## Phone follow is separate

The phone's push approvals come through [Tailscale Serve](security.md#tailscale)
against this server's own UI. The mesh never serves `/api/*`: a peer gets a
policy-bound channel, not an HTTP client of this awui.
