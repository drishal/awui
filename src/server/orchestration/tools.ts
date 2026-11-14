// The orchestration surface an agent sees: the tools that let one chat delegate work to
// another harness, watch it, talk to it, and read the result back, plus the one status
// line it sets for the person watching. This file is the one
// place a tool is defined — the Pi/omp/awui extension and the MCP bridge both fetch this
// catalogue from GET /api/orchestration/tools, so a name, a description, and a parameter
// schema exist once. Each tool also has a Zod schema here, applied by orchestrator.ts
// before any work starts: a bridge forwards what the model sent and decides nothing
// itself, which is also why these schemas live here and not in protocol.ts (no browser
// ever sees them).
import { z } from "zod";
import type { AgentStatusState, BotProfile } from "../../shared/protocol.js";
import type { AgentProfileConfig } from "../config.js";
import type { BoardManager } from "../boards/types.js";
import { ChatError, type Chat } from "../chats/chat.js";
import type { AgentStatuses } from "../agent-status.js";
import { noteAgentStatus } from "../overview-events.js";
import type { HarnessRegistry } from "../harness/registry.js";
import type { Workspaces } from "../workspaces.js";

/** A brief or a follow-up an agent sends a child: bounded, because it becomes a prompt. */
export const MAX_DELEGATE_BRIEF_CHARS = 32_000;
/** How often a heartbeat may beat: at least 5 minutes apart, at most once a day. */
export const MIN_HEARTBEAT_INTERVAL_MS = 5 * 60_000;
export const MAX_HEARTBEAT_INTERVAL_MS = 24 * 60 * 60_000;
/** A heartbeat runs at most this many times, so a forgotten one cannot run for ever. */
export const MAX_HEARTBEAT_RUNS = 10_000;
/** How many tasks one turn may wait on at once. */
export const MAX_WAIT_TASKS = 4;
/** A wait's own cap: under a proxy's idle timeout, over a quick tool call. */
export const MAX_WAIT_MS = 110_000;
export const DEFAULT_WAIT_MS = 55_000;
/** Profiles one call may list, and the note a bot contributes. */
export const MAX_PROFILES = 64;
export const MAX_PROFILE_NOTE_CHARS = 120;
/** The write scope's bounds (scope.ts judges with them): globs one delegation may carry. */
import { MAX_WRITE_SCOPE_GLOBS, MAX_GLOB_CHARS } from "./scope.js";
import { residentName } from "./residents.js";
export { MAX_WRITE_SCOPE_GLOBS, MAX_GLOB_CHARS };

const taskId = z.string().regex(/^[0-9a-f]{4,16}$/);
const nameSchema = z.string().transform((s: string) => residentName(s));
export const residentAgentSchema = z.object({
  name: nameSchema,
  profile: z.string().min(1).max(128).optional(),
  workspaceId: z.string().min(1).max(128).optional(),
  prompt: z.string().max(MAX_DELEGATE_BRIEF_CHARS).optional(),
  note: z.object({ key: z.string().trim().min(1).max(80), text: z.string().min(1).max(4_000) }).optional(),
  forget: z.string().trim().min(1).max(80).optional(),
}).strict();

export const listProfilesSchema = z.object({ workspaceId: z.string().min(1).max(128).optional() }).strict();

export const delegateTaskSchema = z
  .object({
    brief: z.string().min(1).max(MAX_DELEGATE_BRIEF_CHARS),
    harness: z.string().min(1).max(64).optional(),
    profile: z.string().min(1).max(128).optional(),
    model: z.string().min(1).max(512).optional(),
    thinkingLevel: z.string().min(1).max(64).optional(),
    permissionMode: z.string().min(1).max(64).optional(),
    role: z.string().min(1).max(64).optional(),
    title: z.string().min(1).max(120).optional(),
    workspaceId: z.string().min(1).max(128).optional(),
    isolation: z.enum(["worktree"]).optional(),
    notify: z.enum(["wake", "none"]).optional(),
    clientRequestId: z.string().min(1).max(128).optional(),
    completionGroup: z.string().min(1).max(128).optional(),
    writeScope: z.array(z.string().min(1).max(MAX_GLOB_CHARS)).max(MAX_WRITE_SCOPE_GLOBS).optional(),
  })
  .strict();

