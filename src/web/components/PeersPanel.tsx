// The Settings dialog's Peers section (mesh P2 §4): this node, the peers it
// can reach, pairing requests waiting on an Accept, invites and joins, the
// ask approvals pending here, and the mesh tasks running on this machine with
// their requests answerable in place. One panel, always mounted like every
// section (so the settings search can read its rows), polling the two GETs
// every 3 s while it is the section on screen. Everything mutating goes
// through /api/mesh — the owner's own routes, behind the same sign-in as the
// rest of Settings — and the QR arrives as an <img> data URL from our own
// qr.ts, never as injected markup.
import { useEffect, useState } from "react";
import type { InteractionAnswer, MeshApprovalRow, MeshHostTermRow, MeshOverview, MeshPendingRow, MeshPeerRow, MeshTaskRow } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { approvalLine, hostTermLine, sasLabel, sourceLabel, taskStateLabel, timeLeft, transportLabel } from "../mesh.js";
import { FormRow } from "./FormRow.js";
import { IconPlus, IconX } from "../icons.js";
import { Select } from "./Select.js";

/** The dialog's section ids (SettingsDialog's own list); this panel is one of them. */
export type SectionIdOf = string;

const POLL_MS = 3_000;

const TRANSPORT_OPTIONS = [
  { value: "tls", label: "TLS", hint: "host:port the peer's awui answers" },
  { value: "ssh", label: "SSH", hint: "user@host the peer's shell reaches" },
  { value: "docker", label: "Docker", hint: "container name or id" },
];

const TTL_OPTIONS = [
  { value: "5", label: "5 minutes" },
  { value: "10", label: "10 minutes" },
  { value: "30", label: "30 minutes" },
  { value: "60", label: "60 minutes" },
];

interface TaskAnswerResult {
  line?: string;
  error?: string;
}

