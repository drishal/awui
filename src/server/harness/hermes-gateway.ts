// Attaching to a running Hermes gateway — the client path Hermes's own TUI, desktop
// app, and dashboard use.
//
// Why this exists: one gateway owns a profile home at a time (`gateway.lock`), and
// since 2026.9.24 the stdio session server awui used to start per chat
// (`python -m tui_gateway.entry`) refuses to start beside a live owner and exits 1.
// So a chat started next to `hermes gateway` (a service, the desktop app, a TUI) can
// never run, and starting one of our own would block the owner from coming back.
// Attaching is what upstream supports: find the home's control socket, ask it for its
// verdict and identity, mint a short-lived single-use session ticket, dial `/api/ws`
// with it, and speak the same JSON-RPC there. Nothing is written to the home, and the
// gateway keeps serving every other client while we are attached.
//
// The worm's-eye detail is upstream's public contract (`docs/developer-guide/
// gateway-internals`, "Local control socket"), and this file follows it rather than
// reading the home: `gateway.sock` (a socket only this user can reach), else the
// `gateway.sock.path` pointer a gateway started under a private temp root leaves
// behind; `resolve-profile` for the verdict and the endpoint; the public form of
// `session-ticket` for the ticket, checking what it echoes back. A gateway older than
// `resolve-profile` (Hermes 0.23 and earlier) still answers `identify`, and that
// answer is read the same way — the two paths produce one GatewayVerdict, so callers
// never branch on which owner they are talking to.
import { constants as fsConstants, promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { isObj, type Obj } from "./agent-events.js";
import { PendingRequests, type FrameCodec } from "./child-process.js";

/** How long the home's control socket has to answer. It is a local socket: seconds mean something is wrong. */
const CONTROL_TIMEOUT_MS = 5_000;
/** The gateway's canonical WebSocket subprotocol (`gateway/session_contract.py`). */
const GATEWAY_PROTOCOL = "hermes-gateway-v1";
/** The ticket rides the second subprotocol; the owner accepts exactly one of these. */
const TICKET_PREFIX = "hermes-gateway-ticket.";
/** The owner's own readiness budget (`tui_gateway`'s clients use 30 s). */
const READY_TIMEOUT_MS = 30_000;
/** A control answer is one line of JSON; anything longer is not one. */
const MAX_CONTROL_BYTES = 1_000_000;
/** `WebSocket.OPEN`, spelled out: the constant lives on the prototype in some runtimes and not others. */
const SOCKET_OPEN = 1;
/** Where a gateway under a private temp root points at the socket it actually serves (`gateway.sock.path`). */
const SOCKET_POINTER = "gateway.sock.path";
const MAX_POINTER_BYTES = 4_096;
/** The pointer's shape, from the contract: `<temp>/hermes-gw-<16 hex>/control.sock`. */
const POINTER_TARGET = /(^|\/)hermes-gw-[0-9a-f]{16}\/control\.sock$/;
/** Loopback origins and URLs only: a gateway the client cannot reach privately is not one to attach to. */
const LOOPBACK_ORIGIN = /^https?:\/\/127\.0\.0\.1:\d+$/;
const LOOPBACK_WS = /^wss?:\/\/127\.0\.0\.1:\d+\//;

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const strOr = (value: unknown, fallback: string): string => str(value) || fallback;

/** One gateway frame; a type alias so it also satisfies `Record<string, unknown>`. */
export type GatewayFrame = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Obj;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

/**
 * A gateway error with its JSON-RPC code (4018: "run this through command.dispatch") and its `data`: a
 * canonical fence refusal (`revision_conflict`, `stale_generation`) names the session's current revision
 * and execution generation there, which the next attempt has to present.
 */
export class HermesRpcError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/**
 * The JSON-RPC dialect both transports speak: requests we send with an id, `event`
 * notifications and `srq-…` server requests coming back. Ids are strings, which can
 * never collide with the owner's `srq-…` request ids.
 */
export function hermesCodec(): FrameCodec<string> {
  return {
    formatId: (n) => String(n),
    encode: (id, payload) => ({ jsonrpc: "2.0", id, ...payload }),
    answeredId: (frame) => (frame.id === undefined ? null : String(frame.id)),
    outcome: (frame) => {
      const error = frame.error as GatewayFrame["error"];
      return error
        ? { error: new HermesRpcError(error.message ?? `hermes error ${error.code ?? ""}`.trim(), error.code, error.data) }
        : { value: frame.result };
    },
  };
}

/** What a live chat needs from its gateway, whichever transport carries it. */
export interface GatewayLink {
  /** Resolves when the gateway says it is ready (`gateway.ready`). */
  readonly ready: Promise<void>;
  /**
   * True for an attachment to a gateway awui did not start: the session lives in that
   * gateway (another client may hold it too), so closing the link does not end it.
   */
  readonly attached: boolean;
  exited: boolean;
  request<T = unknown>(method: string, params?: Obj): Promise<T>;
  /** Answer a server→client request (its `srq-…` id). */
  respond(id: string | number, result: unknown): void;
  onExit(listener: (message: string) => void): void;
  kill(): Promise<void>;
}

/** The endpoint a home's owner publishes: where it listens, and which profile that is. */
export interface GatewayEndpoint {
  /** Loopback origin, e.g. `http://127.0.0.1:40233` (`/api/ws` is dialled under it). */
  apiOrigin: string;
  /** The owner's own WebSocket URL when it names one (`resolve-profile`, `attach --json`). */
  wsUrl?: string;
  /** The subprotocol it expects (`hermes-gateway-v1`), when it names one. */
  wsProtocol?: string;
  /** The prefix the ticket subprotocol rides under, when the owner names one. */
  ticketPrefix?: string;
  /** The owner's profile id for this home; a ticket is minted for exactly it. */
  profileId: string;
  /** The running instance; a ticket for another one is stale. */
  instanceId: string;
  /** The owner's version, when it names one, for the harness menu. */
  version?: string;
  /** The commit the owner booted from, when it names one. */
  codeSha?: string;
}

/**
 * What the home's owner says about itself: the discovery verdict clients show, and the
 * endpoint to attach to when there is one. `resolve-profile` answers all of it; a gateway
 * older than that verb answers `identify`, and the same fields are read from it (`legacy`).
 */
export interface GatewayVerdict {
  /** `ready`, `starting`, `draining`, `absent`, `inaccessible`, `incompatible`, `conflict`, … */
  state: string;
  /** The owner's own code for that state (`ready`, `restart_wait`, `no_control_socket`, …). */
  reasonCode: string;
  /** The bounded cause the owner names, when it names one. */
  detail?: string;
  /** The owner's verdict lines when not attachable (`gateway <state>: <reason>`, then the remedy). */
  message?: string;
  /** True when a client may dial the endpoint now (ready, or a restart's after-turn wait). */
  attachable: boolean;
  /** An update owns the install: starting a gateway must go through the CLI. */
  updateFenced: boolean;
  /** Where to attach, or null. */
  endpoint: GatewayEndpoint | null;
  /** The commit installed on disk now; unlike `endpoint.codeSha`, the gateway outlived an update. */
  installCodeSha?: string;
  /** True when this came from `identify` rather than `resolve-profile`. */
  legacy: boolean;
}

/** The same home, however each side spelled it (`~`, a trailing slash, a symlink). */
function sameHome(left: string, right: string): boolean {
  return left.replace(/\/+$/, "") === right.replace(/\/+$/, "");
}

/**
 * The endpoint an `identify` answer names for `home`, or null when this home is not
 * served (yet, or at all). The checks mirror `hermes_cli.gateway_runtime._endpoint`:
 * a ready owner, the session authority, a loopback origin, and this home among the
 * profiles it serves — anything else is not something to attach a chat to.
 */
export function endpointFromIdentify(payload: Obj, home: string): GatewayEndpoint | null {
  if (payload.runtime_protocol !== 1 || payload.state !== "ready") return null;
  const capabilities = Array.isArray(payload.capabilities) ? payload.capabilities : [];
  if (!capabilities.includes("session-authority-v1")) return null;
  const apiOrigin = str(payload.api_origin);
  if (!LOOPBACK_ORIGIN.test(apiOrigin)) return null;
  const profiles = Array.isArray(payload.served_profiles) ? payload.served_profiles : [];
  const mine = profiles.find((entry) => isObj(entry) && sameHome(str(entry.home), home));
  const profileId = isObj(mine) ? str(mine.profile_id) : "";
  const instanceId = str(payload.instance_id);
  if (!profileId || !instanceId) return null;
  const version = str(payload.code_version);
  const codeSha = str(payload.code_sha);
  return { apiOrigin, profileId, instanceId, ...(version ? { version } : {}), ...(codeSha ? { codeSha } : {}) };
}

/** The endpoint `resolve-profile` (or `attach --json`'s `endpoint`) names, or null when it is not one to dial. */
export function endpointFromResolved(raw: Obj): GatewayEndpoint | null {
  const profileId = str(raw.profile_id);
  const instanceId = str(raw.instance_id);
  if (!profileId || !instanceId) return null;
  const wsUrl = str(raw.ws_url);
  const apiOrigin = LOOPBACK_ORIGIN.test(str(raw.api_origin)) ? str(raw.api_origin) : wsUrl.replace(/^ws/, "http").replace(/\/api\/ws$/, "");
  if (!LOOPBACK_ORIGIN.test(apiOrigin)) return null;
  const version = str(raw.code_version);
  const codeSha = str(raw.code_sha);
  const wsProtocol = str(raw.ws_protocol);
  const ticketPrefix = str(raw.ticket_protocol_prefix);
  return {
    apiOrigin,
    profileId,
    instanceId,
    ...(LOOPBACK_WS.test(wsUrl) ? { wsUrl } : {}),
    ...(wsProtocol ? { wsProtocol } : {}),
    ...(ticketPrefix ? { ticketPrefix } : {}),
    ...(version ? { version } : {}),
    ...(codeSha ? { codeSha } : {}),
  };
}

/** The verdict `resolve-profile` returns, in the shape callers read. */
export function verdictFromResolve(answer: Obj): GatewayVerdict {
  const state = strOr(answer.state, "unknown");
  const reasonCode = strOr(answer.reason_code, state);
  const detail = str(answer.detail);
  const message = str(answer.message);
  const attachable = answer.attachable === true;
  const endpoint = attachable && isObj(answer.endpoint) ? endpointFromResolved(answer.endpoint) : null;
  const installCodeSha = str(answer.install_code_sha);
  return {
    state,
    reasonCode,
    attachable: attachable && endpoint !== null,
    updateFenced: answer.update_fenced === true,
    endpoint,
    legacy: false,
    ...(detail ? { detail } : {}),
    ...(message ? { message } : {}),
    // Attachable but nothing dialable: say that, rather than "ready" and no endpoint.
    ...(attachable && endpoint === null ? { message: "gateway ready: the owner named no endpoint to dial" } : {}),
    ...(installCodeSha ? { installCodeSha } : {}),
  };
}

/** The verdict the same fields make when an older gateway answered `identify`. */
export function verdictFromIdentify(answer: Obj, home: string): GatewayVerdict {
  const endpoint = endpointFromIdentify(answer, home);
  const state = strOr(answer.state, "unknown");
  const reasonCode = strOr(answer.reason_code, state);
  const detail = str(answer.detail);
  return {
    state,
    reasonCode,
    attachable: endpoint !== null,
    updateFenced: false,
    endpoint,
    legacy: true,
    ...(detail ? { detail } : {}),
    ...(endpoint === null ? { message: `gateway ${state}: ${reasonCode}` } : {}),
  };
}

/**
 * The homes the rendezvous names for `home`: the home itself, and for a named profile
 * (`<root>/profiles/<name>`) the root, whose multiplexer answers for the profiles it
 * serves when they have no socket of their own.
 */
function rendezvousHomes(home: string): string[] {
  const parent = path.dirname(home);
  if (path.basename(parent) !== "profiles" || path.basename(home).startsWith(".")) return [home];
  return [home, path.dirname(parent)];
}

/**
 * A home's control socket, per the public contract: `gateway.sock` when it is a socket
 * only this user can reach, else the `gateway.sock.path` pointer a gateway started under
 * a private temp root leaves (a 0600 file this user owns, naming an absolute
 * `hermes-gw-<16 hex>/control.sock` inside a directory others cannot reach). Null when
 * neither qualifies — never a guess at another path.
 */
async function privateSocketAt(home: string): Promise<string | null> {
  // Windows has no such socket (the owner listens on a named pipe whose SID a Node
  // client cannot check); `hermes gateway attach --json` is the contract there.
  if (process.platform === "win32") return null;
  const direct = path.join(home, "gateway.sock");
  if (await privateSocket(direct)) return direct;
  const target = await pointerTarget(home);
  return target !== null && (await privateSocket(target)) ? target : null;
}

/** True for a path that is a socket this user owns, with no group or other access. */
async function privateSocket(file: string): Promise<boolean> {
  const info = await fs.lstat(file).catch(() => null);
  if (!info?.isSocket()) return false;
  if (process.getuid && info.uid !== process.getuid()) return false;
  return (info.mode & 0o077) === 0;
}

/** The socket `gateway.sock.path` points at, when the pointer itself is the one the contract describes. */
async function pointerTarget(home: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    // Opened without following links: the pointer is a file the owner wrote, not a name to chase.
    handle = await fs.open(path.join(home, SOCKET_POINTER), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_POINTER_BYTES || (info.mode & 0o777) !== 0o600) return null;
    if (process.getuid && info.uid !== process.getuid()) return null;
    const target = (await handle.readFile("utf8")).trim();
    if (!path.isAbsolute(target) || !POINTER_TARGET.test(target)) return null;
    const directory = await fs.lstat(path.dirname(target)).catch(() => null);
    if (!directory?.isDirectory() || (directory.mode & 0o077) !== 0) return null;
    if (process.getuid && directory.uid !== process.getuid()) return null;
    return target;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** One line of JSON to the home's control socket, and its one-line answer. */
function controlRequest(socketPath: string, payload: Obj, timeoutMs = CONTROL_TIMEOUT_MS): Promise<Obj> {
  return new Promise<Obj>((resolve, reject) => {
    const socket = net.connect(socketPath);
    let data = "";
    let settled = false;
    const settle = (error: Error | null, result?: Obj) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result ?? {});
    };
    const timer = setTimeout(() => settle(new Error(`${path.basename(socketPath)} did not answer`)), timeoutMs);
    socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
      const end = data.indexOf("\n");
      if (end < 0) {
        if (data.length > MAX_CONTROL_BYTES) settle(new Error("oversized control answer"));
        return;
      }
      let frame: Obj;
      try {
        frame = JSON.parse(data.slice(0, end)) as Obj;
      } catch {
        return settle(new Error("unreadable control answer"));
      }
      // The envelope echoes the request's `id` and protocol; anything else is not this answer.
      if (frame.protocol !== 1 || frame.id !== payload.id) return settle(new Error("unreadable control answer"));
      if (frame.ok !== true) return settle(new Error(str(frame.error) || "the control socket refused the request"));
      settle(null, isObj(frame.result) ? frame.result : {});
    });
    socket.on("error", (error) => settle(error));
  });
}

