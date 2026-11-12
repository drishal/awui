// Wire protocol shared by the server and the browser. Nothing in here may
// reference a harness SDK: adapters normalize into these types.
import { z } from "zod";
import type { BreakdownRules } from "./breakdown.js";

export type HarnessId = string & { readonly __brand: "HarnessId" };
export const asHarnessId = (id: string): HarnessId => id as HarnessId;

export interface HarnessCapabilities {
  supportsSteer: boolean;
  supportsFollowUp: boolean;
  supportsThinkingLevel: boolean;
  supportsCompact: boolean;
  supportsExtensions: boolean;
  supportsInteractiveRequests: boolean;
  supportsRename: boolean;
  supportsModelSelection: boolean;
  /** The chat can be branched into a new session at a chosen turn. */
  supportsFork: boolean;
  /** A portable transcript seed can start a fresh session here. */
  supportsHandoff: boolean;
  /** A past prompt can be replaced in place: the session drops it and what followed, then runs the new one (Hermes). */
  supportsRewind: boolean;
  /** The harness was given awui's render tool, so its calls can publish an HTML page into the chat. */
  supportsHtmlRender: boolean;
  /** Queued steering and follow-up messages can be taken back and replaced (edited, removed) before they run. */
  supportsQueueEdit: boolean;
  /** The harness has permission modes (how much it asks before acting), switchable at any time, mid-run too (Claude Code). */
  supportsPermissionMode: boolean;
  /** A saved session can be resumed in the harness's own CLI from a terminal, by a command the server gives ("Copy resume command"). */
  supportsResumeCommand: boolean;
  /** A backgrounded job outlives the harness process that started it (Claude Code's task files). Without this, a job reloaded from a transcript as still running is reconciled to stopped, because the new process no longer holds it. */
  jobsSurviveRestart: boolean;
  /**
   * The harness is a read-only surface by design (awui denies its child the write and exec
   * tools). It never gets the orchestration tools and is never a delegation target: a child
   * handed to it would carry the very tools it exists to deny.
   */
  readOnlyHarness: boolean;
}

export interface HarnessStatus {
  id: HarnessId;
  displayName: string;
  available: boolean;
  /** Short and comparable, for the menu: 1.0.2, 18.6.1, 2026.9.24. */
  version?: string;
  /** The CLI's full version line (the tooltip), when it says more than `version`. */
  versionDetail?: string;
  /** Why the harness is unavailable or degraded. Never contains paths or secrets. */
  reason?: string;
  warnings: string[];
  capabilities: HarnessCapabilities;
  /** Config-dir overrides reported as set/unset only. */
  overrides: Record<string, "set" | "unset">;
  /** The theme colour token (`link`, `thinking`, …) its dot, badge, spinner, and chip use. */
  accent: string;
  /** The terminal command that logs it in to a provider (`opencode auth login`), when it has one. */
  setupCommand?: string;
}

/** Theme colour tokens a harness may take, in the order unclaimed harnesses get them. */
export const HARNESS_ACCENTS = ["link", "thinking", "orange", "rare", "info", "ok"] as const;

export interface WorkspaceInfo {
  id: string;
  path: string;
  name: string;
  /**
   * The project's direnv state: a .envrc in the tree that direnv will not run
   * until allowed (so harness children spawn without it), and its path.
   * Absent means no .envrc or direnv not installed.
   */
  direnv?: { blocked: boolean; rcPath: string | null };
}

export interface DirEntry {
  name: string;
  path: string;
  hidden: boolean;
}

export interface BrowseResult {
  /** null when listing the configured roots themselves. */
  path: string | null;
  parent: string | null;
  entries: DirEntry[];
}

export interface SessionSummary {
  /** Namespaced and opaque, e.g. `pi:<id>`. */
  id: string;
  harnessId: HarnessId;
  title: string;
  updatedAt: string | null;
  messageCount?: number;
  /** Chat id when this session is already open in this process. */
  liveChatId?: string;
  /** That live chat's status, so lists can show which sessions are working. */
  status?: ChatStatus;
  /** Kept at the top of the list (a mark this server keeps, shared by every device). */
  pinned?: true;
  /** Hidden from the list unless archived sessions are shown. */
  archived?: true;
  /** Done for now: out of the projects until a run starts in it again. */
  settled?: true;
  /** Epoch ms: out of the projects until then (or until it needs you). */
  snoozedUntil?: number;
  /** Not seen yet: a dot on the row until it is opened here (a mark this server keeps). */
  unread?: true;
  /** A live chat waiting on an answer or an approval. */
  asking?: true;
  /** Open in a herdr pane (its harness run there, not by this server), and what herdr says it does. */
  herdr?: { paneId: string; status: HerdrStatus };
}

/** A herdr pane's agent: `done` is idle with a finish nobody has looked at yet. */
export type HerdrStatus = "idle" | "done" | "working" | "blocked" | "unknown";

/** A session together with the project it belongs to. */
export interface ProjectSession extends SessionSummary {
  workspaceId: string;
}

/** One isolated workspace managed by awui. */
export interface WorktreeInfo {
  id: string;
  path: string;
  branch: string;
  base: string;
  createdAt: number;
}

/** What a new managed worktree was seeded with, from the project's checked-in `.worktreeinclude`. */
export interface WorktreeSeedReport {
  /** Gitignored files and small folders copied into the new tree. */
  copied: string[];
  /** Large gitignored folders symlinked into the new tree. */
  linked: string[];
  /** Entries the file listed that were not seeded, each with why. */
  skipped: Array<{ path: string; reason: string }>;
  /** Skipped entries past the report's cap that are not listed. */
  more: number;
}

/** One created worktree together with what was seeded into it (the create response only). */
export type WorktreeCreated = WorktreeInfo & { seeded: WorktreeSeedReport };

/** How a race member stands: its chat's live run, or closed once that chat was closed. */
export type RaceMemberStatus = "running" | "settled" | "failed" | "closed";

/** One file's line counts against a race's fork point, as `git diff --numstat` reads them. */
export interface RaceFile {
  /** Relative to the member's worktree. */
  path: string;
  added: number;
  removed: number;
  /** Git counts no lines for a binary file. */
  binary: boolean;
}

/**
 * One agent's chat in a race: its worktree, its branch, and what it changed. The
 * counts, files, uncommitted work and unmerged commits cost git runs, so only the
 * race's own view carries them; the list keeps to the record and the live chats.
 */
export interface RaceMemberView {
  chatId: string;
  harnessId: string;
  model: string | null;
  branch: string;
  /** The worktree's folder name; the project's paths never leave the server. */
  worktree: string;
  startedAt: number;
  status: RaceMemberStatus;
  winner: boolean;
  /** Against the fork point, over its tracked files (committed or not). */
  added?: number;
  removed?: number;
  files?: RaceFile[];
  /** The last answer's opening words (300 characters), when its chat is open. */
  answer?: string | null;
  /** Uncommitted work: cleanup skips it rather than deleting it. */
  dirty?: boolean;
  /** Commits its branch has that the reference branch does not: `git branch -d` would refuse. */
  unmerged?: number;
}

/** One prompt sent to several worktree chats, and where the comparison stands. */
export interface RaceSummary {
  id: string;
  workspaceId: string;
  workspaceName: string;
  prompt: string;
  base: string;
  createdAt: number;
  winnerChatId: string | null;
  /** When a cleanup removed what it could; absent until then. */
  cleanedAt: number | null;
  members: RaceMemberView[];
}

/** Picking a winner: mark it (keep), or also put its changes in the project's working tree (apply). */
export interface RaceWinnerResult {
  race: RaceSummary;
  mode: "keep" | "apply";
  /** Whether the winner's changes are in the project's working tree now. */
  applied: boolean;
  /** What to do next, in words a user can act on. */
  instructions: string;
}

/** What a cleanup did to one member, or why it left it alone. */
export interface RaceCleanupMember {
  chatId: string;
  /** Its worktree is gone. */
  removed: boolean;
  /** Its branch went too. */
  branchRemoved: boolean;
  /**
   * `running`, `uncommitted`, `moved` (its HEAD is no longer on the branch the record names),
   * `unmerged` (its tree has commits the reference lacks, or git cannot count them),
   * `branch_kept`, `worktree_gone`, `worktree_refused`, or `outside_project`.
   */
  reason: string | null;
}

export interface RaceCleanupResult {
  race: RaceSummary;
  results: RaceCleanupMember[];
}

/** One file of a race member's worktree, changed against the fork point. */
export interface RaceFileDiff {
  path: string;
  /** Null when the file has no change against the fork point now. */
  diff: ToolDiff | null;
}

/** A project folder's place in its git repository, for the order of the sidebar's projects. */
export interface Checkout {
  /** Opaque, and the same for every worktree of one repository. */
  repo: string;
  /** The branch checked out; null when HEAD is detached. */
  branch: string | null;
  /** The repository's own working tree, not a linked worktree. */
  primary: boolean;
}

/** The sidebar's list: recent sessions from every project, plus all of the current one's. */
/** A lightweight status change for one native chat. Contains no transcript. */
export interface SessionOverviewEvent {
  type: "session";
  nativeId: string;
  harnessId: string;
  workspaceId: string;
  title: string;
  updatedAt: string | null;
  messageCount?: number;
  liveChatId?: string;
  status?: ChatStatus;
  asking?: true;
  disposed?: true;
}
/** The overview is metadata only. A snapshot asks the client to reload the full ordinary overview. */
export type OverviewEvent =
  | SessionOverviewEvent
  | { type: "room"; room: RoomSummary }
  | { type: "snapshot" };