export function PeersPanel({ current }: { current: SectionIdOf }) {
  const [view, setView] = useState<MeshOverview | null>(null);
  const [tasks, setTasks] = useState<MeshTaskRow[]>([]);
  /** The terminals peers opened on this node (finding #2), read with the tasks. */
  const [hostTerms, setHostTerms] = useState<MeshHostTermRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Each peer's last Test: its own line when it drew one, else its error. */
  const [tests, setTests] = useState<Record<string, { busy: boolean; line?: string; error?: string }>>({});
  // The add form: one row, the transport picks which field the address is.
  const [addName, setAddName] = useState("");
  const [addTransport, setAddTransport] = useState<"tls" | "ssh" | "docker">("tls");
  const [addAddress, setAddAddress] = useState("");
  // Each pending request's chosen policy, keyed by node id (an invite pre-fills its own).
  const [acceptPolicies, setAcceptPolicies] = useState<Record<string, string>>({});
  const [invitePolicy, setInvitePolicy] = useState("worker");
  const [inviteTtl, setInviteTtl] = useState("10");
  const [invite, setInvite] = useState<{ code: string; qrSvg: string; expiresAt: number; policy: string } | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [joinName, setJoinName] = useState("");
  const [joinLine, setJoinLine] = useState<string | null>(null);
  /** One task request's answer result, keyed by task id and request id. */
  const [taskAnswers, setTaskAnswers] = useState<Record<string, TaskAnswerResult>>({});

  const refresh = () => {
    void api<MeshOverview>("/api/mesh")
      .then((v) => setView(v))
      .catch((e: unknown) => setError(errorText(e)));
    void api<{ tasks: MeshTaskRow[] }>("/api/mesh/tasks")
      .then((t) => setTasks(t.tasks))
      .catch(() => undefined);
    void api<{ terms: MeshHostTermRow[] }>("/api/mesh/terms")
      .then((t) => setHostTerms(t.terms))
      .catch(() => undefined);
  };

  useEffect(() => {
    void refresh();
    // Only the open section keeps polling: the mesh is quiet, and two GETs
    // every 3 s are nothing while the Peers page is the one being read.
    if (current !== "peers") return;
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [current === "peers"]);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setError(null);
    try {
      await action();
    } catch (e: unknown) {
      setError(errorText(e));
    }
  };

  const enabled = view?.enabled === true;
  const policies = view?.policies ?? [];
  const policyOptions = policies.map((p) => ({ value: p, label: p }));
  const policyFor = (pending: MeshPendingRow): string => acceptPolicies[pending.nodeId] ?? pending.invitedPolicy ?? "worker";

  const addPeer = () =>
    void run(async () => {
      const name = addName.trim();
      const address = addAddress.trim();
      if (!name || !address) return;
      const entry: Record<string, unknown> = { name, [addTransport]: address };
      await api("/api/mesh/peers", { method: "POST", body: entry });
      setAddName("");
      setAddAddress("");
      refresh();
    });

  const removePeer = (peer: MeshPeerRow) =>
    void run(async () => {
      await api(`/api/mesh/peers/${encodeURIComponent(peer.name)}`, { method: "DELETE", body: {} });
      refresh();
    });

  const testPeer = (peer: MeshPeerRow) =>
    void run(async () => {
      setTests((t) => ({ ...t, [peer.name]: { busy: true } }));
      try {
        const said = await api<{ paired: boolean; policy: string; sas: string; info: unknown }>(`/api/mesh/peers/${encodeURIComponent(peer.name)}/test`, { method: "POST", body: {} });
        setTests((t) => ({ ...t, [peer.name]: { busy: false, line: `${said.paired ? "Paired" : "Not accepted yet"} · policy ${said.policy} · SAS ${sasLabel(said.sas)}` } }));
      } catch (e: unknown) {
        setTests((t) => ({ ...t, [peer.name]: { busy: false, error: errorText(e) } }));
      }
    });

  const decidePending = (pending: MeshPendingRow, accept: boolean) =>
    void run(async () => {
      if (accept) await api(`/api/mesh/pending/${encodeURIComponent(pending.nodeId)}/accept`, { method: "POST", body: { policy: policyFor(pending) } });
      else await api(`/api/mesh/pending/${encodeURIComponent(pending.nodeId)}/reject`, { method: "POST", body: {} });
      refresh();
    });

  const makeInvite = () =>
    void run(async () => {
      const made = await api<{ code: string; qrSvg: string; expiresAt: number; policy: string }>("/api/mesh/invites", {
        method: "POST",
        body: { policy: invitePolicy, ttlMinutes: Number(inviteTtl) },
      });
      setInvite(made);
      refresh();
    });

  const join = () =>
    void run(async () => {
      const code = joinCode.trim();
      if (!code) return;
      const made = await api<{ pinned: boolean; redeemed: boolean; saved: boolean; name: string }>("/api/mesh/join", {
        method: "POST",
        body: { code, ...(joinName.trim() ? { name: joinName.trim() } : {}) },
      });
      setJoinCode("");
      setJoinName("");
      setJoinLine(
        made.saved
          ? `Pinned ${made.name} and redeemed the invite; its owner still has to Accept you.`
          : made.pinned
            ? `Pinned ${made.name}'s key. The code carries no address, so the invite was not redeemed.`
            : "Joined.",
      );
      refresh();
    });

  const decide = (approval: MeshApprovalRow, decision: "allow-once" | "allow-for-link" | "deny") =>
    void run(async () => {
      await api(`/api/mesh/approvals/${encodeURIComponent(approval.id)}`, { method: "POST", body: { decision } });
      refresh();
    });

  const answerRequest = (task: MeshTaskRow, requestId: string, answer: InteractionAnswer) =>
    void run(async () => {
      const key = `${task.remoteTaskId}/${requestId}`;
      try {
        await api(`/api/mesh/tasks/${encodeURIComponent(task.remoteTaskId)}/answer`, { method: "POST", body: { requestId, answer } });
        setTaskAnswers((t) => ({ ...t, [key]: { line: "Answered." } }));
      } catch (e: unknown) {
        setTaskAnswers((t) => ({ ...t, [key]: { error: errorText(e) } }));
      }
      refresh();
    });

  const abortTask = (task: MeshTaskRow) =>
    void run(async () => {
      await api(`/api/mesh/tasks/${encodeURIComponent(task.remoteTaskId)}/abort`, { method: "POST", body: {} });
      refresh();
    });
  const killTerm = (term: MeshHostTermRow) =>
    void run(async () => {
      await api(`/api/mesh/terms/${encodeURIComponent(term.termId)}/close`, { method: "POST", body: {} });
      refresh();
    });


  return (
    <section className="form-section" id="settings-panel-peers" role="tabpanel" aria-labelledby="settings-peers" hidden={current !== "peers"}>
      <h3 id="settings-peers">Peers</h3>
      <p className="form-note">
        {view === null
          ? "The mesh links this awui to another machine's, over SSH, Docker, or direct TLS."
          : enabled
            ? "The mesh links this awui to another machine's, over SSH, Docker, or direct TLS. A peer's own policy decides what it may do here."
            : "The mesh is off: set mesh.enabled true in config.yml to reach peers or answer theirs."}
      </p>
      <div className="form-card">
        <FormRow row="node" label="This node" desc={view === null ? "…" : `${view.name} · node id ${view.nodeId ?? "unreadable"}${view.listen ? ` · listening on ${view.listen.host}:${view.listen.port}` : " · no TLS listener"}`}>
          <code className="mesh-node-id">{view?.nodeId ?? ""}</code>
        </FormRow>
      </div>
      <div className="form-card">
        <FormRow row="peer-list" label="Peers" desc="Test runs one handshake and asks peer.info, nothing more. Remove forgets the peer and drops its pins; a peer defined in config.yml is edited there." stack>
          {view && view.peers.length > 0 ? (
            <div className="mesh-peers">
              {view.peers.map((peer) => {
                const test = tests[peer.name];
                return (
                  <div className="mesh-peer" key={peer.name}>
                    <span className={`mesh-dot${peer.pinned ? " is-on" : ""}`} title={peer.pinned ? "Pinned" : "Not pinned yet"} />
                    <span className="mesh-peer-name">{peer.name}</span>
                    <span className="mesh-peer-address">
                      {transportLabel(peer.transport)} · {peer.address}
                    </span>
                    <span className="mesh-peer-source">{sourceLabel(peer.source)}</span>
                    <button type="button" className="btn btn-small" disabled={!enabled || test?.busy} onClick={() => testPeer(peer)}>
                      {test?.busy ? "Testing…" : "Test"}
                    </button>
                    <button type="button" className="ghost-icon" aria-label={`Remove ${peer.name}`} title="Remove peer" disabled={!enabled} onClick={() => removePeer(peer)}>
                      <IconX size={14} />
                    </button>
                    {test?.line || test?.error ? (
                      <p className="mesh-test-line" role="status">
                        {test.line ?? test.error}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="form-empty">{enabled ? "None configured. Add one below, or join from an invite code." : "None configured."}</p>
          )}
        </FormRow>
        <FormRow row="peer-add" label="Add a peer" desc="Saved to this machine's peers.json; config.yml wins on a name clash." stack>
          <div className="mesh-add">
            <input className="input" aria-label="Peer name" placeholder="e.g. lab-vm-3" value={addName} onChange={(e) => setAddName(e.target.value)} />
            <Select label="Transport" value={addTransport} options={TRANSPORT_OPTIONS} onChange={(v) => setAddTransport(v as typeof addTransport)} />
            <input
              className="input"
              aria-label="Peer address"
              placeholder={addTransport === "tls" ? "host:4784" : addTransport === "ssh" ? "user@host" : "container-name"}
              value={addAddress}
              onChange={(e) => setAddAddress(e.target.value)}
            />
            <button type="button" className="btn btn-small btn-primary" disabled={!enabled || !addName.trim() || !addAddress.trim()} onClick={addPeer}>
              <IconPlus size={13} /> Add
            </button>
          </div>
        </FormRow>
      </div>
      <div className="form-card">
        <FormRow row="pending" label="Pairing requests" desc="A peer that said hello. Compare the SAS with the other machine's screen before accepting." stack>
          {view && view.pending.length > 0 ? (
            <div className="mesh-pending">
              {view.pending.map((pending) => (
                <div className="mesh-pending-row" key={pending.nodeId}>
                  <span className="mesh-pending-name">
                    {pending.name}
                    <span className="mesh-node-id">{pending.nodeId}</span>
                  </span>
                  <span className="mesh-sas">
                    SAS <strong>{sasLabel(pending.sas)}</strong>
                  </span>
                  <Select
                    label={`Policy for ${pending.name}`}
                    value={policyFor(pending)}
                    options={policyOptions.some((o) => o.value === policyFor(pending)) ? policyOptions : [{ value: policyFor(pending), label: policyFor(pending) }, ...policyOptions]}
                    disabled={!enabled}
                    onChange={(policy) => setAcceptPolicies((p) => ({ ...p, [pending.nodeId]: policy }))}
                  />
                  <button type="button" className="btn btn-small btn-primary" disabled={!enabled} onClick={() => decidePending(pending, true)}>
                    Accept
                  </button>
                  <button type="button" className="btn btn-small btn-ghost" disabled={!enabled} onClick={() => decidePending(pending, false)}>
                    Reject
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="form-empty">No one is waiting to be paired.</p>
          )}
        </FormRow>
      </div>
      <div className="form-card">
        <FormRow row="invite" label="Invite a peer" desc="One single-use code with a QR: it carries this node's key, so the joiner pins it outright and redeems the code over TLS. You still accept them afterwards." stack>
          <div className="mesh-add">
            <Select label="Invite policy" value={invitePolicy} options={policyOptions.some((o) => o.value === invitePolicy) ? policyOptions : [{ value: invitePolicy, label: invitePolicy }, ...policyOptions]} disabled={!enabled} onChange={setInvitePolicy} />
            <Select label="Invite lifetime" value={inviteTtl} options={TTL_OPTIONS} disabled={!enabled} onChange={setInviteTtl} />
            <button type="button" className="btn btn-small btn-primary" disabled={!enabled} onClick={() => void makeInvite()}>
              Create invite
            </button>
          </div>
          {invite ? (
            <div className="mesh-invite" role="status">
              <div className="dialog-actions">
                <input className="input" readOnly aria-label="Invite code" value={invite.code} onFocus={(e) => e.currentTarget.select()} />
                <button type="button" className="btn btn-small" onClick={() => void navigator.clipboard?.writeText(invite.code)}>
                  Copy code
                </button>
              </div>
              {/* Our own qr.ts drew this SVG; the data URL keeps it markup-free, never innerHTML. */}
              <img className="mesh-qr" alt="Invite QR code" src={`data:image/svg+xml;utf8,${encodeURIComponent(invite.qrSvg)}`} width={176} height={176} />
              <p className="form-desc">
                Policy {invite.policy} · {timeLeft(invite.expiresAt, Date.now())}. Single use: the redeem spends it, and five bad attempts burn it.
              </p>
            </div>
          ) : null}
        </FormRow>
        <FormRow row="join" label="Join a peer" desc="Paste a code from the target's invite. Its key is pinned from the code itself; the target's owner still has to accept you." stack>
          <div className="mesh-add">
            <input className="input" aria-label="Invite code from the target" placeholder="awui-invite:1:…" value={joinCode} onChange={(e) => setJoinCode(e.target.value)} />
            <input className="input" aria-label="Name for this peer" placeholder="name (the code's own if left blank)" value={joinName} onChange={(e) => setJoinName(e.target.value)} />
            <button type="button" className="btn btn-small btn-primary" disabled={!enabled || !joinCode.trim()} onClick={() => void join()}>
              Join
            </button>
          </div>
          {joinLine ? (
            <p className="form-desc" role="status">
              {joinLine}
            </p>
          ) : null}
        </FormRow>
      </div>
      <div className="form-card">
        <FormRow row="approvals" label="Ask approvals" desc="A policy cap set to ask waits here: allow once, for this link's remaining work in the same root, or deny. Five minutes unanswered is a denial." stack>
          {view && view.approvals.length > 0 ? (
            <div className="mesh-approvals">
              {view.approvals.map((approval) => (
                <div className="mesh-approval-row" key={approval.id}>
                  <span className="mesh-approval-line">{approvalLine(approval, Date.now())}</span>
                  <button type="button" className="btn btn-small btn-primary" disabled={!enabled} onClick={() => decide(approval, "allow-once")}>
                    Allow once
                  </button>
                  <button type="button" className="btn btn-small" disabled={!enabled} onClick={() => decide(approval, "allow-for-link")}>
                    Allow for link
                  </button>
                  <button type="button" className="btn btn-small btn-ghost" disabled={!enabled} onClick={() => decide(approval, "deny")}>
                    Deny
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="form-empty">Nothing is asking.</p>
          )}
        </FormRow>
      </div>
      <div className="form-card">
        <FormRow row="tasks" label="Mesh tasks on this node" desc="Chats a peer's run drives here. Their requests answer in place, exactly as a chat's approval card answers." stack>
          {tasks.length > 0 ? (
            <div className="mesh-tasks">
              {tasks.map((task) => (
                <div className="mesh-task" key={task.remoteTaskId}>
                  <div className="mesh-task-head">
                    <span className="mesh-peer-name">{task.peerName}</span>
                    <span className="mesh-peer-address">
                      {task.harness} · {task.cwd}
                    </span>
                    <span className="mesh-task-state">{taskStateLabel(task.state)}</span>
                    <button type="button" className="btn btn-small btn-ghost" disabled={!enabled} onClick={() => void abortTask(task)}>
                      Abort
                    </button>
                  </div>
                  {task.pendingRequests.map((request) => {
                    const said = taskAnswers[`${task.remoteTaskId}/${request.id}`];
                    return (
                      <div className="mesh-task-request" key={request.id}>
                        <span className="mesh-approval-line">{request.summary}</span>
                        {request.approval ? (
                          <>
                            <button type="button" className="btn btn-small btn-primary" disabled={!enabled} onClick={() => void answerRequest(task, request.id, request.approval!.approve)}>
                              Approve
                            </button>
                            <button type="button" className="btn btn-small btn-ghost" disabled={!enabled} onClick={() => void answerRequest(task, request.id, request.approval!.deny)}>
                              Deny
                            </button>
                          </>
                        ) : (
                          <span className="mesh-peer-source">answered from the chat's own card</span>
                        )}
                        {said?.line || said?.error ? (
                          <span className="mesh-test-line" role="status">
                            {said.line ?? said.error}
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ) : (
            <p className="form-empty">No peer task is running on this node.</p>
          )}
        </FormRow>
      </div>
      <div className="form-card">
        <FormRow row="terms" label="Peer terminals on this node" desc="Terminals peers opened here, read-only with a kill action — a live shell as this machine's user, closed exactly as the peer's own close would." stack>
          {hostTerms.length > 0 ? (
            <div className="mesh-tasks">
              {hostTerms.map((term) => (
                <div className="mesh-task" key={term.termId}>
                  <div className="mesh-task-head">
                    <span className="mesh-peer-name">{term.peerName}</span>
                    <span className="mesh-peer-address">{hostTermLine(term)}</span>
                    <button type="button" className="btn btn-small btn-ghost" aria-label={`Kill ${term.peerName}'s terminal`} disabled={!enabled} onClick={() => void killTerm(term)}>
                      Kill
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="form-empty">No peer terminal is open on this node.</p>
          )}
        </FormRow>
      </div>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
