// An ACP agent from config.yml, with no adapter code per agent: Gemini CLI
// (`gemini --experimental-acp`), Qwen Code, Goose, Cline, or anything else that
// speaks the Agent Client Protocol over stdio. Each `harnesses.acp:` entry
// registers one adapter under its own id, so awui's menus, sessions, and
// Settings treat it like a built-in harness.
//
// The agent stays the source of truth: awui never reads or writes its login,
// models, or session files, and declares only what the agent itself advertised
// in `initialize` (resume, images, HTTP MCP) or listed in its session's config
// options (models, reasoning). An app that replays no history shows no
// transcript for an existing session rather than an invented one.
import path from "node:path";
import type { ChatConfig, ChatItem, ConfigPatch, ContextUsage, HarnessCapabilities, ImageAttachment, InteractionAnswer, InteractionRequest, ModelInfo, SlashCommand, TodoItem } from "../../shared/protocol.js";
import { asHarnessId, type HarnessId } from "../../shared/protocol.js";
import type { AcpAgentConfig } from "../config.js";
import { embeddedVersion } from "../embedded.js";
import { boundText, isObj, type Obj } from "./agent-events.js";
import { AcpClient, killAcpChildren, liveAcpChildren } from "./acp-client.js";
import { foldAcpUpdate, itemsFromAcpFolds, type AcpFold } from "./acp-updates.js";
import { DialogTracker, EventHub } from "./event-hub.js";
import { nodeForMcpServers, ORCH_MCP_SERVER, orchestrateMcpServer, renderHtmlMcpServer } from "./render-extension.js";
import { HTML_RENDER_MCP_SERVER } from "./render-token.js";
import type { HarnessAdapter, HarnessDiscovery, HarnessEventListener, LiveChat, NativeSessionSummary, OpenChatRequest, RecentNativeSession, UsageEntry } from "./types.js";

/** How long the initialize, authenticate, or session handshake may take. */
const READY_TIMEOUT_MS = 60_000;
/** How long abort waits for the cancelled turn's own result before settling it itself. */
const ABORT_WAIT_MS = 30_000;
/** How long a discovery verdict is reused: one handshake is a whole agent process, and every page load asks. */
const DISCOVERY_CACHE_MS = 60_000;
/** How many distinct unknown update kinds one chat notes before it stays quiet. */
const MAX_UNKNOWN_NOTES = 5;
const CLIENT_VERSION = embeddedVersion ?? "dev";
/** ACP's protocol version this client speaks. */
const PROTOCOL_VERSION = 1;
/** A permission card shows at most this many of an agent's options, and no name or title longer than this. */
const MAX_PERMISSION_OPTIONS = 16;
const MAX_PERMISSION_TEXT = 200;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/** An ACP error's message, with `data.details` when the agent put the real reason there. */
function errorText(value: unknown): string {
  if (isObj(value)) {
    const message = str(value.message);
    const data = isObj(value.data) ? value.data : {};
    const details = str(data.details);
    if (message && details && details !== message) return `${message}: ${details}`;
    if (message) return message;
    if (details) return details;
  }
  return typeof value === "string" && value ? value : "the ACP agent reported an error";
}

/** An agent's session config option (ACP `configOptions`). */
interface ConfigOption {
  id: string;
  category: string;
  currentValue: string;
  choices: Array<{ value: string; name: string; description?: string }>;
}

function optionsFrom(raw: unknown): Map<string, ConfigOption> {
  const out = new Map<string, ConfigOption>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!isObj(entry)) continue;
    const id = str(entry.id);
    if (!id) continue;
    const choices = (Array.isArray(entry.options) ? entry.options : [])
      .filter(isObj)
      .map((option) => ({
        value: str(option.value),
        name: str(option.name) || str(option.value),
        ...(str(option.description) ? { description: str(option.description) } : {}),
      }))
      .filter((option) => option.value);
    out.set(id, { id, category: str(entry.category), currentValue: str(entry.currentValue), choices });
  }
  return out;
}

/** The option an agent lists models in, when it lists them at all. */
function modelOption(options: Map<string, ConfigOption>): ConfigOption | null {
  for (const option of options.values()) if (option.category === "model") return option;
  return options.get("model") ?? null;
}