export interface SessionsOverview {
  /** Every project referenced by `sessions`, and the current project. */
  workspaces: WorkspaceInfo[];
  /** Newest activity first. */
  sessions: ProjectSession[];
  /** One line per harness that could not list its sessions. */
  errors: string[];
  /** Each project's git checkout, by workspace id; projects outside git are absent. */
  checkouts?: Record<string, Checkout>;
  /** Hand-made session orders (the sidebar's drag), by `harnessId:workspaceId`, first to last. */
  orders?: Record<string, string[]>;
}

export type ChatStatus = "starting" | "idle" | "running" | "stopping" | "compacting" | "error" | "disposed";

export interface ModelInfo {
  /** `provider/id`, the value sent back in config patches. */
  key: string;
  provider: string;
  /** The provider's display name, when it says more than the slug (Hermes's virtual `moa` row: "Mixture of Agents"). */
  providerName?: string;
  id: string;
  name: string;
  reasoning?: boolean;
  /** Accepts image input; absent when the harness does not say. */
  vision?: boolean;
  /** Reasoning levels the harness offers for this model, weakest first; "off" is not a level. */
  levels?: string[];
}

/** One of a harness's permission modes. */
export interface PermissionModeInfo {
  /** The harness's own name for it (Claude Code's `acceptEdits`). */
  id: string;
  label: string;
  /** What the agent does without asking in this mode, in a line. */
  description: string;
  /** Nothing is asked or checked in this mode: clients mark it while it is on. */
  caution?: boolean;
}

export interface ChatConfig {
  model: string | null;
  thinkingLevel: string | null;
  models: ModelInfo[];
  thinkingLevels: string[];
  /** What the harness actually sends for thinkingLevel when its route clamps it (Hermes's "ultra" sends "max"); absent or null when it sends the level as named. */
  thinkingSent?: string | null;
  /** The permission mode in force; absent when the harness has none (supportsPermissionMode). */
  permissionMode?: string | null;
  /** The modes it can switch to, in the harness's order. */
  permissionModes?: PermissionModeInfo[];
}

/** An image under a prompt, served at /api/images/<id>. */
export interface ImageRef {
  id: string;
  mimeType: string;
}

export interface UserItem {
  kind: "user";
  id: string;
  text: string;
  imageCount?: number;
  /** The images themselves, when the harness kept them (in order; may be fewer than imageCount). */
  images?: ImageRef[];
  /** A "/" command the harness answered itself: no stored turn, so forks do not count it. */
  command?: true;
  /** Epoch ms when the harness recorded it, when known. */
  at?: number;
}

export interface AssistantItem {
  kind: "assistant";
  id: string;
  text: string;
  thinking: string;
  streaming: boolean;
  error?: string;
  model?: string;
  at?: number;
  endedAt?: number;
}

export type ToolCategory = "read" | "edit" | "write" | "command" | "search" | "web" | "agent" | "other";

/** One subagent a delegation call started (omp's task, pi-subagents' subagent, Claude Code's Task). */
export interface SubagentRun {
  /** Stable within the call: the harness's agent id (omp's CrookedThrush), else its launch index. */
  id: string;
  /** Its agent type: scout, worker, general-purpose. */
  agent: string;
  /** The brief it was given. */
  task: string;
  status: "pending" | "running" | "done" | "failed" | "stopped";
  model?: string;
  toolCount?: number;
  tokens?: number;
  cost?: number;
  durationMs?: number;
  /** While it runs: its latest tool calls, newest last. */
  activity?: string[];
  /** Its final answer (bounded). */
  output?: string;
  error?: string;
  /** Its own transcript, readable through /api/chats/:id/tools/:toolId/agents/:runId. */
  transcript?: boolean;
  /** The harness's id for the run it belongs to (pi-subagents' asyncId), to match its later report. */
  ref?: string;
}

export interface SubagentsInfo {
  /** single, parallel, chain; omp's background runs report back later. */
  mode?: string;
  background?: boolean;
  runs: SubagentRun[];
}

/** One line of a tool's diff. `line` is its number in the file: the new side for add/ctx, the old for del. */
export interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk" | "gap";
  text: string;
  line?: number;
}

export interface ToolDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
}

/** Bounds for review threads (see docs/security.md). */
export const MAX_REVIEW_NOTE_CHARS = 4_000;
export const MAX_REVIEW_THREADS_PER_CHAT = 200;
export const MAX_REVIEW_NOTES_PER_THREAD = 50;
export const MAX_REANCHOR_MOVES = 200;
/** The line text an anchor carries: one tool-diff line, as tool-diff.ts bounds it. */
export const MAX_REVIEW_LINE_CHARS = 400;

/**
 * A comment pinned to one diff line. `text` and `hash` are the line as it was
 * when the comment was written, so the pin can be found again after the agent
 * edits the file: the hash of the line's trimmed text moves with it, and a pin
 * with no match left is stale rather than lost.
 */
export interface ReviewAnchor {
  /** Workspace-relative, no leading "/", no "..". */
  path: string;
  /** The line's side in the diff: added, removed, or context. */
  side: "add" | "del" | "ctx";
  /** The file line at pin time: the new side for add/ctx, the old side for del. */
  line: number | null;
  /** hashLine(text): 8 lowercase hex characters. */
  hash: string;
  /** The line's trimmed text at pin time, cut to MAX_REVIEW_LINE_CHARS. */
  text: string;
}

/** One message in a thread: the original comment, then the replies, in order. */
export interface ReviewNote {
  id: string;
  text: string;
  at: number;
}

/** A line's comments as one conversation, open until resolved, kept until deleted. */
export interface ReviewThread {
  id: string;
  /** The chat whose edits the thread reviews (it outlives the chat being open). */
  chatId: string;
  anchor: ReviewAnchor;
  notes: ReviewNote[];
  status: "open" | "resolved";
  resolvedAt?: number;
  /** The last batch of open threads that carried it. */
  lastSentAt?: number;
  createdAt: number;
}

/** What a send did: the chat the prompt went to, and how many threads it carried. */
export interface ReviewSendResult {
  accepted: true;
  targetChatId: string;
  sent: number;
}

/** Bounds for an agent-published HTML page (the harness's render tool). */
export const HTML_RENDER_MIN_HEIGHT = 80;
export const HTML_RENDER_MAX_HEIGHT = 2000;
export const HTML_RENDER_MAX_TITLE = 200;
/** Largest HTML document the server keeps. */
export const HTML_RENDER_MAX_BYTES = 512 * 1024;

/**
 * A self-contained HTML page an agent published into the chat, stored
 * server-side and fetched at /api/chats/:id/html-render/:renderId. `heights`
 * holds `[width, contentHeight]` pairs the server measured, ascending by width.
 */
export interface HtmlRenderRef {
  id: string;
  title: string;
  /** The frame height the agent asked for, and the cap on any measured height. */
  height: number;
  heights?: Array<readonly [width: number, height: number]>;
}

export interface ToolItem {
  kind: "tool";
  id: string;
  name: string;
  args: string;
  status: "running" | "done" | "error";
  output: string;
  truncated: boolean;
  category: ToolCategory;
  /** One-line description: a path, command, or query. */
  summary: string;
  /** Files named in the arguments (absolute or as given). */
  paths: string[];
  /** Added/removed lines for an edit or write (from its diff, else its output's own count). */
  diffStat?: { added: number; removed: number };
  /** An edit's or write's lines: the harness's own diff once it answers, the arguments' until then. */
  diff?: ToolDiff;
  /** A delegation call's subagents, with their live progress and results. */
  subagents?: SubagentsInfo;
  /** An HTML page the call published, shown in a sandboxed frame. */
  htmlRender?: HtmlRenderRef;
  /** A proposed plan the call handed over for review (Claude's ExitPlanMode, pi-plan-mode's plan_mode_complete), as Markdown. */
  plan?: string;
  /** A shell call's exit code, when the harness reported one (OpenCode's shell result carries metadata.exit; Pi/omp/Claude bash results carry none). */
  exitCode?: number;
  /** Pictures the call's result carried (a read of a screenshot), served at /api/images/<id> and opened full size like a prompt's. */
  images?: ImageRef[];
  /**
   * Background jobs this call started or looked at (omp's backgrounded bash and `wait`, Claude Code's
   * run_in_background, the bg_task extension's spawn and status), as it last saw them; a job's later
   * report updates every call that holds it.
   */
  jobs?: BackgroundJob[];
  at?: number;
  endedAt?: number;
}

/** How a job's widget colours a part: the harness's words, mapped to theme tokens by the client. */
export type JobTone = "success" | "error" | "warning" | "info" | "muted" | "accent";

/** One part of a job's widget (omp's job widget: what its progress means, worked out by the harness). */
export type JobBlock =
  | { kind: "meter"; label?: string; /** 0–1. */ value: number; text?: string; tone?: JobTone }
  | { kind: "stat"; items: Array<{ label: string; text: string; tone?: JobTone }> }
  | { kind: "text"; text: string }
  | { kind: "bars"; label?: string; items: Array<{ label: string; value: number; text?: string; tone?: JobTone }>; max?: number }
  | { kind: "spark"; label?: string; values: number[]; last?: string; min?: number; max?: number }
  | { kind: "grid"; label?: string; items: Array<{ label: string; text?: string; tone?: JobTone }> };

