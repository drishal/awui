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
import type { BoardManager } from "../boards/types.js";
import { ChatError, type Chat } from "../chats/chat.js";
import type { AgentStatuses } from "../agent-status.js";
import { noteAgentStatus } from "../overview-events.js";
import type { HarnessRegistry } from "../harness/registry.js";
import type { Workspaces } from "../workspaces.js";

/** A brief or a follow-up an agent sends a child: bounded, because it becomes a prompt. */
export const MAX_DELEGATE_BRIEF_CHARS = 32_000;
/** How many tasks one turn may wait on at once. */
export const MAX_WAIT_TASKS = 4;
/** A wait's own cap: under a proxy's idle timeout, over a quick tool call. */
export const MAX_WAIT_MS = 110_000;
export const DEFAULT_WAIT_MS = 55_000;
/** Profiles one call may list, and the note a bot contributes. */
export const MAX_PROFILES = 64;
export const MAX_PROFILE_NOTE_CHARS = 120;

const taskId = z.string().regex(/^[0-9a-f]{4,16}$/);

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
    notify: z.enum(["wake", "none"]).optional(),
    clientRequestId: z.string().min(1).max(128).optional(),
  })
  .strict();

export const taskStatusSchema = z.object({ taskId: taskId.optional() }).strict();

export const taskCancelSchema = z.object({ taskId }).strict();

export const threadSendSchema = z.object({ taskId, text: z.string().min(1).max(MAX_DELEGATE_BRIEF_CHARS) }).strict();

export const threadReadSchema = z
  .object({ taskId, before: z.number().int().min(0).max(10_000).optional(), limit: z.number().int().min(1).max(200).optional() })
  .strict();

export const threadWaitSchema = z
  .object({ taskIds: z.array(taskId).min(1).max(MAX_WAIT_TASKS), waitMs: z.number().int().min(0).max(MAX_WAIT_MS).optional() })
  .strict();

/** One status line, as the agent sets it: a state, and the sentence a person reads. */
export const MAX_STATUS_COMMENT_CHARS = 200;

export const setStatusSchema = z
  .object({
    status: z.enum(["working", "blocked", "review", "done"]),
    comment: z.string().trim().max(MAX_STATUS_COMMENT_CHARS).default(""),
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

export const ORCH_TOOLS: OrchTool[] = [
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
        notify: { type: "string", enum: ["wake", "none"], description: "Wake this chat with the result when the child finishes (default), or report only when asked." },
        clientRequestId: stringProperty("A key for this request: sending it twice returns the same task instead of spawning another."),
      },
      ["brief"],
    ),
  },
  {
    name: "task_status",
    description:
      "Report how your delegated tasks stand: state, harness and model, how long they have run, their last line, and their result once finished. " +
      "With a taskId, that one task alone.",
    parameters: object({ taskId: stringProperty("The task to report; omit it to list every task this chat started.") }),
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
    name: "list_profiles",
    description:
      "List the workers you can delegate to: this project's saved bot profiles and one entry per installed harness at its default model. " +
      "Use it to pick a harness, model, and provider — a council picks distinct providers from this list.",
    parameters: object({ workspaceId: stringProperty("Project id to list for; defaults to this chat's project.") }),
  },
];

/** One worker an agent can ask for by id: a saved bot profile, or a harness at its default model. */
export interface ToolProfile {
  id: string;
  source: "bot" | "harness";
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

/** Every worker this project offers, with what a delegation from this chat still has room for. */
export async function listProfiles(
  ctx: ToolContext,
  args: { workspaceId?: string },
  limits: { remainingDepth: number; remainingTasks: number },
): Promise<ToolOutput> {
  const workspace = args.workspaceId ? await ctx.workspaces.get(args.workspaceId) : ctx.chat.workspace;
  const bots = ctx.boards ? await ctx.boards.listBots() : [];
  const profiles: ToolProfile[] = [];
  for (const bot of bots.slice(0, MAX_PROFILES)) profiles.push(await botProfile(bot, ctx.registry));
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
    `${remainingDepth} delegation level(s) left for this chat, ${remainingTasks} task(s).`,
  ].join("\n");
  return { text, data: { profiles, workspace, remainingDepth, remainingTasks } };
}