export const taskStatusSchema = z.object({ taskId: taskId.optional() }).strict();

export const taskCancelSchema = z.object({ taskId }).strict();

/** One review-state report, as the caller's model reads it. */
export const taskReviewSchema = z.object({ taskId }).strict();

export const threadSendSchema = z.object({ taskId, text: z.string().min(1).max(MAX_DELEGATE_BRIEF_CHARS) }).strict();

export const threadReadSchema = z
  .object({ taskId, before: z.number().int().min(0).max(10_000).optional(), limit: z.number().int().min(1).max(200).optional() })
  .strict();

export const threadWaitSchema = z
  .object({ taskIds: z.array(taskId).min(1).max(MAX_WAIT_TASKS), waitMs: z.number().int().min(0).max(MAX_WAIT_MS).optional() })
  .strict();

export { planProposalSchema } from "./plans.js";
const planEditContent = z.object({ title: z.string(), tasks: z.unknown(), maxParallel: z.number().int().min(1).max(4) }).strict();
const planAttempt = { clientRequestId: z.string().min(1).max(128).optional() };
export const planEditSchema = z.discriminatedUnion("action", [
  planEditContent.extend({ action: z.literal("save"), planId: z.string().regex(/^[0-9a-f]{8,32}$/).optional(), ...planAttempt }).strict(),
  z.object({ action: z.enum(["confirm", "cancel"]), planId: z.string().regex(/^[0-9a-f]{8,32}$/), ...planAttempt }).strict(),
]);

/** One status line, as the agent sets it: a state, and the sentence a person reads. */
export const MAX_STATUS_COMMENT_CHARS = 200;

/** One decision a worker may park on: a bounded question, at most a handful of options, and the
 * caller's own stable id that makes a retry safe. */
export const MAX_DECISION_IDS = 4;

export const requestDecisionSchema = z
  .object({
    question: z.string().trim().min(1).max(200),
    message: z.string().trim().max(2_000).optional(),
    kind: z.enum(["confirm", "select"]).default("confirm"),
    options: z.array(z.string().trim().min(1).max(200)).max(6).optional(),
    decisionId: z.string().trim().min(1).max(128),
    waitMs: z.number().int().min(0).max(MAX_WAIT_MS).optional(),
  })
  .strict();

export const setStatusSchema = z
  .object({
    status: z.enum(["working", "blocked", "review", "done"]),
    comment: z.string().trim().max(MAX_STATUS_COMMENT_CHARS).default(""),
  })
  .strict();

/**
 * An agent heartbeat: a prompt on an interval, delivered to the chat that scheduled it
 * — never to one the arguments name. The owner identity and workspace come from the
 * calling chat server-side; `cancelId` cancels this chat's own heartbeat by id.
 */
export const scheduleHeartbeatSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    prompt: z.string().trim().min(1).max(MAX_DELEGATE_BRIEF_CHARS),
    intervalMs: z.number().int().min(MIN_HEARTBEAT_INTERVAL_MS).max(MAX_HEARTBEAT_INTERVAL_MS),
    maxRuns: z.number().int().min(1).max(MAX_HEARTBEAT_RUNS).optional(),
    cancelId: z.string().min(1).max(64).optional(),
  })
  .strict();

/** One tool as the bridges register it: the name, the words the model reads, and JSON Schema for its arguments. */
export interface OrchTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const object = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

const stringProperty = (description: string, maxLength?: number): Record<string, unknown> => ({
  type: "string",
  description,
  ...(maxLength !== undefined ? { maxLength } : {}),
});