/** A job's progress as the harness draws it (omp's job widget), bounded. */
export interface JobWidget {
  title?: string;
  /** Where it is now: the test running, the step it is on. */
  stage?: string;
  /** One big number with its word ("208 passed"). */
  headline?: { text: string; label?: string };
  blocks: JobBlock[];
}

/** A command or task the agent left running in the background, as one call saw it. */
export interface BackgroundJob {
  /** The harness's own id: omp's bg_3, Claude Code's task id, bg_task's bg-1. */
  id: string;
  kind: "shell" | "task";
  status: "running" | "done" | "failed" | "stopped";
  /** What it runs, one line, bounded: the command, or the task's name. */
  label: string;
  /** Why, in words, when the harness says (omp's intent, Claude's description, bg_task's title). */
  title?: string;
  /** Epoch ms, when known. */
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  exitCode?: number;
  /** The tail of what it printed, when the harness handed it over (bounded). */
  output?: string;
  widget?: JobWidget;
}

export interface NoticeItem {
  kind: "notice";
  id: string;
  level: "info" | "warning" | "error";
  /** The line shown; with a `detail`, a one-line summary of it (the row itself shows only the title). */
  text: string;
  /** A label for an expandable notice (an extension's message: "Memory"). */
  title?: string;
  /** The full text behind the disclosure, when `text` only summarizes it. */
  detail?: string;
  /** The detail is the harness's Markdown (Hermes's MoA reference advice), drawn as such instead of verbatim. */
  detailFormat?: "markdown";
  at?: number;
  /** Arrived while the agent was idle (e.g. extension notices on open): not part of any turn's work. */
  ambient?: boolean;
}

export interface RequestItem {
  kind: "request";
  id: string;
  request: InteractionRequest;
  outcome?: string;
  at?: number;
}

export type ChatItem = UserItem | AssistantItem | ToolItem | NoticeItem | RequestItem;

export type InteractionKind = "select" | "confirm" | "input" | "editor";

export interface InteractionRequest {
  id: string;
  kind: InteractionKind;
  title: string;
  message?: string;
  options?: string[];
  /** A line under each option, where the harness describes them (Claude Code's questions). */
  optionDetails?: string[];
  placeholder?: string;
  prefill?: string;
  /** Absolute epoch ms when the harness gives up on its own. */
  expiresAt?: number;
  createdAt: number;
}

export const interactionAnswerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("select"), value: z.string().max(10_000) }),
  z.object({ kind: z.literal("confirm"), confirmed: z.boolean() }),
  z.object({ kind: z.literal("input"), value: z.string().max(100_000) }),
  z.object({ kind: z.literal("editor"), value: z.string().max(1_000_000) }),
  z.object({ kind: z.literal("cancel") }),
]);
export type InteractionAnswer = z.infer<typeof interactionAnswerSchema>;

/** A "/" command the open chat's harness offers (the composer's menu). */
export interface SlashCommand {
  /** Without the slash, e.g. "compact" or "skill:review". */
  name: string;
  description?: string;
  /** What goes after the name, e.g. "[instructions]". */
  hint?: string;
  /** How the harness labels it: builtin, extension, skill, prompt, plugin, ... */
  source: string;
}

/** One slice of the context window: omp's own `/context` figures, or this server's estimate for Pi. */
export interface ContextCategory {
  id: string;
  label: string;
  tokens: number;
}

export interface ContextUsage {
  tokens: number | null;
  window: number;
  percent: number | null;
  /** What fills the window; estimates. */
  categories?: ContextCategory[];
}

/** Session-wide tokens and model timing (the composer's stats line). */
export interface SessionUsage {
  /** Prompts and model calls across the whole session, from the harness. */
  turns: number;
  steps: number;
  /** Token totals: input sent fresh, input read from the provider's cache, cache writes, output. */
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
  /** USD, when the harness prices the model. */
  cost: number | null;
  /** Measured by this server over the runs it watched; null until one has finished. */
  llmMs: number | null;
  ttftMs: number | null;
  tokensPerSecond: number | null;
  /**
   * How long the provider keeps this session's cached prompt prefix after a request (Claude Code's
   * 5 minutes or 1 hour), when it reports which cache it wrote. Absent for harnesses that do not.
   */
  promptCacheTtlMs?: number;
  /**
   * When that prefix stops being readable, epoch ms: the last request's time plus the lifetime.
   * The composer's cold-resume hint reads it rather than guessing from the clock.
   */
  promptCacheExpiresAt?: number;
}

/** One rate-limit window of a subscription: Claude's five hours or seven days, a provider's month. */
export interface LimitWindow {
  /** "5 hours", "7 days", "30 days". */
  label: string;
  /** Share used, 0–1; null when the source gives only a status. */
  used: number | null;
  /** Epoch ms. */
  resetsAt: number | null;
}

/** A subscription's limits, as a harness reports them. No account names or emails. */
export interface LimitAccount {
  /** Stable while the server runs: `claude`, `omp:openai-codex:0`. */
  id: string;
  /** The harness that reported it. */
  source: string;
  provider: string;
  plan?: string;
  windows: LimitWindow[];
  /** Requests are refused until a window resets. */
  limited: boolean;
  /** Epoch ms of the report. */
  at: number;
}

export interface UsageLimits {
  accounts: LimitAccount[];
  /** One line per harness that could not report. */
  errors: string[];
}

/** Something a device is told about: a run finished or failed, or the agent asks for an answer. */
export interface PushNote {
  id: string;
  kind: "done" | "error" | "ask";
  /** The chat it is about; "" for a Board room's note, which names its room instead. */
  chatId: string;
  sessionId: string | null;
  /** A Board room's note: the room to open, and where an approval's answer goes (a room's bots are no ordinary chats). */
  roomId?: string;
  /** The chat's title. */
  title: string;
  /** One line: the answer's start, the question, or the error. */
  body: string;
  /** Epoch ms. */
  at: number;
  /** An approval the notification can answer itself (its Approve and Deny buttons): the request and the two answers. */
  approval?: { requestId: string; approve: InteractionAnswer; deny: InteractionAnswer };
}

export interface TodoItem {
  phase?: string;
  text: string;
  /** Harness status, e.g. pending, in_progress, completed. */
  status: string;
}

export interface QueueState {
  steering: string[];
  followUp: string[];
}

/** What restoring a checkpoint does to a file: puts its old content back, deletes it (it is new since), or brings it back (deleted since). */
export type CheckpointChange = "restore" | "delete" | "recreate";

export interface CheckpointFile {
  /** Relative to the repository's top level. */
  path: string;
  change: CheckpointChange;
}

export interface CheckpointPreview {
  files: CheckpointFile[];
}

export interface CheckpointRestored {
  files: CheckpointFile[];
  /** The tree from just before: restoring it puts the files back as they were. */
  undo: string;
}

/** A point on a chat's file timeline: the files as they were just before prompt `turn`. */
export interface CheckpointPoint {
  turn: number;
  /** Epoch ms the snapshot was taken. */
  at: number;
  /** The prompt's start. */
  prompt: string;
}

/** Two points to compare: a prompt's checkpoint by its turn, or "now" (the files as they are). */
const checkpointPoint = z.union([z.literal("now"), z.coerce.number().int().min(1).max(100_000)]);
export const checkpointCompareSchema = z.object({ from: checkpointPoint, to: checkpointPoint });

export interface CheckpointCompareFile {
  /** Relative to the repository's top level. */
  path: string;
  change: "added" | "deleted" | "modified";
  /** Its lines, bounded as a tool's diff is; null for a binary file or one past the cap (`note` says). */
  diff: ToolDiff | null;
  note?: string;
}

export interface CheckpointComparison {
  files: CheckpointCompareFile[];
  /** Files changed beyond those listed. */
  more: number;
}

/** One side of a file's git status: what was done to it in the index (staged) or the work tree. */
export type GitFileState = "modified" | "added" | "deleted" | "renamed" | "copied" | "typechange" | "untracked" | "conflict";

export interface GitFile {
  /** Relative to the repository's top level. */
  path: string;
  /** A rename's or copy's source. */
  from?: string;
  staged: GitFileState | null;
  unstaged: GitFileState | null;
  /** Lines against HEAD; null for binary files and untracked ones. */
  added: number | null;
  removed: number | null;
  /** The staged side's lines (index against HEAD) and the unstaged side's (work tree against the index). */
  stagedLines?: { added: number | null; removed: number | null };
  unstagedLines?: { added: number | null; removed: number | null };
}

/** Which side of a file a diff shows: what is staged, what is not yet, or a whole untracked file. */
export type GitDiffSide = "staged" | "unstaged" | "untracked";

export interface GitFileDiff {
  diff: ToolDiff | null;
  /** Why there is no diff: a binary file, one too large, … */
  note?: string;
}

/** The project's direnv state, as `direnv status --json` reports it (the composer's direnv row). */
export interface DirenvState {
  /** The nearest .envrc, when one exists in the tree. */
  rcPath: string | null;
  /** A .envrc direnv refuses to run until allowed (the composer's note). */
  blocked: boolean;
  /** The .envrc is allowed and loads into every spawn here; null when direnv could not say. */
  allowed: boolean | null;
}

