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
import type { MeshPeerEntry } from "./peer-store.js";
import { PeerPeersStore } from "./peer-store.js";
import { loadConfig, type ServerConfig } from "../config.js";
import { HarnessRegistry } from "../harness/registry.js";
import { TerminalManager } from "../terminal.js";
import type { LiveChat } from "../harness/types.js";
import type { ApprovalQueue } from "./approvals.js";
import { ATTACH_FALLBACK_NOTE, connectAndPipe, planServeStdio, socketPath } from "./attach.js";
import { AuditLog } from "./audit.js";
import { fsList, fsRead, fsStat, fsWrite } from "./files.js";
import { HandoffWorker } from "./handoff-worker.js";
import { ServerHandshake } from "./handshake.js";
import type { HostLink, TaskHost } from "./host.js";
import { loadOrCreateIdentity, nodeIdOf, type NodeIdentity } from "./identity.js";
import { TermHost } from "./terms.js";
import { encodeInviteCode, inviteCreateSchema, redeemInvite, type InviteStore } from "./pairing.js";
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
/** EX_TEMPFAIL: no awui service to attach to right now; a caller may retry later (sendmail's code). */
const EXIT_TEMPFAIL = 75;
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
/** How many task.open idempotency keys one link remembers. */
const MAX_OPEN_KEYS = 128;
/** The spec's per-link write pace: at most 32 fs.write calls in any sliding minute. */
const WRITES_PER_MINUTE = 32;
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
  /**
   * A term.input's decoded byte count (finding #12): keystrokes are traffic,
   * not decisions, so allowed inputs are aggregated to one audit line per
   * minute instead of one per call.
   */
  inputBytes?: number;
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
/** task.attach (daemon only): replay the task's ring past this seq, then stream live. */
const attachSchema = z
  .object({
    remoteTaskId: z.string().min(1).max(64),
    afterSeq: z.number().int().min(0),
  })
  .strict();
/** task.list (daemon only): this peer's live tasks. */
const listSchema = z.object({}).strict();
// term.* params (P3 §1): strict, and deliberately without a shell or env field
// at all — the caller chooses a cwd and a size, and the target's own
// TerminalManager decides everything else. The dims bound is the spec's; a
// target whose own terminal bound is narrower refuses the rest itself.
const termOpenSchema = z
  .object({
    cwd: z.string().min(1).max(4096),
    cols: z.number().int().min(10).max(500),
    rows: z.number().int().min(5).max(200),
  })
  .strict();
/** term.input: 64 KiB of bytes is 87384 base64 characters at the very most. */
const termInputSchema = z
  .object({
    termId: z.string().min(1).max(64),
    data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, "not base64").max(87_384),
  })
  .strict();
const termResizeSchema = z
  .object({
    termId: z.string().min(1).max(64),
    cols: z.number().int().min(10).max(500),
    rows: z.number().int().min(5).max(200),
  })
  .strict();
const termIdSchema = z.object({ termId: z.string().min(1).max(64) }).strict();
/** term.attach (daemon only): replay the terminal's ring past this seq, then stream live. */
const termAttachSchema = z
  .object({
    termId: z.string().min(1).max(64),
    afterSeq: z.number().int().min(0),
  })
  .strict();
/** term.list (daemon and ephemeral): this peer's terminals. */
const termListSchema = z.object({}).strict();
// fs.* params (P1.5): strict like every other shape, paths bounded to the
// same 4096 a cwd gets. Sizes are deliberately not schema-bounds here: an
// oversized read or write is the wire's limit answer, not a bad shape, and
// base64 shape is checked the same way shared/protocol.ts checks image data.
const fsStatSchema = z.object({ path: z.string().min(1).max(4096) }).strict();
const fsListSchema = z
  .object({
    path: z.string().min(1).max(4096),
    limit: z.number().int().min(1).max(1000).optional(),
  })
  .strict();
const fsReadSchema = z
  .object({
    path: z.string().min(1).max(4096),
    offset: z.number().int().min(0).optional(),
    length: z.number().int().min(1).optional(),
  })
  .strict();
const fsWriteSchema = z
  .object({
    path: z.string().min(1).max(4096),
    data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, "not base64"),
    mode: z.enum(["create", "overwrite"]),
    expectMtimeMs: z.number().optional(),
  })
  .strict();
/**
 * A base64url field of exactly n bytes: the charset is checked first because
 * Buffer.from(base64url) silently skips characters it does not know, which
 * would let a malformed field decode to a shorter, different value.
 */
