// The mesh's owner-facing REST surface (P2 §4): the local half of the Settings
// dialog's Peers section, and the target's answer to the review finding that a
// peer-owned chat's requests had no surface to be answered from. Every route
// lives under the app's own /api behind the same auth, CSRF and origin guards
// as the settings routes (this router is mounted by app.ts after requireAuth
// and a settings.manage grant) — a peer never reaches it: the mesh's own ports
// speak only awui-mesh/1, never /api/*, and nothing here trusts loopback.
// Mutating routes refuse with 409 mesh_off while the mesh is off, exactly as
// the CLI's commands do; the GETs answer an empty-but-honest shape instead, so
// the dialog can always say what this node is. The bodies are strict zod, the
// same schemas the stores and the wire already hold, so a shape never drifts
// between config.yml, peers.json and the dialog.
import { Router, type Request } from "express";
import { z, type ZodType } from "zod";
import type { PushNote } from "../../shared/protocol.js";
import { answerSchema } from "../../shared/protocol.js";
import { encodeQr, qrToSvg } from "../../shared/qr.js";
import { ChatError } from "../chats/chat.js";
import { approvalAnswers } from "../../shared/approval.js";
import { meshPeerSchema } from "../user-config.js";
import type { AuditLog } from "./audit.js";
import type { ApprovalQueue, MeshApprovalDecision } from "./approvals.js";
import { clientHandshake, SAS_CONTEXT } from "./handshake.js";
import type { TaskHost } from "./host.js";
import { nodeIdOf, sasOf, type NodeIdentity } from "./identity.js";
import type { PeerManager } from "./manager.js";
import { encodeInviteCode, decodeInviteCode, INVITE_CODE_PREFIX, inviteMac, type InviteStore } from "./pairing.js";
import type { PinStore } from "./pins.js";
import { resolvePolicies } from "./policy.js";
import { mergePeers, type MeshPeerStore } from "./peer-store.js";
import { RpcPeer } from "./rpc.js";
import { connectTls } from "./tls.js";
import type { MeshConfig } from "../user-config.js";

/** A peer name as config.yml spells it (P0): the one shape every surface agrees on. */
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** A policy name: the built-ins and anything configured all match this (P0). */
const POLICY_RE = /^[a-z0-9_-]{1,32}$/;
/** How long the join route gives one address's redeem to answer: in-memory work, a hang guard. */
const REDEEM_RPC_MS = 10_000;

/** The strict bodies; the peer add reuses config.yml's own entry schema, so the two sources can never disagree. */
const acceptSchema = z.object({ policy: z.string().regex(POLICY_RE) }).strict();
const inviteCreateBodySchema = z.object({ policy: z.string().regex(POLICY_RE).optional(), ttlMinutes: z.number().int().min(1).max(60).optional() }).strict();
const joinSchema = z.object({ code: z.string().min(INVITE_CODE_PREFIX.length + 8).max(4096), name: z.string().regex(NAME_RE).optional() }).strict();
const decideSchema = z.object({ decision: z.enum(["allow-once", "allow-for-link", "deny"]) }).strict();
const taskAnswerSchema = answerSchema.extend({ requestId: z.string().min(1).max(128) });

export interface MeshRoutesDeps {
  /** mesh.enabled as the rest of the server reads it (config re-read, never an env force-on). */
  enabled: () => boolean;
  /** This node's mesh name, what a handshake presents and a code carries. */
  name: () => string;
  /** This node's identity, loaded like every mesh surface loads it (once, on first use). */
  identity: () => Promise<NodeIdentity>;
  pins: PinStore;
  /** Peers added from the UI or a join (mesh/peers.json). */
  saved: MeshPeerStore;
  /** config.yml's `mesh:` block, re-read at each use. */
  config: () => MeshConfig | undefined;
  /** config.yml's `mesh.listen`, or null when this node answers no TLS port. */
  listen: () => { host: string; port: number } | null;
  /** The service's own task host: what the tasks routes read and answer. */
  host: TaskHost;
  /** The service's ask-approval queue, or null while no daemon holds one. */
  approvals: () => ApprovalQueue | null;
  /** The service's live invites, or null while no daemon holds one. */
  invites: () => InviteStore | null;
  /** The leader-side manager, for the Test button's one handshake; null only in tests that pass none. */
  peers: PeerManager | null;
  audit: AuditLog;
  /** One note for this machine's owner (the push pipeline), so an ask approval is never silent. */
  notify?: (note: Omit<PushNote, "id" | "at">) => void;
  log?: (message: string) => void;
}

