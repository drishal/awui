// The canonical session dialect: how a chat rides the Hermes gateway that owns its home.
//
// A ticketed `/api/ws` connection (see hermes-gateway.ts) speaks Hermes's canonical
// wire — `gateway/session_contract.py`, the one its own Ink TUI, Desktop, and dashboard
// use — where the session namespace has different verbs and stricter contracts than the
// stdio `tui_gateway.entry` dialect the chat code was written against: `session.create`
// takes a closed parameter set with a `request_id`, prompts are admitted with a
// client-minted `input_id` and fenced by `execution_generation`, edits are
// revision-fenced `session.mutate` operations, and approvals arrive as events rather
// than server→client requests.
//
// Rather than rewrite the chat for that wire (and again on the next one), this module
// translates: it presents the stdio dialect's methods and shapes on top of the canonical
// connection, the way upstream's own clients do (the Ink TUI's `canonicalRequest` /
// `canonicalResult` shim, `hermes_cli/gateway_client.py`). The wire's differences then
// land here — negotiated through `runtime.describe`, which names the create contract the
// owner accepts — instead of breaking every call site. Nothing is written to the home,
// and the session belongs to the gateway: it outlives this link and every other client
// keeps seeing it.
import { randomUUID } from "node:crypto";
import { isObj, type Obj } from "./agent-events.js";
import { GatewaySocket, HermesRpcError, type GatewayEndpoint, type GatewayFrame, type GatewayGrant, type GatewayLink } from "./hermes-gateway.js";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** What `runtime.describe` promised: the create contract this owner accepts. */
interface Described {
  sources: string[];
  parameters: string[];
}

/** The live session this link holds: its subscription and the two fences edits are checked against. */
interface Tracked {
  sessionId: string;
  /** The durable id a resume is addressed by (the session survives this link). */
  storedId: string;
  subscriptionId: string;
  revision: number;
  generation: number;
}

/** A pending approval/clarify, keyed by the prompt id its `…respond` verb wants back. */
interface Control {
  kind: "approval" | "clarify";
  sessionId: string;
  generation: number;
  promptId: string;
}

/**
 * The snapshot's rows in the stdio dialect's shape (`role`/`text`/`name`/`content`/`args`).
 *
 * The canonical wire returns two copies. `messages` are the stored rows (`content` holds the
 * text, tools are `tool_name`); `display_messages`, only when `display_projection` was asked,
 * are what the TUI renders (`text`, `name`, `args`, and no tool output). Using `messages`
 * alone drops every user prompt — the chat opens on the empty composer — and using only
 * `display_messages` drops what a tool returned. This keeps the display rows and fills tool
 * output from the stored ones; with no display copy, a string `content` is the text.
 */
function projectSnapshot(snapshot: Obj): Obj[] {
  const raw = (Array.isArray(snapshot.messages) ? snapshot.messages : []).filter(isObj);
  const display = (Array.isArray(snapshot.display_messages) ? snapshot.display_messages : []).filter(isObj);
  const byCall = new Map<string, Obj>();
  const byRow = new Map<number, Obj>();
  for (const row of raw) {
    const call = str(row.tool_call_id);
    if (call) byCall.set(call, row);
    const id = num(row.row_id);
    if (id !== null) byRow.set(id, row);
  }
  return (display.length > 0 ? display : raw).map((row) => {
    const call = str(row.tool_call_id);
    const id = num(row.row_id);
    const stored = (call && byCall.get(call)) || (id !== null ? byRow.get(id) : undefined);
    const content = row.content !== undefined ? row.content : stored?.content;
    const text = str(row.text) || (typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (typeof part === "string" ? part : isObj(part) && typeof part.text === "string" ? part.text : "")).filter(Boolean).join("\n") : "");
    const name = str(row.name) || str(stored?.name) || str(stored?.tool_name) || str(row.tool_name);
    const reasoning = str(row.reasoning) || str(stored?.reasoning);
    const context = str(row.context) || str(stored?.context);
    const args = row.args ?? stored?.args;
    return {
      ...row,
      ...(text ? { text } : {}),
      ...(name ? { name } : {}),
      ...(content !== undefined ? { content } : {}),
      ...(args !== undefined ? { args } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(context ? { context } : {}),
    };
  });
}

