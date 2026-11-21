// The worker end of the mesh (P1): `awui peer serve-stdio` and the serve()
// loop behind it. One link is one SSH or docker exec session speaking
// newline-delimited JSON-RPC on stdio, and this module is the target-side
// policy enforcement point, so every rule the specs spell out lives here: the
// mesh is off unless config says otherwise, the handshake must finish before
// anything else, inbound policy is re-resolved on every call (pins re-read
// from disk, config re-read behind the caller's cache) so an accept, a
// revocation, or a policy edit bites on the very next request, and a task's
// harness session is a real delegated chat opened with no toolEnv — a remote
// child gets no orchestration tools at all, which makes max_hops 1 structural
// and not just a checked number. Nothing but protocol is ever written to the
// link's output; every decision goes to the audit log with lengths, never
// prompt text, answers, or file contents.
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { interactionAnswerSchema } from "../../shared/protocol.js";
import { loadConfig, type ServerConfig } from "../config.js";
import { HarnessRegistry } from "../harness/registry.js";
import type { LiveChat } from "../harness/types.js";
import { AuditLog } from "./audit.js";
import { ServerHandshake } from "./handshake.js";
import { loadOrCreateIdentity, nodeIdOf, type NodeIdentity } from "./identity.js";
import {
  BUILTIN_POLICIES,
  CEILINGS,
  checkHops,
  clampCeiling,
  decide,
  harnessAllowed,
  resolveInRoots,
  resolvePolicies,
  type Cap,
  type Ceiling,
  type PeerPolicy,
} from "./policy.js";
import { PinStore } from "./pins.js";
import { MeshErrorCode, MeshRpcError, RpcPeer } from "./rpc.js";
import { configDir, configEnv, meshConfig, meshEnabled, readUserConfig, type MeshConfig } from "../user-config.js";