const b64uBytes = (n: number) =>
  z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${Math.floor((4 * n + 2) / 3)}}$`)).transform((s) => Buffer.from(s, "base64url"));
/** peer.redeem (P2 §3): the invite's id and the MAC binding it to this one link's handshake. */
const redeemSchema = z.object({ inviteId: b64uBytes(8), mac: b64uBytes(32) }).strict();
/** local.approvals.list: nothing to ask for. */
// handoff.* params (P3 §2): the shapes the worker methods promise. Sizes are
// judged in the worker, not here, because the bundle cap is the worker's own
// bound to answer with; a bad sha256 shape is a bad shape, so it is a parse.
const handoffBeginSchema = z
  .object({
    repoCwd: z.string().min(1).max(4096),
    size: z.number().int().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
const handoffChunkSchema = z
  .object({
    uploadId: z.string().min(1).max(64),
    index: z.number().int().min(0),
    data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, "not base64"),
  })
  .strict();
const handoffIdSchema = z.object({ uploadId: z.string().min(1).max(64) }).strict();
const handoffExportSchema = z.object({ worktree: z.string().min(1).max(4096) }).strict();
const handoffReadSchema = z
  .object({
    exportId: z.string().min(1).max(64),
    index: z.number().int().min(0),
  })
  .strict();
const localListSchema = z.object({}).strict();
/** local.approvals.decide: one card, one of its three answers. */
const localDecideSchema = z.object({ id: z.string().min(1).max(64), decision: z.enum(["allow-once", "allow-for-link", "deny"]) }).strict();

/** One strict params parse: a shape the protocol did not promise is an invalid request, never a best-effort read. */
function parse<T>(schema: z.ZodType<T>, method: string, params: unknown): T {
  const parsed = schema.safeParse(params);
  if (!parsed.success) throw new MeshRpcError(MeshErrorCode.invalid_params, `${method} params were not the promised shape`, { code: "invalid_params" });
  return parsed.data;
}

/** Standard base64's decoded length, without materializing the bytes: audit counts, never contents. */
function decodedBase64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
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
  /**
   * TLS links only (P2): this session's exporter value, appended to the
   * handshake transcript both signatures cover, so a MITM terminating TLS on
   * both sides cannot satisfy a pin however faithfully it relays. Stdio and
   * attach links leave it unset and sign exactly the P1 transcript.
   */
  binding?: Buffer;
  /**
   * Daemon mode (P1.5): when set, tasks are owned by the host and outlive this
   * link — closing the link only drops its subscriptions — and task.attach /
   * task.list are served. Without it, P1's ephemeral behavior holds: every
   * chat dies with its link.
   */
  host?: TaskHost;
  /**
   * P3 §1: the terminal host behind term.*. In daemon mode this is the
   * service's shared host, so a peer's terminals outlive any one link (a
   * detached one is reaped after an hour); an ephemeral worker builds its own
   * in runServeStdio, and serve() disposes that one with the link. Absent
   * means term.* answers method_not_found.
   */
  terms?: TermHost;
  /**
   * Daemon mode's ask-cap answer (P2 §2): a cap decision of "ask" waits on
   * this shared queue instead of failing with -33003. Absent — every ephemeral
   * link — keeps P1's refusal: there is no one there to ask.
   */
  approvals?: ApprovalQueue;
  /**
   * P2 §3: the service's live single-use invites. Present only in daemon
  /**
   * P2 §3: the service's live single-use invites. Present only in daemon
   * mode; without it peer.redeem answers method_not_found.
   */
  invites?: InviteStore;
  /**
   * P3 §2: the service's handoff state — uploads being received, exports
   * being paged out — shared by every link so a dropped link does not strand
   * a node's half-finished upload. Absent, every handoff.* method answers
   * method_not_found (the same shape a worker before P3 gave).
   */
  handoffs?: HandoffWorker;
  /**
   * Where this link arrived from: "attach" (the running service's own Unix
   * socket, this uid's and trusted exactly as the CLI is) may serve the
   * local.* methods; "tls" and the default "stdio" never do.
   */
  origin?: "attach" | "tls" | "stdio";
  /**
   * Peers added from the UI or a join (mesh/peers.json), read per call: a
   * saved entry's inbound_policy resolves an inbound caller exactly as a
   * config.yml entry does, with config still winning on a name clash —
   * before this, a field the store accepted and persisted did nothing.
   */
  saved?: () => MeshPeerEntry[];
  /**
   * TLS links only: called once the handshake resolved the caller as paired,
   * so the listener can lift its unpaired-authenticated bounds (the 60 s
   * grace and the per-IP caps). Stdio and attach links leave it unset.
   */
  linkPaired?: () => void;
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
  const host = deps.host;
  const handoffs = deps.handoffs;
  const origin = deps.origin ?? "stdio";
  // This link's "allow for link" grants on the shared queue; they end with the link.
  const linkGrants = deps.approvals?.openLink() ?? null;
  // One link's presence on the host: what its subscriptions hang from, detached (never disposed) at link end.
  const hostLink = host !== undefined ? host.openLink((method, params) => peer.notify(method, params)) : null;
  // The same presence for the terminal host: subscriptions hang from the link, terminals from the host.
  const terms = deps.terms ?? null;
  const termLink = terms !== null ? terms.openLink((method, params) => peer.notify(method, params)) : null;
  const tasks = new Map<string, LinkTask>();
  /** clientRequestId -> the answer already given, so a retry returns the same task, not a second chat. */
  const opens = new Map<string, { remoteTaskId: string; result: unknown }>();
  /** task.open calls in flight on this link: part of the cap until they land or fail. */
  let openingTasks = 0;
  /** fs.write times this link has landed, a sliding one-minute window; the cap itself bounds the array. */
  const writeTimes: number[] = [];
  /** Takes one of this link's 32-per-minute write slots, or throws limit; a refused or failed write still spends it. */
  const takeWriteSlot = (): void => {
    const now = Date.now();
    for (;;) {
      const oldest = writeTimes[0];
      if (oldest === undefined || now - oldest < 60_000) break;
      writeTimes.shift();
    }
    if (writeTimes.length >= WRITES_PER_MINUTE) {
      throw new MeshRpcError(MeshErrorCode.limit, `this link already wrote ${WRITES_PER_MINUTE} files in the last minute`, { code: "limit" });
    }
    writeTimes.push(now);
  };
  let peerName: string | null = null;
  let pendingRecorded = false;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Finding #12: allowed term.input calls are traffic, not decisions — an
   * interactive remote terminal writes per keystroke batch, and one audit
   * line per call buried real decisions under hundreds of allows. The counts
   * aggregate here and flush as one line per minute (and once more at the
   * link's close); a refused input is a decision and is audited per call.
   */
  let termInputBytes = 0;
  let termInputCalls = 0;
  let termInputTimer: ReturnType<typeof setTimeout> | null = null;
  const flushTermInput = (): void => {
    if (termInputTimer !== null) {
      clearTimeout(termInputTimer);
      termInputTimer = null;
    }
    if (termInputCalls === 0) return;
    const bytes = termInputBytes;
    const calls = termInputCalls;
    termInputBytes = 0;
    termInputCalls = 0;
    void deps.audit.append({ peer: peerName, method: "term.input", decision: "allow", outcome: `${bytes} bytes in ${calls} call(s)` });
  };

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
   * by node id decides pairing, and a peer entry of the same name — config's,
   * or one saved in peers.json with config winning on a clash — can re-point
   * the policy. Unknown names fall back to `none`, the floor.
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
    // A peers.json entry's inbound_policy resolves exactly as a config.yml one
    // does (finding #13): until now this lookup read config only, so a field
    // the store's own schema accepted and persisted silently did nothing.
    // Config still wins wherever both name the same peer.
    const savedEntry = deps.saved?.().find((entry) => entry.name === pinned.name);
    const policyName = configured?.inbound_policy ?? savedEntry?.inbound_policy ?? pinned.policy;
    return { paired: true, policyName, policy: policies.get(policyName) ?? none, mismatch: false };
  };

  const handshake = new ServerHandshake({
    identity: deps.identity,
    name: deps.name,
    binding: deps.binding,
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
      // The listener's unpaired bounds (finding #14) lift the moment pairing
      // is a fact; a TLS link that is merely authenticated stays on its grace.
      if (inbound.paired) deps.linkPaired?.();
      if (!inbound.paired && !pendingRecorded && origin !== "attach") {
        // Once per link: one pending entry is what a person compares before saying yes.
        pendingRecorded = true;
        await deps.pins
          .addPending(clientKey, clientName)
          .catch((error: unknown) => log(`mesh serve: could not record the pending request: ${error instanceof Error ? error.message : String(error)}`));
      }
      return { paired: inbound.paired, policy: inbound.policyName };
    },
  });

  /**
   * The cap gate every method goes through: allow, ask, or deny (-33002) with
   * the reason. An "ask" is answered by this node's own owner in daemon mode
   * (P2 §2): the call waits on the shared queue until someone answers, grants
   * the link already holds pass without a new card, and an expiry answers
   * "no one answered on the target". An ephemeral link keeps P1's -33003:
   * there is no one there to ask, so it fails closed instead of hanging.
   */
  const requireCap = async (policy: PeerPolicy, cap: Cap, method: string, opts: { target?: string; harness?: string } = {}): Promise<void> => {
    const decision = decide(policy, cap);
    if (decision.kind === "allow") return;
    if (decision.kind !== "ask") {
      throw new MeshRpcError(MeshErrorCode.denied, `the policy refuses "${method}": ${decision.reason}`, { code: "denied" });
    }
    if (host === undefined || deps.approvals === undefined || linkGrants === null) {
      throw new MeshRpcError(MeshErrorCode.needs_approval, `"${method}" needs an approval on the target; this link has no one to ask (ephemeral mode keeps -33003)`, { code: "needs_approval" });
    }
    const client = handshake.client;
    if (client === null) throw new MeshRpcError(MeshErrorCode.internal_error, "internal error", { code: "internal_error" });
    // The grant's key: the policy root the call points into, so one "allow for link" covers
    // the link's remaining work in the same root. A target that is not a path (a task id)
    // keys the grant exactly as it arrives, which only narrows what a grant covers.
    let root: string | null = null;
    if (opts.target !== undefined) {
      const resolved = await resolveInRoots(policy, opts.target, deps.home);
      root = resolved.ok ? resolved.root : opts.target;
    }
    // The summary is method + path/cwd/harness only: never file content, never prompt text.
    const summary = [method, opts.target, opts.harness].filter((part) => part !== undefined).join(" ");
    const outcome = await deps.approvals.ask(linkGrants, { nodeId: nodeIdOf(client.publicKey), peerName: client.name, method, cap, root, summary });
    if (outcome === "deny") {
      throw new MeshRpcError(MeshErrorCode.denied, `"${method}" was denied on the target`, { code: "denied" });
    }
    if (outcome === "expired") {
      throw new MeshRpcError(MeshErrorCode.denied, `"${method}" expired: no one answered on the target`, { code: "denied" });
    }
  };

  const taskOf = (remoteTaskId: string): LinkTask => {
    const task = tasks.get(remoteTaskId);
    if (task === undefined) throw new MeshRpcError(MeshErrorCode.not_found, `no task "${remoteTaskId}" is open on this link`, { code: "not_found" });
    return task;
  };

  const info = async (policy: PeerPolicy): Promise<unknown> => {
    await requireCap(policy, "discover", "peer.info");
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
      // Finding #1: what this caller's resolved policy opens and what it asks
      // for, so the leader can advertise a peer's abilities (the "New terminal
      // on…" menu) without trying a call to learn them.
      caps: { allow: [...policy.caps], ask: [...policy.ask] },
    };
  };

  const openTask = async (policy: PeerPolicy, raw: unknown, note: (entry: CallNote) => void): Promise<unknown> => {
    const params = parse(openSchema, "task.open", raw);
    note({ target: params.cwd });
    await requireCap(policy, "task.run", "task.open", { target: params.cwd, harness: params.harness });
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
    // A retry of an open that already happened answers the same task, even at the cap.
    const existing = opens.get(params.clientRequestId);
    if (existing !== undefined && tasks.has(existing.remoteTaskId)) return existing.result;
    if (tasks.size + openingTasks >= policy.maxTasks) {
      throw new MeshRpcError(MeshErrorCode.limit, `this peer already holds ${tasks.size} live tasks and the policy allows ${policy.maxTasks}`, { code: "limit" });
    }
    // Counted before the first await, so concurrent opens cannot all see room for one.
    openingTasks++;
    try {
      return await openCounted(params, policy, adapter, resolved.real, note);
    } finally {
      openingTasks--;
    }
  };

  const openCounted = async (
    params: z.infer<typeof openSchema>,
    policy: PeerPolicy,
    adapter: NonNullable<ReturnType<ServeDeps["registry"]["get"]>>,
    cwd: string,
    note: (entry: CallNote) => void,
  ): Promise<unknown> => {
    const ceiling = clampCeiling(policy, params.ceiling);
    // A real harness session, delegated, and with no toolEnv at all: the remote child gets no
    // orchestration tools, so it cannot delegate, and max_hops 1 holds structurally.
    const live = await adapter.openChat({ cwd, delegated: true });
    if (peer.isClosed) {
      // The link went away while the harness started: nobody could ever reach this chat.
      await live.dispose().catch(() => undefined);
      throw new MeshRpcError(MeshErrorCode.link_closed, "the link closed while the task was opening", { code: "link_closed" });
    }
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
    // Bounded: a link cycling open/close never grows this without limit.
    while (opens.size > MAX_OPEN_KEYS) opens.delete(opens.keys().next().value as string);
    note({ outcome: remoteTaskId });
    return result;
  };

  const promptTask = async (policy: PeerPolicy, raw: unknown, note: (entry: CallNote) => void): Promise<unknown> => {
    const params = parse(promptSchema, "task.prompt", raw);
    // Lengths only, never the text: the audit log is evidence about who asked, not a transcript.
    note({ target: params.remoteTaskId, outcome: `${params.mode} ${params.text.length} chars` });
    await requireCap(policy, "task.run", "task.prompt", { target: params.remoteTaskId });
    const task = taskOf(params.remoteTaskId);
    if (params.mode === "prompt") await task.live.prompt(params.text);
    else if (params.mode === "steer") await task.live.steer(params.text);
    else await task.live.followUp(params.text);
    return {};
  };

  const answerTask = async (policy: PeerPolicy, raw: unknown, note: (entry: CallNote) => void): Promise<unknown> => {
    const params = parse(answerSchema, "task.answer", raw);
    note({ target: params.remoteTaskId });
    await requireCap(policy, "task.approve", "task.answer", { target: params.remoteTaskId });
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
    await requireCap(policy, "task.run", "task.abort", { target: params.remoteTaskId });
    await taskOf(params.remoteTaskId).live.abort();
    return {};
  };

  const closeTask = async (policy: PeerPolicy, raw: unknown, note: (entry: CallNote) => void): Promise<unknown> => {
    const params = parse(idSchema, "task.close", raw);
    note({ target: params.remoteTaskId });
    await requireCap(policy, "task.run", "task.close", { target: params.remoteTaskId });
    const task = taskOf(params.remoteTaskId);
    tasks.delete(params.remoteTaskId);
    for (const [key, open] of opens) if (open.remoteTaskId === params.remoteTaskId) opens.delete(key);
    task.unsubscribe();
    await task.live.dispose().catch((error: unknown) => log(`mesh serve: disposing a task failed: ${error instanceof Error ? error.message : String(error)}`));
    return {};
  };

  const historyTask = async (policy: PeerPolicy, raw: unknown, note: (entry: CallNote) => void): Promise<unknown> => {
    const params = parse(idSchema, "task.history", raw);
    note({ target: params.remoteTaskId });
    await requireCap(policy, "task.run", "task.history", { target: params.remoteTaskId });
    return taskOf(params.remoteTaskId).live.history();
  };

  const configTask = async (policy: PeerPolicy, raw: unknown, note: (entry: CallNote) => void): Promise<unknown> => {
    const params = parse(configSchema, "task.config", raw);
    note({ target: params.remoteTaskId });
    await requireCap(policy, "task.run", "task.config", { target: params.remoteTaskId });
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

  // ---- daemon mode (P1.5): the host owns every task; a link is one way to reach it ----

  /** What a hosted handler needs to name one peer: the key its node id is derived from, and its handshake name. */
  type HostClient = { publicKey: Buffer; name: string };

  /**
   * task.open against the host: the ephemeral path's checks in its order,
   * minus the P1 refusal of target/both approvals — that refusal is exactly
   * what daemon mode lifts, because the chat is a real chat on this node and
   * its requests are answerable in this node's own UI.
   */
  const openHosted = async (host: TaskHost, hostLink: HostLink, client: HostClient, policy: PeerPolicy, raw: unknown, note: (entry: CallNote) => void): Promise<unknown> => {
    const params = parse(openSchema, "task.open", raw);
    note({ target: params.cwd });
    await requireCap(policy, "task.run", "task.open", { target: params.cwd, harness: params.harness });
    if (!checkHops(params.hops)) {
      throw new MeshRpcError(MeshErrorCode.hop_limit, "hops reached max_hops; a remote task can never start another remote task", { code: "hop_limit" });
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
    const result = await host.open(hostLink, nodeIdOf(client.publicKey), client.name, {
      clientRequestId: params.clientRequestId,
      harness: params.harness,
      cwd: resolved.real,
      ceiling: clampCeiling(policy, params.ceiling),
      maxTasks: policy.maxTasks,
      approvalsAt: policy.approvalsAt,
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.thinkingLevel !== undefined ? { thinkingLevel: params.thinkingLevel } : {}),
    });
    note({ outcome: result.remoteTaskId });
    return result;
  };

  const promptHosted = async (host: TaskHost, client: { publicKey: Buffer }, policy: PeerPolicy, raw: unknown, note: (entry: CallNote) => void): Promise<unknown> => {
    const params = parse(promptSchema, "task.prompt", raw);
    // Lengths only, never the text: the audit log is evidence about who asked, not a transcript.
    note({ target: params.remoteTaskId, outcome: `${params.mode} ${params.text.length} chars` });
    await requireCap(policy, "task.run", "task.prompt", { target: params.remoteTaskId });
    await host.prompt(nodeIdOf(client.publicKey), params.remoteTaskId, params.mode, params.text);
    return {};
  };

  const answerHosted = async (host: TaskHost, client: { publicKey: Buffer }, policy: PeerPolicy, raw: unknown, note: (entry: CallNote) => void): Promise<unknown> => {
    const params = parse(answerSchema, "task.answer", raw);
    note({ target: params.remoteTaskId });
    await requireCap(policy, "task.approve", "task.answer", { target: params.remoteTaskId });
    if (policy.approvalsAt === "target") {
      throw new MeshRpcError(MeshErrorCode.denied, "this policy's approvals sit on the target, so the caller may not answer them", { code: "denied" });
    }
    // "origin" answers over the wire as P1; "both" answers over the wire or in this node's own UI, and the first answer wins.
    return host.answer(nodeIdOf(client.publicKey), params.remoteTaskId, params.requestId, params.answer);
  };

  const abortHosted = async (host: TaskHost, client: { publicKey: Buffer }, policy: PeerPolicy, raw: unknown, note: (entry: CallNote) => void): Promise<unknown> => {
    const params = parse(idSchema, "task.abort", raw);
    note({ target: params.remoteTaskId });
    await requireCap(policy, "task.run", "task.abort", { target: params.remoteTaskId });
    await host.abort(nodeIdOf(client.publicKey), params.remoteTaskId);
    return {};
  };

  const closeHosted = async (host: TaskHost, client: { publicKey: Buffer }, policy: PeerPolicy, raw: unknown, note: (entry: CallNote) => void): Promise<unknown> => {
    const params = parse(idSchema, "task.close", raw);
    note({ target: params.remoteTaskId });
    await requireCap(policy, "task.run", "task.close", { target: params.remoteTaskId });
    await host.close(nodeIdOf(client.publicKey), params.remoteTaskId);
    return {};
  };

  const historyHosted = async (host: TaskHost, client: { publicKey: Buffer }, policy: PeerPolicy, raw: unknown, note: (entry: CallNote) => void): Promise<unknown> => {
    const params = parse(idSchema, "task.history", raw);
    note({ target: params.remoteTaskId });
    await requireCap(policy, "task.run", "task.history", { target: params.remoteTaskId });
    return host.history(nodeIdOf(client.publicKey), params.remoteTaskId);
  };

  const configHosted = async (host: TaskHost, client: { publicKey: Buffer }, policy: PeerPolicy, raw: unknown, note: (entry: CallNote) => void): Promise<unknown> => {
    const params = parse(configSchema, "task.config", raw);
    note({ target: params.remoteTaskId });
    await requireCap(policy, "task.run", "task.config", { target: params.remoteTaskId });
    // Model and thinking level only; permissionMode is the target's own decision (the ceiling), never the caller's.
    const patch = params.patch;
    if (patch !== undefined) {
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
    }
    return host.config(
      nodeIdOf(client.publicKey),
      params.remoteTaskId,
      patch !== undefined
        ? {
            ...(patch.model !== undefined ? { model: patch.model as string } : {}),
            ...(patch.thinkingLevel !== undefined ? { thinkingLevel: patch.thinkingLevel as string } : {}),
          }
        : undefined,
    );
  };

  const attachHosted = async (host: TaskHost, hostLink: HostLink, client: { publicKey: Buffer }, policy: PeerPolicy, raw: unknown, note: (entry: CallNote) => void): Promise<unknown> => {
    const params = parse(attachSchema, "task.attach", raw);
    note({ target: params.remoteTaskId });
    await requireCap(policy, "task.run", "task.attach", { target: params.remoteTaskId });
    return host.attach(hostLink, nodeIdOf(client.publicKey), params.remoteTaskId, params.afterSeq);
  };

  const listHosted = async (host: TaskHost, client: { publicKey: Buffer }, policy: PeerPolicy, raw: unknown): Promise<unknown> => {
    parse(listSchema, "task.list", raw);
    await requireCap(policy, "task.run", "task.list");
    return host.list(nodeIdOf(client.publicKey));
  };

  const dispatch = async (method: string, params: unknown, note: (entry: CallNote) => void): Promise<unknown> => {
    if (!deps.enabled()) {
      closeSoon("mesh off");
      // Off is off for the whole node, not just this link: every host task is disposed with it.
      if (host !== undefined) {
        // Off is off for the whole node, not just this link: every host task and terminal is disposed with it.
        void host.disposeAll("the mesh was turned off").catch(() => undefined);
        if (terms !== null) void terms.disposeAll().catch(() => undefined);
      }
      throw new MeshRpcError(MeshErrorCode.mesh_off, "The mesh is off on this node", { code: "mesh_off" });
    }
    const handshakeAnswer = handshake.handle(method, params);
    if (handshakeAnswer !== null) {
      // A failed or out-of-order handshake gets its answer and then the link closes: no
      // retrying peer.auth on one link, no half-open links parked in "hello".
      return handshakeAnswer.catch((error: unknown) => {
        if (handshake.state !== "done") closeSoon("handshake failed");
        throw error;
      });
    }
    const client = handshake.client;
    if (client === null) {
      closeSoon("a method before the handshake");
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
    // local.* is the owner's own CLI reaching the running service through its
    // attach socket: it never crosses a peer link, so every other origin answers
    // method_not_found, and the unpaired gate lets only the attach origin
    // through (that socket is this uid's, trusted exactly as the CLI is).
    if (method.startsWith("local.") && origin !== "attach") {
      throw new MeshRpcError(MeshErrorCode.method_not_found, `no method "${method}" is served`, { code: "method_not_found" });
    }
    if (!inbound.paired && method !== "peer.ping" && method !== "peer.redeem" && !(origin === "attach" && method.startsWith("local."))) {
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
        if (host === undefined || hostLink === null) return openTask(policy, params, note);
        return openHosted(host, hostLink, client, policy, params, note);
      case "task.prompt":
        if (host === undefined) return promptTask(policy, params, note);
        return promptHosted(host, client, policy, params, note);
      case "task.answer":
        if (host === undefined) return answerTask(policy, params, note);
        return answerHosted(host, client, policy, params, note);
      case "task.abort":
        if (host === undefined) return abortTask(policy, params, note);
        return abortHosted(host, client, policy, params, note);
      case "task.close":
        if (host === undefined) return closeTask(policy, params, note);
        return closeHosted(host, client, policy, params, note);
      case "task.history":
        if (host === undefined) return historyTask(policy, params, note);
        return historyHosted(host, client, policy, params, note);
      case "task.config":
        if (host === undefined) return configTask(policy, params, note);
        return configHosted(host, client, policy, params, note);
      case "task.attach":
        if (host === undefined || hostLink === null) throw new MeshRpcError(MeshErrorCode.method_not_found, `no method "${method}" is served`, { code: "method_not_found" });
        return attachHosted(host, hostLink, client, policy, params, note);
      case "task.list":
        if (host === undefined) throw new MeshRpcError(MeshErrorCode.method_not_found, `no method "${method}" is served`, { code: "method_not_found" });
        return listHosted(host, client, policy, params);
      // ---- term.* (P3 §1): remote PTYs; every method rides the one term.open cap ----
      case "term.open": {
        const p = parse(termOpenSchema, method, params);
        note({ target: p.cwd });
        await requireCap(policy, "term.open", method, { target: p.cwd });
        if (terms === null || termLink === null) throw new MeshRpcError(MeshErrorCode.method_not_found, `no method "${method}" is served`, { code: "method_not_found" });
        const opened = await terms.open(termLink, nodeIdOf(client.publicKey), client.name, policy, deps.home, p);
        note({ outcome: opened.termId });
        return opened;
      }
      case "term.input": {
        const p = parse(termInputSchema, method, params);
        // Byte counts only: what a peer typed into its terminal is its own, never audit evidence.
        note({ target: p.termId, inputBytes: decodedBase64Bytes(p.data) });
        await requireCap(policy, "term.open", method, { target: p.termId });
        if (terms === null) throw new MeshRpcError(MeshErrorCode.method_not_found, `no method "${method}" is served`, { code: "method_not_found" });
        await terms.input(nodeIdOf(client.publicKey), p.termId, p.data);
        return {};
      }
      case "term.resize": {
        const p = parse(termResizeSchema, method, params);
        note({ target: p.termId });
        await requireCap(policy, "term.open", method, { target: p.termId });
        if (terms === null) throw new MeshRpcError(MeshErrorCode.method_not_found, `no method "${method}" is served`, { code: "method_not_found" });
        await terms.resize(nodeIdOf(client.publicKey), p.termId, p.cols, p.rows);
        return {};
      }
      case "term.close": {
        const p = parse(termIdSchema, method, params);
        note({ target: p.termId });
        await requireCap(policy, "term.open", method, { target: p.termId });
        if (terms === null) throw new MeshRpcError(MeshErrorCode.method_not_found, `no method "${method}" is served`, { code: "method_not_found" });
        await terms.close(nodeIdOf(client.publicKey), p.termId);
        return {};
      }
      case "term.attach": {
        const p = parse(termAttachSchema, method, params);
        note({ target: p.termId });
        await requireCap(policy, "term.open", method, { target: p.termId });
        // A terminal's scrollback only exists where the host does: an ephemeral worker has no cross-link state to replay.
        if (host === undefined || terms === null || termLink === null) throw new MeshRpcError(MeshErrorCode.method_not_found, `no method "${method}" is served`, { code: "method_not_found" });
        return terms.attach(termLink, nodeIdOf(client.publicKey), p.termId, p.afterSeq);
      }
      case "term.list": {
        parse(termListSchema, method, params);
        await requireCap(policy, "term.open", method);
        if (terms === null) throw new MeshRpcError(MeshErrorCode.method_not_found, `no method "${method}" is served`, { code: "method_not_found" });
        return terms.list(nodeIdOf(client.publicKey));
      }
      case "fs.stat": {
        const p = parse(fsStatSchema, method, params);
        note({ target: p.path });
        await requireCap(policy, "fs.read", method, { target: p.path });
        const stat = await fsStat(policy, p, deps.home);
        note({ outcome: `${stat.size} bytes` });
        return stat;
      }
      case "fs.list": {
        const p = parse(fsListSchema, method, params);
        note({ target: p.path });
        await requireCap(policy, "fs.read", method, { target: p.path });
        const listed = await fsList(policy, p, deps.home);
        note({ outcome: `${listed.entries.length} entries${listed.truncated ? ", truncated" : ""}` });
        return listed;
      }
      case "fs.read": {
        const p = parse(fsReadSchema, method, params);
        note({ target: p.path });
        await requireCap(policy, "fs.read", method, { target: p.path });
        const read = await fsRead(policy, p, deps.home);
        note({ outcome: `${Buffer.byteLength(read.data, "base64")} bytes` });
        return read;
      }
      case "fs.write": {
        const p = parse(fsWriteSchema, method, params);
        note({ target: p.path });
        await requireCap(policy, "fs.write", method, { target: p.path });
        takeWriteSlot();
        const wrote = await fsWrite(policy, p, deps.home);
        note({ outcome: `${wrote.size} bytes` });
        return wrote;
      }
      // ---- handoff.* (P3 §2): one bundle in, one worktree out, one bundle back ----
      case "handoff.begin": {
        // The one place a handoff is fully cap-gated, on both caps the spec
        // names: an inbound handoff runs work (task.run) and writes a bundle
        // and a worktree (fs.write), so a policy that asks raises its card
        // here, once, before a single chunk is accepted.
        const p = parse(handoffBeginSchema, method, params);
        note({ target: p.repoCwd });
        if (handoffs === undefined) throw new MeshRpcError(MeshErrorCode.method_not_found, `no method "${method}" is served`, { code: "method_not_found" });
        await requireCap(policy, "task.run", method, { target: p.repoCwd });
        await requireCap(policy, "fs.write", method, { target: p.repoCwd });
        const begun = await handoffs.begin(policy, nodeIdOf(client.publicKey), p);
        note({ outcome: `${begun.uploadId}, ${p.size} bytes promised` });
        return begun;
      }
      case "handoff.chunk": {
        const p = parse(handoffChunkSchema, method, params);
        note({ target: p.uploadId });
        if (handoffs === undefined) throw new MeshRpcError(MeshErrorCode.method_not_found, `no method "${method}" is served`, { code: "method_not_found" });
        const data = Buffer.from(p.data, "base64");
        await handoffs.chunk(policy, nodeIdOf(client.publicKey), p);
        note({ outcome: `${data.length} bytes` });
        return {};
      }
      case "handoff.finish": {
        const p = parse(handoffIdSchema, method, params);
        note({ target: p.uploadId });
        if (handoffs === undefined) throw new MeshRpcError(MeshErrorCode.method_not_found, `no method "${method}" is served`, { code: "method_not_found" });
        const landed = await handoffs.finish(policy, nodeIdOf(client.publicKey), p.uploadId);
        note({ outcome: landed.worktree });
        return landed;
      }
      case "handoff.abort": {
        const p = parse(handoffIdSchema, method, params);
        note({ target: p.uploadId });
        if (handoffs === undefined) throw new MeshRpcError(MeshErrorCode.method_not_found, `no method "${method}" is served`, { code: "method_not_found" });
        await handoffs.abort(nodeIdOf(client.publicKey), p.uploadId);
        note({ outcome: "aborted" });
        return {};
      }
      case "handoff.export": {
        const p = parse(handoffExportSchema, method, params);
        note({ target: p.worktree });
        if (handoffs === undefined) throw new MeshRpcError(MeshErrorCode.method_not_found, `no method "${method}" is served`, { code: "method_not_found" });
        await requireCap(policy, "fs.read", method, { target: p.worktree });
        const exported = await handoffs.export(policy, nodeIdOf(client.publicKey), p.worktree);
        note({ outcome: `${exported.exportId}, ${exported.size} bytes` });
        return exported;
      }
      case "handoff.read": {
        const p = parse(handoffReadSchema, method, params);
        note({ target: p.exportId });
        if (handoffs === undefined) throw new MeshRpcError(MeshErrorCode.method_not_found, `no method "${method}" is served`, { code: "method_not_found" });
        const page = await handoffs.read(policy, nodeIdOf(client.publicKey), p);
        note({ outcome: `${Math.floor((page.data.length * 3) / 4)} bytes${page.eof ? ", eof" : ""}` });
        return page;
      }
      case "peer.redeem": {
        if (inbound.paired) {
          throw new MeshRpcError(MeshErrorCode.denied, "this node has already paired with the caller; peer.redeem is only for an unpaired first contact", { code: "denied" });
        }
        const p = parse(redeemSchema, method, params);
        note({ target: p.inviteId.toString("base64url") });
        const t = handshake.transcript;
        if (t === null) throw new MeshRpcError(MeshErrorCode.internal_error, "internal error", { code: "internal_error" });
        if (deps.invites === undefined) {
          throw new MeshRpcError(MeshErrorCode.method_not_found, 'no method "peer.redeem" is served: this link has no invite store', { code: "method_not_found" });
        }
        // Redeem never needs a cap: the invite is its own grant, and a good mac buys only
        // a pending record marked invited — the owner still has to Accept it.
        const redeemed = await redeemInvite(deps.invites, deps.pins, {
          inviteId: p.inviteId,
          mac: p.mac,
          transcript: t,
          clientKey: client.publicKey,
          clientName: client.name,
        });
        if (!redeemed.ok) throw redeemed.error;
        note({ outcome: `invited, policy ${redeemed.policy}` });
        return {};
      }
      case "local.approvals.list": {
        parse(localListSchema, method, params);
        if (deps.approvals === undefined) {
          throw new MeshRpcError(MeshErrorCode.method_not_found, `no method "${method}" is served`, { code: "method_not_found" });
        }
        return deps.approvals.list();
      }
      case "local.approvals.decide": {
        const p = parse(localDecideSchema, method, params);
        if (deps.approvals === undefined) {
          throw new MeshRpcError(MeshErrorCode.method_not_found, `no method "${method}" is served`, { code: "method_not_found" });
        }
        if (deps.approvals.decide(p.id, p.decision) === "not-found") {
          throw new MeshRpcError(MeshErrorCode.not_found, `no approval "${p.id}" is pending on this node`, { code: "not_found" });
        }
        note({ outcome: p.decision });
        return {};
      }
      case "local.invite.create": {
        const p = parse(inviteCreateSchema, method, params);
        if (deps.invites === undefined) {
          throw new MeshRpcError(MeshErrorCode.method_not_found, `no method "${method}" is served`, { code: "method_not_found" });
        }
        // The policy must exist here, not just look like a name: accept pre-fills it, and a
        // typo would otherwise pin a caller under the "none" floor silently.
        const policy = p.policy ?? "worker";
        const policies = resolvePolicies(deps.config()?.policies);
        if (!policies.has(policy)) {
          throw new MeshRpcError(MeshErrorCode.denied, `no mesh policy named "${policy}" (have: ${[...policies.keys()].join(", ")})`, { code: "denied" });
        }
        const addresses = p.addresses ?? [];
        const record = deps.invites.create(policy, p.ttlMinutes ?? 10, addresses);
        note({ outcome: `policy ${policy}` });
        return {
          code: encodeInviteCode({ v: 1, name: deps.name, addresses, targetKey: deps.identity.publicKey, inviteId: record.id, secret: record.secret }),
          policy,
          expiresAt: record.expiresAt,
        };
      }
      default:
        throw new MeshRpcError(MeshErrorCode.method_not_found, `no method "${method}" is served`, { code: "method_not_found" });
    }
  };

  peer.onRequest(async (method, params) => {
    const noted: CallNote = {};
    const note = (entry: CallNote): void => {
      if (entry.target !== undefined) noted.target = entry.target;
      if (entry.outcome !== undefined) noted.outcome = entry.outcome;
      if (entry.inputBytes !== undefined) noted.inputBytes = entry.inputBytes;
    };
    try {
      const result = await dispatch(method, params, note);
      // A successful ping is liveness, not a decision: never logged, so nobody can flood the log with it.
      if (method === "peer.ping") return result;
      // A successful term.input is traffic (finding #12): the byte counts
      // aggregate into one line per minute; a refusal took the error path
      // below and is audited as the decision it is.
      if (noted.inputBytes !== undefined) {
        termInputBytes += noted.inputBytes;
        termInputCalls++;
        if (termInputTimer === null) {
          termInputTimer = setTimeout(flushTermInput, 60_000);
          termInputTimer.unref?.();
        }
        return result;
      }
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
    // The last of the minute's input counts leave with the link (finding #12),
    // before the closing line, so nothing a peer typed is left unaccounted.
    flushTermInput();
    if (linkGrants !== null) {
      // Grants last exactly as long as the link that earned them, and a card nobody is
      // waiting on any more is gone rather than parked for five minutes.
      deps.approvals?.dropLink(linkGrants);
    }
    if (host !== undefined && hostLink !== null) {
      // Daemon mode: the host owns the chats and the terminals, so the link's end only drops this link's subscriptions.
      host.closeLink(hostLink);
      if (terms !== null && termLink !== null) terms.closeLink(termLink);
    } else {
      // A P1 link is ephemeral: every chat it opened dies with it, and a failed disposal never keeps the link alive.
      const live = [...tasks.values()];
      tasks.clear();
      await Promise.allSettled(live.map((task) => task.live.dispose()));
      // Its terminals go the same way: an ephemeral worker's term host is this link's own.
      if (terms !== null) await terms.disposeAll();
    }
    void deps.audit.append({ peer: peerName, method: "link closed", decision: reason === "eof" || reason === "closed" ? "allow" : "error", outcome: reason });
    return reason;
  });
  return { closed };
}

/**
 * `awui peer serve-stdio [--peer <name>] [--policy <policy>] [--ephemeral]
 * [--attach]`: the worker end of an SSH or docker exec link, run as the remote
 * command. Protocol only on stdout, every log line on stderr, and a refusal
 * (78) when the mesh is off. The forced form takes --policy and --peer
 * together, as authorized_keys spells it; without a forced command a caller
 * who can SSH in already has a shell, so --policy grants nothing extra.
 * Unless --ephemeral is given, the link first tries the attach socket of an
 * already-running awui service, so tasks outlive this SSH session; when there
 * is none it serves in-process (P1: tasks end with the link), and --attach
 * turns that fallback into exit 75 instead.
 */
export async function runServeStdio(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  let forcedPeer: string | undefined;
  let forcedPolicy: string | undefined;
  let ephemeral = false;
  let attach = false;
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
    } else if (arg === "--ephemeral") {
      ephemeral = true;
    } else if (arg === "--attach") {
      attach = true;
    } else {
      console.error(`awui peer serve-stdio: unknown option: ${arg}`);
      return 2;
    }
  }
  if (ephemeral && attach) {
    console.error("awui peer serve-stdio: --ephemeral and --attach disagree: one skips the running service, the other requires it");
    return 2;
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
  // P1.5: unless --ephemeral, the link prefers a running awui service over a
  // fresh in-process serve, so its tasks outlive this SSH session. The forced
  // pair rides the one prologue line; the daemon enforces it as its own ceiling.
  const plan = planServeStdio({ ephemeral, attach, canAttach: process.platform !== "win32" });
  if (plan.tryAttach) {
    let attachPath: string | null = null;
    try {
      attachPath = await socketPath(env, config.stateDir);
    } catch (error) {
      log(`the attach socket could not be prepared: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (attachPath !== null) {
      const piped = await connectAndPipe(attachPath, forced ?? null, process.stdin, process.stdout, { timeoutMs: 1000 });
      if (piped.ok) {
        const reason = await piped.closed;
        // A daemon-side refusal (finding #16, P15R #9) now arrives as its own
        // reason — "closed by the service" — so a rejected attach is exit 1,
        // distinguishable from a session that simply finished.
        return reason === "closed" ? 0 : 1;
      }
      if (plan.onAttachFailure === "tempfail") {
        console.error(`awui peer serve-stdio: no running awui service to attach to (${piped.reason})`);
        return EXIT_TEMPFAIL;
      }
    } else if (plan.onAttachFailure === "tempfail") {
      console.error("awui peer serve-stdio: no running awui service to attach to");
      return EXIT_TEMPFAIL;
    }
    console.error(ATTACH_FALLBACK_NOTE);
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
  // Peers saved from the other side's UI or a join (finding #13): an inbound
  // policy on one of them resolves this node's callers exactly as config.yml's does.
  const savedPeers = PeerPeersStore(path.join(config.stateDir, "mesh", "peers.json"));
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
  // P3 §1: the ephemeral worker's own terminal host, over the target's own
  // TerminalManager (its shell, its env, its kill path). It is this link's
  // alone — serve() disposes it when the link ends — and term.open only works
  // under a plain-allow cap, since there is no one here to answer an ask.
  const termTerms = new TermHost({ manager: new TerminalManager(), clock: Date.now, log });
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
    saved: () => savedPeers.snapshot(),
    // Ephemeral workers serve handoffs too, but from their own state: this
    // process's uploads die with the link, exactly as its tasks do.
    handoffs: new HandoffWorker({ stateDir: config.stateDir, home: config.home, log }),
    ...(forced !== undefined ? { forced } : {}),
    terms: termTerms,
    log,
  });
  const reason = await link.closed;
  await termTerms.shutdown().catch(() => undefined);
  await registry.shutdown().catch(() => undefined);
  return reason === "eof" || reason === "closed" ? 0 : 1;
}