/** The option an agent lists its reasoning levels in. */
function effortOption(options: Map<string, ConfigOption>): ConfigOption | null {
  for (const option of options.values()) if (option.category === "thought_level" || option.category === "reasoning") return option;
  return options.get("reasoning_effort") ?? options.get("thought_level") ?? null;
}

/** Everything an `initialize` handshake said, kept for capability mapping and the Settings Test button. */
export interface AcpProbe {
  /** The agent's own name, when it gave one. */
  agentName: string | null;
  version: string | null;
  protocolVersion: number | null;
  /** Resuming an existing session with its history replayed (ACP `loadSession`). */
  loadSession: boolean;
  /** Resuming without a replay (ACP `sessionCapabilities.resume`). */
  resumeSession: boolean;
  image: boolean;
  /** The agent takes MCP servers over HTTP itself, so the orchestration tools need no Node bridge. */
  mcpHttp: boolean;
  /** The auth methods it offers, by id: what `authMethod` in config.yml may name. */
  authMethods: string[];
}

function probeFrom(init: Obj): AcpProbe {
  const capabilities = isObj(init.agentCapabilities) ? init.agentCapabilities : {};
  const prompt = isObj(capabilities.promptCapabilities) ? capabilities.promptCapabilities : {};
  const mcp = isObj(capabilities.mcpCapabilities) ? capabilities.mcpCapabilities : {};
  const sessions = isObj(capabilities.sessionCapabilities) ? capabilities.sessionCapabilities : {};
  const info = isObj(init.agentInfo) ? init.agentInfo : {};
  const methods = (Array.isArray(init.authMethods) ? init.authMethods : [])
    .filter(isObj)
    .map((method) => str(method.id))
    .filter(Boolean);
  return {
    agentName: str(info.title) || str(info.name) || null,
    version: str(info.version) || null,
    protocolVersion: typeof init.protocolVersion === "number" ? init.protocolVersion : null,
    loadSession: capabilities.loadSession === true,
    resumeSession: sessions.resume !== undefined,
    image: prompt.image === true,
    mcpHttp: mcp.http === true,
    authMethods: methods,
  };
}


export interface AcpOptions {
  /** The user's home directory: where an agent dir is kept when it keeps one. */
  home: string;
  /** awui's state folder: this adapter's own folder, its only state. */
  stateDir: string;
  /** Base environment for the child; defaults to this process's. */
  env?: NodeJS.ProcessEnv;
}

class AcpLiveChat implements LiveChat {
  private hub = new EventHub();
  private dialogs = new DialogTracker(this.hub);
  private rpc: AcpClient | null = null;
  private disposed = false;
  private sessionId: string | null = null;
  /** Set when the session handshake answers; every update before that is the load's replay. */
  private accepting = false;
  private readonly replayed: AcpFold[] = [];
  private model: string | null = null;
  private level: string | null = null;
  private models: ModelInfo[] = [];
  private options = new Map<string, ConfigOption>();
  private commands: SlashCommand[] = [];
  private imageCapable = false;
  /** ACP `usage_update`: the occupancy the agent reports itself. */
  private contextUsage: { used: number; size: number } | null = null;
  private turnOpen = false;
  private promptRpc: Promise<unknown> | null = null;
  private assistantOpen = false;
  private readonly openTools = new Set<string>();
  /** What each open call was, for its approval card. */
  private readonly toolInfo = new Map<string, { name: string; args: unknown }>();
  private readonly permissionOptions = new Map<string, string[]>();
  private readonly unknownKinds = new Set<string>();

  constructor(
    private readonly adapter: AcpAdapter,
    private readonly cwd: string,
    private readonly resumeId: string | null,
    /** The chat's render and orchestration tokens: mounted on the session, never written anywhere. */
    private readonly toolEnv?: NodeJS.ProcessEnv,
  ) {}

  get nativeId(): string | null {
    return this.sessionId;
  }

  get title(): string | null {
    return null;
  }

  private get live(): AcpClient {
    if (!this.rpc || this.rpc.exited) throw new Error(`${this.adapter.displayName} is not running for this chat`);
    return this.rpc;
  }

  private emit(event: Parameters<HarnessEventListener>[0]): void {
    this.hub.emit(event);
  }

  private emitConfig(): void {
    this.emit({ type: "config", config: this.getConfigNow() });
  }

