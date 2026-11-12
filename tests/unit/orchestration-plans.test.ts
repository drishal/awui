// Lead/worker plan drafts: dependency order, capacity, and write-scope overlaps are checked
// before a proposal can start anything, and are identical for client and tool callers.
import { describe, expect, it } from "vitest";
import { assertIndependentScopes, planBatches, PlanProblem, validatePlan } from "../../src/server/orchestration/plans.js";

const plan = {
  title: "Split the parser and tests",
  maxParallel: 2,
  tasks: [
    { id: "parser", prompt: "Make the parser accept trailing commas", dependsOn: [], writeScope: ["src/parser/**"] },
    { id: "docs", prompt: "Describe trailing-comma syntax", writeScope: ["docs/parser.md"], dependsOn: ["parser"] },
    { id: "test", prompt: "Cover the old parser behavior", dependsOn: [], writeScope: ["tests/legacy/**"] },
  ],
};

describe("lead/worker plans", () => {
  it("keeps proposal order inside independent dependency batches", () => {
    const batches = planBatches(plan.tasks as Parameters<typeof planBatches>[0]);
    expect(batches.map((batch) => batch.map((task) => task.id))).toEqual([["parser", "test"], ["docs"]]);
    expect(validatePlan(plan)).toEqual(plan);
  });

  it("refuses an unknown dependency instead of skipping that worker", () => {
    expect(() => planBatches([{ ...plan.tasks[0]!, dependsOn: ["missing"] }])).toThrow("unknown missing");
  });

  it("rejects cycles before any execution", () => {
    const tasks = [
      { ...plan.tasks[0]!, id: "a", dependsOn: ["b"] },
      { ...plan.tasks[1]!, id: "b", dependsOn: ["a"] },
    ];
    expect(() => planBatches(tasks)).toThrow("cycle");
  });

  it("rejects duplicate ids and repeated dependencies", () => {
    expect(() => planBatches([plan.tasks[0] as never, plan.tasks[0] as never])).toThrow("Duplicate");
    expect(() => planBatches([{ ...plan.tasks[0]!, dependsOn: ["test", "test"] }])).toThrow("repeats");
  });

  it("denies overlapping concurrent write scopes, but not dependent ones", () => {
    expect(() => assertIndependentScopes([
      { ...plan.tasks[0]!, writeScope: ["src/**"] },
      { ...plan.tasks[2]!, writeScope: ["src/parser/a.ts"] },
    ])).toThrowError(expect.objectContaining({ code: "scope_collision" }) as PlanProblem);
    expect(() => assertIndependentScopes(plan.tasks as Parameters<typeof planBatches>[0])).not.toThrow();
  });

  it("allows read-only workers beside a writer", () => {
    expect(() => assertIndependentScopes([plan.tasks[0] as Parameters<typeof planBatches>[0][number], { ...plan.tasks[1]!, writeScope: [] }])).not.toThrow();
  });
});
