// Deterministic in-process harness for tests and UI development. It never
// touches the network or a model. Prompt text selects scripted behaviour:
//   "tool"  run a fake tool          "ask"   raise a confirm request first
//   "fail"  end with an error        "slow"  stream many chunks
//   "silent" end with an empty answer (a run with nothing to report)
//   "quietrun" answer "QUIET: …" (a run that says in words that it has nothing to report)
//   "big"   produce oversized tool output    "edit"  edit a file (src/app.ts)
//   "bloat" pad the session to about two thirds of the context window
//   "quiz"  ask a multiple-choice question (omp's style; "quiz described": Claude Code's)
//   "wait"  report a provider wait on the harness's status line for 1.5 s
//   "planned" hand a ten-step plan over for review (an ExitPlanMode call)
//   "ratelimit" stop on a usage limit that resets in an hour
//   "interleaved" reply, run a command, then answer (a reply between tool calls)
//   "afterreply" the answer first, then a tool call after it
//   "unfinished" a call whose result never comes; the run settles with it open
//   "midcompact" compact the context inside the run, then carry on
//   "contended" refuse a prompt because a run is going (pi's "already processing")
//   "ticking" run a command whose output arrives a line at a time
//   "testrun" run a command that prints a Vitest summary with one failing test
//   "bgjob" leave a test suite running in the background (omp's shapes): a wait streams its widget, then it reports done
//   "orphantask" a task job spawns (omp's shapes) and nothing ever reports it: the run settles with it running
//   "orphanshell" a backgrounded shell whose async-result never arrives: its job stays running on the file
//   "e2eprogress" run a Playwright suite whose line reporter prints its progress a test at a time, one failing
//   "manycalls" twelve quick reads in a row (a run long enough to fold)
//   "toolfail" a command call that fails (port in use), then the run carries on
//   "imagecall" a read of a picture, whose result carries an image block
//   "todolist" a rpiv-todo `todo` call whose result carries the whole numbered list (the status stack's source)
//   "widethought" a call, thinking shaped like narration with a code line wider than the column, another call
//   "moaref" a MoA turn's reference advice as Markdown notice folds, and its status line
//   "noticefold" a reply, an extension's notice, then a second reply (a tool-less stretch between replies)
//   "delegate" delegate a task through the real orchestration endpoint, then wait for it (a child chat appears);
//              with "slow" the child runs the slow script, with "askchild" it waits on a question, so a
//              running row can be cancelled, and with "worktree" it works in its own managed checkout and
//              edits a file, so its patch can be reviewed
//   "unsafe" a real write to unsafe-outside.ts in the project root, which a delegated child's write scope refuses
//
// Board rooms drive this adapter through the real server. A Board invocation is
// recognised by the prompt envelope's "## Current request" section, and its
// those words pick the scenario:
//   "consult"       the whole answer is a valid control document for the first permitted consultant
//   "consult-bad"   the same, with trailing prose after the envelope
//   "consult-unknown" targets a handle the room does not have
//   "consult-self"  targets the bot's own handle
//   "consult-dup"   asks the same question twice in one document
//   "consult-slow"  a consultant that streams slowly (Stop and wall-clock tests)
//   "consult-fail"  a consultant whose run fails
//   "consult-ask"   a consultant whose harness raises a confirm request
//   "roomtwice"     a short answer naming the bot, so two addressed bots differ
//   "roomwork"      a thought, a read and a command, then a reply with its own thinking (a run as a chat turn)
//   "usagevary"     different token counts per model, and a null cost for fake/slow
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  asHarnessId,
  type ChatConfig,
  type ChatItem,
  type ConfigPatch,
  type ContextUsage,
  type HarnessCapabilities,
  type ImageAttachment,
  type InteractionAnswer,
  type ModelInfo,
  type PermissionModeInfo,
  type SlashCommand,
  type TodoItem,
} from "../../shared/protocol.js";
import { commandOutputEvents, extensionMessage, forkCutIndex, historyToItems, isObj, piTodos, usageEntries } from "./agent-events.js";
import { rememberImage } from "../image-store.js";
import { jobReports } from "./jobs.js";
import { seedTranscript, toolRecordText, type HandoffSeed } from "./handoff.js";
import type {
  HarnessAdapter,
  HarnessDiscovery,
  HarnessEvent,
  HarnessEventListener,
  HarnessUsage,
  LiveChat,
  NativeSessionSummary,
  OpenChatRequest,
  RecentNativeSession,
  UsageEntry,
} from "./types.js";
import { ENVELOPE_BEGIN as CONSULT_MARKER_BEGIN, ENVELOPE_END as CONSULT_MARKER_END } from "../envelope.js";
import { CONSULT_RESULTS_MARKER } from "../boards/consult.js";

interface FakeCall {
  name: string;
  args: Record<string, unknown>;
  output: string;
  details?: Record<string, unknown>;
  /** The output as it arrives while the call runs, one update per entry (else one "partial output…"). */
  updates?: string[];
  /** The partial result's details with each update (omp's wait streams its jobs this way). */
  updateDetails?: Array<Record<string, unknown>>;
  /** The call failed: its result is an error. */
  isError?: boolean;
  /** Pictures in the result (a read of a screenshot), as Pi-family content blocks send them. */
  images?: Array<{ mimeType: string; data: string }>;
}

/** A 96×64 gradient, base64: what a read of a picture returns, so a row can show one without a file on disk. */
const FAKE_PICTURE =
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAABgElEQVR42u2axU4YYRRGZ+aJkOL2oS1awV36DoXiTgvF3d2l" +
  "r8i9DU0Ii9mwm5zkZJJvezM5OYs/StEPI1X9RpoG0vQz3Rn84AxlaNjI1EiWM5qtMSNH40auJnI1medM5WuqQNMFmil0Zouc" +
  "OemXUazfRonmS7RQqoUy/THKtViupQpn+aOz8kmrRqXWqpz1am0YNdo0arVVq+06Z+ezs/tFe1+d/W/OQb0OjQYdGY06btRJ" +
  "k06adWq06KxF563ORZtz2a4ro0PXRqduunRrdOvO6NF9jx56ncc+5+m7/kZBGARh+P8bMt/MiHPEz4hzxM+Ic8TPiHPETySN" +
  "pN8r6SgIovAfwasv82UiaSSNpJE0JU1JI+kES5reiZ1IGkkjaSRNSVPSSDrBkqZ3YieSRtJIGklT0pQ0kk6wpOmd2ImkkTSS" +
  "RtKUNCWNpBMsaXondiJpJI2kkTQlTUkjad5J806anwVJI2kkTUlT0kiad9K8k2YiaSSNpClpShpJJ2I+A0OQky/bHAHCAAAA" +
  "AElFTkSuQmCC";

const FAKE_MODELS: ModelInfo[] = [
  { key: "fake/echo", provider: "fake", id: "echo", name: "Fake Echo", reasoning: true, vision: true, levels: ["low", "high"] },
  { key: "fake/slow", provider: "fake", id: "slow", name: "Fake Slow", reasoning: false },
  { key: "acme/gpt-5.5", provider: "acme", id: "gpt-5.5", name: "GPT-5.5", reasoning: true, levels: ["minimal", "low", "medium", "high", "xhigh"] },
  { key: "acme/gpt-5.5-mini", provider: "acme", id: "gpt-5.5-mini", name: "GPT-5.5 Mini" },
  { key: "zeta/glm-5.3-flash", provider: "zeta", id: "glm-5.3-flash", name: "GLM-5.3-Flash", reasoning: true, vision: false, levels: ["low", "high", "max"] },
];
const FAKE_THINKING = ["off", "low", "high"];

/** Narration between calls, as a reasoning model writes it: a numbered list, code spans, and a fenced line far wider than any column. */
const WIDE_THOUGHT = [
  "Key findings:",
  "",
  "1. The sound card symlink goes through the **USB interface** `5-1.1:1.1`, not the device. The interface has no `product` / `idVendor`, so `ATTRS{product}` walks up to the parent.",
  "2. udev sets `ID_MODEL=ACCENTUM_Plus`, derived from the USB product string; `ID_MODEL_ENC=ACCENTUM\\x20Plus` is its encoded form.",
  "",
  "```",
  `SUBSYSTEM=="sound", KERNEL=="card*", ENV{ID_USB_MODEL}=="ACCENTUM_Plus", RUN+="${"/run/current-system/sw/bin/amixer -c %n sset PCM 0dB ".repeat(4)}"`,
  "```",
  "",
  "Which is better? Both match by name; combine them for robustness.",
].join("\n");
const FAKE_PERMISSION_MODES: PermissionModeInfo[] = [
  { id: "default", label: "Ask first", description: "Asks before edits and commands" },
  { id: "acceptEdits", label: "Accept edits", description: "Edits files without asking; asks before commands" },
  { id: "bypass", label: "Bypass", description: "Runs everything without asking", caution: true },
];

interface FakeSession {
  nativeId: string;
  cwd: string;
  title: string;
  messages: unknown[];
  updatedAt: Date;
  /** The per-child auth-account slot used for tests of native pin behavior. */
  pinAccount?: (index: number) => Promise<void>;
}