  async start(): Promise<void> {
    const rpc = new AcpClient({
      key: this.adapter.childKey,
      label: this.adapter.displayName,
      command: this.adapter.cliCommand,
      args: this.adapter.childArgs,
      env: this.adapter.childEnv(),
      cwd: this.cwd,
      onFrame: (frame) => this.onFrame(frame),
      errorText,
    });
    this.rpc = rpc;
    rpc.onExit((message) => {
      if (this.disposed) return;
      this.dialogs.cancelAll();
      // The child's stderr tail rides in the message, bounded by the transport: a
      // run that dies mid-turn has no other place to say why.
      this.emit({ type: "fatal", message: `${this.adapter.displayName} stopped unexpectedly (${message})` });
    });
    try {
      const init = await rpc.request<Obj>("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "awui", version: CLIENT_VERSION } }, READY_TIMEOUT_MS);
      const probe = probeFrom(init);
      if (probe.protocolVersion !== null && probe.protocolVersion !== PROTOCOL_VERSION) {
        this.emit({ type: "notice", level: "warning", text: `${this.adapter.displayName} spoke ACP protocol ${probe.protocolVersion}; awui expects ${PROTOCOL_VERSION}.` });
      }
      this.imageCapable = probe.image;
      if (this.resumeId && !probe.loadSession && !probe.resumeSession) {
        throw new Error(`${this.adapter.displayName} cannot resume a session: it advertises neither loadSession nor resume`);
      }
      await this.authenticate(rpc, probe);
      // After initialize: whether the agent takes MCP servers over HTTP is its own answer.
      const params: Obj = { cwd: this.cwd, mcpServers: this.adapter.mcpServers(this.toolEnv, probe.mcpHttp) };
      const result = this.resumeId
        ? probe.resumeSession && !probe.loadSession
          ? await rpc.request<Obj>("session/resume", { ...params, sessionId: this.resumeId }, READY_TIMEOUT_MS)
          : await rpc.request<Obj>("session/load", { ...params, sessionId: this.resumeId }, READY_TIMEOUT_MS)
        : await rpc.request<Obj>("session/new", params, READY_TIMEOUT_MS);
      const nativeId = this.applySession(result, this.resumeId ?? str(result.sessionId));
      this.accepting = true;
      this.emit({ type: "session", nativeId });
      this.emitConfig();
    } catch (error) {
      this.rpc = null;
      await rpc.kill().catch(() => undefined);
      throw error;
    }
  }

  /** A named `authMethod` from config.yml is the only sign-in awui ever starts; the agent keeps any secret. */
  private async authenticate(rpc: AcpClient, probe: AcpProbe): Promise<void> {
    const method = this.adapter.authMethod;
    if (!method) return;
    if (!probe.authMethods.includes(method)) {
      const offered = probe.authMethods.length > 0 ? probe.authMethods.join(", ") : "none";
      throw new Error(`${this.adapter.displayName} does not offer the auth method "${method}" (offered: ${offered})`);
    }
    await rpc.request("authenticate", { methodId: method }, READY_TIMEOUT_MS);
  }

  private applySession(result: Obj, sessionId: string): string {
    if (!sessionId) throw new Error(`${this.adapter.displayName} did not name a session`);
    this.sessionId = sessionId;
    this.applyOptions(result.configOptions);
    // ACP may report the session's title metadata for a loaded session.
    const info = isObj(result.sessionInfo) ? result.sessionInfo : {};
    if (str(info.title)) this.emit({ type: "title", title: oneLine(str(info.title), 200) });
    return sessionId;
  }

  private applyOptions(raw: unknown): void {
    this.options = optionsFrom(raw);
    const model = modelOption(this.options);
    this.models =
      model?.choices.map((choice) => ({
        key: choice.value,
        provider: this.adapter.id,
        id: choice.value,
        name: choice.name,
      })) ?? [];
    this.model = model?.currentValue || null;
    this.level = effortOption(this.options)?.currentValue || null;
    // A model pill appears only once an agent says it lists models: the capability follows the session.
    this.adapter.rememberCatalog(this.models, (effortOption(this.options)?.choices ?? []).map((choice) => choice.value));
  }

  private getConfigNow(): ChatConfig {
    return { model: this.model, thinkingLevel: this.level, models: this.models, thinkingLevels: effortOption(this.options)?.choices.map((choice) => choice.value) ?? [] };
  }

  // ---- the child's frames -------------------------------------------------------

  private onFrame(frame: Obj): void {
    const method = typeof frame.method === "string" ? frame.method : null;
    if (method === null) return;
    if (method === "session/update") {
      const update = isObj(frame.params) ? frame.params.update : undefined;
      if (!isObj(update)) return;
      if (this.accepting) this.onUpdate(update);
      else if (this.replayed.length < 20_000) this.replayed.push(foldAcpUpdate(update, Date.now()));
      return;
    }
    if (method === "session/request_permission") {
      this.onPermission(frame);
      return;
    }
    if (frame.id !== undefined) {
      // An unanswered request leaves the agent waiting forever.
      this.rpc?.respondError(frame.id, -32601, `awui does not implement ${method}`);
    }
  }

  private onUpdate(update: Obj): void {
    const fold = foldAcpUpdate(update, Date.now());
    switch (fold.type) {
      case "user":
        // awui paints the prompt when it writes the request; the agent's echo would double it.
        return;
      case "delta": {
        if (!this.assistantOpen) {
          this.assistantOpen = true;
          this.emit({ type: "assistant_start", ...(this.model ? { model: this.model } : {}) });
        }
        this.emit({ type: "assistant_delta", field: fold.field, delta: fold.delta });
        return;
      }
      case "tool_start": {
        // The tool call closes the text bubble; later words start a new one.
        this.assistantOpen = false;
        this.openTools.add(fold.toolCallId);
        this.toolInfo.set(fold.toolCallId, { name: fold.name, args: fold.args });
        this.emit({ type: "tool_start", toolCallId: fold.toolCallId, name: fold.name, args: fold.args });
        return;
      }
      case "tool_update":
        this.emit({ type: "tool_update", toolCallId: fold.toolCallId, output: boundText(fold.output).text });
        return;
      case "tool_end": {
        this.openTools.delete(fold.toolCallId);
        this.toolInfo.delete(fold.toolCallId);
        this.emit({ type: "tool_end", toolCallId: fold.toolCallId, output: boundText(fold.output).text, isError: fold.isError, ...(fold.details ? { details: fold.details } : {}) });
        return;
      }
      case "context":
        this.contextUsage = { used: fold.used, size: fold.size };
        return;
      case "config":
        if (Array.isArray(fold.options)) {
          this.applyOptions(fold.options);
          this.emitConfig();
        }
        return;
      case "commands":
        this.commands = fold.commands;
        return;
      case "title":
        this.emit({ type: "title", title: fold.title });
        return;
      case "notice":
        this.emit({ type: "notice", level: "info", text: fold.text });
        return;
      case "unknown": {
        if (this.unknownKinds.size >= MAX_UNKNOWN_NOTES || this.unknownKinds.has(fold.kind)) return;
        this.unknownKinds.add(fold.kind);
        this.emit({ type: "notice", level: "info", text: `${this.adapter.displayName} sent an update awui does not draw yet: ${oneLine(fold.kind, 60)}` });
        return;
      }
      default:
        return;
    }
  }

  // ---- permissions --------------------------------------------------------------

  private onPermission(frame: Obj): void {
    const rpc = this.rpc;
    const id = frame.id;
    if (!rpc || id === undefined || id === null) return;
    const params = isObj(frame.params) ? frame.params : {};
    const toolCall = isObj(params.toolCall) ? params.toolCall : {};
    const callId = str(toolCall.toolCallId);
    const options = (Array.isArray(params.options) ? params.options : [])
      .filter(isObj)
      .slice(0, MAX_PERMISSION_OPTIONS)
      .map((option) => ({ optionId: str(option.optionId), name: oneLine(str(option.name) || str(option.optionId), MAX_PERMISSION_TEXT) }))
      .filter((option) => option.optionId);
    const requestId = `perm:${String(id)}`;
    if (options.length === 0) {
      // Nothing to pick from: the agent's own refusal is the only honest answer.
      rpc.respond(id, { outcome: { outcome: "cancelled" } });
      return;
    }
    this.permissionOptions.set(requestId, options.map((option) => option.name));
    const known = callId ? this.toolInfo.get(callId) : undefined;
    const request: InteractionRequest = {
      id: requestId,
      kind: "select",
      // An agent's own wording, bounded: a card is drawn from it, and the id it answers with is
      // the option's, not this name.
      title: oneLine(str(toolCall.title) || known?.name || "Allow this?", MAX_PERMISSION_TEXT),
      message: inputLine(known?.args ?? toolCall.rawInput),
      // The agent's own words for its options; awui never renames them Approve/Deny.
      options: options.map((option) => option.name),
      createdAt: Date.now(),
    };
    void this.dialogs.open(request).then((answer) => {
      this.permissionOptions.delete(requestId);
      const name = answer && answer.kind === "select" ? answer.value : null;
      const chosen = name === null ? undefined : options.find((option) => option.name === name);
      if (chosen) rpc.respond(id, { outcome: { outcome: "selected", optionId: chosen.optionId } });
      else rpc.respond(id, { outcome: { outcome: "cancelled" } });
    });
  }

  // ---- LiveChat -----------------------------------------------------------------

  subscribe(listener: HarnessEventListener): () => void {
    return this.hub.subscribe(listener);
  }

  async history(): Promise<ChatItem[]> {
    // Only a session/load replay is history this client can see: an agent that
    // keeps its transcript to itself (and replays nothing) shows none.
    return itemsFromAcpFolds(this.replayed);
  }

  async getConfig(): Promise<ChatConfig> {
    return this.getConfigNow();
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    const reported = this.contextUsage;
    if (!reported || reported.size <= 0) return null;
    return { tokens: reported.used, window: reported.size, percent: Math.round((100 * reported.used) / reported.size) };
  }

  async getUsage(): Promise<null> {
    // ACP reports occupancy and, optionally, a cumulative cost; a per-turn token
    // split is not something an ACP agent says, so no figure is invented here.
    return null;
  }

  async getTodos(): Promise<TodoItem[]> {
    return [];
  }

  async listCommands(): Promise<SlashCommand[]> {
    return [...this.commands];
  }

  async prompt(text: string, images?: ImageAttachment[]): Promise<void> {
    const rpc = this.live;
    if (images?.length && !this.imageCapable) throw new Error(`${this.adapter.displayName} cannot take images`);
    const blocks: unknown[] = [];
    for (const image of images ?? []) blocks.push({ type: "image", mimeType: image.mimeType, data: image.data });
    blocks.push({ type: "text", text });
    this.turnOpen = true;
    // session/prompt returns when the turn ends, so writing it is the acceptance.
    let result: Promise<Obj>;
    try {
      result = rpc.request<Obj>("session/prompt", { sessionId: this.sessionId, prompt: blocks }, null);
    } catch (error) {
      this.turnOpen = false;
      throw error instanceof Error ? error : new Error(String(error));
    }
    this.promptRpc = result;
    void result.then(
      () => this.completeTurn(),
      (error: unknown) => this.failTurn(error),
    );
    this.emit({ type: "user_message", text, ...(images?.length ? { imageCount: images.length } : {}) });
    this.emit({ type: "busy" });
  }

  private failTurn(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.promptRpc = null;
    // The chat is gone, or this turn was already closed (a late error after Stop).
    if (this.disposed || !this.turnOpen) return;
    this.emit({ type: "notice", level: "error", text: message });
    this.completeTurn();
  }

  /** The prompt RPC's result: one settled per turn, whichever path gets here first. */
  private completeTurn(): void {
    this.promptRpc = null;
    if (!this.turnOpen) return;
    this.turnOpen = false;
    for (const id of [...this.openTools]) this.emit({ type: "tool_end", toolCallId: id, output: "", isError: true });
    this.openTools.clear();
    this.toolInfo.clear();
    this.assistantOpen = false;
    // Empty text: the streamed bubble stays; this only closes the turn.
    this.emit({ type: "assistant_end", text: "", thinking: "" });
    this.emit({ type: "settled" });
  }

  async abort(): Promise<void> {
    const rpc = this.rpc;
    if (!rpc || rpc.exited) return;
    rpc.notify("session/cancel", { sessionId: this.sessionId ?? "" });
    // Every open approval goes back cancelled, on the wire, before the child is torn down.
    this.dialogs.cancelAll();
    if (!this.turnOpen) return;
    const prompt = this.promptRpc;
    const settled = prompt ? await Promise.race([prompt.then(() => true, () => true), delay(ABORT_WAIT_MS).then(() => false)]) : false;
    if (!settled && this.turnOpen) {
      this.emit({ type: "notice", level: "warning", text: `${this.adapter.displayName} is still stopping; the chat is idle.` });
      this.completeTurn();
    }
  }

  async setConfig(patch: ConfigPatch): Promise<void> {
    const rpc = this.live;
    if (patch.model !== undefined) {
      const option = modelOption(this.options);
      const value = option?.choices.find((choice) => choice.value === patch.model);
      if (!option || !value) throw new Error(`${patch.model} is not a model ${this.adapter.displayName} lists`);
      await this.setOption(rpc, option.id, value.value);
    }
    if (patch.thinkingLevel !== undefined) {
      const option = effortOption(this.options);
      const value = option?.choices.find((choice) => choice.value === patch.thinkingLevel);
      if (!option || !value) throw new Error(`${patch.thinkingLevel} is not a reasoning level of ${this.model ?? "this model"}`);
      await this.setOption(rpc, option.id, value.value);
    }
  }

  private async setOption(rpc: AcpClient, configId: string, value: string): Promise<void> {
    const result = await rpc.request<Obj>("session/set_config_option", { sessionId: this.sessionId, configId, value });
    if (isObj(result) && Array.isArray(result.configOptions)) this.applyOptions(result.configOptions);
    else {
      // A build that answers without the option table: keep the values we just set.
      const option = this.options.get(configId);
      if (option) option.currentValue = value;
      if (configId === modelOption(this.options)?.id) this.model = value;
      else if (configId === effortOption(this.options)?.id) this.level = value;
    }
    this.emitConfig();
  }

  async refreshModels(): Promise<void> {
    // ACP has no session-less model call: re-selecting the current model asks the agent for its table again.
    const rpc = this.rpc;
    const option = modelOption(this.options);
    if (!rpc || rpc.exited || !this.sessionId || !option || !this.model) return;
    await this.setOption(rpc, option.id, option.currentValue || this.model);
  }

  async steer(): Promise<void> {
    throw new Error(`${this.adapter.displayName} cannot do that`);
  }

  async followUp(): Promise<void> {
    throw new Error(`${this.adapter.displayName} cannot do that`);
  }

  async rename(): Promise<void> {
    throw new Error(`${this.adapter.displayName} cannot do that`);
  }

  async compact(): Promise<void> {
    throw new Error(`${this.adapter.displayName} cannot do that`);
  }

  answer(requestId: string, answer: InteractionAnswer): boolean {
    if (!this.rpc || this.rpc.exited) return false;
    if (answer.kind === "select") {
      const names = this.permissionOptions.get(requestId);
      if (!names || !names.includes(answer.value)) return false;
    }
    return this.dialogs.answer(requestId, answer);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.dialogs.cancelAll();
    this.hub.clear();
    const rpc = this.rpc;
    this.rpc = null;
    await rpc?.kill().catch(() => undefined);
  }
}

function inputLine(raw: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(raw ?? {});
  } catch {
    text = "";
  }
  return oneLine(text ?? "", 500);
}

