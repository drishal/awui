// The server-side harness contract. Routes, the chat manager, and tests talk
// only to these types; SDK- or protocol-specific shapes stay inside adapters.
import type {
  BackgroundJob,
  ChatConfig,
  ChatItem,
  ConfigPatch,
  ContextUsage,
  HarnessCapabilities,
  HarnessId,
  ImageAttachment,
  ImageRef,
  InteractionAnswer,
  InteractionRequest,
  LimitAccount,
  ModelInfo,
  QueueState,
  SlashCommand,
  SubagentRun,
  TodoItem,
  OauthAccountChoice,
} from "../../shared/protocol.js";

import type { HandoffSeed } from "./handoff.js";
import type { AgentReport } from "./subagents.js";

export interface HarnessDiscovery {
  available: boolean;
  /** Short and comparable (versionLabel): 1.0.2, 2026.9.24. */
  version?: string;
  /** The CLI's full version line, when it says more. */
  versionDetail?: string;
  reason?: string;
  warnings: string[];
  overrides: Record<string, "set" | "unset">;
}

export interface NativeSessionSummary {
  /** Adapter-native, opaque to everything outside the adapter. */
  nativeId: string;
  title: string;
  updatedAt: Date | null;
  messageCount?: number;
}

/** One model call's tokens, as the provider reported them. */
export interface StepUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Session totals the harness keeps (Pi getSessionStats, omp get_session_stats). */
export interface HarnessUsage {
  turns: number;
  steps: number;
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
  cost: number | null;
  /** How long the provider keeps this session's cached prompt prefix (Claude Code's 5m or 1h), when it says. */
  promptCacheTtlMs?: number;
  /** When that prefix runs out: the last request's time plus the lifetime (epoch ms). */
  promptCacheExpiresAt?: number;
}

export interface RecentNativeSession extends NativeSessionSummary {
  /** The project the session belongs to. */
  cwd: string;
}

/** One model call's tokens, from a session's file. */
export interface UsageEntry {
  /** Epoch ms. */
  at: number;
  model: string | null;
  input: number;
  /** Input read from the provider's cache. */
  cachedInput: number;
  cacheWrite: number;
  output: number;
  /** USD, where the harness priced the call; null where it did not. */
  cost: number | null;
}

/**
 * How a harness's CLI is started, from config.yml's `harnesses:` block: the
 * executable (else its name on PATH) and arguments added to each live chat's
 * command line. A file setting, never the browser's: a command path is a
 * program the server runs.
 */
export interface HarnessLaunch {
  command?: string;
  args?: string[];
}

export interface OpenChatRequest {
  cwd: string;
  /** Native id from this adapter's own listSessions(). */
  resumeNativeId?: string;
  /**
   * Extra environment for the spawned child, one variable pair per tool family:
   * AWUI_RENDER_URL/AWUI_RENDER_TOKEN arm awui's render tool, and
   * AWUI_ORCH_URL/AWUI_ORCH_TOKEN its orchestration tools (extension for
   * Pi/omp, MCP server for Claude). Absent or empty means the tool is not
   * wired for this chat.
   */
  toolEnv?: NodeJS.ProcessEnv;
  /**
   * Spawned for a task another agent delegated (an orchestration child), not by the user: a
   * harness that treats its own subagents differently then does so here too (Claude Code's
   * subagent prompt-cache lifetime).
   */
  delegated?: boolean;
}