export interface FakeAdapterOptions {
  id?: string;
  displayName?: string;
  /** Delay between streamed chunks. */
  chunkDelayMs?: number;
  /** How long resuming a session takes to "start the harness" (the real ones take 0.4–3 s). */
  resumeDelayMs?: number;
  /** How long a stop takes to bite while a run is going: a harness that refuses to stop promptly. */
  stopDelayMs?: number;
  capabilities?: Partial<HarnessCapabilities>;
}

class Aborted extends Error {}

/** The board envelope's current-request section, or null for an ordinary chat prompt. */
function boardTask(text: string): string | null {
  const marker = "## Current request\n";
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const rest = text.slice(at + marker.length);
  const end = rest.indexOf("\n\n## ");
  return (end >= 0 ? rest.slice(0, end) : rest).trim();
}

/** The fields the board envelope carries for this bot. */
function boardIdentity(text: string): { name: string; handle: string; permitted: string[] } {
  const name = /^Name: (.+)$/m.exec(text)?.[1]?.trim() ?? "Fake";
  const handle = /^Handle: (.+)$/m.exec(text)?.[1]?.trim() ?? "fake";
  const permitted = [...text.matchAll(/^- @([A-Za-z0-9_-]+) \(/gm)].map((match) => match[1] ?? "").filter((value) => value.length > 0);
  return { name, handle, permitted };
}

export class FakeAdapter implements HarnessAdapter {
  readonly id;
  readonly displayName;
  readonly cliCommand = "fake";
  readonly capabilities: HarnessCapabilities;
  readonly sessions = new Map<string, FakeSession>();
  private readonly chunkDelayMs: number;
  private readonly resumeDelayMs: number;
  private readonly stopDelayMs: number;

  constructor(options: FakeAdapterOptions = {}) {
    this.resumeDelayMs = options.resumeDelayMs ?? 0;
    this.stopDelayMs = options.stopDelayMs ?? 0;
    this.id = asHarnessId(options.id ?? "fake");
    this.displayName = options.displayName ?? "Fake";
    this.chunkDelayMs = options.chunkDelayMs ?? 15;
    this.capabilities = {
      supportsSteer: true,
      supportsFollowUp: true,
      supportsThinkingLevel: true,
      supportsCompact: true,
      supportsExtensions: true,
      supportsInteractiveRequests: true,
      supportsRename: true,
      supportsModelSelection: true,
      supportsFork: true,
      supportsHandoff: true,
      supportsRewind: true,
      supportsHtmlRender: true,
      supportsQueueEdit: true,
      supportsPermissionMode: true,
      supportsResumeCommand: true,
      readOnlyHarness: false,
      supportsAccountSelection: false,
      jobsSurviveRestart: false,
      supportsProjectFolders: true,
      webOnly: false,
      ...options.capabilities,
    };
  }

  async discover(): Promise<HarnessDiscovery> {
    return { available: true, version: "fake-1", warnings: [], overrides: {} };
  }

  workspaceProblem(): string | null {
    return null;
  }

  async resolveAgentDir(): Promise<string> {
    return "/nonexistent/fake-agent";
  }

  async resolveSessionDir(cwd: string): Promise<string> {
    return `/nonexistent/fake-sessions${cwd}`;
  }

  async listModels(): Promise<ModelInfo[]> {
    return FAKE_MODELS;
  }

  async listThinkingLevels(): Promise<string[]> {
    return FAKE_THINKING;
  }

  /** A chat starts on the first model and the lowest thinking level, so the start screen names it. */
  async defaultModel(): Promise<{ model: string; thinkingLevel: string | null } | null> {
    return { model: "fake/echo", thinkingLevel: "low" };
  }

  async listSessions(cwd: string): Promise<NativeSessionSummary[]> {
    return [...this.sessions.values()]
      .filter((s) => s.cwd === cwd && s.messages.length > 0)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map((s) => ({
        nativeId: s.nativeId,
        title: s.title,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length,
      }));
  }

  async listRecentSessions(limit: number): Promise<RecentNativeSession[]> {
    return [...this.sessions.values()]
      .filter((s) => s.messages.length > 0)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit)
      .map((s) => ({ nativeId: s.nativeId, cwd: s.cwd, title: s.title, updatedAt: s.updatedAt, messageCount: s.messages.length }));
  }

  /** Copy the messages of the first `throughTurns` user turns into a new in-memory session. */
  async forkSession(req: { cwd: string; nativeId: string; throughTurns: number }): Promise<{ nativeId: string }> {
    const source = this.sessions.get(req.nativeId);
    if (!source || source.cwd !== req.cwd) throw new Error("Unknown session");
    const nativeId = randomUUID();
    this.sessions.set(nativeId, {
      nativeId,
      cwd: source.cwd,
      title: source.title,
      messages: source.messages.slice(0, forkCutIndex(source.messages, req.throughTurns)),
      updatedAt: new Date(),
    });
    return { nativeId };
  }

  /** Fresh in-memory session with the seed's turns recorded as transcript messages. */
  async seedChat(req: { cwd: string; seed: HandoffSeed }): Promise<LiveChat> {
    const session: FakeSession = { nativeId: randomUUID(), cwd: req.cwd, title: req.seed.title ?? "", messages: [], updatedAt: new Date() };
    this.sessions.set(session.nativeId, session);
    const push = (message: Record<string, unknown>) => {
      session.messages.push({ timestamp: Date.now(), ...message });
    };
    for (const entry of seedTranscript(req.seed)) {
      if (entry.role === "user") push({ role: "user", content: entry.text });
      else if (entry.role === "assistant") {
        const content: unknown[] = [];
        if (entry.thinking) content.push({ type: "thinking", thinking: entry.thinking });
        if (entry.text) content.push({ type: "text", text: entry.text });
        push({ role: "assistant", content, stopReason: "stop" });
      } else {
        const id = randomUUID();
        push({ role: "assistant", content: [{ type: "toolCall", id, name: entry.name, arguments: {} }], stopReason: "toolUse" });
        push({ role: "toolResult", toolCallId: id, toolName: entry.name, content: [{ type: "text", text: toolRecordText(entry) }], isError: false });
      }
    }
    return new FakeLiveChat(session, this.chunkDelayMs, this.capabilities.supportsPermissionMode, this.stopDelayMs, undefined, this.capabilities.supportsInteractiveRequests);
  }

  /** Like the file-backed harnesses: each call's usage, from the stored session. */
  async readUsage(req: { cwd: string; nativeId: string }): Promise<UsageEntry[] | null> {
    const session = this.sessions.get(req.nativeId);
    if (!session || session.cwd !== req.cwd) return null;
    return usageEntries(session.messages.map((m) => ({ message: m, at: isObj(m) && typeof m.timestamp === "number" ? m.timestamp : 0 })));
  }

  /** Like the file-backed harnesses: the stored transcript, without "starting" anything. */
  async readTranscript(req: { cwd: string; nativeId: string }): Promise<{ items: ChatItem[]; title: string | null } | null> {
    const session = this.sessions.get(req.nativeId);
    if (!session || session.cwd !== req.cwd) return null;
    return { items: historyToItems(session.messages), title: session.title || null };
  }

  async resumeCommand(req: { cwd: string; nativeId: string }): Promise<string[] | null> {
    const session = this.sessions.get(req.nativeId);
    return session && session.cwd === req.cwd && session.messages.length > 0 ? [this.cliCommand, "--resume", req.nativeId] : null;
  }

  async openChat(req: OpenChatRequest): Promise<LiveChat> {
    let session: FakeSession | undefined;
    if (req.resumeNativeId) {
      if (this.resumeDelayMs > 0) await new Promise((r) => setTimeout(r, this.resumeDelayMs));
      session = this.sessions.get(req.resumeNativeId);
      if (!session || session.cwd !== req.cwd) throw new Error("Unknown session");
    } else {
      session = { nativeId: randomUUID(), cwd: req.cwd, title: "", messages: [], updatedAt: new Date() };
      this.sessions.set(session.nativeId, session);
    }
    return new FakeLiveChat(session, this.chunkDelayMs, this.capabilities.supportsPermissionMode, this.stopDelayMs, req.toolEnv, this.capabilities.supportsInteractiveRequests);
  }

  async shutdown(): Promise<void> {}
}

class FakeLiveChat implements LiveChat {
  private listeners = new Set<HarnessEventListener>();
  private running: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private steering: string[] = [];
  private followUps: string[] = [];
  private pending = new Map<string, (answer: InteractionAnswer | null) => void>();
  private model = "fake/echo";
  private thinkingLevel = "low";
  private permissionMode = "default";
  private disposed = false;

  constructor(
    private readonly session: FakeSession,
    private readonly delayMs: number,
    /** The adapter declares permission modes (fake does, fake-b does not). */
    private readonly modes: boolean,
    /** A stop that waits this long before biting, for the teardown-bound test. */
    private readonly stopDelayMs = 0,
    private readonly toolEnv?: NodeJS.ProcessEnv,
    /** The adapter raises its own permission request before writes (interactive requests). */
    private readonly requests = true,
  ) {}

