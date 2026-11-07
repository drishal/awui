// Attaching to a running Hermes gateway — the client path Hermes's own TUI, desktop
// app, and dashboard use.
//
// Why this exists: one gateway owns a profile home at a time (`gateway.lock`), and
// since 2026.9.24 the stdio session server awui used to start per chat
// (`python -m tui_gateway.entry`) refuses to start beside a live owner and exits 1.
// So a chat started next to `hermes gateway` (a service, the desktop app, a TUI) can
// never run, and starting one of our own would block the owner from coming back.
// Attaching is what upstream supports: ask the home's control socket for its identity
// (`identify`), mint a short-lived single-use session ticket, dial `/api/ws` with it,
// and speak the same JSON-RPC there. Nothing is written to the home, and the gateway
// keeps serving every other client while we are attached.
import { promises as fs } from "node:fs";
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

const str = (value: unknown): string => (typeof value === "string" ? value : "");

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
  /** The owner's profile id for this home; a ticket is minted for exactly it. */
  profileId: string;
  /** The running instance; a ticket for another one is stale. */
  instanceId: string;
  /** The owner's version, when it names one, for the harness menu. */
  version?: string;
  /** The commit the owner booted from, when it names one. */
  codeSha?: string;
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
  if (!/^https?:\/\/127\.0\.0\.1:\d+$/.test(apiOrigin)) return null;
  const profiles = Array.isArray(payload.served_profiles) ? payload.served_profiles : [];
  const mine = profiles.find((entry) => isObj(entry) && sameHome(str(entry.home), home));
  const profileId = isObj(mine) ? str(mine.profile_id) : "";
  const instanceId = str(payload.instance_id);
  if (!profileId || !instanceId) return null;
  const version = str(payload.code_version);
  const codeSha = str(payload.code_sha);
  return { apiOrigin, profileId, instanceId, ...(version ? { version } : {}), ...(codeSha ? { codeSha } : {}) };
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
      if (frame.ok !== true) return settle(new Error(str(frame.error) || "the control socket refused the request"));
      settle(null, isObj(frame.result) ? frame.result : {});
    });
    socket.on("error", (error) => settle(error));
  });
}

/**
 * The gateway serving `home`, or null when none answers there. Read-only: `identify`
 * asks the owner who it is and never changes anything, and the answer is validated
 * before it is trusted for an attach.
 */
export async function gatewayEndpoint(home: string): Promise<GatewayEndpoint | null> {
  const answer = await controlRequest(path.join(home, "gateway.sock"), { protocol: 1, id: 1, verb: "identify" }).catch(() => null);
  if (!answer) return null;
  const served = await fs.realpath(home).catch(() => home);
  return endpointFromIdentify(answer, served);
}

/**
 * One ticket for `endpoint` (`interactive`: create, read, submit, control, approve,
 * respond — what a chat surface needs). It is single-use and expires in 30 s, so it is
 * minted at dial time and never kept.
 */
export async function gatewayTicket(home: string, endpoint: GatewayEndpoint): Promise<string> {
  const answer = await controlRequest(path.join(home, "gateway.sock"), {
    protocol: 1,
    id: 1,
    verb: "session-ticket",
    params: { profile_id: endpoint.profileId, instance_id: endpoint.instanceId, purpose: "interactive" },
  });
  const ticket = str(answer.ticket);
  // The owner refuses a ticket minted for an instance that is no longer the one serving the home.
  if (!ticket || str(answer.instance_id) !== endpoint.instanceId) throw new Error("Hermes refused a gateway ticket");
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
   * `gateway.ready` frame, as the stdio child's does.
   */
  static async open(endpoint: GatewayEndpoint, ticket: string, onEvent: (params: Obj) => void, onRequest: (frame: GatewayFrame) => void): Promise<GatewaySocket> {
    const origin = endpoint.apiOrigin.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
    const socket = new WebSocket(`${origin}/api/ws`, [GATEWAY_PROTOCOL, `${TICKET_PREFIX}${ticket}`]);
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
    if (socket.protocol !== GATEWAY_PROTOCOL) {
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