/** A control verb's refusal text, as the socket gave it. */
const refusalText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A socket whose owner is gone refuses the connection: a crashed gateway's leftover, not an answer. */
const ownerGone = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ECONNREFUSED" || code === "ENOENT";
};

/**
 * What `hermes gateway attach --json` hands a client with its own UI: the owner's
 * WebSocket URL, the subprotocols to dial with (the ticket rides the second), the ticket
 * itself, and the endpoint it belongs to. Hermes's own public attach step — the one its
 * TUI and desktop use — so a client that cannot read the home's control socket (Windows'
 * named pipe, a home whose rendezvous is not the documented shape) still gets in.
 */
export interface GatewayGrant {
  /** The owner's URL, e.g. `ws://127.0.0.1:40233/api/ws`. */
  url: string;
  /** The subprotocols to dial with, the ticket's included: `[protocol, "…ticket.<t>"]`. */
  protocols: string[];
  /** The single-use ticket. A credential: never logged, never kept beyond its dial. */
  ticket: string;
  /** Where the grant points, in the same shape every other attach path uses. */
  endpoint: GatewayEndpoint;
  /** The CLI's own commit; unlike `endpoint.codeSha`, the gateway outlived an update. */
  clientCodeSha?: string;
}

/**
 * The grant the command printed, or null when the line is not one it prints. The command
 * emits one JSON object (a verdict object when it cannot attach: no `url`, no `ticket`),
 * so anything else is a refusal to attach, not something to dial.
 */