  get nativeId(): string {
    return this.session.nativeId;
  }

  get title(): string | null {
    return this.session.title || null;
  }

  subscribe(listener: HarnessEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: HarnessEvent): void {
    for (const l of this.listeners) l(event);
  }

  async history(): Promise<ChatItem[]> {
    return historyToItems(this.session.messages);
  }

  /** Tests: a refresh "discovers" one more model. */
  private refreshed = false;

  async refreshModels(): Promise<void> {
    this.refreshed = true;
  }

  async getConfig(): Promise<ChatConfig> {
    return {
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      models: this.refreshed ? [...FAKE_MODELS, { key: "fake/fresh", provider: "fake", id: "fresh", name: "Fake Fresh" }] : FAKE_MODELS,
      thinkingLevels: FAKE_THINKING,
      ...(this.modes ? { permissionMode: this.permissionMode, permissionModes: FAKE_PERMISSION_MODES } : {}),
    };
  }

  /** True when a prompt asked for the "coldcache" scenario: a big session whose prompt cache expired. */
  private get coldCache(): boolean {
    return this.session.messages.some((m) => isObj(m) && m.role === "user" && typeof m.content === "string" && m.content.includes("coldcache"));
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    const categories = [
      { id: "system", label: "System prompt", tokens: 1500 },
      { id: "tools", label: "Tool definitions", tokens: 5200 },
      { id: "messages", label: "Messages", tokens: this.session.messages.length * 850 },
    ];
    // "coldcache": a session as big as the ones the cold-resume hint is for (a Claude model's
    // million-token window), so a browser test can see that hint without waiting out a cache.
    if (this.coldCache) return { tokens: 260_000, window: 1_000_000, percent: 26, categories };
    const tokens = categories.reduce((sum, c) => sum + c.tokens, 0);
    return { tokens, window: 100_000, percent: Math.min(100, (tokens / 100_000) * 100), categories };
  }

  async getUsage(): Promise<HarnessUsage | null> {
    const role = (r: string) => this.session.messages.filter((m) => isObj(m) && m.role === r).length;
    const steps = role("assistant");
    // "coldcache": the prompt cache Claude Code wrote expired half an hour ago.
    if (this.coldCache) {
      const expired = { promptCacheTtlMs: 300_000, promptCacheExpiresAt: Date.now() - 30 * 60_000 };
      return { turns: role("user"), steps, input: steps * 1200, cachedInput: Math.max(0, steps - 1) * 900, cacheWrite: 0, output: steps * 40, cost: null, ...expired };
    }
    // "usagevary" rooms report different counts per model, and one unpriced model, for aggregation and null-cost tests.
    const vary = this.session.messages.some((m) => isObj(m) && m.role === "user" && typeof m.content === "string" && m.content.includes("usagevary"));
    if (vary) {
      return { turns: role("user"), steps, input: steps * 2000, cachedInput: steps * 500, cacheWrite: steps * 100, output: steps * (this.model === "fake/slow" ? 90 : 40), cost: this.model === "fake/slow" ? null : steps * 0.002 };
    }
    return { turns: role("user"), steps, input: steps * 1200, cachedInput: Math.max(0, steps - 1) * 900, cacheWrite: 0, output: steps * 40, cost: null };
  }

  async listCommands(): Promise<SlashCommand[]> {
    return [
      { name: "fake-status", description: "Report the fake harness's status without a model call", source: "builtin" },
      { name: "skill:review", description: "Review the work so far", hint: "[focus]", source: "skill" },
    ];
  }

  async getTodos(): Promise<TodoItem[]> {
    // A scripted `todo` call is read the way Pi's own adapter reads it (its result's details).
    const recorded = piTodos(this.session.messages);
    if (recorded.length > 0) return recorded;
    const wanted = this.session.messages.some((m) => {
      const msg = m as { role?: string; content?: unknown };
      return msg.role === "user" && typeof msg.content === "string" && /\btodo\b/i.test(msg.content);
    });
    if (!wanted) return [];
    return [
      { phase: "Plan", text: "Read the code", status: "completed" },
      { phase: "Plan", text: "Write the fix", status: "in_progress" },
      { phase: "Verify", text: "Run the tests", status: "pending" },
    ];
  }

  /** As Hermes does it: the session drops user turn `turn` and what followed, then runs the new prompt. */
  async rewind(turn: number, text: string, images: ImageAttachment[] = []): Promise<void> {
    let seen = 0;
    const cut = this.session.messages.findIndex((m) => (m as { role?: unknown }).role === "user" && ++seen === turn);
    if (cut < 0) throw new Error("That message is no longer in the session");
    this.session.messages.splice(cut);
    return this.prompt(text, images);
  }

  async prompt(text: string, images: ImageAttachment[] = []): Promise<void> {
    if (this.disposed) throw new Error("Chat is closed");
    // Like omp's builtins: runs locally, answers with output, no model turn.
    if (text.trim() === "/fake-status") {
      for (const event of commandOutputEvents("/fake-status", "fake status: all good")) this.emit(event);
      this.emit({ type: "settled" });
      return;
    }
    // pi's own refusal while a run is going, verbatim: the run carries on, so this says so.
    if (/\bcontended\b/i.test(text)) {
      this.emit({ type: "busy" });
      throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
    }
    if (this.running) throw new Error("Agent is busy");
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.emit({ type: "busy" });
    this.running = this.run(text, signal, images).finally(() => {
      this.running = null;
      this.emit({ type: "settled" });
    });
  }

  private emitQueue(): void {
    this.emit({ type: "queue", queue: { steering: [...this.steering], followUp: [...this.followUps] } });
  }

  async steer(text: string): Promise<void> {
    if (!this.running) throw new Error("Nothing to steer");
    this.steering.push(text);
    this.emitQueue();
  }

  async followUp(text: string): Promise<void> {
    if (!this.running) throw new Error("Nothing to follow");
    this.followUps.push(text);
    this.emitQueue();
  }

  async replaceQueue(queue: { steering: string[]; followUp: string[] }): Promise<void> {
    this.steering = [...queue.steering];
    this.followUps = [...queue.followUp];
    this.emitQueue();
  }

  private stopDelayUsed = false;

  async abort(): Promise<void> {
    // The delay belongs to a harness that refuses to stop promptly; a later dispose must not wait again.
    if (this.stopDelayMs > 0 && this.running && !this.stopDelayUsed) {
      this.stopDelayUsed = true;
      await sleep(this.stopDelayMs);
    }
    this.steering = [];
    this.followUps = [];
    this.emitQueue();
    for (const [id, resolve] of this.pending) {
      this.pending.delete(id);
      resolve(null);
      this.emit({ type: "request_cancelled", requestId: id, outcome: "cancelled" });
    }
    this.abortController?.abort();
    await this.running?.catch(() => undefined);
  }

  async setConfig(patch: ConfigPatch): Promise<void> {
    if (this.running && (patch.model !== undefined || patch.thinkingLevel !== undefined)) throw new Error("Agent is busy");
    if (patch.permissionMode !== undefined) {
      if (!this.modes || !FAKE_PERMISSION_MODES.some((m) => m.id === patch.permissionMode)) throw new Error("Unknown permission mode");
      this.permissionMode = patch.permissionMode;
    }
    if (patch.model !== undefined) {
      if (!FAKE_MODELS.some((m) => m.key === patch.model)) throw new Error("Unknown model");
      this.model = patch.model;
    }
    if (patch.thinkingLevel !== undefined) {
      if (!FAKE_THINKING.includes(patch.thinkingLevel)) throw new Error("Unknown thinking level");
      this.thinkingLevel = patch.thinkingLevel;
    }
    this.emit({ type: "config", config: await this.getConfig() });
  }

  async rename(name: string): Promise<void> {
    this.session.title = name;
    this.emit({ type: "title", title: name });
  }

  async compact(): Promise<void> {
    if (this.running) throw new Error("Agent is busy");
    this.emit({ type: "compacting", active: true });
    // A real compaction takes a while. Three chunks (45 ms) is a flicker no one can
    // see or assert; hold it long enough that the status is a state, not a frame.
    await sleep(Math.max(250, this.delayMs * 3));
    this.session.messages = [{ role: "compactionSummary", summary: "fake", tokensBefore: 0 }];
    this.emit({ type: "compacting", active: false });
    this.emit({ type: "notice", level: "info", text: "Compacted conversation" });
  }

  answer(requestId: string, answer: InteractionAnswer): boolean {
    const resolve = this.pending.get(requestId);
    if (!resolve) return false;
    this.pending.delete(requestId);
    resolve(answer);
    return true;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.abort();
    this.listeners.clear();
  }

  // ---- scripted run ------------------------------------------------------

  private async pause(signal: AbortSignal, factor = 1): Promise<void> {
    if (signal.aborted) throw new Aborted();
    await sleep(this.delayMs * factor);
    if (signal.aborted) throw new Aborted();
  }