const DEFINED_TOOLS: OrchTool[] = [
  {
    name: "delegate_task",
    description:
      "Delegate one self-contained task to a fresh agent chat and return at once; the work runs in the background. " +
      "The child is an ordinary chat in this project, so it shares your working tree: never delegate edits that would collide with your own. " +
      "Write the brief as a complete instruction — the child sees none of this conversation — saying what to change and how to verify it. " +
      "Follow it with thread_wait or task_status for the outcome, thread_read for its transcript, and thread_send to continue it.",
    parameters: object(
      {
        brief: stringProperty("The complete task, as a prompt the child reads on its own.", MAX_DELEGATE_BRIEF_CHARS),
        harness: stringProperty("Harness id for the child (see list_profiles); defaults to this chat's harness."),
        profile: stringProperty("A saved bot profile id from list_profiles; its harness, model, and mode apply."),
        model: stringProperty("Model key for the child, as its harness spells it."),
        thinkingLevel: stringProperty("Thinking level, when the child's harness has them."),
        permissionMode: stringProperty("Permission mode; never broader than this chat's own."),
        role: stringProperty("What the child is for (review, research, test): a label, shown in the task list.", 64),
        title: stringProperty("A short name for the task; defaults to the brief's first line.", 120),
        workspaceId: stringProperty("Project id to work in; defaults to this chat's project."),
        isolation: { type: "string", enum: ["worktree"], description: "Run the child in its own managed worktree of this project instead of your shared working tree, so its edits cannot collide with yours. Its finished work is recorded for review and applied into your checkout only after a person reviews it." },
        notify: { type: "string", enum: ["wake", "none"], description: "Wake this chat with the result when the child finishes (default), or report only when asked." },
        clientRequestId: stringProperty("A key for this request: sending it twice returns the same task instead of spawning another."),
        completionGroup: stringProperty("Optional label: related delegated results wait for every group member before a single consolidated wake reaches the parent."),
        writeScope: {
          type: "array",
          items: { type: "string", maxLength: MAX_GLOB_CHARS },
          maxItems: MAX_WRITE_SCOPE_GLOBS,
          description:
            "Globs (project-relative) the child's file writes must match, so its edits stay inside its assignment; its private scratch dir is always allowed. Omit it for work that may touch the whole project.",
        },
      },
      ["brief"],
    ),
  },
  {
    name: "resident_agent",
    description:
      "Create or resume one named ordinary chat and send it the next prompt, rather than starting another agent chat for the same purpose. " +
      "Its native session persists across reopen, hibernation, and a server restart; opening one session at a time avoids two writers. " +
      "note saves a bounded short-lived fact for future turns, redacted for credential-shaped material; never copy a transcript or credentials into it. " +
      "Omit prompt and name to list your own residencies, or supply forget to remove one note without hiding/deleting the agent's native historical session.",
    parameters: object(
      {
        name: stringProperty("Stable lowercase purpose name, unique within your chat; optional only when listing residents.", 80),
        profile: stringProperty("A saved bot/shared profile id (see list_profiles), with real harness/model/mode preferences matching the actual chat."),
        workspaceId: stringProperty("Optional project identifier (defaults to this chat's project)."),
        prompt: stringProperty("Send the next ordinary prompt to this named agent; it must be idle to avoid one session getting two writers.", MAX_DELEGATE_BRIEF_CHARS),
        note: { type: "object", properties: { key: { type: "string", description: "A continuity key (1-80 chars)" }, text: { type: "string", description: "Small fact, redacted of credentials; future turns receive it" } }, required: ["key", "text"], additionalProperties: false, description: "Persist one bounded fact for this residency." },
        forget: stringProperty("Forget this note key only; native transcript stays in its harness."),
      },
    ),
  },
  {
    name: "task_review",
    description:
      "Report how a finished isolated task stands with a person: unreviewed (waiting), applied into the lead checkout, discarded, or stale (the recorded heads moved, so the apply is guarded). " +
      "With a taskId, that one task alone.",
    parameters: object({ taskId: stringProperty("The isolated task to report.") }, ["taskId"]),
  },
  {
    name: "task_status",
    description:
      "Report how your delegated tasks stand: state, harness and model, how long they have run, their last line, and their result once finished. " +
      "With a taskId, that one task alone.",
    parameters: object({ taskId: stringProperty("The task to report; omit it to list every task this chat started.") }),
  },
  {
    name: "plan_workers",
    description:
      "Draft and edit a lead/worker plan before anyone starts work. save with no planId creates a draft; another save edits its tasks, harness/model, write scopes and dependencies. " +
      "Confirm runs independent tasks in at most 4 parallel workers using the real catalog; dependencies start only after the previous ones succeed. Save is always free and confirm is the only start. " +
      "Cancel closes the proposal (never a running worker). Completed workers still require review before integration.",
    parameters: {
      type: "object",
      oneOf: [
        object({ action: { type: "string", enum: ["save"] }, planId: stringProperty("Existing draft to replace; omit to create a draft."), title: stringProperty("Proposal title", 160), tasks: { type: "array", items: { type: "object" }, minItems: 1, maxItems: 16 }, maxParallel: { type: "integer", minimum: 1, maximum: 4 } }, ["action", "title", "tasks", "maxParallel"]),
        object({ action: { type: "string", enum: ["confirm", "cancel"] }, planId: stringProperty("The draft to start or close.") }, ["action", "planId"]),
      ],
    },
  },
  {
    name: "task_cancel",
    description: "Stop one of your delegated tasks: its run is aborted and the tasks below it cancelled first. Idempotent: a finished task comes back unchanged.",
    parameters: object({ taskId: stringProperty("The task to stop.") }, ["taskId"]),
  },
  {
    name: "thread_send",
    description:
      "Send more text to a delegated task's chat, continuing where it left off: steered into a running turn, or sent as a new prompt when it is idle. " +
      "After a task reported its result, this puts it back to work.",
    parameters: object({ taskId: stringProperty("The task to talk to."), text: stringProperty("What to send the child.", MAX_DELEGATE_BRIEF_CHARS) }, ["taskId", "text"]),
  },
  {
    name: "thread_read",
    description: "Read a delegated task's chat, newest last: what it is doing now and what it already said. Images are left out.",
    parameters: object(
      {
        taskId: stringProperty("The task whose transcript to read."),
        before: { type: "integer", minimum: 0, description: "Skip that many of the newest items, to page backwards." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Items to return (default 40)." },
      },
      ["taskId"],
    ),
  },
  {
    name: "thread_wait",
    description:
      "Wait until the given tasks have finished or one of them is asking you a question, then report them as task_status does. " +
      "An approval raised in a child does not end the wait (the user already sees it); a question does. " +
      "Returns at once when every task is already finished or asking.",
    parameters: object(
      {
        taskIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_WAIT_TASKS, description: "The tasks to wait on (1-4)." },
        waitMs: { type: "integer", minimum: 0, maximum: MAX_WAIT_MS, description: `How long to wait, in ms (default ${DEFAULT_WAIT_MS}, at most ${MAX_WAIT_MS}).` },
      },
      ["taskIds"],
    ),
  },
  {
    name: "set_status",
    description:
      "Set this chat's status line: one word for where the work stands and one short sentence saying what you are doing or waiting on. " +
      "A person reads it in the sidebar's row and the chat's header without opening the chat, so use it when you are stuck, finished, or working on something long. " +
      "It replaces the previous line; set it again when it changes.",
    parameters: object(
      {
        status: { type: "string", enum: ["working", "blocked", "review", "done"], description: "working: still on it; blocked: waiting on something; review: ready for a person; done: finished." },
        comment: stringProperty("One sentence for the person watching: what you are doing, or what you need.", MAX_STATUS_COMMENT_CHARS),
      },
      ["status"],
    ),
  },
  {
    name: "request_decision",
    description:
      "Ask the person for an explicit decision only they can make — an approach to take, a trade-off to accept, a resource to spend — and wait for the answer. " +
      "The question appears as a regular prompt on this chat, which the person sees; approvals and questions the harness itself raises are not yours to send. " +
      "The call parks until the person answers (or waitMs passes) and then returns the recorded answer verbatim; a denial's corrective reason rides beside it. " +
      "The person is the only one who answers: never guess, never proceed without the answer, and never ask twice for the same decision — " +
      "pass the same decisionId to re-read an answer you have already asked for.",
    parameters: object(
      {
        question: stringProperty("The decision, as one short question the person reads on its own.", 200),
        message: stringProperty("Context for the question: the options' trade-offs, what each costs.", 2_000),
        kind: { type: "string", enum: ["confirm", "select"], description: "confirm: a yes/no question; select: one of the options you list." },
        options: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 6, description: "The choices, for kind select (2-6); each one line." },
        decisionId: stringProperty("A stable id for this decision, unique within this task: asking again with it returns the recorded answer instead of asking twice.", 128),
        waitMs: { type: "integer", minimum: 0, maximum: MAX_WAIT_MS, description: `How long to wait for the answer, in ms (default ${DEFAULT_WAIT_MS}, at most ${MAX_WAIT_MS}).` },
      },
      ["question", "decisionId"],
    ),
  },
  {
    name: "list_profiles",
    description:
      "List the workers you can delegate to: this project's saved bot profiles and one entry per installed harness at its default model. " +
      "Use it to pick a harness, model, and provider — a council picks distinct providers from this list.",
    parameters: object({ workspaceId: stringProperty("Project id to list for; defaults to this chat's project.") }),
  },
  {
    name: "schedule_heartbeat",
    description:
      "Schedule a prompt this chat itself receives on an interval (5 minutes to a day apart), so you can pick long work back up without anyone prompting you. " +
      "The prompt is delivered to this exact chat session, including after it is closed and reopened, until it reaches maxRuns or is cancelled. " +
      "With cancelId, cancel one of this chat's own heartbeats by id instead of scheduling. The schedule survives a server restart; no other chat can receive it.",
    parameters: object(
      {
        name: stringProperty("A short name for the heartbeat, shown in the Routines dialog.", 80),
        prompt: stringProperty("What to send this chat on each due run.", MAX_DELEGATE_BRIEF_CHARS),
        intervalMs: { type: "integer", minimum: MIN_HEARTBEAT_INTERVAL_MS, maximum: MAX_HEARTBEAT_INTERVAL_MS, description: `How often to beat, in ms (at least ${MIN_HEARTBEAT_INTERVAL_MS}, at most ${MAX_HEARTBEAT_INTERVAL_MS}).` },
        maxRuns: { type: "integer", minimum: 1, description: `Stop after this many runs (at most ${MAX_HEARTBEAT_RUNS}); omit for the cap.` },
        cancelId: stringProperty("Cancel this chat's heartbeat with this id instead of scheduling a new one."),
      },
      ["name", "prompt", "intervalMs"],
    ),
  },
];