export function grantFromAttach(stdout: string): GatewayGrant | null {
  const line = stdout.trim().split("\n").pop() ?? "";
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObj(data) || data.state !== "ready") return null;
  const url = str(data.url);
  // Loopback only, and only the `/api/ws` path the owner serves.
  if (!LOOPBACK_WS.test(url)) return null;
  const protocols = Array.isArray(data.protocols) ? data.protocols.map(String).filter(Boolean) : [];
  const ticket = str(data.ticket);
  const endpoint = isObj(data.endpoint) ? endpointFromResolved(data.endpoint) : null;
  if (!ticket || protocols.length === 0 || !endpoint) return null;
  const protocol = str(data.protocol);
  const clientCodeSha = str(data.client_code_sha);
  return {
    url,
    protocols,
    ticket,
    // The URL and protocol the command names win over what its endpoint record implies.
    endpoint: { ...endpoint, wsUrl: url, ...(protocol ? { wsProtocol: protocol } : {}) },
    ...(clientCodeSha ? { clientCodeSha } : {}),
  };
}

/** A verdict that names no owner: no socket, or one nobody could be asked on. */
const noOwner = (state: string, reasonCode: string, detail?: string, legacy = true): GatewayVerdict => ({
  state,
  reasonCode,
  attachable: false,
  updateFenced: false,
  endpoint: null,
  legacy,
  ...(detail ? { detail } : {}),
});