/** The project's git repository as `git status` sees it (the composer's git row). */
export interface GitStatus {
  root: string;
  /** Null when HEAD is detached. */
  branch: string | null;
  /** Short hash; null before the first commit. */
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** A merge, rebase, … that is under way. */
  operation: "merge" | "rebase" | "cherry-pick" | "revert" | "bisect" | null;
  lastCommit: { hash: string; subject: string; author: string; at: number } | null;
  stashes: number;
  files: GitFile[];
  /** Files left out past the list's cap. */
  more: number;
  counts: { staged: number; changed: number; untracked: number; conflicts: number };
  added: number;
  removed: number;
}

/** How a delegated task stands. `waiting_for_children` is a child whose own delegates still run. */
export type DelegatedState = "working" | "waiting_for_user" | "waiting_for_children" | "result_available";
/** How it ended; null while it has not. */
export type DelegatedOutcome = "done" | "failed" | "cancelled" | "interrupted";

/** How many of a chat's delegated tasks a snapshot carries. */
export const MAX_DELEGATED_TASKS = 20;

/**
 * One delegated task as the browser sees it. The child is an ordinary chat, so its
 * transcript is its own; this view carries only what a parent's panel needs, and a
 * result is bounded (the full answer is in the child chat).
 */
export interface DelegatedTaskView {
  id: string;
  parentChatId: string;
  childChatId: string | null;
  title: string;
  harnessId: HarnessId;
  model: string | null;
  role: string;
  /** The bot profile the child was started from, if any. */
  profile: string | null;
  depth: number;
  state: DelegatedState;
  outcome: DelegatedOutcome | null;
  createdAt: number;
  endedAt: number | null;
  /** The child's last answer line while it works (≤300 chars). */
  activity: string | null;
  /** Bounded to 4 000 chars; the child's full transcript is its own chat. */
  result: { finalText: string; error: string | null; usage: SessionUsage | null } | null;
  /** A child waiting on an answer: its request's title, never the request body. */
  asking: string | null;
}

/** A chat another agent delegated: which task, and where in the tree. */
export interface ChatLineage {
  kind: "delegate";
  taskId: string;
  parentChatId: string;
  parentTitle: string | null;
  depth: number;
}
export interface ChatSnapshot {
  chatId: string;
  harnessId: HarnessId;
  /** Namespaced session id once the harness has assigned one. */
  sessionId: string | null;
  workspace: WorkspaceInfo;
  title: string;
  status: ChatStatus;
  items: ChatItem[];
  queue: QueueState;
  pending: InteractionRequest[];
  config: ChatConfig;
  capabilities: HarnessCapabilities;
  extensionStatus: Record<string, string>;
  context: ContextUsage | null;
  usage: SessionUsage | null;
  todos: TodoItem[];
  /** User turns (fork's 1-based count) whose files can be put back as they were before the prompt. */
  checkpoints: number[];
  /** What runs after the current run, step by step (see ChainStep). */
  chain: ChainStep[];
  /** Why the chain waits (a run stopped or failed); null when it goes on by itself. */
  chainPaused: string | null;
  /** When this chat was told to carry on after a usage limit resets: the timer is the server's, so no tab has to stay open. */
  continueAt: number | null;
  /**
   * How many streams (browser tabs, devices, atui) are attached to this chat, as last announced (a `viewers` event follows a change after a second).
   * A count only: no device names or addresses, since a remote device is a signed-in user and who it is is not other devices' business.
   */
  viewers: number;
  /** The context's percent and tokens after each change the harness reported, oldest first, at most 200: what the context panel's sparkline draws. */
  contextHistory: ContextPoint[];
  generation: number;
  lastEventId: number;
  /**
   * The tasks this chat delegated, newest first, at most 20: the panel's rows, fed live by
   * `task` events. Absent when the chat delegates nothing (the common case).
   */
  delegated?: DelegatedTaskView[];
  /** Set when another agent delegated this chat: what the header's lineage chip reads. */
  lineage?: ChatLineage;
}

/** How many context readings a chat keeps (server) and a client mirrors. */
export const MAX_CONTEXT_HISTORY = 200;

/** One reading of the context window, kept per chat so the panel can draw how it grew. */
export interface ContextPoint {
  percent: number | null;
  tokens: number | null;
}

export type ChatEvent =
  | { type: "snapshot"; snapshot: ChatSnapshot }
  | { type: "item"; item: ChatItem }
  | { type: "delta"; itemId: string; field: "text" | "thinking" | "output"; append: string }
  | { type: "status"; status: ChatStatus }
  | { type: "queue"; queue: QueueState }
  | { type: "config"; config: ChatConfig }
  | { type: "title"; title: string; sessionId: string | null }
  | { type: "request"; request: InteractionRequest }
  | { type: "request_resolved"; requestId: string; outcome: string }
  | { type: "extension_status"; key: string; text: string | null }
  | { type: "context"; context: ContextUsage | null }
  | { type: "viewers"; viewers: number }
  | { type: "usage"; usage: SessionUsage | null }
  | { type: "todos"; todos: TodoItem[] }
  | { type: "checkpoints"; turns: number[] }
  | { type: "chain"; chain: ChainStep[]; paused: string | null }
  /** One of this chat's delegated tasks changed: a panel row updates without polling. */
  | { type: "task"; task: DelegatedTaskView }
  | { type: "disposed"; reason: string };

export interface ThemeInfo {
  source: "file" | "none";
  name: string | null;
  polarity: "dark" | "light" | null;
  /** CSS custom properties, already contrast-checked. */
  vars: Record<string, string>;
  themeColor: string | null;
  fonts: { sans?: string; mono?: string };
  /** Why no scheme is active, when a file was configured but unusable. */
  problem?: string;
}

/** config.yml's `theme`: the default look on every device. `custom` is the legacy name for `base16`. */
export const themeChoiceSchema = z.enum(["system", "light", "dark", "base16", "custom"]);
/** A device's theme mode; the file's legacy `custom` maps to `base16`. */
export type ThemeChoice = Exclude<z.infer<typeof themeChoiceSchema>, "custom">;
/** How wide the conversation and composer run: 960px, 1400px, or the whole pane. */
export const chatWidthSchema = z.enum(["comfortable", "wide", "full"]);
export type ChatWidth = z.infer<typeof chatWidthSchema>;
/** How tight the web UI's rows and gaps sit: today's look, or tighter sidebar rows, turns, tool rows, composer, and tab strip. */
export const densitySchema = z.enum(["comfortable", "compact"]);
export type Density = z.infer<typeof densitySchema>;
/** How a turn's work is drawn: the card that groups a run's calls as one tile, or the flat line list older versions drew. */
export const toolStyleSchema = z.enum(["cards", "lines"]);
export type ToolStyle = z.infer<typeof toolStyleSchema>;
/** Which type the web UI sets in: the font it ships (the same on every machine), or this device's system font. */
export const uiFontSchema = z.enum(["bundled", "system"]);
export type UiFont = z.infer<typeof uiFontSchema>;

export interface Bootstrap {
  version: string;
  /** What this server serves as the web bundle (index.html's hash); pages compare it to notice a deploy. */
  build: string;
  /** "local": this machine, no sign-in. "password": signed in from another device. */
  auth: { mode: "local" | "password"; username: string | null; remoteEnabled: boolean };
  harnesses: HarnessStatus[];
  roots: string[];
  home: string;
  theme: { active: string; problem?: string };
  /** From config.yml: the shared look (theme null lets theme.yml decide, scale null is 100%). Re-read on every page load. */
  ui: { theme: ThemeChoice | null; textScale: number | null; chatWidth: ChatWidth | null; density: Density | null; toolStyle: ToolStyle | null; font: UiFont | null; autocollapseSidebar: boolean; showStatusBar: boolean; herdr: boolean };
  pairing: { urls: string[] };
  /** From config.yml's `breakdown:`: which changed paths a card counts as tests and as generated output (shared/breakdown.ts holds the defaults). */
  breakdown: BreakdownRules;
  limits: { maxMessageChars: number };
}

export const MAX_MESSAGE_CHARS = 100_000;

/**
 * The request header that makes a mutating call safe to repeat: the same key and body
 * replays the first answer instead of running again (server/idempotency.ts). In memory
 * only, so it covers a retry within a few minutes, not a restart.
 */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

