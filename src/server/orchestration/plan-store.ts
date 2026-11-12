// Lead/worker plan lifecycle: a draft is a bounded record owned by one chat, not a
// prompt or a second transcript. Only confirm may call the orchestrator's ordinary
// delegation machinery; edits validate the same DAG and independent write scopes.
import { randomBytes } from "node:crypto";
import { PlanProblem, validatePlan, type Plan, type PlanTask } from "./plans.js";
import { denial, type StoredTask } from "./types.js";
import { writeJsonChecked, readJson, isObj } from "../state-file.js";
import type { Chat } from "../chats/chat.js";

export interface PlanDelegate {
  (brief: string, task: PlanTask): Promise<{ task: StoredTask; done: Promise<void> }>;
}

export interface PlanRecord extends Plan {
  /** Session identity and chat identity prevent another agent editing this proposal. */
  parentChatId: string;
  parentSessionId: string | null;
  /** Server only: delegated task ids assigned when this proposal was confirmed. */
  taskIds: Record<string, string>;
  /** Human-readable, bounded failure/next-action line when a worker blocked the rest. */
  note: string | null;
}

export const MAX_PLANS = 64;
const PLAN_FILE_VERSION = 1;

function deny(error: PlanProblem): import("../chats/chat.js").ChatError {
  // All authoring problems fixable before any harness starts are unprocessable proposals, not internal failures.
  return denial(422, error.code === "scope_collision" ? "scope_collision" : "invalid_plan", error.message);
}

/** Durable only as actionable records; a server restart marks an unfinished proposal failed. */
export class PlanStore {
  private plans = new Map<string, PlanRecord>();
  private loading: Promise<void> | null = null;
  constructor(private readonly file: string | null, private readonly onChange: (plan: PlanRecord) => void) {}

  async ready(): Promise<void> {
    this.loading ??= (async () => {
      const raw = await readJson(this.file);
      if (!isObj(raw) || raw.version !== PLAN_FILE_VERSION || !Array.isArray(raw.plans)) return;
      for (const candidate of raw.plans) {
        if (!isObj(candidate)) continue;
        try {
          const plan = { ...candidate, taskIds: isObj(candidate.taskIds) ? candidate.taskIds : isObj(candidate.assigned) ? candidate.assigned : {} } as PlanRecord;
          validatePlan(plan);
          if (plan.status === "running") {
            plan.status = "failed";
            plan.note = "The server restarted before this plan finished. Inspect the worker chats before confirming another run.";
          }
          this.plans.set(plan.id, plan);
        } catch { /* A malformed row cannot start anything; leave it out and keep others. */ }
      }
    })();
    return this.loading;
  }

  /** Latest proposal belonging to this session: attached on register, never auto-started. */
  latestFor(caller: Chat): PlanRecord | null {
    const owned = [...this.plans.values()].filter((plan) => plan.parentChatId === caller.chatId || (plan.parentSessionId !== null && plan.parentSessionId === caller.sessionId));
    return owned[owned.length - 1] ?? null;
  }

  private own(caller: Chat, id: string): PlanRecord {
    const plan = this.plans.get(id);
    if (!plan || (plan.parentChatId !== caller.chatId && plan.parentSessionId !== caller.sessionId)) throw denial(404, "unknown_plan", `No plan ${id} in this chat`);
    return plan;
  }

  private async save(plan: PlanRecord): Promise<void> {
    // Keep the durable write before confirmation's side effect and before any run starts.
    await writeJsonChecked(this.file, { version: PLAN_FILE_VERSION, plans: [...this.plans.values()].slice(-MAX_PLANS) });
    this.onChange(plan);
  }

  async create(caller: Chat, input: unknown): Promise<PlanRecord> {
    await this.ready();
    const proposed = (() => {
      try { return validatePlan(input); }
      catch (error) { if (error instanceof PlanProblem) throw deny(error); throw error; }
    })();
    const id = randomBytes(6).toString("hex");
    const now = Date.now();
    const plan: PlanRecord = {
      ...proposed, id, status: "draft", createdAt: now, updatedAt: now, taskIds: {}, note: null,
      parentChatId: caller.chatId, parentSessionId: caller.sessionId,
    };
    this.plans.set(id, plan);
    await this.save(plan);
    return plan;
  }