/**
 * Ask the home's rendezvous for one answer: the first candidate whose socket answers wins,
 * and a leftover socket (its owner crashed) means try the next candidate, as the contract says.
 */
async function askControl<T>(home: string, ask: (socket: string) => Promise<T>): Promise<T> {
  let last: unknown = null;
  for (const candidate of rendezvousHomes(home)) {
    const socket = await privateSocketAt(candidate);
    if (!socket) continue;
    try {
      return await ask(socket);
    } catch (error) {
      if (ownerGone(error)) {
        last = error;
        continue;
      }
      throw error;
    }
  }
  if (last) throw last;
  throw Object.assign(new Error("no Hermes gateway control socket"), { code: "ENOENT" });
}

/**
 * What the home's owner says about itself: `resolve-profile` when the gateway has that
 * verb, `identify` when it is older than it (Hermes 0.23 and earlier). Read-only, and
 * every field is validated before it is trusted for an attach. A home with no control
 * socket at all is `absent`, which is a verdict too — not an error.
 */
export async function gatewayVerdict(home: string): Promise<GatewayVerdict> {
  const served = await fs.realpath(home).catch(() => home);
  try {
    return await askControl<GatewayVerdict>(served, async (socket) => {
      try {
        return verdictFromResolve(await controlRequest(socket, { protocol: 1, id: 1, verb: "resolve-profile", params: { home: served } }));
      } catch (error) {
        // Only "this gateway is older than the verb" falls through: every other refusal is its verdict.
        const refusal = refusalText(error);
        if (!(/unknown verb/.test(refusal) && /resolve-profile/.test(refusal))) {
          // A root socket that does not serve this named profile: no gateway here.
          if (/profile_mismatch/.test(refusal)) return noOwner("absent", "profile_mismatch", refusal);
          throw error;
        }
      }
      return verdictFromIdentify(await controlRequest(socket, { protocol: 1, id: 1, verb: "identify" }), served);
    });
  } catch (error) {
    return ownerGone(error) ? noOwner("absent", "no_control_socket") : noOwner("inaccessible", "control_refused", refusalText(error));
  }
}