export const openWorkspaceSchema = z.object({ path: z.string().min(1).max(4096) });
export const worktreeCreateSchema = z.object({ name: z.string().trim().min(1).max(64), base: z.string().trim().min(1).max(256) });
export const terminalCreateSchema = z.object({ cols: z.number().int().min(10).max(400).default(100), rows: z.number().int().min(4).max(120).default(30) });
export const terminalWriteSchema = z.object({ data: z.string().max(16_384) });
export const htmlRenderPreviewSchema = z.object({ theme: z.record(z.string().regex(/^--[a-z0-9-]+$/), z.string().max(1000).refine((value) => !/[;{}]/.test(value))).refine((value) => Object.keys(value).length <= 32), appearance: z.enum(["light", "dark"]) });
export const gitHubPrSchema = z.object({ base: z.string().trim().min(1).max(120), title: z.string().trim().min(1).max(200), body: z.string().max(20_000).default("") });
export const compareStartSchema = z.object({ workspaceId: z.string().min(1).max(128), name: z.string().trim().min(1).max(64), base: z.string().trim().min(1).max(256), prompt: z.string().min(1).max(MAX_MESSAGE_CHARS), choices: z.array(z.object({ harnessId: z.string().min(1).max(64), model: z.string().min(1).max(512).optional() }).strict()).min(2).max(4) });
/** Picking a race's winner: mark it, or also put its changes in the project's working tree. */
export const raceWinnerSchema = z.object({ chatId: z.string().min(1).max(128), mode: z.enum(["keep", "apply"]).default("keep") });
/** Cleaning up a race's losers: members whose unmerged branch the user chose to throw away. */
export const raceCleanupSchema = z.object({ discard: z.array(z.string().min(1).max(128)).max(8).default([]) });
/** One file of a race member's worktree, by its path in that worktree. */
export const raceDiffQuery = z.object({ path: z.string().min(1).max(4096) });
/** Allow a project's .envrc (direnv allow), within the workspace roots. */
export const direnvAllowSchema = z.object({ workspaceId: z.string().min(1).max(128) });
export const createChatSchema = z.object({
  harnessId: z.string().min(1).max(64),
  workspaceId: z.string().min(1).max(128),
  /** A model picked before the chat existed (the start screen's chip); absent starts on the harness's own default. */
  model: z.string().min(1).max(512).optional(),
  /** A thinking level picked before the chat existed; absent starts on the harness's own default. */
  thinkingLevel: z.string().min(1).max(64).optional(),
});
export const resumeChatSchema = z.object({
  harnessId: z.string().min(1).max(64),
  workspaceId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(512),
  /** Resume it even though a herdr pane runs it: a second harness on the same session file, which the user chose. */
  ignoreHerdr: z.boolean().optional(),
});
/** A herdr pane to show (herdr's ids look like `w1:p2`). */
export const herdrFocusSchema = z.object({ paneId: z.string().regex(/^[A-Za-z0-9:_-]{1,64}$/) });
/** A mention picker's search over a project's files. */
export const fileSearchSchema = z.object({ q: z.string().max(200).default("") });
/** Text search across a project's files (fixed strings, never a regex). */
export const projectSearchSchema = z.object({
  q: z.string().trim().min(2).max(200),
  /** "1": match case. */
  case: z.enum(["0", "1"]).default("0"),
});

/** One line of a project search. */
export interface SearchMatch {
  /** Relative to the project. */
  path: string;
  /** 1-based. */
  line: number;
  /** The line, cut to a few hundred characters around the match. */
  text: string;
}

export interface ProjectSearch {
  matches: SearchMatch[];
  /** More matched than were returned. */
  truncated: boolean;
}

/** Usage across sessions: the last `days` days, by day in the browser's time zone (`tz`, as getTimezoneOffset gives it). */
export const usageReportSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  tz: z.coerce.number().int().min(-840).max(840).default(0),
  /** "1": bypass the report's session cache (the panel's Refresh). */
  refresh: z.enum(["0", "1"]).default("0"),
});

/** Tokens and cost over some calls. */
export interface UsageTotals {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
  /** USD over the calls the harness priced (see `unpriced`). */
  cost: number;
  calls: number;
  /** Calls with no price (Claude Code's files price none). */
  unpriced: number;
}

export interface UsageReport {
  days: number;
  /** Epoch ms the range starts at (a local midnight). */
  since: number;
  totals: UsageTotals & { sessions: number };
  /** One per day, oldest first, every day of the range; tokens by harness too, for the chart. */
  byDay: Array<{ day: string; totals: UsageTotals; tokensByHarness: Record<string, number> }>;
  byHarness: Array<{ harnessId: string; totals: UsageTotals; sessions: number }>;
  /** The most-used models, most tokens first. */
  /** One row per model name across harnesses (the panel names no harness per row), with who ran it, most tokens first. */
  byModel: Array<{ model: string; harnesses: string[]; totals: UsageTotals }>;
  /** The sessions that used the most, most first. */
  top: Array<{ session: ProjectSession; totals: UsageTotals }>;
  workspaces: WorkspaceInfo[];
  /** Harnesses whose sessions cannot be read for usage (Hermes keeps no file). */
  unreadable: string[];
  scanned: number;
  total: number;
  truncated: boolean;
}

/** Saved prompts are kept on the server, for every device: at most this many, each at most this long. */
export const MAX_SAVED_PROMPTS = 200;
export const MAX_SAVED_PROMPT_CHARS = 20_000;

/** A prompt to save: a new one, or `id`'s new name and text. `{{blank}}`s in it are filled in when it is used. */
export const savedPromptSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .refine((v) => !/[\u0000-\u001f]/.test(v), "must be one line"),
  text: z.string().min(1).max(MAX_SAVED_PROMPT_CHARS),
});

export interface SavedPrompt {
  id: string;
  name: string;
  text: string;
  /** Epoch ms. */
  updatedAt: number;
}

/** A project file for the file viewer: relative to the project (or absolute inside it). */
export const fileViewSchema = z.object({ path: z.string().min(1).max(4096) });

/** A file dropped into a project: its name only; the bytes are the body. */
export const fileUploadSchema = z.object({ name: z.string().min(1).max(120) });

/** A routine's cadence, mirroring shared/routine-schedule.ts. */
export const routineCadenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hourly"), minute: z.number().int().min(0).max(59) }),
  z.object({ kind: z.literal("daily"), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }),
  z.object({ kind: z.literal("weekdays"), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }),
  z.object({ kind: z.literal("weekly"), weekday: z.number().int().min(0).max(6), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }),
]);

/** A routine's precheck is one command line; longer than this is a typo, not a guard. */
export const MAX_PRECHECK_CHARS = 500;
/** Why the last slot was skipped or failed, as the list shows it. */
export const MAX_RUN_DETAIL_CHARS = 300;

/** What the Routines dialog saves: a prompt on a cadence, in a project, on a harness. */
export const routineSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
  harnessId: z.string().min(1).max(64),
  workspaceId: z.string().min(1).max(64),
  cadence: routineCadenceSchema,
  /** A shell command run in the project before a due run; a non-zero exit skips it. Empty = none. */
  precheck: z.string().trim().max(MAX_PRECHECK_CHARS).default(""),
  enabled: z.boolean().default(true),
});
// What the dialog sends: `enabled` and `id` are optional here and filled in by the
// schema on parse, so a caller need not spell out the defaults.
export type RoutineInput = z.input<typeof routineSchema>;

/** How a routine's last due slot ended: a chat started, a precheck skipped it, or the start threw. */
export type RoutineOutcome = "launched" | "skipped" | "failed";

/** A saved routine: its input, plus the id, the times, and the last outcome the server keeps. */
export interface Routine extends Omit<RoutineInput, "enabled" | "precheck"> {
  id: string;
  enabled: boolean;
  precheck: string;
  nextRunAt: number;
  lastRunAt: number | null;
  /** Null before the first run (or from a file written before outcomes were kept). */
  lastRunOutcome: RoutineOutcome | null;
  /** The exit code or reason behind a skip, bounded; null when there is nothing to say. */
  lastRunDetail: string | null;
}

export interface FileView {
  /** Relative to the project, with forward slashes. */
  path: string;
  /** Bytes on disk. */
  size: number;
  /** Its text, or null for a binary file. */
  text: string | null;
  binary: boolean;
  /** Only the first part was read (the viewer says so). */
  truncated: boolean;
  /** Lines in `text`. */
  lines: number;
}

/** Search every chat: the words to find (all of them, in one message), and optionally one harness. */
export const chatSearchSchema = z.object({
  q: z.string().trim().min(2).max(200),
  harnessId: z.string().min(1).max(64).optional(),
});

/** Where in a chat the words were found. */
export type ChatSearchKind = "title" | "prompt" | "answer" | "tool";

export interface ChatSearchHit {
  kind: ChatSearchKind;
  /** The prompt it belongs to, 1-based; null for the title. */
  turn: number | null;
  /** The text around the match, whitespace collapsed, cut to a couple of hundred characters. */
  snippet: string;
  /** Each matched word in the snippet, as [start, end) offsets. */
  ranges: Array<[number, number]>;
}

export interface ChatSearchResult {
  session: ProjectSession;
  /** The first few hits, in the chat's order (the title first). */
  hits: ChatSearchHit[];
  /** Hits in this chat beyond those. */
  more: number;
}

export interface ChatSearch {
  results: ChatSearchResult[];
  /** The projects the results' sessions belong to. */
  workspaces: WorkspaceInfo[];
  /** Sessions read, of those there are; a search that ran out of time or hits says so. */
  scanned: number;
  total: number;
  truncated: boolean;
}

/** A chat's whole queue, to replace what the harness holds (an edited or removed queued message). */
export const queueSchema = z.object({
  steering: z.array(z.string().min(1).max(MAX_MESSAGE_CHARS)).max(20),
  followUp: z.array(z.string().min(1).max(MAX_MESSAGE_CHARS)).max(20),
});
/** One session's last exchange, for a history picker's preview. */
export const sessionPreviewSchema = z.object({
  harnessId: z.string().min(1).max(64),
  workspaceId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(512),
});
/** A session to resume from a terminal, outside awui ("Copy resume command"). */
export const resumeCommandSchema = sessionPreviewSchema;

/** The shell line that resumes a session in its harness's own CLI. */
export interface ResumeCommand {
  /** `cd <project> && claude --resume <id>`, quoted for a POSIX shell or fish. */
  command: string;
  /** awui has the session open: closing it here first keeps one writer on the session. */
  live: boolean;
}