  private async run(firstText: string, signal: AbortSignal, firstImages: ImageAttachment[]): Promise<void> {
    let text: string | undefined = firstText;
    let images = firstImages;
    while (text !== undefined) {
      await this.turn(text, signal, images);
      images = [];
      text = this.followUps.shift();
      if (text !== undefined) this.emitQueue();
    }
  }

  private async turn(text: string, signal: AbortSignal, attached: ImageAttachment[] = []): Promise<void> {
    const imageCount = attached.length;
    // Kept in the session like Pi keeps them, so a reload shows them again; the live echo, like most harnesses, is a count.
    const images = attached.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
    this.record({ role: "user", content: imageCount ? [{ type: "text", text }, ...images] : text });
    this.emit({ type: "user_message", text, ...(imageCount ? { imageCount } : {}) });
    if (!this.session.title) {
      this.session.title = text.slice(0, 60);
      this.emit({ type: "title", title: this.session.title });
    }
    const task = boardTask(text);
    if (task !== null) {
      await this.boardTurn(task, text, signal);
      return;
    }
    try {
      if (/\bask\b/i.test(text)) {
        // "ask twice" raises two requests at once (stacked approvals).
        const asks = /\btwice\b/i.test(text) ? [this.ask(signal, "bash"), this.ask(signal, "read")] : [this.ask(signal)];
        const approved = (await Promise.all(asks)).every(Boolean);
        if (!approved) {
          this.emit({ type: "notice", level: "warning", text: "Fake tool denied" });
          await this.reply(`Denied: ${text}`, signal);
          return;
        }
      }
      if (/\bwait\b/i.test(text)) {
        // A provider wait, as Hermes reports one: the harness's own status line, then cleared.
        this.emit({ type: "extension_status", key: "fake:status", text: "Provider temporarily unavailable — retrying in 2s (cycle 1/5)" });
        if (signal.aborted) throw new Aborted();
        await sleep(1500);
        this.emit({ type: "extension_status", key: "fake:status", text: null });
      }
      if (/\bbloat\b/i.test(text)) for (let i = 0; i < 70; i++) this.session.messages.push({ role: "custom", content: "filler" });
      if (/\bquiz\b/i.test(text)) {
        const chose = await this.question(signal, /\bdescribed\b/i.test(text));
        await this.reply(`Chose: ${chose}`, signal);
        return;
      }
      if (/\brecall\b/i.test(text)) {
        // A memory extension's recall, as pi-book injects it (a displayed custom message).
        const recall = extensionMessage("book-recall", "<memory>\nYour memory book: notes about the user.\n- prefers tabs over spaces\n</memory>");
        if (recall) this.emit({ type: "notice", level: "info", ...recall });
      }
      if (/\btool\b|\bbig\b|\bask\b/i.test(text)) await this.tool(/\bbig\b/i.test(text) ? "big" : "read", signal);
      if (/\bedit\b/i.test(text)) await this.tool("edit", signal);
      // The delegated child's guard scenario: an out-of-scope write the task's scope refuses,
      // before the run goes on. A capable harness denies it before the tool runs.
      if (/\bunsafe\b/i.test(text)) await this.tool("unsafe", signal);
      if (/\bshowcase\b/i.test(text)) for (const call of this.showcase()) await this.call(call, signal);
      if (/\bsubagents\b/i.test(text)) await this.subagents(signal);
      if (/\bevalagents\b/i.test(text)) await this.evalAgents(signal);
      if (/\binterleaved\b/i.test(text)) {
        // A reply to the user, then a command, then the answer: the reply is not process text.
        await this.reply("this is reply block 1", signal);
        await this.call({ name: "bash", args: { command: "sleep 1" }, output: "" }, signal);
      }
      if (/\bwidethought\b/i.test(text)) {
        // A call, then a step that only thinks, shaped like narration (it still folds as a Thought), then another call.
        await this.call({ name: "bash", args: { command: "ls -l /sys/class/sound/card0" }, output: "card0 -> ../../devices/usb5/5-1.1/5-1.1:1.1/sound/card0" }, signal);
        await this.think(WIDE_THOUGHT, signal);
        await this.call({ name: "bash", args: { command: "udevadm info /sys/class/sound/card0" }, output: "E: ID_MODEL=ACCENTUM_Plus" }, signal);
      }
      if (/\bslowthought\b/i.test(text)) {
        // A thought read out slowly, then a command: the row is open while it streams and folds once the call starts.
        await this.think("Looking for the card's model, then its driver, before running the command.", signal, 8);
        await this.call({ name: "bash", args: { command: "npm run check" }, output: "ok" }, signal);
      }
      if (/\bworkreply\b/i.test(text)) {
        // Work, a reply to the user, then work again: the stretch above the reply folds away as the reply lands.
        // Two calls a side, so each stretch is a card with a header (one call is a row of its own), and the
        // second side's command prints a line at a time, so a test can look while the run goes.
        await this.call({ name: "bash", args: { command: "npm run build" }, output: "built" }, signal);
        await this.call({ name: "read", args: { path: "dist/index.js" }, output: "// built" }, signal);
        await this.reply("The build is fine; now the tests.", signal);
        const lines = Array.from({ length: 6 }, (_, i) => ` \u2713 tests/unit/case-${i + 1}.test.ts`);
        await this.call(
          { name: "bash", args: { command: "npm test" }, output: lines.join("\n"), updates: lines.map((_, i) => lines.slice(0, i + 1).join("\n")) },
          signal,
        );
        await this.call({ name: "read", args: { path: "test-results/last.txt" }, output: "all good" }, signal);
      }
      if (/\bmoaref\b/i.test(text)) {
        // A MoA turn's reference advice: each is a notice whose detail is Markdown, with the fan-out on the status line.
        this.emit({ type: "extension_status", key: "fake:status", text: "MoA · 1/2 references done" });
        this.emit({ type: "notice", level: "info", title: "MoA · opencode-go:glm-5.3-flash (1/2)", text: "MoA reference advice from opencode-go:glm-5.3-flash", detail: "## Advice one\n\nUse `cache` for repeats.", detailFormat: "markdown" });
        this.emit({ type: "notice", level: "info", title: "MoA · opencode-go:deepseek-v4.1-flash (2/2)", text: "MoA reference advice from opencode-go:deepseek-v4.1-flash", detail: "- fast\n- cheap", detailFormat: "markdown" });
        this.emit({ type: "extension_status", key: "fake:status", text: null });
      }
      if (/\bnoticefold\b/i.test(text)) {
        // Work, a reply, an extension's notice (pi's kendex event), then a second reply: the
        // notice's stretch holds no tool, so it draws inline — not a fold card with an empty header.
        await this.call({ name: "bash", args: { command: "sleep 1" }, output: "" }, signal);
        await this.reply("First reply, then the notice.", signal);
        this.emit({ type: "notice", level: "info", title: "Kendex background tasks:event", text: "Background task bg-1 finished.", detail: "Background task bg-1 finished.\nCommand: npm run e2e" });
        await this.reply("Second reply, after the notice.", signal);
      }
      if (/\bafterreply\b/i.test(text)) {
        // The answer, then a tool call after it: that work keeps its place below the reply.
        await this.reply("The answer comes first.\n\nThen the agent keeps working.", signal);
        await this.call({ name: "bash", args: { command: "npm run lint" }, output: "clean" }, signal);
        return;
      }
      if (/\bmidcompact\b/i.test(text)) {
        // A harness that compacts the context inside a run (pi does, when the window fills) and goes on with it.
        this.emit({ type: "compacting", active: true });
        await this.pause(signal, 60);
        this.emit({ type: "compacting", active: false });
        await this.pause(signal, 60);
      }
      if (/\bunfinished\b/i.test(text)) {
        // A call whose result never comes, as a cancelled question leaves it: the run settles with it open.
        this.emit({ type: "tool_start", toolCallId: "unfinished-1", name: "ask_user", args: { questions: [{ id: "q1", prompt: "Tea?" }] } });
        await this.pause(signal);
        this.emit({ type: "settled" });
        return;
      }
      if (/\bticking\b/i.test(text)) {
        // A test run printing a line a file, as a long command does while you watch it.
        const lines = Array.from({ length: 6 }, (_, i) => ` ✓ tests/unit/step-${i + 1}.test.ts`);
        const updates = lines.map((_, i) => lines.slice(0, i + 1).join("\n"));
        await this.call({ name: "bash", args: { command: "npm test" }, output: `${updates[updates.length - 1]}\n\n Tests  6 passed (6)`, updates }, signal);
      }
      if (/\bmanycalls\b/i.test(text)) {
        for (let n = 1; n <= 12; n++) await this.call({ name: "read", args: { path: `src/part-${n}.ts` }, output: `// part ${n}` }, signal);
      }
      if (/\bimagecall\b/i.test(text)) {
        // A read of a picture: Pi's read answers with a text line and an image block.
        await this.call(
          {
            name: "read",
            args: { path: "docs/screenshots/usage.png" },
            output: "Read image file [image/png]",
            images: [{ mimeType: "image/png", data: FAKE_PICTURE }],
          },
          signal,
        );
      }
      if (/\bbgjob\b/i.test(text)) {
        // omp: a backgrounded bash starts the job, a wait streams its widget, and an async-result says how it ended.
        const command = "npm run test:e2e:fast";
        await this.call(
          {
            name: "bash",
            args: { command, i: "Running the e2e suite" },
            output: "Backgrounded as job bg_1; its output is injected into the conversation as a follow-up the moment it finishes.",
            details: { async: { state: "running", jobId: "bg_1", type: "bash" }, timeoutSeconds: 600 },
          },
          signal,
        );
        const widget = (passed: number, failed: number, done: boolean) => ({
          title: "e2e fast · 12 tests",
          stage: done ? `${passed} passed, ${failed} failed` : `[chromium] › tests/e2e/tabs.spec.ts:${passed * 10}:1 › case ${passed + failed + 1}`,
          headline: { text: String(passed), label: "passed" },
          blocks: [
            { kind: "meter", label: "tests done", value: (passed + failed) / 12, text: `${passed + failed}/12`, tone: failed > 0 ? "warning" : "success" },
            { kind: "stat", items: [{ label: "passed", text: String(passed), tone: "success" }, { label: "failed", text: String(failed), tone: failed > 0 ? "error" : "muted" }] },
            { kind: "grid", label: "tests", items: Array.from({ length: passed + failed }, (_, i) => ({ label: String(i + 1), text: i === 2 && failed > 0 ? "✘" : "✓", tone: i === 2 && failed > 0 ? "error" : "success" })) },
          ],
        });
        const job = (passed: number, failed: number, done: boolean) => ({ id: "bg_1", type: "bash", status: done ? "completed" : "running", label: command, intent: "Running the e2e suite", widget: widget(passed, failed, done) });
        const steps: Array<[number, number]> = [
          [1, 0],
          [2, 0],
          [3, 1],
          [6, 1],
          [9, 1],
        ];
        await this.call(
          {
            name: "wait",
            args: { i: "Waiting for the suite" },
            output: "Job bg_1 completed",
            updates: steps.map(([p, f]) => `waiting on 1 job (${p + f}/12)`),
            updateDetails: steps.map(([p, f]) => ({ op: "wait", jobs: [job(p, f, false)] })),
            details: { op: "wait", jobs: [{ ...job(11, 1, true), durationMs: 4200 }] },
          },
          signal,
        );
        const report = { jobs: [{ jobId: "bg_1", type: "bash", status: "completed", label: command, durationMs: 4200 }] };
        this.record({ role: "custom", customType: "async-result", display: false, content: "<system-notice>\nBackground job bg_1 has completed.\n11 passed, 1 failed\n</system-notice>", details: report });
        this.emit({ type: "job_reports", jobs: jobReports("async-result", "11 passed, 1 failed", report) });
      }
      if (/\borphantask\b/i.test(text)) {
        // omp's delegated task spawned and never heard of again (the run settled with it open,
        // as the EsetResearch transcript reads): still "running" at settle, so the UI folds it.
        await this.call(
          {
            name: "task",
            args: { context: "Research the thing", i: "Researching" },
            output: "Spawned agent `EsetResearch` (job `EsetResearch`).",
            details: { async: { state: "running", jobId: "EsetResearch", type: "task" } },
          },
          signal,
        );
        // No wait, no async-result: the run just ends.
      }
      if (/\borphanshell\b/i.test(text)) {
        // A backgrounded shell whose async-result never arrived (the server went away before it fired):
        // the run settles with a `running` shell job on the file, which resume must reconcile.
        await this.call(
          {
            name: "bash",
            args: { command: "sleep 30", i: "Sleeping" },
            output: "Backgrounded as job bg_1",
            details: { async: { state: "running", jobId: "bg_1", type: "bash" } },
          },
          signal,
        );
      }
      if (/\be2eprogress\b/i.test(text)) {
        // Playwright's line reporter: the total up front, then [n/N] as each test starts, a failure numbered as it lands.
        const lines = ["Running 8 tests using 1 worker", ""];
        const updates: string[] = [];
        for (let n = 1; n <= 8; n++) {
          lines.push(`[${n}/8] [chromium] › tests/e2e/tabs.spec.ts:${n * 10}:1 › case ${n}`);
          if (n === 4) lines.push("  1) [chromium] › tests/e2e/tabs.spec.ts:30:1 › case 3 ─────");
          updates.push(lines.join("\n"));
        }
        await this.call({ name: "bash", args: { command: "npx playwright test tests/e2e/tabs.spec.ts" }, output: `${lines.join("\n")}\n\n  1 failed\n  7 passed (12.0s)`, updates }, signal);
      }
      if (/\btestrun\b/i.test(text)) {
        // A test run that ends with one failure, as Vitest prints it.
        const output = " RUN  v5.0.3 /work\n\n \u276f tests/unit/sum.test.ts (2 tests | 1 failed) 10ms\n   \u00d7 keeps the order of two lists 7ms\n\n FAIL  tests/unit/sum.test.ts > keeps the order of two lists\nAssertionError: expected [ 1, 2 ] to deeply equal [ 2, 1 ]\n\n Test Files  1 failed (1)\n      Tests  1 failed | 1 passed (2)\n   Duration  220ms";
        await this.call({ name: "bash", args: { command: "npm test" }, output }, signal);
      }
      if (/\btoolfail\b/i.test(text)) {
        await this.call({ name: "bash", args: { command: "npm run e2e" }, output: "Error: port 4791 is already in use\n    at Server.setupListenHandle", isError: true, details: { exit: 1 } }, signal);
      }
      if (/\btodolist\b/i.test(text)) {
        // rpiv-todo (`todo`): one action on a numbered list, whose result carries the whole list again.
        const tasks = [
          { id: 1, subject: "Read the tool card", status: "completed" },
          { id: 2, subject: "Draw the reason inline", status: "in_progress" },
          { id: 3, subject: "Run the suite", status: "pending" },
        ];
        await this.call(
          {
            name: "todo",
            args: { action: "update", id: 2, status: "in_progress" },
            output: "Updated #2 (pending → in_progress)",
            details: { action: "update", params: { action: "update", id: 2, status: "in_progress" }, tasks, nextId: 4 },
          },
          signal,
        );
      }
      if (/\bplanned\b/i.test(text)) {
        // A plan handed over for review, as Claude Code's ExitPlanMode does it.
        const plan = "## Plan\n\n1. Read `src/app.ts`\n2. Split the handler\n3. Add a test\n4. Run the suite\n5. Update the README\n6. Check the build\n7. Tidy the imports\n8. Write the commit\n9. Push it\n10. Tell the user";
        await this.call({ name: "ExitPlanMode", args: { plan }, output: "User has approved your plan." }, signal);
      }
      if (/\brender\b|\bhtmlrender\b/i.test(text)) await this.render(signal);
      // The same page through omp's `write xd://render_html` device, whose result keeps
      // the tool's text only: the reference rides that text's last line instead of details.
      if (/\bxdrender\b/i.test(text)) await this.render(signal, true);
      if (/\bdelegate\b/i.test(text)) await this.delegate(signal, text);
      if (/\bratelimit\b/i.test(text)) {
        // A stop on a usage limit, worded as Claude Code words it (the reset as an epoch after "|").
        const error = `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 3600}`;
        this.emit({ type: "assistant_start", model: this.model });
        await this.pause(signal);
        this.record({ role: "assistant", content: [], stopReason: "error", errorMessage: error });
        this.emit({ type: "assistant_end", text: "", thinking: "", error });
        return;
      }
      if (/\bsilent\b/i.test(text)) {
        // A run that ends with no answer at all: what a quiet routine's chat settles with.
        this.emit({ type: "assistant_start", model: this.model });
        await this.pause(signal);
        this.record({ role: "assistant", content: [] });
        this.emit({ type: "assistant_end", text: "", thinking: "" });
        return;
      }
      if (/\bquietrun\b/i.test(text)) {
        await this.reply("QUIET: nothing needed today.", signal);
        return;
      }
      if (/\bfail\b/i.test(text)) {
        this.emit({ type: "assistant_start", model: this.model });
        await this.pause(signal);
        this.record({ role: "assistant", content: [], stopReason: "error", errorMessage: "Fake failure" });
        this.emit({ type: "assistant_end", text: "", thinking: "", error: "Fake failure" });
        return;
      }
      await this.reply(`Echo: ${text}`, signal, /\bslow\b/i.test(text) ? 60 : 1);
      while (this.steering.length > 0) {
        const steer = this.steering.shift() as string;
        this.emitQueue();
        this.record({ role: "user", content: steer });
        this.emit({ type: "user_message", text: steer });
        await this.reply(`Steered: ${steer}`, signal);
      }
    } catch (error) {
      if (!(error instanceof Aborted)) throw error;
      this.record({ role: "assistant", content: [], stopReason: "aborted" });
      this.emit({ type: "assistant_end", text: this.partial, thinking: "", error: "Stopped" });
    }
  }