/**
 * One ticket for `endpoint` (`interactive`: create, read, submit, control, approve,
 * respond — what a chat surface needs). It is single-use and expires in 30 s, so it is
 * minted at dial time and never kept.
 *
 * `restart_wait: "refuse"` keeps a machine poller from parking on a restart's after-turn
 * wait; an owner older than that key refuses the parameters themselves, and the retry
 * without it is the contract's own instruction.
 */
export async function gatewayTicket(home: string, endpoint: GatewayEndpoint): Promise<string> {
  const served = await fs.realpath(home).catch(() => home);
  const params = { profile_id: endpoint.profileId, instance_id: endpoint.instanceId, purpose: "interactive", restart_wait: "refuse" };
  const answer = await askControl<Obj>(served, async (socket) => {
    try {
      return await controlRequest(socket, { protocol: 1, id: 1, verb: "session-ticket", params });
    } catch (error) {
      if (!/invalid bootstrap parameters/.test(refusalText(error))) throw error;
      return controlRequest(socket, { protocol: 1, id: 1, verb: "session-ticket", params: { ...params, restart_wait: undefined } });
    }
  });
  const ticket = str(answer.ticket);
  // What the owner must echo back: a ticket for another instance or profile is one the
  // socket would refuse at the upgrade, so it is refused here with a message that says so.
  const echoes = answer.profile_id === undefined || str(answer.profile_id) === endpoint.profileId;
  if (!ticket || !echoes || str(answer.instance_id) !== endpoint.instanceId || (answer.runtime_protocol !== undefined && answer.runtime_protocol !== 1)) {
    throw new Error("Hermes refused a gateway ticket");
  }
  return ticket;
}