/** What a history picker or a hover card shows of a session: its last prompt and answer, cut short. */
export interface SessionPreview {
  prompt: string | null;
  answer: string | null;
  /** User turns in the session. */
  turns: number;
  /** The model of its last answer, where the transcript names one. */
  model: string | null;
  /** Files its edits and writes changed, relative to the project, newest last (at most 8). */
  files: string[];
}

/** Branch the chat after its Nth user turn (1-based). */
export const forkChatSchema = z.object({
  through: z.number().int().min(1).max(10_000),
});
/** Replace user turn `turn` (1-based, as fork counts) and everything after it with a new prompt, in place. */
/** Continue this chat in another harness: transcript seed plus an optional first prompt. */
/** A chain runs at most this many steps. */
export const MAX_CHAIN_STEPS = 10;

/**
 * A step a chat runs once its run settles on its own, kept by the server so
 * it happens with no browser open: send a message (a new run), or hand the
 * chat off to another harness (the rest of the chain goes with it).
 */
export type ChainStep = { id: string } & ({ kind: "send"; text: string } | { kind: "handoff"; harness: string; prompt?: string });

const chainStepSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("send"), text: z.string().trim().min(1).max(MAX_MESSAGE_CHARS) }),
  z.object({ kind: z.literal("handoff"), harness: z.string().min(1).max(64), prompt: z.string().max(MAX_MESSAGE_CHARS).optional() }),
]);

/** A chat's whole chain, replaced; `resume` lets a paused one go on. */
/** A usage-limit continuation: when to send "continue", or null to call it off. */
export const continueAtSchema = z.object({ at: z.number().int().nullable() });

export const chainSchema = z.object({
  steps: z.array(chainStepSchema).max(MAX_CHAIN_STEPS),
  resume: z.boolean().optional(),
});

export const handoffSchema = z.object({
  harness: z.string().min(1).max(64),
  through: z.number().int().min(1).max(10_000).optional(),
  prompt: z.string().max(MAX_MESSAGE_CHARS).optional(),
});
/** Image types both harnesses and the major providers accept. */
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];
export const MAX_IMAGES = 8;
/** Per image, after the browser's downscaling; Anthropic's API refuses anything larger. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** A pasted, dropped, or picked image, base64-encoded. The harness resizes it further for the model. */
export interface ImageAttachment {
  mimeType: ImageMimeType;
  data: string;
}

export const imageAttachmentSchema = z.object({
  mimeType: z.enum(IMAGE_MIME_TYPES),
  data: z
    .string()
    .min(8)
    .max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "not base64"),
});

/** A big text blob pasted into the composer, parked server-side as a file the agent can read. */
export const MAX_PASTE_BYTES = 1024 * 1024;

export interface PasteAttachment {
  id: string;
  path: string;
  bytes: number;
  lines: number;
}

/** The client may only reference a paste the server issued (id); the path is server-owned. */
export const pasteRefSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{8,40}$/) });

export const uploadPasteSchema = z.object({
  text: z.string().min(1).max(MAX_PASTE_BYTES),
});

export const rewindSchema = z.object({
  turn: z.number().int().min(1).max(10_000),
  text: z.string().min(1).max(MAX_MESSAGE_CHARS),
  images: z.array(imageAttachmentSchema).max(MAX_IMAGES).default([]),
});
export const sendMessageSchema = z.object({
  // Text stays required with images: some providers reject an empty text block.
  text: z.string().min(1).max(MAX_MESSAGE_CHARS),
  images: z.array(imageAttachmentSchema).max(MAX_IMAGES).default([]),
  attachments: z.array(pasteRefSchema).max(4).default([]),
  mode: z.enum(["normal", "steer", "followUp", "stopAndSend"]).default("normal"),
  /** Compact the context first, then send (a normal send while idle). */
  compactFirst: z.boolean().optional(),
});
export const patchConfigSchema = z
  .object({
    model: z.string().min(1).max(512).optional(),
    thinkingLevel: z.string().min(1).max(32).optional(),
    permissionMode: z.string().min(1).max(64).optional(),
  })
  .refine((v) => v.model !== undefined || v.thinkingLevel !== undefined || v.permissionMode !== undefined, {
    message: "empty patch",
  });
/** A chat's settings change: model and thinking only while idle, permission mode at any time. */
export type ConfigPatch = { model?: string; thinkingLevel?: string; permissionMode?: string };

/** A comment's line pin: a path inside the project, the side, the file line, and the line's hash. */
const reviewAnchorSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^(?!\/)(?!.*(^|\/)\.\.(\/|$)).+/, "A workspace-relative path with no .."),
  side: z.enum(["add", "del", "ctx"]),
  line: z.number().int().min(1).max(1_000_000).nullable(),
  hash: z.string().regex(/^[0-9a-f]{8}$/),
  text: z.string().max(MAX_REVIEW_LINE_CHARS),
});
export const createThreadSchema = z.object({ anchor: reviewAnchorSchema, text: z.string().trim().min(1).max(MAX_REVIEW_NOTE_CHARS) });
export const replySchema = z.object({ text: z.string().trim().min(1).max(MAX_REVIEW_NOTE_CHARS) });
export const threadStatusSchema = z.object({ status: z.enum(["open", "resolved"]) });
/** Line moves one client's reconciliation pass found: the anchor's hash matched at another line. */
export const reanchorSchema = z.object({
  moves: z
    .array(z.object({ id: z.string().uuid(), line: z.number().int().min(1).max(1_000_000) }))
    .max(MAX_REANCHOR_MOVES),
});
/**
 * Send the chat's open threads as one prompt. `stale` names the threads whose line
 * no longer matches this client's diffs: the server composes the prompt, so the
 * client has to say which pins it could not find (the prompt says so beside them).
 */
export const sendThreadsSchema = z.object({
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("chat"), chatId: z.string().min(1).max(256) }),
    z.object({ kind: z.literal("new"), harnessId: z.string().min(1).max(64) }),
  ]),
  mode: z.enum(["normal", "followUp"]).optional(),
  stale: z.array(z.string().uuid()).max(MAX_REVIEW_THREADS_PER_CHAT).default([]),
});
export const renameSchema = z.object({ name: z.string().trim().min(1).max(200) });
export const pushSubscriptionSchema = z.object({ endpoint: z.string().url().max(2048) });
export const pushTestSchema = z.object({ endpoint: z.string().url().max(2048).optional() });
/** A web client's presence report: which chat or room this tab shows, and whether the user visibly sees it. */
export const presenceSchema = z
  .object({
    clientId: z.string().min(1).max(64),
    chatId: z.string().max(128).nullable().optional(),
    roomId: z.string().max(128).nullable().optional(),
    visible: z.boolean(),
    focused: z.boolean(),
  })
  .refine((v) => v.chatId == null || v.roomId == null, { message: "one target at a time" });
export type PresenceReport = z.infer<typeof presenceSchema>;

export const restoreSchema = z.object({
  /** The files to put back: some or all of what the preview listed. */
  paths: z.array(z.string().min(1).max(4096)).min(1).max(5000),
});
export const putBackSchema = z.object({
  tree: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
  paths: z.array(z.string().min(1).max(4096)).min(1).max(5000).optional(),
});

export const RUN_SHELLS = ["bash", "sh", "zsh", "fish"] as const;
export type RunShell = (typeof RUN_SHELLS)[number];
/** Run one command line from a shell code block, in the chat's project folder. */
export const runCommandSchema = z.object({
  command: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .refine((c) => !c.includes("\n"), "One line only"),
  shell: z.enum(RUN_SHELLS).default("bash"),
});

/** Files for a git action: relative to the project, and only ones its status lists. */
export const gitPathsSchema = z.object({ paths: z.array(z.string().min(1).max(4096)).min(1).max(200) });

/** A commit message; the commit takes whatever is staged. */
export const gitCommitSchema = z.object({ message: z.string().trim().min(1).max(4000) });