  /** Board scenarios: the words live in the envelope's current-request section, never in the charter. */
  private async boardTurn(task: string, envelope: string, signal: AbortSignal): Promise<void> {
    const { name, handle, permitted } = boardIdentity(envelope);
    if (/\broomwork\b/i.test(task)) {
      // A run with work before its reply, so a room shows the chat's fold over the answer.
      await this.think(`Looking at what ${name} was asked before answering.`, signal);
      await this.call({ name: "read", args: { path: "README.md" }, output: "# Fake README\nhello" }, signal);
      await this.call({ name: "bash", args: { command: "git log --oneline -3" }, output: "a1b2c3d first\nd4e5f6a second\n0a1b2c3 third" }, signal);
      await this.reply(`${name} (@${handle}) read the README and the last three commits; nothing blocks the plan.`, signal);
      return;
    }
    if (/\broomtwice\b/i.test(task)) {
      await this.say(`Answer from ${name} (@${handle}) about: ${task.slice(0, 80)}`, signal);
      return;
    }
    if (/\bslow\b/i.test(task)) {
      // A long, slowly streamed answer, so tests can act while the run is live.
      await this.say(`Echo from ${name}: ${task}\n${"x".repeat(400)}`, signal, true);
      return;
    }
    if (task === "ask" || /^ask\b/i.test(task)) {
      // The ordinary approval scenario, inside a room: only the user can answer it.
      const approved = await this.ask(signal);
      await this.say(approved ? "Approved path." : "Denied path.", signal);
      return;
    }
    if (!/\bconsult/.test(task)) {
      // usagevary and every plain Board request: a short, distinguishable answer.
      await this.say(`Echo from ${name}: ${task.slice(0, 200)}`, signal);
      return;
    }
    const consultant = envelope.includes("## Consultations") && !envelope.includes(CONSULT_RESULTS_MARKER);
    if (consultant) {
      if (/consult-fail/i.test(task)) {
        this.emit({ type: "assistant_start", model: this.model });
        await this.pause(signal);
        this.record({ role: "assistant", content: [], stopReason: "error", errorMessage: "Fake consultant failure" });
        this.emit({ type: "assistant_end", text: "", thinking: "", error: "Fake consultant failure" });
        return;
      }
      if (/consult-ask/i.test(task)) {
        const approved = await this.ask(signal);
        await this.say(`Consultant answer (${approved ? "approved" : "denied"}): ${task.slice(0, 120)}`, signal);
        return;
      }
      await this.say(`Consultant answer from ${name}: ${task.slice(0, 200)}`, signal, /consult-slow/i.test(task));
      return;
    }
    if (envelope.includes(CONSULT_RESULTS_MARKER)) {
      await this.say(`Final answer after consultations: ${task.slice(0, 200)}`, signal);
      return;
    }
    const to = permitted[0] ?? "Scout";
    const question = `Please weigh in on: ${task.slice(0, 300)}`;
    const target = /consult-self/i.test(task) ? handle : /consult-unknown/i.test(task) ? "Outsider" : to;
    const requests = /consult-dup/i.test(task) ? [{ to: target, question }, { to: target, question }] : [{ to: target, question }];
    const document = `${CONSULT_MARKER_BEGIN}\n${JSON.stringify({ version: 1, action: "consult", requests }, null, 2)}\n${CONSULT_MARKER_END}`;
    await this.say(/consult-bad/i.test(task) ? `${document}\n\nHope that helps!` : document, signal);
  }