/** What a harness is told these tools are: a model that sees `delegate_task` in a list has no way to know whose it is. */
export const AWUI_TOOL_BRAND = "awui";

/**
 * The catalogue every bridge serves (the Pi/omp extension, the MCP bridge, OpenCode's and Codex's own
 * registrations). Each description opens with the brand, so a harness that lists its tools by description
 * (Pi's "Available tools", an MCP client's tool picker) shows these as awui's, not as anonymous names.
 */
export const ORCH_TOOLS: OrchTool[] = DEFINED_TOOLS.map((tool) => ({ ...tool, description: `${AWUI_TOOL_BRAND}: ${tool.description}` }));

/**
 * What a harness is told about these tools once, beyond each description: whose they are, when they are worth
 * reaching for, and the one habit that goes wrong (polling). Served by `GET /tools` (the Pi/omp extension puts it
 * in Pi's system prompt), as the MCP server's `instructions` over HTTP and stdio (Claude Code shows it with the
 * server), so every route says the same words. Kept under 4,000 bytes: Codex truncates a longer instruction.
 */
export const ORCH_INSTRUCTIONS = `## awui

awui is the web UI running this chat. It serves the orchestration tools itself (${DEFINED_TOOLS.map((tool) => tool.name).join(", ")}), not an MCP server from your config. Ordinary coding tasks need none of them.

Delegating
- Use delegate_task when a self-contained piece of work should run in another awui chat: a different harness or model, a second opinion, or work that can run in parallel. The child sees none of this conversation, so write a complete brief. It shares your working tree unless you pass isolation:"worktree".
- Call list_profiles before naming a harness or model. It also states your budget: delegation levels left, and how many more tasks may run at once (a finished task frees its slot). Read it there; don't work it out yourself.
- After delegating, thread_wait blocks until the child finishes or asks a question. Never poll in a loop. task_status shows where your tasks stand, thread_read what a child said, thread_send continues it, task_cancel stops a run you no longer need.
- plan_workers drafts a lead/worker plan for a person to confirm before any worker starts. resident_agent keeps one named chat to come back to.
- As a delegated child, do the work yourself; start no further delegates unless your task says to.

Talking to the person
- set_status tells the person watching what you are doing (one word, one sentence). request_decision asks a question only they can answer and waits. schedule_heartbeat prompts this chat on an interval so long work can resume unattended.
- Write plain Markdown. Inline HTML tags (<small>, <br>) are shown as text, not rendered. When you have render_html, use it for a table, chart, diagram or mockup, and browser_action to look at the page you rendered.

Skills (ask for one by name when the user's request matches)
- council: "council this diff", "put three models on it". Three reviewers from three model families, one merged verdict.
- advisor: "ask an advisor", "what would another model say". One read-only second opinion.
- handoff: "hand this to a fresh agent". A zero-context briefing, delegated as a new chat.
Where your client lists MCP prompts, use them. Otherwise read one with: curl -s -H "X-Awui-Orch-Token: $AWUI_ORCH_TOKEN" "$AWUI_ORCH_URL/prompts?name=council".`;