/** A `prompt.submit`'s stdio-dialect edit keys, which the canonical wire does its own way. */
function truncateTarget(params: Obj): number | null {
  return num(params.truncate_before_row_id);
}

/**
 * One chat's connection to the owner: the stdio dialect in, the canonical wire out.
 * Also the reverse for prompts — canonical `approval.request` / `clarify.request`
 * events are presented as the `approval` / `clarify` server→client requests the chat
 * answers, and its answers go back as `approval.respond` / `clarify.respond`.
 */
export class CanonicalChatLink implements GatewayLink {
  readonly attached = true;
  private socket!: GatewaySocket;
  private described: Described | null = null;
  private session: Tracked | null = null;
  private rows: Obj[] | null = null;
  /** The snapshot's `info` (model, cwd, title, …), kept for a caller that only reads. */
  private info: Obj = {};
  private readonly controls = new Map<string, Control>();

  private constructor(
    private readonly onEventOuter: (params: Obj) => void,
    private readonly onRequestOuter: (frame: GatewayFrame) => void,
  ) {}

  /** Dial the owner's canonical socket and wrap it in this dialect. */
  static async open(endpoint: GatewayEndpoint, ticket: string, onEvent: (params: Obj) => void, onRequest: (frame: GatewayFrame) => void): Promise<CanonicalChatLink> {
    const link = new CanonicalChatLink(onEvent, onRequest);
    link.socket = await GatewaySocket.open(endpoint, ticket, (params) => link.onEvent(params), (frame) => link.onRequest(frame));
    return link;
  }

  /**
   * The same link, over a grant `hermes gateway attach --json` minted: the owner's URL and
   * ticket as the command printed them. The shim sits over it exactly as over the socket
   * path — a granted connection speaks the same canonical wire, so a chat that came in
   * through the CLI is translated like any other.
   */
  static async openGrant(grant: GatewayGrant, onEvent: (params: Obj) => void, onRequest: (frame: GatewayFrame) => void): Promise<CanonicalChatLink> {
    const link = new CanonicalChatLink(onEvent, onRequest);
    link.socket = await GatewaySocket.openGrant(grant, (params) => link.onEvent(params), (frame) => link.onRequest(frame));
    return link;
  }

  get ready(): Promise<void> {
    return this.socket.ready;
  }

  get exited(): boolean {
    return this.socket.exited;
  }

  async request<T = unknown>(method: string, params: Obj = {}): Promise<T> {
    switch (method) {
      // Prompts are events on this wire; there is no capability handshake to make.
      case "client.capabilities":
        return {} as T;
      case "session.create":
        return this.create(params) as Promise<T>;
      case "session.resume":
        return this.resume(str(params.session_id)) as Promise<T>;
      case "session.history":
        return this.history(str(params.session_id)) as Promise<T>;
      case "prompt.submit":
        return this.submit(params) as Promise<T>;
      // A correction is fenced to the execution it was typed into. A stale generation is refused
      // (and the closed parameter set takes no input id), and the adapter then queues the text.
      case "session.steer": {
        const session = this.require();
        return this.socket.request("session.steer", { session_id: session.sessionId, text: str(params.text), execution_generation: session.generation }) as Promise<T>;
      }
      case "session.interrupt": {
        const session = this.require();
        return this.socket.request("session.interrupt", { session_id: session.sessionId, execution_generation: session.generation }) as Promise<T>;
      }
      // Closing the link detaches; the session belongs to the gateway and outlives it.
      case "session.close":
        return this.detach("client_close") as Promise<T>;
      case "config.set":
        return this.setConfig(params) as Promise<T>;
      case "session.title":
        return this.mutate("rename", { title: str(params.title) }, false) as Promise<T>;
      case "session.compress":
        return this.mutate("compress", str(params.focus_topic) ? { focus: str(params.focus_topic) } : {}, true) as Promise<T>;
      // Everything else (slash.exec, command.dispatch, complete.slash, model.options,
      // projects.tree, image.attach_bytes, …) is the same verb on both wires.
      default:
        return this.socket.request(method, params) as Promise<T>;
    }
  }