  /** A reply whose text is exactly what the scenario asked for (no thinking, no bullets). */
  private async say(text: string, signal: AbortSignal, slow = false): Promise<void> {
    this.partial = "";
    this.emit({ type: "assistant_start", model: this.model });
    const size = slow ? 8 : Math.max(4, Math.ceil(text.length / 6));
    for (const chunk of chunks(text, size)) {
      await this.pause(signal, slow ? 15 : 1);
      this.partial += chunk;
      this.emit({ type: "assistant_delta", field: "text", delta: chunk });
    }
    const usage = { input: 1200, output: Math.ceil(text.length / 4), cacheRead: 0, cacheWrite: 0 };
    const cost = { total: (usage.input + usage.output * 5) / 1_000_000 };
    this.record({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", model: this.model, usage: { ...usage, cost } });
    this.emit({ type: "assistant_end", text, thinking: "", usage });
  }

  private partial = "";

  private async reply(text: string, signal: AbortSignal, repeat = 1): Promise<void> {
    this.partial = "";
    this.emit({ type: "assistant_start", model: this.model });
    const thinking = `Considering: ${text.slice(0, 40)}`;
    for (const chunk of chunks(thinking, 3)) {
      await this.pause(signal);
      this.emit({ type: "assistant_delta", field: "thinking", delta: chunk });
    }
    const body = `${text}\n\n${Array.from({ length: repeat }, (_, i) => `- line ${i + 1} with **markdown**`).join("\n")}`;
    // "slow" streams many small chunks so tests can act while the run is live.
    const size = repeat > 1 ? 24 : Math.max(4, Math.ceil(body.length / 8));
    for (const chunk of chunks(body, size)) {
      await this.pause(signal);
      this.partial += chunk;
      this.emit({ type: "assistant_delta", field: "text", delta: chunk });
    }
    const usage = { input: 1200, output: Math.ceil(body.length / 4), cacheRead: 0, cacheWrite: 0 };
    // Priced as pi-ai prices a call, so usage across sessions has a cost to add up.
    const cost = { total: (usage.input * 1 + usage.output * 5) / 1_000_000 };
    this.record({
      role: "assistant",
      content: [
        { type: "thinking", thinking },
        { type: "text", text: body },
      ],
      stopReason: "stop",
      model: this.model,
      usage: { ...usage, cost },
    });
    this.emit({ type: "assistant_end", text: body, thinking, usage });
  }

  /** A step that only thinks: no text and no call, as a model narrates between its calls. */
  private async think(thinking: string, signal: AbortSignal, factor = 1): Promise<void> {
    this.emit({ type: "assistant_start", model: this.model });
    for (const chunk of chunks(thinking, Math.ceil(thinking.length / 6))) {
      await this.pause(signal, factor);
      this.emit({ type: "assistant_delta", field: "thinking", delta: chunk });
    }
    this.record({ role: "assistant", content: [{ type: "thinking", thinking }], stopReason: "stop", model: this.model });
    this.emit({ type: "assistant_end", text: "", thinking });
  }

  /** A true file write kept beside the tool's deterministic diff scenarios. */
  private async editScenario(): Promise<FakeCall> {
    const file = path.join(this.session.cwd, "src", "app.ts");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const before = await fs.readFile(file, "utf8").catch(() => null);
    // Edit the tracked example without erasing the user's original file content.
    // Fresh worktrees still get a real write so comparison/isolation tests exercise disk, _not_ harness JSON.
    const text = before?.includes("const b = 1;")
      ? before.replace("const b = 1;", "const changed = true;")
      : `${before?.endsWith("\n") ? before : `${before ?? ""}\n`}// Managed by the fake harness's edit command.\nexport const changed = true;\n`;
    await fs.writeFile(file, text);
    return { name: "edit", args: { path: file, oldText: "a", newText: "b" }, output: "Edited src/app.ts (+1 -1)" };
  }

  /**
   * An out-of-scope write a delegated child's guard would refuse: the harness raises its own
   * write ask first (as it does before any write), then writes `unsafe-outside.ts` in the
   * project root only when approved — so a capable harness's pre-emption denies the ask before
   * the tool runs, and an incapable one's detection sees the landed row.
   */
  private async unsafeScenario(signal: AbortSignal): Promise<FakeCall> {
    const approved = await this.ask(signal, "write");
    if (!approved) return { name: "write", args: { path: "unsafe-outside.ts", content: "outside" }, output: "Write denied outside the scope", isError: true };
    const file = path.join(this.session.cwd, "unsafe-outside.ts");
    await fs.writeFile(file, "// Written by the fake harness's unsafe write command.\nexport const outside = true;\n");
    return { name: "write", args: { path: file, content: "outside" }, output: `Wrote ${file}` };
  }

  private async tool(kind: "read" | "big" | "edit" | "unsafe", signal: AbortSignal): Promise<void> {
    await this.call(
      kind === "edit" ? await this.editScenario() : kind === "unsafe" ? await this.unsafeScenario(signal) : { name: "read", args: { path: "README.md" }, output: kind === "big" ? "x".repeat(200_000) : "# Fake README\nhello" },
      signal,
    );
  }

  /** One call of every kind, as the harnesses send them: for screenshots and the tool-card tests. */
  private showcase(): FakeCall[] {
    const cwd = this.session.cwd;
    return [
      {
        name: "edit",
        args: {
          path: `${cwd}/src/server.ts`,
          edits: [{ oldText: "const port = 3000;\nconst host = \"localhost\";\nlisten(port);", newText: "const port = Number(process.env.PORT ?? 3000);\nconst host = \"localhost\";\nlisten(port, host);\nlog(`listening on ${host}:${port}`);" }],
        },
        output: "Successfully replaced 1 block in src/server.ts.",
        // Pi's own numbered diff, as its edit tool reports it.
        details: { diff: "  9 import { listen, log } from \"./net\";\n 10 \n-11 const port = 3000;\n+11 const port = Number(process.env.PORT ?? 3000);\n 12 const host = \"localhost\";\n-13 listen(port);\n+13 listen(port, host);\n+14 log(`listening on ${host}:${port}`);\n   ...\n 40 export {};", firstChangedLine: 11 },
      },
      { name: "write", args: { path: `${cwd}/notes/todo.md`, content: "# Todo\n\n- [ ] ship the diff view\n- [x] tidy tool cards\n" }, output: "Wrote 4 lines to notes/todo.md" },
      { name: "bash", args: { command: "npm test -- --run tool-diff", timeout: 120 }, output: " ✓ tests/unit/tool-diff.test.ts (5 tests) 12ms\n\n Test Files  1 passed (1)\n      Tests  5 passed (5)" },
      { name: "grep", args: { pattern: "listen\\(", path: "src" }, output: "src/server.ts:13:listen(port, host);\nsrc/net.ts:4:export function listen(port: number, host?: string) {" },
      { name: "read", args: { path: `${cwd}/src/net.ts`, offset: 1, limit: 20 }, output: "1\timport { createServer } from \"node:http\";\n2\t\n3\texport function listen(port: number, host?: string) {\n4\t  createServer().listen(port, host);\n5\t}" },
      { name: "web_fetch", args: { url: "https://example.com/docs/listen" }, output: "Example Domain\nThis domain is for use in illustrative examples in documents." },
      {
        name: "TodoWrite",
        args: {
          todos: [
            { content: "Normalize each harness's diff", status: "completed", activeForm: "Normalizing diffs" },
            { content: "Ship the diff view", status: "in_progress", activeForm: "Shipping the diff view" },
            { content: "Polish the tool cards", status: "pending", activeForm: "Polishing tool cards" },
          ],
        },
        output: "Todos have been modified successfully",
      },
      // omp's and Pi's form: operations on a phased list.
      { name: "todo_write", args: { _i: "Updating progress", ops: [{ op: "done", task: "Normalize each harness's diff" }, { op: "done", task: "Ship the diff view" }] }, output: "Updated" },
      // An MCP-like call: nested arguments and a JSON result, which the tool card draws as trees.
      {
        name: "mcp__tracker__triage_ticket",
        args: { query: "listen", filter: { state: "open", labels: ["bug", "server"] }, limit: 2 },
        output: JSON.stringify({ total: 2, items: [{ id: 41, title: "Listen ignores the host", labels: ["bug"], assignee: null }, { id: 57, title: "Log the port", labels: ["server"], assignee: { login: "sam", site_admin: false } }] }),
      },
    ];
  }

  /**
   * pi-subagents' parallel run, as it reports it: live progress snapshots,
   * then results with each agent's answer and transcript file.
   */
  private async subagents(signal: AbortSignal): Promise<void> {
    const toolCallId = randomUUID();
    const args = {
      tasks: [
        { agent: "scout", task: "Find where the server starts listening.\n\nReport the file and line." },
        { agent: "worker", task: "Summarize the startup path in two sentences." },
      ],
    };
    // Inside the (test) workspace, so it goes when the workspace does.
    const dir = path.join(this.session.cwd, ".awui-fake-subagents");
    await fs.mkdir(dir, { recursive: true });
    const transcript = async (i: number, answer: string, tool: string) => {
      const file = path.join(dir, `${toolCallId}_${i}_transcript.jsonl`);
      const record = (message: object) => JSON.stringify({ version: 1, recordType: "message", agent: args.tasks[i]?.agent, childIndex: i, ts: Date.now(), message });
      const call = { type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: tool } };
      await fs.writeFile(
        file,
        [
          record({ role: "user", content: [{ type: "text", text: `Task: ${args.tasks[i]?.task}` }] }),
          record({ role: "assistant", content: [{ type: "thinking", thinking: "Looking around first." }, call] }),
          record({ role: "toolResult", toolCallId: `c${i}`, toolName: "bash", content: [{ type: "text", text: "src/server.ts:13:listen(port, host);" }], isError: false }),
          record({ role: "assistant", content: [{ type: "text", text: answer }] }),
        ].join("\n"),
      );
      return file;
    };
    const progress = (status0: string, status1: string) => [
      { index: 0, agent: "scout", status: status0, task: "[prompt redacted]", recentTools: [{ tool: "bash", args: "rg -n listen src" }], toolCount: 1, tokens: 1800, durationMs: 1200 },
      // Running, the worker has its own recent command too: whichever agent is running shows an activity line.
      { index: 1, agent: "worker", status: status1, task: "[prompt redacted]", recentTools: status1 === "running" ? [{ tool: "bash", args: "sed -n 1,40p src/server.ts" }] : [], toolCount: status1 === "running" ? 1 : 0, tokens: 0, durationMs: 0 },
    ];
    this.emit({ type: "assistant_start", model: this.model });
    this.record({ role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "subagent", arguments: args }], stopReason: "toolUse" });
    this.emit({ type: "assistant_end", text: "", thinking: "" });
    this.emit({ type: "tool_start", toolCallId, name: "subagent", args });
    await this.pause(signal, 2);
    this.emit({ type: "tool_update", toolCallId, output: "(running...)", details: { mode: "parallel", progress: progress("running", "pending") } });
    await this.pause(signal, 12);
    this.emit({ type: "tool_update", toolCallId, output: "(running...)", details: { mode: "parallel", progress: progress("completed", "running") } });
    await this.pause(signal, 12);
    const answers = ["`src/server.ts:13` calls `listen(port, host)`.", "The server reads its config, then listens on the configured host and port."];
    const results = await Promise.all(
      answers.map(async (answer, i) => ({
        index: i,
        agent: args.tasks[i]?.agent,
        task: "[prompt redacted]",
        exitCode: 0,
        model: this.model,
        finalOutput: answer,
        usage: { input: 2100, output: 240, cacheRead: 0, cacheWrite: 0, cost: 0.0012, turns: 2 },
        toolCalls: [{ text: "$ rg -n listen src", expandedText: "$ rg -n listen src" }],
        transcriptPath: await transcript(i, answer, i === 0 ? "rg -n listen src" : "sed -n 1,40p src/server.ts"),
      })),
    );
    const output = answers.join("\n\n");
    const details = { mode: "parallel", results };
    this.record({ role: "toolResult", toolCallId, toolName: "subagent", content: [{ type: "text", text: output }], isError: false, details });
    this.emit({ type: "tool_end", toolCallId, output, isError: false, details });
  }

  /**
   * omp's eval spawning agents from inside a cell: the call is a code run, and
   * its cells' `statusEvents[]` carry the agents (`op: "agent"`, the label as
   * the id), live and at the end, with each answer under `extractedToolData`.
   */
  private async evalAgents(signal: AbortSignal): Promise<void> {
    const toolCallId = randomUUID();
    const code = 'h1 = agent("Reply with exactly ONE.", label="probe-one")\nh2 = agent("Reply with exactly TWO.", label="probe-two")\nprint(wait([h1, h2], raise_errors=False))';
    const args = { language: "py", code, title: "probe-one / probe-two" };
    const rows = (status0: string, status1: string) => [
      {
        index: 0,
        id: "probe-one",
        agent: "task",
        status: status0,
        task: "Complete assignment thoroughly:\n\nReply with exactly ONE.",
        assignment: "Reply with exactly ONE.",
        recentTools: [{ tool: "bash", args: "sleep 6" }],
        toolCount: 1,
        tokens: 8433,
        cost: 0.0013,
        durationMs: 10074,
        resolvedModel: "opencode-go/deepseek-v4.1-flash:high",
      },
      { index: 0, id: "probe-two", agent: "task", status: status1, task: "Complete assignment thoroughly:\n\nReply with exactly TWO.", assignment: "Reply with exactly TWO.", toolCount: status1 === "running" ? 0 : 2, tokens: status1 === "running" ? 0 : 17864, durationMs: 22945, resolvedModel: "opencode-go/deepseek-v4.1-flash:high" },
    ];
    const details = (statuses: [string, string], output: string) => ({
      language: "python",
      languages: ["python"],
      cells: [{ index: 0, title: "probe-one / probe-two", code, language: "python", output, status: statuses.every((s) => s === "completed") ? "complete" : "running", statusEvents: rows(...statuses) }],
    });
    this.emit({ type: "assistant_start", model: this.model });
    this.record({ role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "eval", arguments: args }], stopReason: "toolUse" });
    this.emit({ type: "assistant_end", text: "", thinking: "" });
    this.emit({ type: "tool_start", toolCallId, name: "eval", args });
    await this.pause(signal, 2);
    this.emit({ type: "tool_update", toolCallId, output: "", details: details(["running", "running"], "") });
    await this.pause(signal, 12);
    this.emit({ type: "tool_update", toolCallId, output: "", details: details(["completed", "running"], "") });
    await this.pause(signal, 12);
    const answers = ["ONE", "TWO"];
    const settled = details(["completed", "completed"], JSON.stringify(answers));
    for (const [i, row] of (settled.cells[0]?.statusEvents ?? []).entries()) Object.assign(row, { extractedToolData: { yield: [{ data: { reply: answers[i] }, status: "success" }] } });
    const output = settled.cells[0]?.output ?? "";
    this.record({ role: "toolResult", toolCallId, toolName: "eval", content: [{ type: "text", text: output }], isError: false, details: settled });
    this.emit({ type: "tool_end", toolCallId, output, isError: false, details: settled });
  }

  private async call(call: FakeCall, signal: AbortSignal): Promise<void> {
    const toolCallId = randomUUID();
    this.emit({ type: "assistant_start", model: this.model });
    this.record({
      role: "assistant",
      content: [{ type: "toolCall", id: toolCallId, name: call.name, arguments: call.args }],
      stopReason: "toolUse",
    });
    this.emit({ type: "assistant_end", text: "", thinking: "" });
    this.emit({ type: "tool_start", toolCallId, name: call.name, args: call.args });
    await this.pause(signal, 2);
    for (const [i, output] of (call.updates ?? ["partial output…"]).entries()) {
      const details = call.updateDetails?.[i];
      this.emit({ type: "tool_update", toolCallId, output, ...(details ? { details } : {}) });
      await this.pause(signal, call.updates ? 10 : 2);
    }
    const details = call.details ? { details: call.details } : {};
    const images = call.images ?? [];
    this.record({
      role: "toolResult",
      toolCallId,
      toolName: call.name,
      content: [{ type: "text", text: call.output }, ...images.map((image) => ({ type: "image", mimeType: image.mimeType, data: image.data }))],
      isError: call.isError ?? false,
      ...details,
    });
    // A picture goes into the image store like any adapter's would; the event carries the reference, never the bytes.
    const refs = images.map((image) => rememberImage(image.mimeType, image.data)).filter((ref) => ref !== null);
    this.emit({ type: "tool_end", toolCallId, output: call.output, isError: call.isError ?? false, ...(refs.length > 0 ? { images: refs } : {}), ...details });
  }

  /**
   * A render_html call that goes through the real endpoint when the chat was
   * given one (AWUI_RENDER_URL/TOKEN): the page is stored and the reference
   * comes back in the result's details, exactly as the pi/omp extension does.
   * Without an endpoint the call still completes, with a noting output.
   */
  private async render(signal: AbortSignal, device = false): Promise<void> {
    const title = "Fake report";
    const html = `<!doctype html><html><head><style>body{font-family:var(--font-sans)}h1{color:var(--accent)}</style></head><body><h1>${title}</h1><p>Rendered by the fake harness.</p></body></html>`;
    const height = 160;
    let output = "Rendered (no endpoint; page not stored)";
    let details: Record<string, unknown> | undefined;
    let page: { id: string; url: string } | null = null;
    const url = this.toolEnv?.AWUI_RENDER_URL;
    const token = this.toolEnv?.AWUI_RENDER_TOKEN;
    if (url && token) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Awui-Render-Token": token },
          body: JSON.stringify({ html, title, height }),
        });
        if (response.ok) {
          page = (await response.json()) as { id: string; url: string };
          output = `Rendered "${title}" into the chat.`;
          details = { htmlRender: { id: page.id, title, height }, url: page.url };
        } else {
          output = `Render refused (HTTP ${response.status})`;
        }
      } catch (error) {
        output = `Render failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (device) {
      const marked = page ? `${output}\nawui-html-render: ${JSON.stringify({ id: page.id, title, height })}` : output;
      await this.call({ name: "write", args: { path: "xd://render_html", content: JSON.stringify({ html, title, height }) }, output: marked }, signal);
      return;
    }
    await this.call({ name: "render_html", args: { html, title, height }, output, ...(details ? { details } : {}) }, signal);
  }

  /**
   * A delegation through the real endpoint when the chat was given one
   * (AWUI_ORCH_URL/TOKEN): delegate_task starts a real child chat on this same
   * fake adapter, and thread_wait reports it — the whole loop the extension and
   * the MCP bridge make, without a model. The child's brief names no scenario
   * word, so it answers a plain echo and finishes; `slow` gives the child the
   * slow script instead, so a panel's own Cancel has a running row to stop.
   */
  private async delegate(signal: AbortSignal, text: string): Promise<void> {
    const url = this.toolEnv?.AWUI_ORCH_URL;
    const token = this.toolEnv?.AWUI_ORCH_TOKEN;
    const orch = async (tool: string, args: Record<string, unknown>): Promise<{ text: string; data: Record<string, unknown> | null; isError: boolean }> => {
      if (!url || !token) return { text: "No orchestration endpoint; nothing was delegated", data: null, isError: true };
      try {
        const response = await fetch(`${url}/call`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Awui-Orch-Token": token },
          body: JSON.stringify({ tool, args }),
          signal,
        });
        const body = (await response.json()) as { ok?: boolean; text?: string; data?: unknown; code?: string; message?: string };
        if (body.ok === true) return { text: body.text ?? "", data: typeof body.data === "object" && body.data !== null ? (body.data as Record<string, unknown>) : null, isError: false };
        return { text: `${body.code ?? `HTTP ${response.status}`}: ${body.message ?? "the call failed"}`, data: null, isError: true };
      } catch (error) {
        return { text: `Orchestration failed: ${error instanceof Error ? error.message : String(error)}`, data: null, isError: true };
      }
    };
    // The parent's own words pick the child's script: `worktree` gives it a managed checkout and an
    // edit to review, `slow` a stream long enough to act on, and `askchild` an approval it waits on
    // (a live row with nothing to finish it but a cancel).
    const slow = /\bslow\b/i.test(text);
    const worktree = /\bworktree\b/i.test(text);
    const ask = /\baskchild\b/i.test(text);
    // A question, not an approval: an approval goes to the person already and leaves the task working.
    const brief = ask ? "quiz about the plan" : slow ? "slow work on the parser" : worktree ? "edit the parser in your own checkout" : "Reply with the word child.";
    const started = await orch("delegate_task", { brief, role: "test", title: "Fake delegated task", ...(worktree ? { isolation: "worktree" } : {}) });
    await this.call(
      { name: "delegate_task", args: { brief, role: "test", title: "Fake delegated task" }, output: started.text, ...(started.isError ? { isError: true } : {}) },
      signal,
    );
    const taskId = typeof started.data?.taskId === "string" ? started.data.taskId : null;
    if (!taskId) return;
    const waited = await orch("thread_wait", { taskIds: [taskId], waitMs: 20_000 });
    await this.call({ name: "thread_wait", args: { taskIds: [taskId], waitMs: 20_000 }, output: waited.text, ...(waited.isError ? { isError: true } : {}) }, signal);
  }

  private ask(signal: AbortSignal, tool = "read"): Promise<boolean> {
    const id = randomUUID();
    // An incapable adapter (fake-b with interactive requests off) asks nothing: a real
    // harness that cannot take a request never blocks on its own ask either.
    if (!this.requests) return Promise.resolve(true);
    return new Promise<boolean>((resolve, reject) => {
      const onAbort = () => {
        if (this.pending.delete(id)) this.emit({ type: "request_cancelled", requestId: id, outcome: "cancelled" });
        reject(new Aborted());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, (answer) => {
        signal.removeEventListener("abort", onAbort);
        if (answer === null) return reject(new Aborted());
        resolve(answer.kind === "confirm" ? answer.confirmed : answer.kind === "select" && answer.value === "Approve");
      });
      this.emit({
        type: "request",
        request: {
          id,
          kind: "confirm",
          title: `Allow tool: ${tool}`,
          message: tool === "bash" ? "npm test -- --watch=false" : tool === "write" ? `The fake agent wants to write unsafe-outside.ts` : "The fake agent wants to read README.md",
          createdAt: Date.now(),
        },
      });
    });
  }

  /** A select request as omp's ask tool sends one, or, `described`, as Claude Code's AskUserQuestion. */
  private question(signal: AbortSignal, described: boolean): Promise<string> {
    const id = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        if (this.pending.delete(id)) this.emit({ type: "request_cancelled", requestId: id, outcome: "cancelled" });
        reject(new Aborted());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, (answer) => {
        signal.removeEventListener("abort", onAbort);
        if (answer === null || answer.kind === "cancel") return reject(new Aborted());
        resolve(answer.kind === "select" || answer.kind === "input" ? answer.value : "?");
      });
      this.emit({
        type: "request",
        request: described
          ? {
              id,
              kind: "select",
              title: "Settings",
              message: "Should the theme and the text size both move into config.yml?",
              options: ["Both shared", "Only text size", "Neither"],
              optionDetails: ["Every device gets the same look.", "The theme stays per device.", "Keep both in each browser."],
              createdAt: Date.now(),
            }
          : {
              id,
              kind: "select",
              title: "Move both theme AND text size into config.yml? (1/2)",
              options: ["Both shared (Recommended)", "Only text size shared, theme stays per-device", "Other (type your own)"],
              createdAt: Date.now(),
            },
      });
    });
  }

  private record(message: Record<string, unknown>): void {
    this.session.messages.push({ timestamp: Date.now(), ...message });
    this.session.updatedAt = new Date();
  }
}

function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