  async edit(caller: Chat, id: string, input: unknown): Promise<PlanRecord> {
    await this.ready();
    const previous = this.own(caller, id);
    if (previous.status !== "draft") throw denial(409, "plan_not_draft", "A confirmed plan cannot be edited; cancel it or inspect the workers");
    const proposal = validatePlan(input);
    const plan: PlanRecord = { ...previous, ...proposal, updatedAt: Date.now() };
    this.plans.set(id, plan);
    await this.save(plan);
    return plan;
  }

  async cancel(caller: Chat, id: string): Promise<PlanRecord> {
    await this.ready();
    const previous = this.own(caller, id);
    if (previous.status === "done" || previous.status === "cancelled") return previous;
    const plan: PlanRecord = { ...previous, status: "cancelled", updatedAt: Date.now(), note: "Cancelled. No new workers will start; already-running workers keep their own chats." };
    this.plans.set(id, plan);
    await this.save(plan);
    return plan;
  }

  /** Start exactly the independent ready tasks; the delegate hook supplies the real worker chats. */
  async confirm(caller: Chat, id: string, launch: PlanDelegate): Promise<PlanRecord> {
    await this.ready();
    const original = this.own(caller, id);
    if (original.status !== "draft") throw denial(409, "plan_not_draft", "This proposal was already confirmed or closed");
    // Revalidate persisted, hand-edited records too: the DAG and path checks are the front door.
    validatePlan({ title: original.title, tasks: original.tasks, maxParallel: original.maxParallel });
    const plan: PlanRecord = { ...original, status: "running", updatedAt: Date.now() };
    this.plans.set(id, plan);
    await this.save(plan);
    // One runner per confirmed record: retries cannot start workers twice, even if a call races.
    void this.run(plan, launch).catch(async (error: unknown) => {
      const failed = this.plans.get(id);
      if (!failed || failed.status !== "running") return;
      const next = { ...failed, status: "failed" as const, note: error instanceof Error ? error.message : String(error), updatedAt: Date.now() };
      this.plans.set(id, next);
      await this.save(next).catch(() => undefined);
    });
    return plan;
  }

  private async run(plan: PlanRecord, launch: PlanDelegate): Promise<void> {
    const remaining = new Map(plan.tasks.map((task) => [task.id, task]));
    const done = new Set<string>();
    const running = new Map<string, Promise<void>>();
    let failure: Error | null = null;
    while (remaining.size > 0) {
      if (this.plans.get(plan.id)?.status === "cancelled") return;
      for (const task of remaining.values()) {
        if (running.has(task.id) || !task.dependsOn.every((id) => done.has(id)) || running.size >= plan.maxParallel) continue;
        remaining.delete(task.id);
        const started = launch(task.prompt, task).then(async ({ task: assigned, done: finished }) => {
          plan.taskIds[task.id] = assigned.id;
          this.plans.set(plan.id, { ...plan, taskIds: { ...plan.taskIds }, updatedAt: Date.now() });
          await this.save(this.plans.get(plan.id) as PlanRecord);
          await finished;
        });
        running.set(task.id, started.then(() => { done.add(task.id); }));
      }
      if (running.size === 0) {
        failure = new PlanProblem("invalid_plan", remaining.size > 0 ? "A dependency could not complete" : "The plan is finished");
        break;
      }
      const settled = await Promise.race([...running.entries()].map(async ([id, promise]) => ({ id, result: await promise.then(() => null, (error: unknown) => error) })));
      running.delete(settled.id);
      if (settled.result) { failure = settled.result instanceof Error ? settled.result : new Error(String(settled.result)); break; }
    }
    // A worker failing must not abandon already-running colleagues. They keep their chats and settle normally.
    await Promise.allSettled([...running.values()]);
    const latest = this.plans.get(plan.id);
    if (!latest || latest.status !== "running") return;
    const next: PlanRecord = {
      ...latest, status: failure ? "failed" : "review",
      note: failure ? `${failure.message}. Later workers did not start; inspect the completed workers and retry with a new proposal.` : "Every worker settled; review is still required before integration.",
      updatedAt: Date.now(),
    };
    this.plans.set(plan.id, next);
    await this.save(next);
  }
}