/**
 * The tracking key a config.yml agent's children are registered under, unique per entry: two
 * agents may share a free-text `name`, so a display label could not tell their chats apart.
 */
function childKey(agentId: string): string {
  return `acp:${agentId}`;
}

/** One config.yml ACP agent, as a harness awui can open chats on. */
export class AcpAdapter implements HarnessAdapter {
  readonly id: HarnessId;
  readonly displayName: string;
  readonly cliCommand: string;
  /**
   * What the agent itself advertised, and nothing more: resume and images come
   * from `initialize`, model and reasoning selection from the session's config
   * options (so a pill appears once a chat has seen them). No steer or
   * follow-up exists in ACP, and awui never renames, compacts, or rewinds a
   * session it does not store.
   */
  readonly capabilities: HarnessCapabilities = {
    supportsSteer: false,
    supportsFollowUp: false,
    supportsThinkingLevel: false,
    supportsCompact: false,
    supportsExtensions: false,
    supportsInteractiveRequests: true,
    supportsRename: false,
    supportsModelSelection: false,
    supportsFork: false,
    supportsHandoff: false,
    supportsRewind: false,
    // awui's render_html MCP server is mounted on the ACP session when a Node can run it.
    supportsHtmlRender: renderHtmlMcpServer() !== null && nodeForMcpServers() !== null,
    supportsQueueEdit: false,
    // ACP's session modes are the agent's own; they are not approval modes awui may switch.
    supportsPermissionMode: false,
    supportsResumeCommand: false,
    readOnlyHarness: false,
    jobsSurviveRestart: false,
    supportsProjectFolders: true,
    webOnly: false,
  };
  private catalog: ModelInfo[] = [];
  /** The last handshake's verdict, reused for a minute (see discover). */
  private discovered: { at: number; result: HarnessDiscovery } | null = null;