  /**
   * Answer a chat-side prompt. The synthesized prompt frames carry the prompt id as
   * their id, which is the key back to the fenced `…respond` verb; anything else is an
   * answer to a real server→client request (sudo, secret), which this wire still speaks.
   */
  respond(id: string | number, result: unknown): void {
    const control = this.controls.get(String(id));
    if (!control) return this.socket.respond(id, result);
    this.controls.delete(String(id));
    const payload = isObj(result) ? result : {};
    if (control.kind === "approval") {
      void this.socket
        .request("approval.respond", { session_id: control.sessionId, execution_generation: control.generation, prompt_id: control.promptId, choice: str(payload.choice) || "deny" })
        .catch(() => undefined);
      return;
    }
    const answers = isObj(payload.answers) ? payload.answers : {};
    // Canonical prompts arrive one question per card, so one answer settles one prompt.
    const answer = str(answers[control.promptId]) || str(Object.values(answers)[0]) || "";
    void this.socket
      .request("clarify.respond", { session_id: control.sessionId, execution_generation: control.generation, prompt_id: control.promptId, answer })
      .catch(() => undefined);
  }

  onExit(listener: (message: string) => void): void {
    this.socket.onExit(listener);
  }

  async kill(): Promise<void> {
    // Leave as a viewer. An end_reason would close the conversation; the session
    // belongs to the gateway and outlives this link.
    await this.detach().catch(() => undefined);
    await this.socket.kill();
  }

  // ---- translation: the chat's verbs onto the wire's ------------------------------------------

  private require(): Tracked {
    if (!this.session) throw new Error("hermes has no session on this connection");
    return this.session;
  }

  /** `runtime.describe`, once per connection: the create contract this owner accepts. */
  private async describe(): Promise<Described> {
    if (this.described) return this.described;
    const result = await this.socket.request<Obj>("runtime.describe", {});
    const descriptor = isObj(result?.session_create) ? result.session_create : {};
    this.described = {
      sources: Array.isArray(descriptor.sources) ? descriptor.sources.map(String) : [],
      parameters: Array.isArray(descriptor.parameters) ? descriptor.parameters.map(String) : [],
    };
    return this.described;
  }

  private async create(params: Obj): Promise<Obj> {
    const described = await this.describe();
    // The owner names the sources it runs; "gui" is this surface, and a policy that
    // names none gets its first allowed one rather than a refused create.
    const source = described.sources.includes("gui") ? "gui" : (described.sources[0] ?? "cli");
    const request: Obj = { request_id: randomUUID(), source };
    const cwd = str(params.cwd);
    if (cwd && described.parameters.includes("cwd")) request.cwd = cwd;
    const title = str(params.title);
    if (title && described.parameters.includes("title")) request.title = title;
    return this.adopt(await this.socket.request<Obj>("session.create", request));
  }

  private async resume(sessionId: string): Promise<Obj> {
    return this.adopt(await this.socket.request<Obj>("session.resume", { session_id: sessionId, source: "webui", display_projection: true }));
  }

  /**
   * `session.history` is the stdio dialect's read; this wire projects the same rows on
   * create/resume ("resuming a live session attaches another event subscriber"), so the
   * snapshot is the history.
   */
  private async history(sessionId: string): Promise<Obj> {
    // The held session's durable id when this link has one, else the caller's: a read of a
    // session this connection has not opened yet (the adapter's readTranscript).
    await this.resume(this.session?.storedId || sessionId);
    return { messages: this.rows ?? [], info: this.info };
  }
  /** Take a canonical snapshot as the stdio create/resume answer, keeping its fences. */
  private adopt(snapshot: Obj): Obj {
    const sessionId = str(snapshot.session_id);
    const subscriptionId = str(snapshot.subscription_id);
    const previous = this.session;
    this.session = {
      sessionId,
      storedId: str(snapshot.stored_session_id) || sessionId,
      subscriptionId,
      revision: num(snapshot.revision) ?? 0,
      generation: num(snapshot.execution_generation) ?? 0,
    };
    this.rows = projectSnapshot(snapshot);
    // A resume over a live session returns a new subscription (the old one is a stale
    // viewer now). Detach names no end_reason: that field closes the conversation, and
    // the owner then ends the idle local row once no viewer is left.
    if (previous?.subscriptionId && (previous.sessionId !== sessionId || previous.subscriptionId !== subscriptionId)) {
      void this.socket.request("session.detach", { session_id: previous.sessionId, subscription_id: previous.subscriptionId }).catch(() => undefined);
    }
    const info: Obj = isObj(snapshot.info) ? snapshot.info : {};
    this.info = { ...info, running: snapshot.running === true };
    return {
      session_id: sessionId,
      stored_session_id: str(snapshot.stored_session_id) || sessionId,
      info: this.info,
      ...(isObj(snapshot.todo_state) ? { todo_state: snapshot.todo_state } : {}),
    };
  }

