// Wire shapes for an editable lead/worker proposal. The server owns its validation
// policy, execution and identity (orchestration/plans.ts); no harness SDK reaches here.
import { z } from "zod";

export const MAX_PLAN_TASKS = 16;
export const MAX_PLAN_WORKERS = 4;
export const MAX_PLAN_WRITE_SCOPES = 64;
export const planTaskIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/i);
export const workerTaskSchema = z.object({
  id: planTaskIdSchema,
  prompt: z.string().trim().min(1).max(32_000),
  harness: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(512).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  dependsOn: z.array(planTaskIdSchema).max(MAX_PLAN_TASKS).default([]),
  writeScope: z.array(z.string().trim().min(1).max(256).refine((value) => !value.includes("\0"))).max(MAX_PLAN_WRITE_SCOPES).default([]),
  /** A managed checkout of this task's current head, with A6 review-gated integration; absent keeps the ordinary shared-project worker path. */
  isolation: z.literal("worktree").optional(),
}).strict();
export const workerProposalSchema = z.object({
  title: z.string().trim().min(1).max(160),
  tasks: z.array(workerTaskSchema).min(1).max(MAX_PLAN_TASKS),
  maxParallel: z.number().int().min(1).max(MAX_PLAN_WORKERS),
}).strict();
export const workerPlanSchema = workerProposalSchema.extend({
  id: z.string().regex(/^[0-9a-f]{8,32}$/),
  status: z.enum(["draft", "running", "review", "done", "failed", "cancelled"]),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  note: z.string().max(1000).nullable(),
  taskIds: z.record(z.string(), z.string().regex(/^[0-9a-f]{4,16}$/)),
}).strict();
export type WorkerTask = z.infer<typeof workerTaskSchema>;
export type WorkerPlan = z.infer<typeof workerPlanSchema>;