/** The exact shape body() parses with everywhere else: a ZodError the app's error handler answers as 400. */
function body<T>(schema: ZodType<T>, req: Request): T {
  return schema.parse(req.body ?? {});
}

const said = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The one refusal every mutating route makes while the mesh is off: the same words the CLI exits 78 with. */
function requireMesh(deps: MeshRoutesDeps): void {
  if (!deps.enabled()) throw new ChatError(409, "mesh_off", "The mesh is turned off: set mesh.enabled true in config.yml");
}

/** Every peer both sources know, each labelled with where it came from (config wins on a name clash). */
function peerRows(deps: MeshRoutesDeps, pinned: Set<string>) {
  const config = deps.config()?.peers ?? [];
  const fromConfig = new Set(config.map((peer) => peer.name.toLowerCase()));
  return mergePeers(config, deps.saved.snapshot()).map((peer) => ({
    name: peer.name,
    transport: peer.ssh !== undefined ? ("ssh" as const) : peer.docker !== undefined ? ("docker" as const) : ("tls" as const),
    address: peer.ssh ?? peer.docker ?? peer.tls ?? "",
    source: fromConfig.has(peer.name.toLowerCase()) ? ("config" as const) : ("ui" as const),
    pinned: pinned.has(peer.name),
  }));
}

/**
 * The Peers section's whole REST surface. Mounted once by app.ts; the raised
 * listener is installed here so a mesh ask approval reaches the owner's devices
 * the same moment it starts waiting — the summary it carries is bounded and
 * content-free by construction (approvals.ts), so the note never leaks a
 * prompt or a file's bytes.
 */