  /**
   * `prompt.submit`, with the stdio dialect's edit-and-retry (cut before a row, run the
   * new prompt in its place) done the canonical way: a `rewind` mutation first, then an
   * admitted submission with a client-minted input id.
   */
  private async submit(params: Obj): Promise<Obj> {
    const session = this.require();
    let target = truncateTarget(params);
    if (target === null && params.truncate_before_user_ordinal !== undefined) {
      // The stdio dialect cuts by turn number; the canonical wire rewinds to a row.
      const rows = ((await this.history(session.sessionId)) as { messages?: unknown }).messages;
      const users = (Array.isArray(rows) ? rows : []).filter(isObj).filter((row) => row.role === "user");
      target = num(users[num(params.truncate_before_user_ordinal) ?? 0]?.row_id);
    }
    if (target !== null) await this.mutate("rewind", { target_message_id: target }, true);
    const receipt = await this.socket.request<Obj>("prompt.submit", {
      session_id: session.sessionId,
      text: str(params.text),
      input_id: randomUUID(),
      queued: params.queued !== false,
    });
    const generation = num(receipt?.execution_generation);
    if (generation !== null) session.generation = generation;
    return receipt ?? {};
  }

  /** `config.set`'s model and reasoning keys are session mutations on this wire. */
  private async setConfig(params: Obj): Promise<Obj> {
    const key = str(params.key);
    if (key === "model") {
      // The picker's value is "model --provider provider" (see switchTarget in hermes.ts).
      const parts = str(params.value).trim().split(/\s+/);
      const model = parts.shift() ?? "";
      const providerAt = parts.indexOf("--provider");
      const provider = providerAt >= 0 ? parts[providerAt + 1] : undefined;
      return this.mutate("model", { model, ...(provider ? { provider } : {}) }, true);
    }
    if (key === "reasoning") return this.mutate("reasoning", { effort: str(params.value) }, true);
    // `show_reasoning` stays this verb: the session's live-stream flag, not an effort
    // and not a settings write. Mapping it onto `reasoning` would change the wrong thing.
    return this.socket.request("config.set", params);
  }

  /**
   * One revision-fenced edit; `fenced` edits also carry the generation they expect. A value pick (model,
   * reasoning) refused for a stale fence is tried once more at the fences the refusal names, as Hermes
   * Desktop does (api/canonical-protocol.ts, retryableFence): applying the same value again is harmless,
   * unlike a compare-and-set of shared metadata (a rename, a rewind), which is left refused.
   */
  private async mutate(operation: string, payload: Obj, fenced: boolean): Promise<Obj> {
    try {
      return await this.mutateOnce(operation, payload, fenced);
    } catch (error) {
      if (!(operation === "model" || operation === "reasoning") || !this.adoptRefusedFences(error)) throw error;
      return this.mutateOnce(operation, payload, fenced);
    }
  }

  /**
   * A fence refusal (`revision_conflict`, `stale_generation`) did not change the session, and names its current
   * fences in the error's data: take them (never moving backwards). True when the next attempt has new fences.
   */
  private adoptRefusedFences(error: unknown): boolean {
    if (!(error instanceof HermesRpcError) || !this.session) return false;
    const data = isObj(error.data) ? error.data : {};
    const reason = str(data.reason) || error.message;
    if (reason !== "revision_conflict" && reason !== "stale_generation") return false;
    const revision = num(data.revision);
    const generation = num(data.execution_generation);
    let moved = false;
    if (revision !== null && revision > this.session.revision) {
      this.session.revision = revision;
      moved = true;
    }
    if (generation !== null && generation > this.session.generation) {
      this.session.generation = generation;
      moved = true;
    }
    return moved;
  }