/** A WebSocket to the owner, ready to carry the session RPC. */
export class GatewaySocket implements GatewayLink {
  readonly attached = true;
  exited = false;
  private readonly calls: PendingRequests<string>;
  private readonly exitListeners = new Set<(message: string) => void>();
  private readonly socket: WebSocket;
  private closing = false;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  readonly ready: Promise<void>;

  private constructor(socket: WebSocket, onEvent: (params: Obj) => void, onRequest: (frame: GatewayFrame) => void) {
    this.socket = socket;
    this.calls = new PendingRequests<string>(hermesCodec(), (frame) => this.send(frame));
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const readyTimer = setTimeout(() => this.failed("the Hermes gateway did not become ready"), READY_TIMEOUT_MS);
    void this.ready.then(() => clearTimeout(readyTimer), () => clearTimeout(readyTimer));
    socket.onmessage = (event: MessageEvent) => {
      let frame: GatewayFrame;
      try {
        frame = JSON.parse(typeof event.data === "string" ? event.data : "") as GatewayFrame;
      } catch {
        return;
      }
      if (frame.method === "event") {
        if (isObj(frame.params) && frame.params.type === "gateway.ready") {
          this.readyResolve();
          return;
        }
        if (isObj(frame.params)) onEvent(frame.params);
        return;
      }
      if (this.calls.accept(frame)) return;
      // No pending request matches: a server→client request (approval, clarify, …).
      if (frame.method && frame.id !== undefined) onRequest(frame);
    };
    socket.onclose = (event: CloseEvent) => this.failed(`the Hermes gateway closed the connection (${event.code}${event.reason ? `: ${event.reason}` : ""})`);
    socket.onerror = () => this.failed("the Hermes gateway connection failed");
  }