export interface RunResult {
  /** Null when the shell could not start or a signal ended it. */
  exitCode: number | null;
  /** Standard output and error, interleaved as they came. */
  output: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

/** Pin or archive a session; pinning unarchives it and archiving unpins it. */
/** The fields of a mark change, shared by one session and by a whole selection. */
const markChangeShape = {
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  settled: z.boolean().optional(),
  snoozedUntil: z.number().int().positive().max(8_640_000_000_000_000).nullable().optional(),
  /** Set exactly these marks, clearing the rest (an undo). */
  replace: z.boolean().optional(),
  unread: z.boolean().optional(),
};

/** False for a body that changes nothing: nothing to apply, nothing to undo. */
const hasMark = (v: { pinned?: unknown; archived?: unknown; settled?: unknown; snoozedUntil?: unknown; unread?: unknown; replace?: unknown }): boolean =>
  v.replace === true || v.pinned !== undefined || v.archived !== undefined || v.settled !== undefined || v.snoozedUntil !== undefined || v.unread !== undefined;

/** Pin or archive a session; pinning unarchives it and archiving unpins it. */
export const sessionMarkSchema = z.object({ sessionId: z.string().min(1).max(512), ...markChangeShape }).refine(hasMark, { message: "empty mark" });

/** The same change for a selection, applied with one write. */
export const sessionBulkMarkSchema = z.object({ ids: z.array(z.string().min(1).max(512)).min(1).max(500), ...markChangeShape }).refine(hasMark, { message: "empty mark" });

/** The marks a session can carry, as the server keeps them. */
/** A project's sessions in a hand-made order, for one harness: the whole list, first to last. */
export const sessionOrderSchema = z.object({
  harnessId: z.string().min(1).max(64),
  workspaceId: z.string().min(1).max(64),
  ids: z.array(z.string().min(1).max(512)).max(500),
});

export interface SessionMarkState {
  pinned?: true;
  archived?: true;
  settled?: true;
  snoozedUntil?: number;
  unread?: true;
}
export const compactSchema = z.object({ instructions: z.string().max(10_000).optional() });
export const answerSchema = z.object({ answer: interactionAnswerSchema });

/**
 * One orchestration tool call from a chat's harness child: the tool's name and the
 * arguments the model produced. The per-tool schema lives in orchestration/tools.ts,
 * which validates `args`; this checks only the envelope.
 */
export const orchCallSchema = z.object({ tool: z.string().min(1).max(64), args: z.unknown().optional() }).strict();

export type SendMode = z.infer<typeof sendMessageSchema>["mode"];

/** config.yml's settings as the Settings dialog shows them; the password itself never leaves the server. */
export interface ServerSettingsValues {
  port: number;
  host: "127.0.0.1" | "0.0.0.0";
  /** Sign-in name for other devices ("" when none is set). */
  username: string;
  /** A sign-in password is set (in config.yml, or by `npm run set-password`). */
  hasPassword: boolean;
  workspaceRoots: string[];
  allowedHosts: string[];
  allowedTailscaleUsers: string[];
  /** Shared look for every device; null theme lets a theme.yml decide, null scale is 100%. */
  theme: ThemeChoice | null;
  textScale: number | null;
  /** null is comfortable. */
  chatWidth: ChatWidth | null;
  /** null is comfortable. */
  density: Density | null;
  /** null is cards. */
  toolStyle: ToolStyle | null;
  /** null is the bundled font. */
  font: UiFont | null;
  autocollapseSidebar: boolean;
  /** Show the bar under the conversation (connection, harness, model, folder, version). */
  showStatusBar: boolean;
  /** Work with herdr: mark the sessions open in its panes, and let atui report to them. */
  herdr: boolean;
  /** Agents may delegate work to other agent chats (config.yml's `orchestration.enabled`). */
  orchestrationEnabled: boolean;
  /** The desktop app: closing its window hides it to the tray (notes keep coming) instead of quitting. */
  desktopBackground: boolean;
  /** config.yml's own ACP agents, as the Settings dialog lists them (environment values never leave the server). */
  acpAgents: AcpAgentSettings[];
}

/**
 * One ACP agent as the Settings dialog shows it. The agent keeps its own login
 * and secrets; `envNames` is what the entry's `env` sets, never the values
 * (a value is write-only, like the sign-in password).
 */
export interface AcpAgentSettings {
  id: string;
  name: string;
  command: string;
  args: string[];
  envNames: string[];
  /** The `authenticate` method id, or null. */
  authMethod: string | null;
}

/** One entry as the dialog saves it: a blank env value keeps the one already stored for that name. */
export interface AcpAgentPatch {
  id: string;
  name?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  authMethod?: string | null;
}

/** What one `initialize` handshake told the Settings dialog's Test, with no model call. */
export interface AcpAgentProbe {
  /** The agent's own name and version, as it introduced itself. */
  agentName: string | null;
  version: string | null;
  /** An existing session can be resumed, and whether its history is replayed. */
  resume: boolean;
  replay: boolean;
  images: boolean;
  /** It takes awui's MCP servers over HTTP itself. */
  mcpHttp: boolean;
  authMethods: string[];
  warnings: string[];
}

/** Settings that take effect only when the server restarts. */
export type RestartSetting = "port" | "host" | "username" | "password" | "workspaceRoots" | "allowedHosts" | "allowedTailscaleUsers" | "acpAgents";

export interface ServerSettings {
  /** This browser is on the machine running the server: it may change them (other devices only read). */
  editable: boolean;
  /** There is a settings folder to write config.yml to (none when AWUI_CONFIG_DIR is ""). */
  writable: boolean;
  /** As config.yml says now. */
  values: ServerSettingsValues;
  /** Saved but not yet in effect: they wait for a restart. */
  restartPending: RestartSetting[];
  /** Settings an environment variable overrides, so config.yml's value has no effect. */
  envOverrides: Array<keyof ServerSettingsValues>;
  /** A supervisor (systemd) brings the server back after it exits, so it can restart itself. */
  canRestart: boolean;
}

/** One ACP agent as the dialog saves it (config.yml's `harnesses.acp` entry, camelCase on the wire). */
export const acpAgentPatchSchema = z
  .object({
    id: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
    name: z.string().trim().max(64).optional(),
    command: z.string().trim().min(1).max(4096),
    args: z.array(z.string().max(4096)).max(64).optional(),
    /** A blank value keeps the one already stored for that name; a name left out is removed. */
    env: z.record(z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(8192)).optional(),
    authMethod: z.string().trim().max(128).nullable().optional(),
  })
  .strict();

/** The dialog's Test: one saved entry, by id (its stored environment included). */
export const acpTestSchema = z.object({ id: z.string().trim().min(1).max(64) }).strict();

/** A change from the Settings dialog; omitted fields stay as they are. `password: null` removes it. */
export const settingsPatchSchema = z
  .object({
    port: z.number().int().min(1).max(65_535).optional(),
    host: z.enum(["127.0.0.1", "0.0.0.0"]).optional(),
    username: z.string().trim().max(64).optional(),
    password: z.string().max(1024).nullable().optional(),
    workspaceRoots: z.array(z.string().trim().min(1).max(4096)).max(64).optional(),
    allowedHosts: z.array(z.string().trim().min(1).max(255)).max(64).optional(),
    allowedTailscaleUsers: z.array(z.string().trim().min(1).max(255)).max(64).optional(),
    theme: themeChoiceSchema.nullable().optional(),
    textScale: z.number().min(0.5).max(2).nullable().optional(),
    chatWidth: chatWidthSchema.nullable().optional(),
    density: densitySchema.nullable().optional(),
    toolStyle: toolStyleSchema.nullable().optional(),
    font: uiFontSchema.nullable().optional(),
    autocollapseSidebar: z.boolean().optional(),
    showStatusBar: z.boolean().optional(),
    herdr: z.boolean().optional(),
    orchestrationEnabled: z.boolean().optional(),
    desktopBackground: z.boolean().optional(),
    /** The whole list, in order: what is missing is removed. A blank env value keeps the stored one. */
    acpAgents: z.array(acpAgentPatchSchema).max(16).optional(),
  })
  .strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

// ---- Board: rooms of named bots over the existing harnesses ----------------
//
// A room owns ordering, attribution, routing, and its own portable transcript
// (records); each membership owns a separate native harness session the room
// drives through the normal ChatManager. Wire types never carry a native
// session id or internal chat id: the browser knows members and invocations.

/** Bound for every Board payload; the plan's defaults (see .todo/awui.md §11). */
export const BOARD_MAX_BOTS = 100;
export const BOARD_MAX_ROOMS = 50;
export const BOARD_MAX_MEMBERS = 12;
export const BOARD_MAX_DIRECT_RESPONDERS = 4;
export const BOARD_CONSULT_DEPTH = 1;
export const BOARD_MAX_CONSULT_REQUESTS = 4;
export const BOARD_MAX_INVOCATIONS = 8;
export const BOARD_MAX_INVOCATIONS_PER_MEMBER = 3;
export const BOARD_TURN_WALL_CLOCK_MS = 180_000;
export const BOARD_QUEUE_MAX = 20;
/** The consult control document a direct responder may end with (§9). */
export const BOARD_CONTROL_MAX_BYTES = 16 * 1024;
/** Consultation questions are bounded apart from the message cap. */
export const BOARD_MAX_QUESTION_CHARS = 4_000;
/** Missed-history window per invocation: records and characters, with an explicit omission marker past it. */
export const BOARD_CONTEXT_MAX_RECORDS = 40;
export const BOARD_CONTEXT_MAX_CHARS = 24_000;
/** Records per snapshot or history page. */
export const BOARD_HISTORY_PAGE = 100;
/** Projected ChatItems kept per bot run (bounded like tool output). */
export const BOARD_MAX_RUN_ITEMS = 400;
export const BOARD_MAX_INSTRUCTIONS_CHARS = 8_000;
export const BOARD_MAX_BOT_NAME_CHARS = 64;
export const BOARD_MAX_ROLE_CHARS = 64;
/** A mention handle: safe characters, unique per room (case-insensitive). */
export const BOARD_HANDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** A reusable bot: one harness, one model, its own instructions. Credentials never appear here. */
export interface BotProfile {
  id: string;
  name: string;
  harnessId: string;
  /** `provider/id` as the harness's model list spells it; null is the harness default. */
  model: string | null;
  thinkingLevel: string | null;
  /** Sent with every invocation, so a native compaction cannot erase Board behavior. */
  instructions: string;
  /** Informational label (lead, researcher, critic); the server routes by mention, never by role. */
  role: string;
  /** A theme accent token, never a hard-coded colour. */
  accent: string | null;
  /** The harness's own mode id, only when it declares permission modes. */
  permissionMode: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/** A bot's identity inside one room: what mentions, rank, and consultation policy attach to. */
export interface RoomMemberView {
  id: string;
  botId: string;
  name: string;
  handle: string;
  /** Display and serial response order; ties break by member id. */
  rank: number;
  canLead: boolean;
  consultable: boolean;
  /** Member ids this one may consult; the server is the only routing authority. */
  consultants: string[];
  /** Disabled members never run and cannot be picked as lead. */
  enabled: boolean;
  accent: string | null;
  harnessId: string;
  model: string | null;
  thinkingLevel: string | null;
  role: string;
  permissionMode: string | null;
}

/** A room's spend caps, editable through PATCH /api/rooms/:id. */
export interface RoomBudgets {
  maxDirectResponders: number;
  maxConsultRequests: number;
  maxInvocations: number;
  maxInvocationsPerMember: number;
  turnWallClockMs: number;
  queueMax: number;
}

/** A room's shape as the room view and the `room` event carry it. */
export interface RoomInfo {
  id: string;
  name: string;
  topic: string | null;
  workspaceId: string;
  workspaceName: string;
  archived: boolean;
  /** Null when the lead was removed and no canLead member remains: the composer explains instead of running. */
  leadMemberId: string | null;
  members: RoomMemberView[];
  budgets: RoomBudgets;
}

/** A rooms-list row. */
export interface RoomSummary {
  id: string;
  name: string;
  topic: string | null;
  archived: boolean;
  leadName: string | null;
  memberCount: number;
  status: "idle" | "queued" | "running" | "waiting";
  pendingCount: number;
  lastActivityAt: number | null;
  usage: BoardUsage;
}

/** Tokens and calls over some invocations; `cost` null means nothing was priced (never zero). */
export interface BoardUsage {
  turns: number;
  steps: number;
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
  cost: number | null;
  /** Invocations the harness did not price. */
  unpriced: number;
}

/** One entry in a room's portable transcript. Bot runs are upserted by id (a running run settles in place). */
export type RoomRecord =
  | { kind: "user"; id: string; seq: number; at: number; turnId: string; text: string; mentions: string[] }
  | {
      kind: "bot_run";
      id: string;
      seq: number;
      at: number;
      turnId: string;
      memberId: string;
      invocationId: string;
      /** The consultation record this run answers, when it is a consultant's run. */
      consultOf?: string;
      status: "running" | "done" | "failed" | "stopped";
      model: string | null;
      /** The effort level in force at settlement, from the confirmed ChatConfig (null when the harness has none). */
      thinkingLevel?: string | null;
      /** The invocation's own projected items, ids namespaced `<invocationId>:<itemId>`. */
      items: ChatItem[];
      usage: BoardUsage | null;
      /** Wall clock of the invocation, when it ran to a settle. */
      latencyMs: number | null;
      error?: string;
    }
  | { kind: "consultation"; id: string; seq: number; at: number; turnId: string; fromMemberId: string; toMemberId: string; question: string; outcome: "requested" | "refused" | "answered" | "failed"; reason?: string }
  | { kind: "notice"; id: string; seq: number; at: number; turnId: string | null; level: "info" | "warning" | "error"; text: string };

export type RoomTurnState = "queued" | "running" | "waiting_for_user" | "stopping" | "stopped" | "done" | "failed" | "interrupted";

/** One user turn as the room shows it (the queue's rows and the active one). */
export interface RoomTurnView {
  id: string;
  state: RoomTurnState;
  text: string;
  mentions: string[];
  directMemberIds: string[];
  queuedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** Invocations spent so far, beside Stop, so the caps are not mysterious. */
  invocationCount: number;
  consultCount: number;
  stopReason?: string;
}

/** An approval a bot's harness raised, surfaced in the room; only the user answers it. */
export interface RoomPendingRequest {
  /** Namespaced `<invocationId>:<requestId>`, what the answer route takes. */
  id: string;
  turnId: string;
  memberId: string;
  invocationId: string;
  request: InteractionRequest;
}

/** The whole room as a fresh viewer gets it: shape, a page of records, and the live state. */
export interface RoomSnapshot {
  room: RoomInfo;
  /** Newest last, at most BOARD_HISTORY_PAGE; older ones come from the history route. */
  records: RoomRecord[];
  activeTurn: RoomTurnView | null;
  queued: RoomTurnView[];
  pending: RoomPendingRequest[];
  usage: BoardUsage;
  lastEventId: number;
}

/** Room SSE, the same snapshot/replay semantics as ordinary Chat SSE. */
export type RoomEvent =
  | { type: "snapshot"; snapshot: RoomSnapshot }
  | { type: "record"; record: RoomRecord }
  | { type: "item"; invocationId: string; item: ChatItem }
  | { type: "delta"; invocationId: string; itemId: string; field: "text" | "thinking" | "output"; append: string }
  | { type: "turn"; turn: RoomTurnView }
  | { type: "queue"; queued: RoomTurnView[] }
  | { type: "request"; request: RoomPendingRequest }
  | { type: "request_resolved"; requestId: string; outcome: string }
  | { type: "usage"; usage: BoardUsage }
  | { type: "room"; room: RoomInfo }
  | { type: "disposed"; reason: string };

export const botCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(BOARD_MAX_BOT_NAME_CHARS),
    harnessId: z.string().min(1).max(64),
    model: z.string().min(1).max(512).nullable().optional(),
    thinkingLevel: z.string().min(1).max(32).nullable().optional(),
    instructions: z.string().max(BOARD_MAX_INSTRUCTIONS_CHARS).optional(),
    role: z.string().max(BOARD_MAX_ROLE_CHARS).optional(),
    accent: z.string().min(1).max(32).nullable().optional(),
    permissionMode: z.string().min(1).max(64).nullable().optional(),
  })
  .strict();