/** EX_CONFIG: bad settings; retrying cannot help, so a supervisor should not restart into the same refusal. */
const EXIT_CONFIG = 78;
/** A peer or policy name as config.yml spells it (P0). */
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The spec's ceiling -> harness permission mode table. Only harnesses whose
 * mode vocabulary awui knows are here; the three names a remote caller must
 * never be given ("bypassPermissions", "full-access", and claude's "auto")
 * appear nowhere in it, and permissionModeFor refuses anything that would.
 */
const CEILING_MODES: Record<string, Record<Ceiling, string>> = {
  claude: { "read-only": "plan", default: "default", "auto-edit": "acceptEdits" },
  codex: { "read-only": "read-only", default: "read-only", "auto-edit": "auto" },
  // Tests: the fake harness's own modes, so a ceiling can be exercised end to end.
  fake: { "read-only": "default", default: "default", "auto-edit": "acceptEdits" },
};

/** Modes no remote caller may ever be handed, whatever a table or harness offers. */
const FORBIDDEN_MODES = ["bypassPermissions", "full-access"];

/**
 * Maps one effective ceiling to the permission mode a harness session is held
 * to. A harness that reports modes must offer the mapped id, or the task is
 * refused — a mapping the harness cannot keep is a silent grant, not a
 * ceiling. A harness with no modes at all (pi, omp, …) cannot be held to less
 * than itself, so it is allowed only at auto-edit, with no mode to set.
 */
export function permissionModeFor(
  harnessId: string,
  ceiling: Ceiling,
  available: string[] | undefined,
): { ok: true; mode: string | null } | { ok: false; reason: string } {
  if (available !== undefined && available.length > 0) {
    const table = CEILING_MODES[harnessId];
    if (table === undefined) {
      return { ok: false, reason: `harness "${harnessId}" reports permission modes, but no ceiling mapping is defined for it, so a remote task cannot be held to one` };
    }
    const mode = table[ceiling];
    if (FORBIDDEN_MODES.includes(mode)) {
      return { ok: false, reason: `the ceiling "${ceiling}" would map harness "${harnessId}" to "${mode}", which a remote caller may never be given` };
    }
    if (!available.includes(mode)) {
      return { ok: false, reason: `the ceiling "${ceiling}" maps harness "${harnessId}" to permission mode "${mode}", which it does not offer` };
    }
    return { ok: true, mode };
  }
  if (ceiling !== "auto-edit") {
    return { ok: false, reason: `harness "${harnessId}" has no permission modes, so it cannot be held to the "${ceiling}" ceiling` };
  }
  return { ok: true, mode: null };
}

/** What the link's dispatcher notes down about one call, for the audit entry: what it pointed at, and what happened. */
interface CallNote {
  target?: string;
  outcome?: string;
}

const pingSchema = z.object({}).strict();
const openSchema = z
  .object({
    clientRequestId: z.string().min(1).max(256),
    harness: z.string().min(1).max(64),
    cwd: z.string().min(1).max(4096),
    model: z.string().min(1).max(256).optional(),
    thinkingLevel: z.string().min(1).max(256).optional(),
    ceiling: z.enum(CEILINGS).optional(),
    hops: z.number().int().min(0).max(255),
  })
  .strict();
const promptSchema = z
  .object({
    remoteTaskId: z.string().min(1).max(64),
    // Bounded well under the wire's own line bound; the harness sees the whole text.
    text: z.string().min(1).max(1_000_000),
    mode: z.enum(["prompt", "steer", "followUp"]),
  })
  .strict();
const answerSchema = z
  .object({
    remoteTaskId: z.string().min(1).max(64),
    requestId: z.string().min(1).max(256),
    answer: interactionAnswerSchema,
  })
  .strict();
const idSchema = z.object({ remoteTaskId: z.string().min(1).max(64) }).strict();
const configSchema = z
  .object({
    remoteTaskId: z.string().min(1).max(64),
    patch: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** One strict params parse: a shape the protocol did not promise is an invalid request, never a best-effort read. */
function parse<T>(schema: z.ZodType<T>, method: string, params: unknown): T {
  const parsed = schema.safeParse(params);
  if (!parsed.success) throw new MeshRpcError(MeshErrorCode.invalid_params, `${method} params were not the promised shape`, { code: "invalid_params" });
  return parsed.data;
}

export interface ServeDeps {
  identity: NodeIdentity;
  /** This node's mesh name, what the client pins beside the key. */
  name: string;
  pins: PinStore;
  audit: AuditLog;
  registry: Pick<HarnessRegistry, "get" | "available">;
  /** The mesh block as config.yml has it now; re-read by the caller, cached. */
  config: () => MeshConfig | undefined;
  enabled: () => boolean;
  home: string;
  /**
   * The authorized_keys forced-command form: --policy and --peer together. The
   * OS has already bound this SSH key to this policy, so the pin follows the
   * key (TOFU on first contact), and the named policy is always the ceiling.
   */
  forced?: { policy: string; peer: string };
  log?: (m: string) => void;
}

/** One inbound task this link opened: the live chat, its event counter, and the requests awaiting an answer. */
interface LinkTask {
  remoteTaskId: string;
  live: LiveChat;
  unsubscribe: () => void;
  /** The seq of the last task.event sent; a task's first event is 1. */
  seq: number;
  /** InteractionRequests the harness raised and nobody has answered yet. */
  pendingRequests: Set<string>;
}

/** What the worker resolves an inbound caller to: paired or not, and under which policy. */
interface Inbound {
  paired: boolean;
  policyName: string;
  policy: PeerPolicy;
  /** A pin under the forced peer name holds a different key: an impersonation, and the link must close. */
  mismatch: boolean;
}

/**
 * Serves one mesh link on the given stdio pair: preamble, handshake, then the
 * P1 method table, every call held to the inbound policy resolved fresh.
 * `closed` resolves once the link is down AND every chat it opened has been
 * disposed, with the close reason.
 */
export function serve(io: { input: Readable; output: Writable }, deps: ServeDeps): { closed: Promise<string> } {
  const log = deps.log ?? (() => undefined);
  const peer = new RpcPeer(io.input, io.output, { role: "server", log });
  const tasks = new Map<string, LinkTask>();
  /** clientRequestId -> the answer already given, so a retry returns the same task, not a second chat. */
  const opens = new Map<string, { remoteTaskId: string; result: unknown }>();
  let peerName: string | null = null;
  let pendingRecorded = false;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Closes the link one moment after the current reply is written: a refused peer gets its error, never a silent drop. */
  const closeSoon = (reason: string): void => {
    if (closeTimer !== null) return;
    closeTimer = setTimeout(() => peer.close(reason), 50);
    closeTimer.unref?.();
  };

  /**
   * The inbound policy for this link's client key, exactly per the spec's
   * resolution rules: forced mode pins the key under the forced name (a
   * different key already holding that name is a mismatch), otherwise the pin
   * by node id decides pairing, and a config peer entry of the same name can
   * re-point the policy. Unknown names fall back to `none`, the floor.
   */
  const resolveInbound = async (clientKey: Buffer): Promise<Inbound> => {
    const mesh = deps.config();
    const policies = resolvePolicies(mesh?.policies);
    const none = policies.get("none") ?? BUILTIN_POLICIES.none;
    if (deps.forced !== undefined) {
      const named = await deps.pins.inboundByName(deps.forced.peer);
      if (named !== null && !named.publicKey.equals(clientKey)) return { paired: false, policyName: "none", policy: none, mismatch: true };
      if ((await deps.pins.inbound(nodeIdOf(clientKey))) === null) {
        // TOFU: the OS already bound this key to this policy, so the pin follows it.
        await deps.pins.setInbound(clientKey, deps.forced.peer, deps.forced.policy, "forced");
      }
      // With --policy the forced command is the ceiling: config's say for this name never widens it.
      return { paired: true, policyName: deps.forced.policy, policy: policies.get(deps.forced.policy) ?? none, mismatch: false };
    }
    const pinned = await deps.pins.inbound(nodeIdOf(clientKey));
    if (pinned === null) return { paired: false, policyName: "none", policy: none, mismatch: false };
    const configured = mesh?.peers?.find((entry) => entry.name === pinned.name);
    const policyName = configured?.inbound_policy ?? pinned.policy;
    return { paired: true, policyName, policy: policies.get(policyName) ?? none, mismatch: false };
  };

  const handshake = new ServerHandshake({
    identity: deps.identity,
    name: deps.name,
    resolve: async (clientKey, clientName) => {
      peerName = clientName;
      const inbound = await resolveInbound(clientKey);
      if (inbound.mismatch) {
        closeSoon(`pin: a different key is pinned as "${deps.forced?.peer}"`);
        throw new MeshRpcError(
          MeshErrorCode.pin_mismatch,
          `A different key is already pinned under the peer name "${deps.forced?.peer}"; the link was closed`,
          { code: "pin_mismatch" },
        );
      }
      if (!inbound.paired && !pendingRecorded) {
        // Once per link: one pending entry is what a person compares before saying yes.
        pendingRecorded = true;
        await deps.pins
          .addPending(clientKey, clientName)
          .catch((error: unknown) => log(`mesh serve: could not record the pending request: ${error instanceof Error ? error.message : String(error)}`));
      }
      return { paired: inbound.paired, policy: inbound.policyName };
    },
  });

  /** The cap gate every method goes through: allow, ask (-33003, unsupported in P1), or deny (-33002) with the reason. */
  const requireCap = (policy: PeerPolicy, cap: Cap, method: string): void => {
    const decision = decide(policy, cap);
    if (decision.kind === "allow") return;
    if (decision.kind === "ask") {
      throw new MeshRpcError(MeshErrorCode.needs_approval, `"${method}" needs an approval on the target; P1 supports caps only`, { code: "needs_approval" });
    }
    throw new MeshRpcError(MeshErrorCode.denied, `the policy refuses "${method}": ${decision.reason}`, { code: "denied" });
  };

  const taskOf = (remoteTaskId: string): LinkTask => {
    const task = tasks.get(remoteTaskId);
    if (task === undefined) throw new MeshRpcError(MeshErrorCode.not_found, `no task "${remoteTaskId}" is open on this link`, { code: "not_found" });
    return task;
  };

  const info = async (policy: PeerPolicy): Promise<unknown> => {
    requireCap(policy, "discover", "peer.info");
    const harnesses: string[] = [];
    for (const id of policy.harnesses) {
      // allowed ∩ available: naming a harness this node cannot start would promise work it cannot do.
      if (deps.registry.get(id) === undefined) continue;
      if (await deps.registry.available(id)) harnesses.push(id);
    }
    return {
      name: deps.name,
      nodeId: deps.identity.nodeId,
      harnesses,
      roots: policy.roots,
      ceiling: policy.permissionCeiling,
      approvalsAt: policy.approvalsAt,
      maxTasks: policy.maxTasks,
    };
  };

  const openTask = async (policy: PeerPolicy, raw: unknown, note: (entry: CallNote) => void): Promise<unknown> => {
    const params = parse(openSchema, "task.open", raw);
    note({ target: params.cwd });
    requireCap(policy, "task.run", "task.open");
    // The spec's check order, each refusal its own code: hops, approvals, harness, cwd, task count, idempotency, ceiling.
    if (!checkHops(params.hops)) {
      throw new MeshRpcError(MeshErrorCode.hop_limit, "hops reached max_hops; a remote task can never start another remote task", { code: "hop_limit" });
    }
    if (policy.approvalsAt !== "origin") {
      throw new MeshRpcError(
        MeshErrorCode.needs_approval,
        `this policy's approvals sit on the target ("${policy.approvalsAt}"); approvals there need the target's awui service (P1.5)`,
        { code: "needs_approval" },
      );
    }
    if (!harnessAllowed(policy, params.harness)) {
      throw new MeshRpcError(
        MeshErrorCode.denied,
        `harness "${params.harness}" is not in the policy's allowlist (${policy.harnesses.join(", ")})`,
        { code: "denied" },
      );
    }
    const adapter = deps.registry.get(params.harness);
    if (adapter === undefined) throw new MeshRpcError(MeshErrorCode.denied, `harness "${params.harness}" is not registered on this node`, { code: "denied" });
    if (!(await deps.registry.available(params.harness))) {
      throw new MeshRpcError(MeshErrorCode.denied, `harness "${params.harness}" is not available on this node`, { code: "denied" });
    }
    const resolved = await resolveInRoots(policy, params.cwd, deps.home);
    if (!resolved.ok) throw new MeshRpcError(MeshErrorCode.denied, `the requested cwd is refused: ${resolved.reason}`, { code: "denied" });
    let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
    try {
      stat = await fs.stat(resolved.real);
    } catch {
      // A cwd that does not exist is refused just below.
    }
    if (stat === null || !stat.isDirectory()) {
      throw new MeshRpcError(MeshErrorCode.denied, "the requested cwd is not an existing directory", { code: "denied" });
    }
    if (tasks.size >= policy.maxTasks) {
      throw new MeshRpcError(MeshErrorCode.limit, `this peer already holds ${tasks.size} live tasks and the policy allows ${policy.maxTasks}`, { code: "limit" });
    }
    const existing = opens.get(params.clientRequestId);
    if (existing !== undefined) return existing.result;
    const ceiling = clampCeiling(policy, params.ceiling);
    // A real harness session, delegated, and with no toolEnv at all: the remote child gets no
    // orchestration tools, so it cannot delegate, and max_hops 1 holds structurally.
    const live = await adapter.openChat({ cwd: resolved.real, delegated: true });
    const config = await live.getConfig();
    const mode = permissionModeFor(params.harness, ceiling, config.permissionModes?.map((m) => m.id));
    if (!mode.ok) {
      await live.dispose().catch(() => undefined);
      throw new MeshRpcError(MeshErrorCode.denied, `the requested ceiling cannot be enforced: ${mode.reason}`, { code: "denied" });
    }
    try {
      if (mode.mode !== null) await live.setConfig({ permissionMode: mode.mode });
      if (params.model !== undefined || params.thinkingLevel !== undefined) {
        await live.setConfig({
          ...(params.model !== undefined ? { model: params.model } : {}),
          ...(params.thinkingLevel !== undefined ? { thinkingLevel: params.thinkingLevel } : {}),
        });
      }
    } catch (error) {
      await live.dispose().catch(() => undefined);
      throw new MeshRpcError(
        MeshErrorCode.invalid_params,
        `the harness refused the requested config: ${error instanceof Error ? error.message : String(error)}`,
        { code: "invalid_params" },
      );
    }
    const remoteTaskId = `rt_${randomBytes(6).toString("hex")}`;
    const task: LinkTask = { remoteTaskId, live, unsubscribe: () => undefined, seq: 0, pendingRequests: new Set() };
    task.unsubscribe = live.subscribe((event) => {
      if (event.type === "request") task.pendingRequests.add(event.request.id);
      if (event.type === "request_cancelled") task.pendingRequests.delete(event.requestId);
      peer.notify("task.event", { remoteTaskId, seq: ++task.seq, event });
    });
    tasks.set(remoteTaskId, task);
    // nativeId rides along: some harnesses know their session at open and never emit a "session" event.
    const result = { remoteTaskId, config: await live.getConfig(), nativeId: live.nativeId };
    opens.set(params.clientRequestId, { remoteTaskId, result });
    note({ outcome: remoteTaskId });
    return result;
  };

  const promptTask = async (policy: PeerPolicy, raw: unknown, note: (entry: CallNote) => void): Promise<unknown> => {
    const params = parse(promptSchema, "task.prompt", raw);
    // Lengths only, never the text: the audit log is evidence about who asked, not a transcript.
    note({ target: params.remoteTaskId, outcome: `${params.mode} ${params.text.length} chars` });
    requireCap(policy, "task.run", "task.prompt");
    const task = taskOf(params.remoteTaskId);
    if (params.mode === "prompt") await task.live.prompt(params.text);
    else if (params.mode === "steer") await task.live.steer(params.text);
    else await task.live.followUp(params.text);
    return {};
  };

  const answerTask = async (policy: PeerPolicy, raw: unknown, note: (entry: CallNote) => void): Promise<unknown> => {
    const params = parse(answerSchema, "task.answer", raw);
    note({ target: params.remoteTaskId });
    requireCap(policy, "task.approve", "task.answer");
    if (policy.approvalsAt === "target") {
      throw new MeshRpcError(MeshErrorCode.denied, "this policy's approvals sit on the target, so the caller may not answer them", { code: "denied" });
    }
    const task = taskOf(params.remoteTaskId);
    if (!task.pendingRequests.has(params.requestId)) {
      throw new MeshRpcError(MeshErrorCode.not_found, "that request is not pending on the task", { code: "not_found" });
    }
    if (!task.live.answer(params.requestId, params.answer)) {
      throw new MeshRpcError(MeshErrorCode.not_found, "the request was already resolved", { code: "not_found" });
    }
    task.pendingRequests.delete(params.requestId);
    return { answered: true };
  };

  const abortTask = async (policy: PeerPolicy, raw: unknown, note: (entry: CallNote) => void): Promise<unknown> => {
    const params = parse(idSchema, "task.abort", raw);
    note({ target: params.remoteTaskId });
    requireCap(policy, "task.run", "task.abort");
    await taskOf(params.remoteTaskId).live.abort();
    return {};
  };

  const closeTask = async (policy: PeerPolicy, raw: unknown, note: (entry: CallNote) => void): Promise<unknown> => {
    const params = parse(idSchema, "task.close", raw);
    note({ target: params.remoteTaskId });
    requireCap(policy, "task.run", "task.close");
    const task = taskOf(params.remoteTaskId);
    tasks.delete(params.remoteTaskId);
    task.unsubscribe();
    await task.live.dispose().catch((error: unknown) => log(`mesh serve: disposing a task failed: ${error instanceof Error ? error.message : String(error)}`));
    return {};
  };

  const historyTask = async (policy: PeerPolicy, raw: unknown, note: (entry: CallNote) => void): Promise<unknown> => {
    const params = parse(idSchema, "task.history", raw);
    note({ target: params.remoteTaskId });
    requireCap(policy, "task.run", "task.history");
    return taskOf(params.remoteTaskId).live.history();
  };

  const configTask = async (policy: PeerPolicy, raw: unknown, note: (entry: CallNote) => void): Promise<unknown> => {
    const params = parse(configSchema, "task.config", raw);
    note({ target: params.remoteTaskId });
    requireCap(policy, "task.run", "task.config");
    const task = taskOf(params.remoteTaskId);
    if (params.patch === undefined) return task.live.getConfig();
    // Model and thinking level only; permissionMode is the target's own decision (the ceiling), never the caller's.
    const patch = params.patch;
    const refused = Object.keys(patch).filter((key) => key !== "model" && key !== "thinkingLevel");
    if (refused.length > 0) {
      throw new MeshRpcError(
        MeshErrorCode.invalid_params,
        `task.config accepts only "model" and "thinkingLevel", never ${refused.map((key) => `"${key}"`).join(", ")}`,
        { code: "invalid_params" },
      );
    }
    if (patch.model !== undefined && typeof patch.model !== "string") {
      throw new MeshRpcError(MeshErrorCode.invalid_params, '"model" must be a string', { code: "invalid_params" });
    }
    if (patch.thinkingLevel !== undefined && typeof patch.thinkingLevel !== "string") {
      throw new MeshRpcError(MeshErrorCode.invalid_params, '"thinkingLevel" must be a string', { code: "invalid_params" });
    }
    await task.live.setConfig({
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.thinkingLevel !== undefined ? { thinkingLevel: patch.thinkingLevel } : {}),
    });
    return task.live.getConfig();
  };

  const dispatch = async (method: string, params: unknown, note: (entry: CallNote) => void): Promise<unknown> => {
    if (!deps.enabled()) {
      closeSoon("mesh off");
      throw new MeshRpcError(MeshErrorCode.mesh_off, "The mesh is off on this node", { code: "mesh_off" });
    }
    const handshakeAnswer = handshake.handle(method, params);
    if (handshakeAnswer !== null) return handshakeAnswer;
    const client = handshake.client;
    if (client === null) {
      throw new MeshRpcError(MeshErrorCode.not_paired, "The handshake must complete before any other method", { code: "not_paired" });
    }
    peerName = client.name;
    // Re-resolved on every call, pins included: a revocation or an accept lands on the next request, never at a restart.
    const inbound = await resolveInbound(client.publicKey);
    if (inbound.mismatch) {
      closeSoon(`pin: a different key is pinned as "${deps.forced?.peer}"`);
      throw new MeshRpcError(
        MeshErrorCode.pin_mismatch,
        `A different key is already pinned under the peer name "${deps.forced?.peer}"; the link was closed`,
        { code: "pin_mismatch" },
      );
    }
    if (!inbound.paired && method !== "peer.ping") {
      throw new MeshRpcError(
        MeshErrorCode.not_paired,
        `This node has not accepted "${client.name}" yet; compare the node id and SAS, then run "awui peer accept"`,
        { code: "not_paired" },
      );
    }
    const policy = inbound.policy;
    switch (method) {
      case "peer.ping":
        parse(pingSchema, method, params);
        return {};
      case "peer.info":
        return info(policy);
      case "task.open":
        return openTask(policy, params, note);
      case "task.prompt":
        return promptTask(policy, params, note);
      case "task.answer":
        return answerTask(policy, params, note);
      case "task.abort":
        return abortTask(policy, params, note);
      case "task.close":
        return closeTask(policy, params, note);
      case "task.history":
        return historyTask(policy, params, note);
      case "task.config":
        return configTask(policy, params, note);
      default:
        throw new MeshRpcError(MeshErrorCode.method_not_found, `no method "${method}" is served`, { code: "method_not_found" });
    }
  };

  peer.onRequest(async (method, params) => {
    const noted: CallNote = {};
    const note = (entry: CallNote): void => {
      if (entry.target !== undefined) noted.target = entry.target;
      if (entry.outcome !== undefined) noted.outcome = entry.outcome;
    };
    try {
      const result = await dispatch(method, params, note);
      // Bookkeeping never delays the answer; a failed append is the audit log's to report.
      void deps.audit.append({
        peer: peerName,
        method,
        ...(noted.target !== undefined ? { target: noted.target } : {}),
        decision: "allow",
        ...(noted.outcome !== undefined ? { outcome: noted.outcome } : {}),
      });
      return result;
    } catch (error) {
      const decision: "ask" | "deny" | "error" =
        error instanceof MeshRpcError
          ? error.code === MeshErrorCode.needs_approval
            ? "ask"
            : error.code === MeshErrorCode.internal_error
              ? "error"
              : "deny"
          : "error";
      if (!(error instanceof MeshRpcError)) {
        // An unexpected failure is ours to read locally, never evidence for the peer.
        log(`mesh serve: "${method}" failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      void deps.audit.append({
        peer: peerName,
        method,
        ...(noted.target !== undefined ? { target: noted.target } : {}),
        decision,
        outcome: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });

  peer.start();
  const closed = peer.closed.then(async (reason) => {
    if (closeTimer !== null) clearTimeout(closeTimer);
    // A P1 link is ephemeral: every chat it opened dies with it, and a failed disposal never keeps the link alive.
    const live = [...tasks.values()];
    tasks.clear();
    await Promise.allSettled(live.map((task) => task.live.dispose()));
    void deps.audit.append({ peer: peerName, method: "link closed", decision: reason === "eof" || reason === "closed" ? "allow" : "error", outcome: reason });
    return reason;
  });
  return { closed };
}

/**
 * `awui peer serve-stdio [--peer <name>] [--policy <policy>]`: the worker end
 * of an SSH or docker exec link, run as the remote command. Protocol only on
 * stdout, every log line on stderr, and a refusal (78) when the mesh is off.
 * The forced form takes --policy and --peer together, as authorized_keys
 * spells it; without a forced command a caller who can SSH in already has a
 * shell, so --policy grants nothing extra.
 */
export async function runServeStdio(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  let forcedPeer: string | undefined;
  let forcedPolicy: string | undefined;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (arg === "--peer" || arg === "--policy") {
      const value = args[++at];
      if (value === undefined) {
        console.error(`awui peer serve-stdio: ${arg} needs a value`);
        return 2;
      }
      if (arg === "--peer") forcedPeer = value;
      else forcedPolicy = value;
    } else {
      console.error(`awui peer serve-stdio: unknown option: ${arg}`);
      return 2;
    }
  }
  if ((forcedPeer === undefined) !== (forcedPolicy === undefined)) {
    console.error("awui peer serve-stdio: --policy and --peer are the one forced-command form; give both or neither");
    return 2;
  }
  if (forcedPeer !== undefined && !NAME_RE.test(forcedPeer)) {
    console.error(`awui peer serve-stdio: peer name ${JSON.stringify(forcedPeer)} must match ${NAME_RE}`);
    return 2;
  }
  const forced = forcedPeer !== undefined && forcedPolicy !== undefined ? { policy: forcedPolicy, peer: forcedPeer } : undefined;
  const log = (message: string): void => console.error(`awui peer serve-stdio: ${message}`);
  let settings: ReturnType<typeof readUserConfig> = null;
  let config: ServerConfig;
  try {
    settings = readUserConfig(configDir(env));
    config = loadConfig({ ...(settings ? configEnv(settings.config) : {}), ...env }, settings?.config);
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return EXIT_CONFIG;
  }
  if (!meshEnabled(settings?.config, env)) {
    console.error("awui peer serve-stdio: the mesh is off on this node; set mesh.enabled: true in awui's config.yml");
    return EXIT_CONFIG;
  }
  if (forced !== undefined) {
    let policies: Map<string, PeerPolicy>;
    try {
      policies = resolvePolicies(meshConfig(settings?.config)?.policies);
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
      return EXIT_CONFIG;
    }
    if (!policies.has(forced.policy)) {
      console.error(`awui peer serve-stdio: no mesh policy named "${forced.policy}"`);
      return 2;
    }
  }
  let identity: NodeIdentity;
  try {
    identity = await loadOrCreateIdentity(config.stateDir);
  } catch (error) {
    log(`the mesh identity could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  let registry: HarnessRegistry;
  try {
    registry = HarnessRegistry.fromConfig(config);
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return EXIT_CONFIG;
  }
  const pins = PinStore(path.join(config.stateDir, "mesh", "pins.json"));
  const audit = new AuditLog(path.join(config.stateDir, "mesh", "audit.jsonl"), log);
  // Config is re-read at most every 2 s: the caller checks on every request, but the file is not parsed that often.
  let cachedAt = Date.now();
  let cached: { mesh: MeshConfig | undefined; on: boolean } = { mesh: meshConfig(settings?.config), on: meshEnabled(settings?.config, env) };
  const reread = (): void => {
    if (Date.now() - cachedAt < 2000) return;
    cachedAt = Date.now();
    try {
      const fresh = readUserConfig(configDir(env));
      cached = { mesh: meshConfig(fresh?.config), on: meshEnabled(fresh?.config, env) };
    } catch {
      // A config.yml broken since startup keeps the last good answer; startup logged the file's problems.
    }
  };
  // The mesh name, sanitized the way a peer name may be written (P0's default).
  const fallback = hostname().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
  const name = cached.mesh?.name ?? (fallback.length > 0 ? fallback : "awui");
  const link = serve({ input: process.stdin, output: process.stdout }, {
    identity,
    name,
    pins,
    audit,
    registry,
    config: () => {
      reread();
      return cached.mesh;
    },
    enabled: () => {
      reread();
      return cached.on;
    },
    home: config.home,
    ...(forced !== undefined ? { forced } : {}),
    log,
  });
  const reason = await link.closed;
  await registry.shutdown().catch(() => undefined);
  return reason === "eof" || reason === "closed" ? 0 : 1;
}