/** Normalized events every adapter emits. */
export type HarnessEvent =
  | { type: "user_message"; text: string; imageCount?: number; images?: ImageRef[]; command?: true }
  | { type: "assistant_start"; model?: string }
  | { type: "assistant_delta"; field: "text" | "thinking"; delta: string }
  | { type: "assistant_end"; text: string; thinking: string; error?: string; usage?: StepUsage }
  | { type: "tool_start"; toolCallId: string; name: string; args: unknown }
  | { type: "tool_update"; toolCallId: string; output: string; details?: unknown; /** Leave the call's own output alone. A subagent's report can arrive after that result is already on the row. */ keepOutput?: boolean }
  /** Background subagents reporting back (omp's async-result): which runs finished, and how. */
  | { type: "subagent_reports"; reports: AgentReport[] }
  /** Background jobs reporting in (omp's async-result, Claude's task_notification, bg_task's exit event): every call holding one shows it. */
  | { type: "job_reports"; jobs: BackgroundJob[] }
  | { type: "tool_end"; toolCallId: string; output: string; isError: boolean; /** The result's structured side (Pi/omp `details`, Claude Code's tool_use_result). */ details?: unknown; /** Pictures the result carried (a read of a screenshot), already in the image store. */ images?: ImageRef[] }
  | { type: "busy" }
  | { type: "settled" }
  | { type: "compacting"; active: boolean }
  | { type: "queue"; queue: QueueState }
  | { type: "notice"; level: "info" | "warning" | "error"; text: string; title?: string; detail?: string; /** The detail is Markdown (Hermes's MoA reference advice). */ detailFormat?: "markdown"; /** Say where it belongs instead of guessing from the status (a one-shot command's notice lands before its turn starts). */ ambient?: boolean }
  | { type: "config"; config: Partial<ChatConfig> }
  | { type: "title"; title: string }
  | { type: "session"; nativeId: string }
  | { type: "request"; request: InteractionRequest }
  | { type: "request_cancelled"; requestId: string; outcome: string }
  | { type: "extension_status"; key: string; text: string | null }
  /** The subscription's rate limits, as the harness last heard them (Claude Code's rate_limit_event). */
  | { type: "limits"; account: LimitAccount }
  | { type: "fatal"; message: string };

export type HarnessEventListener = (event: HarnessEvent) => void;

export interface LiveChat {
  /** Known once the harness has assigned a session; stable afterwards. */
  readonly nativeId: string | null;
  readonly title: string | null;
  /** True while the harness behind it is still starting (a resumed chat shown from its file). */
  readonly starting?: boolean;
  subscribe(listener: HarnessEventListener): () => void;
  /** Active branch only, rebuilt through the harness's public API. */
  history(): Promise<ChatItem[]>;
  getConfig(): Promise<ChatConfig>;
  /** Context window occupancy, or null when the harness cannot tell. */
  getContextUsage(): Promise<ContextUsage | null>;
  /** Allowed credential index carried verbatim into native `/session pin`, an action scoped to this attached session. */
  pinAccount?(index: number): Promise<void>;
  /** Session token totals, or null when the harness cannot tell. */
  getUsage(): Promise<HarnessUsage | null>;
  /** The harness's own todo list, if it keeps one. */
  getTodos(): Promise<TodoItem[]>;
  /** The "/" commands this session understands; sending "/name args" as a prompt runs one. */
  listCommands(): Promise<SlashCommand[]>;
  /** Resolves once the harness accepted the prompt; the run streams as events. */
  prompt(text: string, images?: ImageAttachment[]): Promise<void>;
  steer(text: string, images?: ImageAttachment[]): Promise<void>;
  /**
   * Drop user turn `turn` (1-based) and everything after it from the session,
   * then run `text` as the new turn, in this same session. Only harnesses with
   * capabilities.supportsRewind implement it.
   */
  rewind?(turn: number, text: string, images?: ImageAttachment[]): Promise<void>;
  followUp(text: string, images?: ImageAttachment[]): Promise<void>;
  /** Aborts the run, clears queues where supported, resolves when idle. */
  abort(): Promise<void>;
  /**
   * Take back every queued steering and follow-up message and queue these in
   * their place, in order (an edited or removed one). Text only: a queued
   * message's images do not survive. Only harnesses with
   * capabilities.supportsQueueEdit implement it.
   */
  replaceQueue?(queue: QueueState): Promise<void>;
  /** Model and thinking only while idle (Chat checks); a permission mode, on a harness that declares them, at any time. */
  setConfig(patch: ConfigPatch): Promise<void>;
  /** Drop cached models so the next getConfig() sees new ones (local servers, catalogs, config edits). */
  refreshModels(): Promise<void>;
  rename(name: string): Promise<void>;
  compact(instructions?: string): Promise<void>;
  /** Returns false when the request is unknown or already resolved. */
  answer(requestId: string, answer: InteractionAnswer): boolean;
  dispose(): Promise<void>;
}