export const botPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(BOARD_MAX_BOT_NAME_CHARS).optional(),
    model: z.string().min(1).max(512).nullable().optional(),
    thinkingLevel: z.string().min(1).max(32).nullable().optional(),
    instructions: z.string().max(BOARD_MAX_INSTRUCTIONS_CHARS).optional(),
    role: z.string().max(BOARD_MAX_ROLE_CHARS).optional(),
    accent: z.string().min(1).max(32).nullable().optional(),
    permissionMode: z.string().min(1).max(64).nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "empty patch" });

/** A member as room creation and member-add spell it. */
const memberShape = {
  botId: z.string().min(1).max(64),
  handle: z.string().regex(BOARD_HANDLE_PATTERN),
  rank: z.number().int().min(0).max(999),
  canLead: z.boolean(),
  consultable: z.boolean(),
  consultants: z.array(z.string().min(1).max(64)).max(BOARD_MAX_MEMBERS),
};
export const roomCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    topic: z.string().max(500).nullable().optional(),
    workspaceId: z.string().min(1).max(128),
    /** members[0] is the lead; `leadBotId` names another member instead. */
    members: z
      .array(
        z
          .object({
            botId: memberShape.botId,
            handle: memberShape.handle.optional(),
            rank: memberShape.rank.optional(),
            canLead: memberShape.canLead.optional(),
            consultable: memberShape.consultable.optional(),
            consultants: memberShape.consultants.default([]),
          })
          .strict(),
      )
      .min(1)
      .max(BOARD_MAX_MEMBERS),
    leadBotId: z.string().min(1).max(64).optional(),
  })
  .strict();
export const roomPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    topic: z.string().max(500).nullable().optional(),
    archived: z.boolean().optional(),
    leadMemberId: z.string().min(1).max(64).optional(),
    budgets: z
      .object({
        maxDirectResponders: z.number().int().min(1).max(BOARD_MAX_DIRECT_RESPONDERS).optional(),
        maxConsultRequests: z.number().int().min(0).max(BOARD_MAX_CONSULT_REQUESTS).optional(),
        maxInvocations: z.number().int().min(1).max(BOARD_MAX_INVOCATIONS).optional(),
        maxInvocationsPerMember: z.number().int().min(1).max(BOARD_MAX_INVOCATIONS_PER_MEMBER).optional(),
        turnWallClockMs: z.number().int().min(10_000).max(600_000).optional(),
        queueMax: z.number().int().min(0).max(BOARD_QUEUE_MAX).optional(),
      })
      .strict()
      .optional(),
  })
  .refine((v) => v.name !== undefined || v.topic !== undefined || v.archived !== undefined || v.leadMemberId !== undefined || v.budgets !== undefined, { message: "empty patch" });
export const memberAddSchema = z
  .object({
    botId: memberShape.botId,
    handle: memberShape.handle,
    rank: memberShape.rank.optional(),
    canLead: memberShape.canLead.optional(),
    consultable: memberShape.consultable.optional(),
    consultants: memberShape.consultants.default([]),
  })
  .strict();
export const memberPatchSchema = z
  .object({
    handle: memberShape.handle.optional(),
    rank: memberShape.rank.optional(),
    canLead: memberShape.canLead.optional(),
    consultable: memberShape.consultable.optional(),
    consultants: memberShape.consultants.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "empty patch" });
export const roomMessageSchema = z.object({
  text: z.string().min(1).max(MAX_MESSAGE_CHARS),
  /** Membership ids the message addresses; empty means the lead only. The server validates count and membership. */
  mentions: z.array(z.string().min(1).max(64)).max(BOARD_MAX_MEMBERS),
  /** Idempotency key: a network retry must not post the user message twice. */
  clientId: z.string().min(1).max(128).optional(),
}).strict();
export const roomAnswerSchema = z.object({ answer: interactionAnswerSchema }).strict();
export const roomHistoryQuery = z.object({ before: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(BOARD_HISTORY_PAGE).optional() });