  constructor(
    private readonly agent: AcpAgentConfig,
    private readonly options: AcpOptions,
  ) {
    this.id = asHarnessId(agent.id);
    this.displayName = agent.name || agent.id;
    this.cliCommand = agent.command;
  }

  get authMethod(): string | null {
    return this.agent.authMethod;
  }

  get childArgs(): string[] {
    return this.agent.args;
  }

  /** What this entry's children are tracked under: its id, never the display name. */
  get childKey(): string {
    return childKey(this.agent.id);
  }

  /** The child's environment: the user's own (so the agent's login applies), plus this entry's variables. */
  childEnv(): NodeJS.ProcessEnv {
    return { ...(this.options.env ?? process.env), ...this.agent.env };
  }


  /**
   * The MCP servers a chat's ACP session mounts: awui's render_html as a stdio
   * child when a Node can run it, and the orchestration tools — over HTTP when
   * the agent advertises `mcpCapabilities.http`, else as the stdio bridge.
   */
  mcpServers(toolEnv: NodeJS.ProcessEnv | undefined, http = true): unknown[] {
    const servers: unknown[] = [];
    const node = nodeForMcpServers();
    const render = renderHtmlMcpServer();
    if (node && render && toolEnv?.AWUI_RENDER_URL && toolEnv.AWUI_RENDER_TOKEN) {
      servers.push({
        name: HTML_RENDER_MCP_SERVER,
        command: node,
        args: [render],
        env: [
          { name: "AWUI_RENDER_URL", value: toolEnv.AWUI_RENDER_URL },
          { name: "AWUI_RENDER_TOKEN", value: toolEnv.AWUI_RENDER_TOKEN },
        ],
      });
    }
    if (toolEnv?.AWUI_ORCH_URL && toolEnv.AWUI_ORCH_TOKEN) {
      if (http) {
        // ACP carries headers as name/value entries and expands nothing, so the token rides in the session's params.
        servers.push({
          name: ORCH_MCP_SERVER,
          type: "http",
          url: `${toolEnv.AWUI_ORCH_URL}/mcp`,
          headers: [{ name: "Authorization", value: `Bearer ${toolEnv.AWUI_ORCH_TOKEN}` }],
        });
      } else {
        const orchestrate = orchestrateMcpServer();
        if (node && orchestrate) {
          servers.push({
            name: ORCH_MCP_SERVER,
            command: node,
            args: [orchestrate],
            env: [
              { name: "AWUI_ORCH_URL", value: toolEnv.AWUI_ORCH_URL },
              { name: "AWUI_ORCH_TOKEN", value: toolEnv.AWUI_ORCH_TOKEN },
            ],
          });
        }
      }
    }
    return servers;
  }

