// A lead's proposed plan, and the order its workers may start in. Kept pure and
// independent of a chat: both the orchestration tool and the browser edit the same
// bounded task list before confirmation, and only the confirm action starts real work.
import { z } from "zod";
import { MAX_PLAN_TASKS, MAX_PLAN_WORKERS, MAX_PLAN_WRITE_SCOPES, workerProposalSchema, workerPlanSchema, type WorkerPlan, type WorkerTask } from "../../shared/worker-plan.js";

export { MAX_PLAN_TASKS, MAX_PLAN_WORKERS, MAX_PLAN_WRITE_SCOPES };
export const MAX_PLAN_TITLE_CHARS = 160;
export const MAX_PLAN_SCOPE_CHARS = 256;
export const planProposalSchema = workerProposalSchema;
export type PlanTask = WorkerTask;
export type Plan = WorkerPlan;

export class PlanProblem extends Error {
  constructor(readonly code: "invalid_plan" | "unknown_dependency" | "cycle" | "scope_collision", message: string) {
    super(message);
  }
}

/** Unknown dependencies and duplicate task ids are validation errors before a task runs. */
function validateIds(tasks: PlanTask[]): Map<string, PlanTask> {
  const ids = new Map<string, PlanTask>();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new PlanProblem("invalid_plan", `Duplicate task id ${task.id}`);
    ids.set(task.id, task);
  }
  for (const task of tasks) {
    if (new Set(task.dependsOn).size !== task.dependsOn.length) throw new PlanProblem("invalid_plan", `Task ${task.id} repeats a dependency`);
    for (const dependency of task.dependsOn) if (!ids.has(dependency)) throw new PlanProblem("unknown_dependency", `Task ${task.id} depends on unknown ${dependency}`);
  }
  return ids;
}

/** Independent tasks form one batch, preserving the proposal's order within that batch. */
export function planBatches(tasks: PlanTask[]): PlanTask[][] {
  const byId = validateIds(tasks);
  const left = new Set(byId.keys());
  const done = new Set<string>();
  const batches: PlanTask[][] = [];
  while (left.size > 0) {
    const batch = tasks.filter((task) => left.has(task.id) && task.dependsOn.every((id) => done.has(id)));
    if (batch.length === 0) throw new PlanProblem("cycle", "The task dependencies form a cycle");
    batches.push(batch);
    for (const task of batch) {
      left.delete(task.id);
      done.add(task.id);
    }
  }
  return batches;
}

/**
 * The same scope in two concurrent assignments invites silently conflicting edits.
 * Exact matches and one path containing the other are enough to reject those; distinct glob
 * patterns stay allowed because awui never guesses a glob language's whole match set.
 */
function scopeOverlap(a: string, b: string): boolean {
  const base = (value: string) => {
    const normalized = value.replaceAll("\\", "/");
    const wildcard = normalized.search(/[*?[{]/);
    const directory = wildcard < 0 ? normalized : normalized.slice(0, wildcard).replace(/\/[^/]*$/, "");
    return directory.replace(/\/+$/, "");
  };
  const left = base(a);
  const right = base(b);
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** Tasks that can execute at once must have disjoint declared write scopes. */
export function assertIndependentScopes(tasks: PlanTask[]): void {
  for (const batch of planBatches(tasks)) {
    for (let a = 0; a < batch.length; a++) {
      for (let b = a + 1; b < batch.length; b++) {
        const left = batch[a] as PlanTask;
        const right = batch[b] as PlanTask;
        // An empty scope means read-only; it cannot overlap any write assignment.
        for (const one of left.writeScope) for (const other of right.writeScope) {
          if (scopeOverlap(one, other)) throw new PlanProblem("scope_collision", `Tasks ${left.id} and ${right.id} can run together and both allow writes to ${one}`);
        }
      }
    }
  }
}

/** Full validation at the single door before a draft becomes a run. */
export function validatePlan(proposal: unknown): z.infer<typeof planProposalSchema> {
  const parsed = planProposalSchema.parse(proposal);
  assertIndependentScopes(parsed.tasks);
  return parsed;
}
