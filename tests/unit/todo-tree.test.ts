// The todo list as phases with numerals and counts, flat when it has none.
import { describe, expect, it } from "vitest";
import { jobIdsIn, roman, todoTree } from "../../src/web/todo-tree.js";

describe("todo tree", () => {
  it("groups consecutive tasks by phase, numbered, with counts", () => {
    const tree = todoTree([
      { phase: "Gates", text: "typecheck", status: "completed" },
      { phase: "Gates", text: "test:e2e:fast", status: "in_progress" },
      { phase: "Smoke", text: "real pi", status: "pending" },
    ]);
    expect(tree.map((p) => [p.numeral, p.name, p.done, p.items.length, p.active])).toEqual([
      ["I.", "Gates", 1, 2, true],
      ["II.", "Smoke", 0, 1, false],
    ]);
  });

  it("keeps a list without phases as one flat branch", () => {
    const tree = todoTree([
      { text: "a", status: "completed" },
      { text: "b", status: "pending" },
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ name: null, numeral: null, done: 1 });
  });

  it("writes numerals and finds the jobs a task names", () => {
    expect([1, 2, 4, 9, 14].map(roman)).toEqual(["I", "II", "IV", "IX", "XIV"]);
    expect(jobIdsIn("test:e2e:fast (running as bg_19), then bg_2 and bg_19", new Set(["bg_19", "bg_2"]))).toEqual(["bg_19", "bg_2"]);
    expect(jobIdsIn("bg_7 is not one of ours", new Set(["bg_19"]))).toEqual([]);
  });
});