export interface HarnessAdapter {
  readonly id: HarnessId;
  readonly displayName: string;
  readonly cliCommand: string;
  readonly capabilities: HarnessCapabilities;
  /** Its colour, one of HARNESS_ACCENTS; without one the registry assigns a free one. */
  readonly accent?: string;
  /** What to run in a terminal to log in to a provider, for the "No models" hint; without one the hint names no command. */
  readonly setupCommand?: string | undefined;
  discover(): Promise<HarnessDiscovery>;
  /** Why this harness cannot open the workspace, or null. */
  workspaceProblem(cwd: string): string | null;
  // Server-only path resolution; never serialized to the browser.
  resolveAgentDir(): Promise<string>;
  resolveSessionDir(cwd: string): Promise<string>;
  listModels(cwd: string): Promise<ModelInfo[]>;
  /**
   * Drop what listModels has cached for `cwd`, so the next call asks the harness
   * again (a Refresh after logging into a provider). Only adapters that cache.
   */
  forgetModels?(cwd: string): void;
  listThinkingLevels(cwd: string): Promise<string[]>;
  /**
   * The model and thinking level a fresh chat in `cwd` would start on, so the
   * start screen can name the harness's own default instead of a generic
   * "Default model". Null when the harness does not expose one. Display only;
   * it never overrides an explicit pick.
   */
  defaultModel?(cwd: string): Promise<{ model: string; thinkingLevel: string | null } | null>;
  listSessions(cwd: string): Promise<NativeSessionSummary[]>;
  /** The newest sessions across every project, newest first. */
  listRecentSessions(limit: number): Promise<RecentNativeSession[]>;
  /**
   * Copy the session's conversation through its Nth user turn (1-based) into a
   * new session of the harness's own store, and return the new native id. The
   * copy is listed and resumable like any other session. Callers gate on
   * capabilities.supportsFork.
   */
  forkSession(req: { cwd: string; nativeId: string; throughTurns: number }): Promise<{ nativeId: string }>;
  /**
   * Start a fresh session seeded with a portable transcript (cross-harness
   * handoff). Tool records arrive as plain transcript text, never live tool
   * state; the caller sends any draft as a normal turn afterwards. Returns the live
   * chat directly (unlike forkSession, the session is already open). Callers
   * gate on capabilities.supportsHandoff.
   */
  seedChat(req: { cwd: string; seed: HandoffSeed }): Promise<LiveChat>;
  openChat(req: OpenChatRequest): Promise<LiveChat>;
  /**
   * The session's transcript read straight from its file, without starting
   * the harness, so a resumed chat shows at once while the harness starts
   * behind it. Null when the session is not this project's (or has no file
   * yet). Harnesses whose history lives only behind their process omit it.
   */
  readTranscript?(req: { cwd: string; nativeId: string }): Promise<{ items: ChatItem[]; title: string | null } | null>;
  /**
   * The command (program and arguments, unquoted) that resumes this session
   * in the harness's own CLI when run from its project folder, for
   * capabilities.supportsResumeCommand. Null when nothing is saved to resume
   * yet, or the session is not this project's.
   */
  resumeCommand?(req: { cwd: string; nativeId: string }): Promise<string[] | null>;
  /**
   * Every model call a stored session made, with its tokens (side branches
   * too: what they spent was spent), read without starting the harness; for
   * usage across sessions. Null when the session cannot be read.
   */
  readUsage?(req: { cwd: string; nativeId: string }): Promise<UsageEntry[] | null>;
  usageLimits?(): Promise<LimitAccount[]>;
  /** Stored provider OAuth accounts as opaque provider/index pairs with no identity or token text. */
  accounts?(cwd: string): Promise<OauthAccountChoice[]>;
  /** Read or pin a live child session's own provider credential, e.g. omp's `/session pin`. */
  /**
   * Whether another process of this harness holds the session right now (omp's session
   * lease), so a resume here would make a second writer. False when it cannot tell.
   */
  heldElsewhere?(nativeId: string): Promise<boolean>;
  /** Kill helper processes; called on server shutdown. */
  /** Where a subagent's transcript lives when its result did not say (omp's runs; pi-subagents' background ones), or null. */
  subagentTranscriptFile?(chat: { nativeId: string; cwd: string }, run: SubagentRun): Promise<string | null>;
  /** A subagent's conversation where it lives behind the harness rather than in a file (OpenCode's child sessions), or null. */
  subagentTranscript?(chat: { nativeId: string; cwd: string }, run: SubagentRun): Promise<ChatItem[] | null>;
  shutdown(): Promise<void>;
}