export function meshRoutes(deps: MeshRoutesDeps): Router {
  const log = deps.log ?? (() => undefined);
  const queue = deps.approvals();
  if (queue !== null && deps.notify !== undefined) {
    queue.events((event) => {
      if (event.type !== "raised") return;
      deps.notify?.({
        kind: "mesh",
        chatId: "",
        sessionId: null,
        title: `Mesh approval from ${event.approval.peerName}`,
        body: event.approval.summary,
      });
    });
  }

  const router = Router();

  // One read of everything the Peers section shows. With the mesh off the
  // lists are honestly empty (no link can exist, the daemon closed them all)
  // while the node's own name, id and peers stay visible: a person turning the
  // mesh on wants to see what turning it on would reach.
  router.get("/", async (_req, res) => {
    const policies = [...resolvePolicies(deps.config()?.policies).keys()];
    let identity: NodeIdentity | null = null;
    try {
      identity = await deps.identity();
    } catch (error) {
      // The rest of the view still answers: a broken identity file is one log line, not a dead dialog.
      log(`the mesh identity could not be read for the peers view: ${said(error)}`);
    }
    const pins = await deps.pins.snapshot();
    const pinned = new Set(pins.outbound.map((pin) => pin.name));
    const approvals = deps.approvals()?.list() ?? [];
    const pending = identity === null ? [] : await deps.pins.pendingAll();
    res.json({
      enabled: deps.enabled(),
      name: deps.name(),
      nodeId: identity === null ? null : nodeIdOf(identity.publicKey),
      listen: deps.enabled() ? deps.listen() : null,
      policies,
      peers: peerRows(deps, pinned),
      pending: pending.map((entry) => ({
        nodeId: nodeIdOf(entry.publicKey),
        name: entry.name,
        sas: identity === null ? "" : sasOf(entry.publicKey, identity.publicKey, SAS_CONTEXT),
        seenAt: entry.seenAt,
        ...(entry.invited !== undefined ? { invitedPolicy: entry.invited.policy } : {}),
      })),
      approvals,
    });
    return;
  });

  // A peer added from the dialog: one config.yml-shaped entry into peers.json.
  // A name config.yml already uses is refused rather than shadowed, so what the
  // dialog shows is never a row that quietly loses to the file.
  router.post("/peers", async (req, res) => {
    requireMesh(deps);
    const entry = body(meshPeerSchema, req);
    if ((deps.config()?.peers ?? []).some((peer) => peer.name.toLowerCase() === entry.name.toLowerCase())) {
      throw new ChatError(409, "config_peer", `config.yml already defines a peer called "${entry.name}"; edit it there`);
    }
    try {
      await deps.saved.add(entry);
    } catch (error) {
      // The store's own refusal (a duplicate name, the 64-entry cap) is a 400,
      // never a silent success the dialog would believe.
      throw new ChatError(400, "peer_not_added", said(error));
    }
    res.json({ added: true });
    return;
  });

  // Removing is revocation: the saved entry goes, and with it every pin under
  // the name, so the peer's next call fails closed (the CLI's `peer remove`).
  // A config.yml peer is not this route's to remove.
  router.delete("/peers/:name", async (req, res) => {
    requireMesh(deps);
    const name = String(req.params.name);
    const inConfig = (deps.config()?.peers ?? []).some((peer) => peer.name.toLowerCase() === name.toLowerCase());
    if (inConfig) throw new ChatError(409, "config_peer", `"${name}" is defined in config.yml; remove it there`);
    const saved = deps.saved.snapshot().find((peer) => peer.name.toLowerCase() === name.toLowerCase());
    if (saved === undefined) throw new ChatError(404, "unknown_peer", `No saved mesh peer called "${name}"`);
    await deps.saved.remove(name);
    await deps.pins.removeByName(name);
    res.json({ removed: true });
    return;
  });

  // The Test button: one handshake and peer.info, nothing opened — the same
  // probe `awui peer test` runs. The error is the worker's own words (its
  // stderr tail, its refusal), never a stack.
  router.post("/peers/:name/test", async (req, res) => {
    requireMesh(deps);
    if (deps.peers === null) throw new ChatError(501, "no_manager", "This server runs no mesh leader side");
    const name = String(req.params.name);
    if (peerRows(deps, new Set()).find((peer) => peer.name.toLowerCase() === name.toLowerCase()) === undefined) {
      throw new ChatError(404, "unknown_peer", `No mesh peer called "${name}"`);
    }
    let connection;
    try {
      connection = await deps.peers.connect(name);
    } catch (error) {
      throw new ChatError(502, "peer_unreachable", said(error));
    }
    try {
      const info = await connection.info();
      res.json({ paired: connection.paired, policy: connection.policy, sas: connection.sas, info });
    } catch (error) {
      throw new ChatError(502, "peer_unreachable", said(error));
    } finally {
      connection.close();
    }
    return;
  });

  // Accept a pending caller by node id: the pin this CLI's `peer accept` would
  // write, with the same policy check (a typo must never pin a caller to the
  // "none" floor silently) and the same SAS already shown beside the button.
  router.post("/pending/:nodeId/accept", async (req, res) => {
    requireMesh(deps);
    const { policy } = body(acceptSchema, req);
    if (!resolvePolicies(deps.config()?.policies).has(policy)) {
      throw new ChatError(400, "unknown_policy", `no mesh policy named "${policy}" is configured here`);
    }
    const pending = await deps.pins.pendingByNode(String(req.params.nodeId));
    if (pending === null) throw new ChatError(404, "unknown_pending", "No pending request from that node; it may have expired or been rejected");
    await deps.pins.setInbound(pending.publicKey, pending.name, policy, "accept");
    // The request this Accept answered is spent: it leaves the pending list,
    // so the dialog never shows a caller it already pinned.
    await deps.pins.removePending(nodeIdOf(pending.publicKey));
    void deps.audit.append({ peer: pending.name, method: "ui.accept", decision: "allow", target: `policy ${policy}` });
    res.json({ accepted: true, name: pending.name });
    return;
  });

  // Reject is forgetting the request only: the caller stays unpinned (its next
  // hello lands in pending again), and any invite it redeemed is spent already.
  router.post("/pending/:nodeId/reject", async (req, res) => {
    requireMesh(deps);
    const nodeId = String(req.params.nodeId);
    const removed = await deps.pins.removePending(nodeId);
    if (!removed) throw new ChatError(404, "unknown_pending", "No pending request from that node");
    void deps.audit.append({ peer: nodeId, method: "ui.reject", decision: "deny" });
    res.json({ rejected: true });
    return;
  });

  // Mint one single-use invite, the `awui peer invite` the dialog replaces. The
  // default address is this node's own listener; a node with none mints a code
  // that pins the key but must be redeemed against a code that carries one.
  router.post("/invites", async (req, res) => {
    requireMesh(deps);
    const store = deps.invites();
    if (store === null) throw new ChatError(501, "no_daemon", "This server's mesh service is not running");
    const { policy: wanted, ttlMinutes } = body(inviteCreateBodySchema, req);
    const policy = wanted ?? "worker";
    if (!resolvePolicies(deps.config()?.policies).has(policy)) {
      throw new ChatError(400, "unknown_policy", `no mesh policy named "${policy}" is configured here`);
    }
    const at = deps.listen();
    const addresses = at === null ? [] : [`${at.host}:${at.port}`];
    let record;
    try {
      record = store.create(policy, ttlMinutes ?? 10, addresses);
    } catch (error) {
      throw new ChatError(409, "invite_limit", said(error));
    }
    const identity = await deps.identity();
    const code = encodeInviteCode({ v: 1, name: deps.name(), addresses, targetKey: identity.publicKey, inviteId: record.id, secret: record.secret });
    res.json({ code, qrSvg: qrToSvg(encodeQr(code)), policy, expiresAt: record.expiresAt });
    return;
  });

  // Join from a pasted code, the `awui peer join` the dialog replaces: pin the
  // key the code carries (the code is the trust), then prove the secret against
  // one live TLS link and save the first address that answered. Joining pairs
  // nothing — the target's owner still Accepts, with the invite's policy.
  router.post("/join", async (req, res) => {
    requireMesh(deps);
    const { code: text, name: wanted } = body(joinSchema, req);
    const code = decodeInviteCode(text.trim());
    if (code === null) {
      throw new ChatError(400, "bad_invite", 'that is not an awui invite code; it must start with "awui-invite:1:" and come from the target');
    }
    const name = wanted ?? code.name;
    const existing = await deps.pins.outbound(name);
    if (existing !== null && !existing.publicKey.equals(code.targetKey)) {
      throw new ChatError(409, "pin_mismatch", `"${name}" is already pinned to a different key; remove the peer first if you mean to re-pin it`);
    }
    await deps.pins.setOutbound(name, code.targetKey);
    if (code.addresses.length === 0) {
      res.json({ pinned: true, redeemed: false, saved: false, name });
      return;
    }
    const identity = await deps.identity();
    let unreachable: string | null = null;
    for (const address of code.addresses) {
      let dialed;
      try {
        dialed = await connectTls(address, { timeoutMs: 10_000 });
      } catch (error) {
        unreachable = said(error);
        continue;
      }
      const rpc = new RpcPeer(dialed.link, dialed.link, { role: "client" });
      rpc.start();
      try {
        const outcome = await clientHandshake(rpc, { identity, name: deps.name(), hops: 0, expectedServerKey: code.targetKey, tofu: false, binding: dialed.binding });
        const mac = inviteMac(code.secret, outcome.transcript);
        await rpc.request("peer.redeem", { inviteId: code.inviteId.toString("base64url"), mac: mac.toString("base64url") }, REDEEM_RPC_MS);
        try {
          await deps.saved.add({ name, tls: address });
        } catch (error) {
          throw new ChatError(409, "peer_exists", said(error));
        }
        void deps.audit.append({ peer: name, method: "ui.join", decision: "allow", target: address });
        res.json({ pinned: true, redeemed: true, saved: true, name });
        return;
      } catch (error) {
        // The invite lives in the target's one service, so a redeem that failed is final — no second address can answer differently.
        if (error instanceof ChatError) throw error;
        throw new ChatError(400, "join_failed", `${name} (${address}): ${said(error)}`);
      } finally {
        rpc.close("the join is done");
        dialed.link.destroy();
      }
    }
    throw new ChatError(502, "peer_unreachable", `no address in the code could be reached (${code.addresses.join(", ")})${unreachable === null ? "" : `: ${unreachable}`}`);
  });

  // One ask approval answered: exactly the CLI's three decisions, on the one
  // queue every link waits on. The audit line records the verdict, as the
  // wire's own decide path does.
  router.post("/approvals/:id", (req, res) => {
    requireMesh(deps);
    const store = deps.approvals();
    const { decision } = body(decideSchema, req);
    if (store === null || store.decide(String(req.params.id), decision) === "not-found") {
      throw new ChatError(404, "unknown_approval", "No mesh approval with that id is pending on this node");
    }
    void deps.audit.append({ peer: null, method: "ui.approvals.decide", decision: decision === "deny" ? "deny" : "allow", outcome: decision });
    res.json({ decided: true });
    return;
  });

  // This host's tasks — every peer's — as the owner reads them. With the mesh
  // off the list is honestly empty: turning it off disposed them all.
  router.get("/tasks", (_req, res) => {
    const tasks = deps.host.listAll().map((task) => ({
      remoteTaskId: task.remoteTaskId,
      chatId: task.chatId,
      peerName: task.peerName,
      nodeId: task.nodeId,
      harness: task.harness,
      cwd: task.cwd,
      state: task.state,
      pendingRequests: task.chat.snapshot().pending.map((request) => {
        const answers = approvalAnswers(request);
        return {
          id: request.id,
          kind: request.kind,
          summary: request.title,
          ...(answers !== null ? { approval: answers } : {}),
        };
      }),
      createdAt: task.createdAt,
    }));
    res.json({ tasks });
    return;
  });

  // Answer one request on a peer-owned chat: the same Chat.answer the normal
  // chat approval route calls, so the first answer wins over the peer's own
  // task.answer exactly as "both" promises. This is the surface the target's
  // owner lacked under approvals_at target.
  router.post("/tasks/:remoteTaskId/answer", (req, res) => {
    requireMesh(deps);
    const task = deps.host.peek(String(req.params.remoteTaskId));
    if (task === undefined) throw new ChatError(404, "unknown_task", "No mesh task with that id is open on this node");
    const { requestId, answer, denialReason } = body(taskAnswerSchema, req);
    // Chat.answer's own refusal (an already-answered request, a closed chat) bubbles
    // as the same 409/404 the chat route answers with.
    const outcome = task.chat.answer(requestId, answer, denialReason);
    void deps.audit.append({ peer: task.peerName, method: "ui.task.answer", decision: "allow", target: task.remoteTaskId, outcome });
    res.json({ outcome });
    return;
  });

  // Stop a peer's run here: the same abort the chat's own Stop sends.
  router.post("/tasks/:remoteTaskId/abort", async (req, res) => {
    requireMesh(deps);
    const task = deps.host.peek(String(req.params.remoteTaskId));
    if (task === undefined) throw new ChatError(404, "unknown_task", "No mesh task with that id is open on this node");
    try {
      await task.chat.abort();
    } catch (error) {
      throw new ChatError(409, "abort_failed", said(error));
    }
    void deps.audit.append({ peer: task.peerName, method: "ui.task.abort", decision: "deny", target: task.remoteTaskId });
    res.json({ aborted: true });
    return;
  });

  return router;
}