/** One worker an agent can ask for by id: a saved bot profile, a shared profile, or a harness at its default model. */
export interface ToolProfile {
  id: string;
  source: "bot" | "harness" | "shared";
  name: string;
  harnessId: string;
  harnessName: string;
  available: boolean;
  model: string | null;
  provider: string | null;
  thinkingLevel: string | null;
  permissionMode: string | null;
  role: string | null;
  note: string | null;
}

/** What a listing tool needs to answer: the calling chat, and what this server knows about it. */
export interface ToolContext {
  /** The chat whose child is calling: every call is authorized as this one chat. */
  chat: Chat;
  registry: HarnessRegistry;
  workspaces: Workspaces;
  boards?: BoardManager;
  /** The shared agent profiles (config.yml's `agent_profiles:`); absent leaves none to list. */
  profiles?: () => AgentProfileConfig[];
}

/** What a tool answers: the line the model reads, and the facts behind it. */
export interface ToolOutput {
  text: string;
  data: unknown;
}

export function findTool(name: string): OrchTool | undefined {
  return ORCH_TOOLS.find((tool) => tool.name === name);
}

/**
 * `set_status`: the one tool that writes rather than reads. The line is kept per native
 * session by agent-status.ts and published on the overview stream, so the sidebar's row
 * and the chat's header show it without a reload. A chat the harness has not yet named
 * has no session to key it on, and says so instead of dropping the line.
 */