  private async mutateOnce(operation: string, payload: Obj, fenced: boolean): Promise<Obj> {
    const session = this.require();
    const request: Obj = { session_id: session.sessionId, request_id: randomUUID(), expected_revision: session.revision, operation, payload };
    if (fenced) request.expected_generation = session.generation;
    const result = await this.socket.request<Obj>("session.mutate", request);
    const revision = num(result?.revision);
    if (revision !== null) session.revision = revision;
    const generation = num(result?.execution_generation);
    if (generation !== null) session.generation = generation;
    return result ?? {};
  }

  private async detach(endReason?: string): Promise<Obj> {
    const session = this.session;
    this.session = null;
    if (!session?.subscriptionId) return { detached: false };
    return this.socket.request("session.detach", {
      session_id: session.sessionId,
      subscription_id: session.subscriptionId,
      ...(endReason ? { end_reason: endReason } : {}),
    });
  }

  // ---- translation: the wire's events and prompts into the chat's ------------------------------

  private onEvent(params: Obj): void {
    const type = str(params.type);
    const payload = isObj(params.payload) ? params.payload : {};
    this.adoptEventFences(type, params, payload);
    if (type === "approval.request" || type === "clarify.request") {
      const promptId = str(payload.prompt_id);
      if (!promptId) return;
      const sessionId = str(params.session_id) || this.session?.sessionId || "";
      const generation = num(payload.execution_generation) ?? this.session?.generation ?? 0;
      const kind = type === "approval.request" ? "approval" : "clarify";
      this.controls.set(promptId, { kind, sessionId, generation, promptId });
      this.onRequestOuter(promptFrame(kind, promptId, payload));
      return;
    }
    if (type === "approval.settled" || type === "clarify.settled") {
      // Another client answered (or the owner gave up on) a prompt this one still shows.
      const promptId = str(payload.prompt_id);
      if (promptId) this.onEventOuter({ type: "request.cancel", payload: { id: promptId } });
    }
    this.onEventOuter(params);
  }

  /**
   * Keep the fences an edit must present current from the stream, as Hermes Desktop's canonical client does
   * (api/canonical-protocol.ts, event): the owner bumps the execution generation when a queued prompt starts
   * running, after the submit receipt was answered, and stamps it on that execution's events; a commit by
   * another viewer, or the owner's own auto-title, moves the revision and says so in `session.info` /
   * `session.updated`. Without this, every model or reasoning change after a turn was refused as stale.
   */
  private adoptEventFences(type: string, params: Obj, payload: Obj): void {
    const session = this.session;
    if (!session) return;
    const sid = str(params.session_id);
    if (sid && sid !== session.sessionId) return;
    const generation = num(params.execution_generation) ?? num(payload.execution_generation);
    if (generation !== null && generation > session.generation) session.generation = generation;
    const revision = num(payload.revision);
    if (revision === null) return;
    if (type === "session.info" || (type === "session.updated" && revision > session.revision)) session.revision = Math.max(session.revision, revision);
  }

  private onRequest(frame: GatewayFrame): void {
    this.onRequestOuter(frame);
  }
}

/** The `approval` / `clarify` request the chat already understands, for one canonical prompt. */
function promptFrame(kind: "approval" | "clarify", promptId: string, payload: Obj): GatewayFrame {
  if (kind === "approval") {
    return { jsonrpc: "2.0", id: promptId, method: "approval", params: { ...payload, request_id: promptId } };
  }
  // One question per card, unless a submitter asked for the batch (clarify_batch).
  const batch = (Array.isArray(payload.questions) ? payload.questions : []).filter(isObj).map((question) => ({
    qid: str(question.qid) || promptId,
    question: str(question.question),
    choices: Array.isArray(question.choices) ? question.choices.map(String) : [],
    multi_select: question.multi_select === true,
  }));
  const single = {
    qid: promptId,
    question: str(payload.question),
    choices: Array.isArray(payload.choices) ? payload.choices.map(String) : [],
    multi_select: payload.multi_select === true,
  };
  const questions = batch.length > 0 ? batch : single.question ? [single] : [];
  return { jsonrpc: "2.0", id: promptId, method: "clarify", params: { questions } };
}