  /**
   * Dial the owner and wait only for the socket itself; `ready` then waits for its
   * `gateway.ready` frame, as the stdio child's does. The owner names its URL and
   * protocol when it can (`resolve-profile`, `attach --json`); the derivation from the
   * origin and the documented defaults are what an older owner's `identify` leaves.
   */
  static async open(endpoint: GatewayEndpoint, ticket: string, onEvent: (params: Obj) => void, onRequest: (frame: GatewayFrame) => void): Promise<GatewaySocket> {
    const origin = endpoint.apiOrigin.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
    const url = endpoint.wsUrl ?? `${origin}/api/ws`;
    const protocol = endpoint.wsProtocol ?? GATEWAY_PROTOCOL;
    return GatewaySocket.dialled(url, [protocol, `${endpoint.ticketPrefix ?? TICKET_PREFIX}${ticket}`], protocol, onEvent, onRequest);
  }

  /**
   * Dial a grant `hermes gateway attach --json` minted: its URL, its own subprotocols
   * (the ticket rides the second), and the protocol it says the owner speaks.
   */
  static async openGrant(grant: GatewayGrant, onEvent: (params: Obj) => void, onRequest: (frame: GatewayFrame) => void): Promise<GatewaySocket> {
    return GatewaySocket.dialled(grant.url, grant.protocols, grant.endpoint.wsProtocol ?? str(grant.protocols[0]), onEvent, onRequest);
  }

  private static async dialled(url: string, protocols: string[], protocol: string, onEvent: (params: Obj) => void, onRequest: (frame: GatewayFrame) => void): Promise<GatewaySocket> {
    const socket = new WebSocket(url, protocols);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the Hermes gateway did not accept the connection")), CONTROL_TIMEOUT_MS);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("the Hermes gateway refused the connection"));
      };
    });
    // The owner echoes its protocol when the ticket was accepted; anything else is a mismatch.
    if (socket.protocol !== protocol) {
      socket.close(1002, "protocol mismatch");
      throw new Error(`the Hermes gateway negotiated ${socket.protocol || "no"} protocol`);
    }
    return new GatewaySocket(socket, onEvent, onRequest);
  }

  request<T = unknown>(method: string, params: Obj = {}): Promise<T> {
    if (this.exited) return Promise.reject(new Error("hermes is not running"));
    return this.calls.send<T>({ method, params }, `hermes did not answer ${method}`);
  }

  respond(id: string | number, result: unknown): void {
    if (this.exited) return;
    this.send({ jsonrpc: "2.0", id, result });
  }

  onExit(listener: (message: string) => void): void {
    this.exitListeners.add(listener);
  }

  /** Close the attachment. The session stays in the gateway: it is not ours to end. */
  async kill(): Promise<void> {
    if (this.exited) return;
    // `closing` keeps the socket's own close from being reported as a failure, but the
    // listeners still hear about it, the way a child's exit reaches them.
    this.closing = true;
    await new Promise<void>((resolve) => {
      if (this.socket.readyState !== SOCKET_OPEN) return resolve();
      const timer = setTimeout(resolve, 1_000);
      this.socket.onclose = () => {
        clearTimeout(timer);
        resolve();
      };
      try {
        this.socket.close(1000, "awui detached");
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
    this.exited = true;
    this.calls.failAll("hermes is not running");
    for (const listener of this.exitListeners) listener("hermes detached from the gateway");
  }

  private send(frame: Obj): void {
    if (this.socket.readyState !== SOCKET_OPEN) throw new Error("the Hermes gateway connection is not open");
    this.socket.send(JSON.stringify(frame));
  }

  private failed(detail: string): void {
    if (this.exited || this.closing) return;
    this.exited = true;
    this.readyReject(new Error(detail));
    this.calls.failAll(detail);
    for (const listener of this.exitListeners) listener(detail);
  }
}