export async function setStatus(chat: Chat, args: { status: AgentStatusState; comment: string }, statuses: AgentStatuses | undefined): Promise<ToolOutput> {
  if (!statuses) throw new ChatError(404, "status_off", "Status lines are not wired on this server");
  if (!chat.sessionId) throw new ChatError(409, "no_session", "This chat has no session yet; set a status once the harness has named it");
  const sessionId = chat.sessionId;
  const line = await statuses.set(sessionId, args.status, args.comment);
  noteAgentStatus(sessionId, line);
  return { text: `Status set: ${line.state}${line.comment ? ` — ${line.comment}` : ""}`, data: line };
}


/** A model key is `provider/id`, so its provider is the part before the first slash. */
function providerOf(model: string | null): string | null {
  if (!model) return null;
  const at = model.indexOf("/");
  return at > 0 ? model.slice(0, at) : null;
}

function firstLine(text: string): string | null {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  return line.length > MAX_PROFILE_NOTE_CHARS ? `${line.slice(0, MAX_PROFILE_NOTE_CHARS - 1)}…` : line;
}

async function botProfile(bot: BotProfile, registry: HarnessRegistry): Promise<ToolProfile> {
  const adapter = registry.get(bot.harnessId);
  return {
    id: bot.id,
    source: "bot",
    name: bot.name,
    harnessId: bot.harnessId,
    harnessName: adapter?.displayName ?? bot.harnessId,
    available: adapter !== undefined && (await registry.available(adapter.id)),
    model: bot.model,
    provider: providerOf(bot.model),
    thinkingLevel: bot.thinkingLevel,
    permissionMode: bot.permissionMode,
    role: bot.role === "" ? null : bot.role,
    note: firstLine(bot.instructions),
  };
}