  /** The last `initialize` reply, for the Settings dialog's Test button. */

/** A live chat's session listed models and reasoning levels: the pills appear, and the start screen can offer them. */
  rememberCatalog(models: ModelInfo[], levels: string[]): void {
    if (models.length > 0) {
      this.capabilities.supportsModelSelection = true;
      this.catalog = models;
    }
    if (levels.length > 0) this.capabilities.supportsThinkingLevel = true;
  }

  /**
   * One handshake, no model call: whether the configured command actually speaks
   * ACP, what it calls itself, what it advertises, and which sign-in methods it
   * offers. The Settings dialog's Test uses this, and so does discovery.
   */
  async probeAgent(cwd: string): Promise<{ probe: AcpProbe; warnings: string[] }> {
    const rpc = new AcpClient({ key: this.childKey, label: this.displayName, command: this.cliCommand, args: this.childArgs, env: this.childEnv(), cwd, onFrame: () => undefined, errorText });
    try {
      const init = await rpc.request<Obj>("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "awui", version: CLIENT_VERSION } }, READY_TIMEOUT_MS);
      const probe = probeFrom(init);
      const warnings: string[] = [];
      if (probe.protocolVersion !== null && probe.protocolVersion !== PROTOCOL_VERSION) warnings.push(`It speaks ACP protocol ${probe.protocolVersion}; awui expects ${PROTOCOL_VERSION}.`);
      if (this.agent.authMethod && !probe.authMethods.includes(this.agent.authMethod)) warnings.push(`config.yml names the auth method "${this.agent.authMethod}", which this agent does not offer.`);
      return { probe, warnings };
    } catch (error) {
      // A child that died is described by how it ended, never by its stderr tail: what an agent
      // prints there is the user's command output and may hold a secret, and a Test is answerable
      // without it. A failure that leaves the child running (a JSON-RPC error, a timeout) is the
      // agent's own words, which carry no output of its own.
      const ended = rpc.exitStatus();
      if (ended) throw new Error(`${this.displayName} exited before it answered the initialize handshake (${ended.signal ? `signal ${ended.signal}` : `exit code ${ended.code}`})`);
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      await rpc.kill().catch(() => undefined);
    }
  }

  /**
   * A handshake is a whole agent process, so the verdict is reused for a minute:
   * every page load asks the registry again, and an ACP agent may boot its own
   * model list and MCP servers before it answers. The Settings Test asks
   * `probeAgent` directly, so it is never cached.
   */
  async discover(): Promise<HarnessDiscovery> {
    const overrides = {} as Record<string, "set" | "unset">;
    if (this.discovered && Date.now() - this.discovered.at < DISCOVERY_CACHE_MS) return this.discovered.result;
    let result: HarnessDiscovery;
    try {
      const { probe, warnings } = await this.probeAgent(this.options.home);
      result = {
        available: true,
        ...(probe.version ? { version: probe.version } : {}),
        ...(probe.agentName && probe.version ? { versionDetail: `${probe.agentName} ${probe.version}` } : {}),
        warnings,
        overrides,
      };
    } catch {
      // The reason names no path and no stderr: a command line is the user's, and its output may hold a secret.
      result = { available: false, reason: `The ACP agent did not answer initialize. Check its command and arguments under harnesses.acp in config.yml.`, warnings: [], overrides };
    }
    // Only a working agent is cached: a command that failed is asked again at the registry's own throttle, so fixing it shows.
    if (result.available) this.discovered = { at: Date.now(), result };
    return result;
  }

  workspaceProblem(): string | null {
    return null;
  }

  async resolveAgentDir(): Promise<string> {
    return path.join(this.options.stateDir, "acp", this.agent.id);
  }

  async resolveSessionDir(cwd: string): Promise<string> {
    return path.join(await this.resolveAgentDir(), "sessions", encodeURIComponent(path.resolve(cwd)));
  }

  /**
   * ACP has no session-less model call, so the catalog is what live chats have
   * seen. A new workspace's start screen shows no picker until a chat opens;
   * that chat's config event carries the table.
   */
  async listModels(): Promise<ModelInfo[]> {
    return this.catalog;
  }

  async listThinkingLevels(): Promise<string[]> {
    return [];
  }

  async listSessions(): Promise<NativeSessionSummary[]> {
    return [];
  }

  async listRecentSessions(): Promise<RecentNativeSession[]> {
    return [];
  }

  /** ACP lists no stored sessions: usage is not readable without the agent running. */
  async readUsage(): Promise<UsageEntry[] | null> {
    return null;
  }

  async forkSession(): Promise<{ nativeId: string }> {
    throw new Error(`${this.displayName} cannot fork a session`);
  }

  async seedChat(): Promise<LiveChat> {
    throw new Error(`${this.displayName} cannot start from a transcript`);
  }

  async openChat(req: OpenChatRequest): Promise<LiveChat> {
    const chat = new AcpLiveChat(this, req.cwd, req.resumeNativeId ?? null, req.toolEnv);
    await chat.start();
    return chat;
  }

  async shutdown(): Promise<void> {
    await killAcpChildren(this.childKey);
  }
}

/** The ACP children one config.yml entry has open, for tests and shutdown checks. */
export function liveAcpAdapterChildren(agentId: string): number {
  return liveAcpChildren(childKey(agentId));
}