/** A shared profile, keyed `shared:<name>` so it reads the same in a URL and a delegation call. */
async function sharedProfile(profile: AgentProfileConfig, registry: HarnessRegistry): Promise<ToolProfile> {
  const adapter = registry.get(profile.harness);
  return {
    id: `shared:${profile.name}`,
    source: "shared",
    name: profile.name,
    harnessId: profile.harness,
    harnessName: adapter?.displayName ?? profile.harness,
    available: adapter !== undefined && (await registry.available(adapter.id)),
    model: profile.model,
    provider: providerOf(profile.model),
    thinkingLevel: profile.thinking,
    permissionMode: profile.permissionMode,
    role: null,
    note: profile.note,
  };
}

/**
 * A chat's delegation budget in the words an agent should repeat, not recompute: depth is how many
 * more generations may delegate; tasks is how many more may run at once, since a finished task
 * gives its slot back (the lifetime and server-wide caps only ever lower the figure).
 */
export function budgetLine(remainingDepth: number, remainingTasks: number): string {
  return `Delegation budget: ${remainingDepth} level(s) left; ${remainingTasks} more task(s) may run at once (a finished task frees its slot).`;
}

/** Every worker this project offers, with what a delegation from this chat still has room for. */
export async function listProfiles(
  ctx: ToolContext,
  args: { workspaceId?: string },
  limits: { remainingDepth: number; remainingTasks: number },
): Promise<ToolOutput> {
  const workspace = args.workspaceId ? await ctx.workspaces.get(args.workspaceId) : ctx.chat.workspace;
  const bots = ctx.boards ? await ctx.boards.listBots() : [];
  const shared = ctx.profiles ? ctx.profiles() : [];
  const profiles: ToolProfile[] = [];
  for (const bot of bots.slice(0, MAX_PROFILES)) profiles.push(await botProfile(bot, ctx.registry));
  for (const profile of shared.slice(0, Math.max(0, MAX_PROFILES - profiles.length))) profiles.push(await sharedProfile(profile, ctx.registry));
  // A read-only harness is never a delegation target: the child would carry the tools it denies.
  for (const adapter of ctx.registry.list()) {
    if (adapter.capabilities.readOnlyHarness) continue;
    profiles.push({
      id: `harness:${adapter.id}`,
      source: "harness",
      name: adapter.displayName,
      harnessId: adapter.id,
      harnessName: adapter.displayName,
      available: await ctx.registry.available(adapter.id),
      model: null,
      provider: null,
      thinkingLevel: null,
      permissionMode: null,
      role: null,
      note: null,
    });
  }
  const { remainingDepth, remainingTasks } = limits;
  const lines = profiles.map((p) => {
    const parts = [p.id, p.name, p.harnessName];
    if (p.model) parts.push(p.model);
    if (p.role) parts.push(p.role);
    if (!p.available) parts.push("unavailable");
    if (p.note) parts.push(p.note);
    return `- ${parts.join(" · ")}`;
  });
  const text = [
    `${profiles.length} profiles in project "${workspace.name}".`,
    ...lines,
    budgetLine(remainingDepth, remainingTasks),
  ].join("\n");
  return { text, data: { profiles, workspace, remainingDepth, remainingTasks } };
}
