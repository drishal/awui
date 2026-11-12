// The write-scope guard (A5): path traversal strictness, a scope glob match, the task's
// scratch dir, the preempt denial path, and the detect fallback for a harness that cannot
// pre-empt writes. Pure on purpose, like the module it judges with; the boundary (chat.ts) and
// the orchestrator (delegate, watch) see the same verdicts and wording, so the counts and rows
// never disagree with the guard.
import { describe, expect, it } from "vitest";
import { normalizeScope, scratchDirFor, judgePath, judgeSettled, wouldRefuse, blockedNotice, landedNotice, scopeNote, makeGuard, assignmentEnvelope, MAX_WRITE_SCOPE_GLOBS } from "../../src/server/orchestration/scope.js";
import type { TaskScope } from "../../src/server/orchestration/types.js";
import type { InteractionRequest } from "../../src/shared/protocol.js";

const workspace = "/tmp/awui-scope-test/proj";

function scopeOf(over: Partial<TaskScope> = {}): TaskScope {
  return { globs: [], scratchDir: scratchDirFor(workspace, "beef"), attempted: 0, blocked: 0, landed: 0, recent: [], ...over };
}

const guard = (globs: string[], prevent = true) => makeGuard(scopeOf({ globs }), workspace, { prevent, detect: true });

const request = (over: Partial<InteractionRequest> = {}): InteractionRequest => ({
  id: "r1",
  kind: "confirm",
  title: "Allow tool: write",
  message: "The fake agent wants to write src/app.ts",
  createdAt: 1,
  ...over,
});

describe("normalizeScope", () => {
  it("dedupes and trims, and accepts no globs as the whole project", () => {
    expect(normalizeScope(undefined)).toEqual({ ok: true, globs: [] });
    expect(normalizeScope([" src/** ", "src/**", ""])).toEqual({ ok: true, globs: ["src/**"] });
  });

  it("refuses a pattern holding .. before any work starts", () => {
    const bad = normalizeScope(["../outside/**"]);
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("expected a refusal");
    expect(bad.why).toContain("..");
    expect(bad.why).toContain("../outside/**");
  });
});

describe("scratchDirFor", () => {
  it("is confined to the project's .awui control folder, one dir per task", () => {
    const dir = scratchDirFor(workspace, "beef");
    expect(dir.startsWith(`${workspace}/.awui/scratch/`)).toBe(true);
    expect(dir.endsWith("beef")).toBe(true);
    const other = scratchDirFor(workspace, "cafe");
    expect(other).not.toBe(dir);
  });
});

describe("judgePath", () => {
  it("allows a file the scope glob covers", () => {
    const verdict = judgePath("src/app.ts", makeGuard(scopeOf({ globs: ["src/**"] }), workspace, { prevent: true, detect: true })!);
    expect(verdict.ok).toBe(true);
  });

  it("refuses one outside the scope, with the scope's words in the refusal", () => {
    const verdict = judgePath("notes/todo.md", makeGuard(scopeOf({ globs: ["src/**"] }), workspace, { prevent: true, detect: true })!);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.path).toBe("notes/todo.md");
    expect(verdict.why).toContain("src/**");
  });

  it("refuses an absolute path resolving outside the project", () => {
    const verdict = judgePath("/etc/passwd", makeGuard(scopeOf({ globs: [] }), workspace, { prevent: true, detect: true })!);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.why).toContain("outside this task's project");
  });

  it("defeats traversal: .. segments stay inside the project", () => {
    const verdict = judgePath("src/../notes/todo.md", makeGuard(scopeOf({ globs: ["src/**"] }), workspace, { prevent: true, detect: true })!);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.path).toBe("notes/todo.md");
  });

  it("always allows the task's scratch dir, scoped or not", () => {
    const guard = makeGuard(scopeOf({ globs: ["src/**"], scratchDir: scratchDirFor(workspace, "beef") }), workspace, { prevent: true, detect: true })!;
    expect(judgePath(`${scratchDirFor(workspace, "beef")}/notes.txt`, guard).ok).toBe(true);
    expect(judgePath(`${scratchDirFor(workspace, "beef")}/a/b/c.txt`, guard).ok).toBe(true);
    // Another task's scratch dir is not this task's.
    const verdict = judgePath(`${scratchDirFor(workspace, "cafe")}/notes.txt`, guard);
    expect(verdict.ok).toBe(false);
  });

  it("with no globs, allows anywhere inside the project only", () => {
    const guard = makeGuard(scopeOf({}), workspace, { prevent: true, detect: true })!;
    expect(judgePath("notes/todo.md", guard).ok).toBe(true);
    expect(judgePath("../outside.txt", guard).ok).toBe(false);
  });
});

describe("judgeSettled", () => {
  it("judges a write row's arguments like the tool's own", () => {
    const guard = makeGuard(scopeOf({ globs: ["src/**"] }), workspace, { prevent: true, detect: true })!;
    expect(judgeSettled("write", JSON.stringify({ path: "src/app.ts", content: "x" }), guard).ok).toBe(true);
    const verdict = judgeSettled("write", JSON.stringify({ path: "notes/todo.md", content: "x" }), guard);
    expect(verdict.ok).toBe(false);
  });

  it("reads an omp patch block's [path#hash] header when the args are not JSON", () => {
    const guard = makeGuard(scopeOf({ globs: ["src/**"] }), workspace, { prevent: true, detect: true })!;
    const verdict = judgeSettled("edit", "[notes/todo.md#abc123]\n@@ notes/todo.md\n-old\n+new", guard);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.path).toBe("notes/todo.md");
  });

  it("holds a repo move against the scope, worded for a worker", () => {
    const guard = makeGuard(scopeOf({}), workspace, { prevent: true, detect: true })!;
    const verdict = judgeSettled("bash", JSON.stringify({ command: "git commit -m 'ship it'" }), guard);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.why).toContain("repo moves");
  });

  it("never parses a command that is not a repo move", () => {
    const guard = makeGuard(scopeOf({}), workspace, { prevent: true, detect: true })!;
    expect(judgeSettled("bash", JSON.stringify({ command: "npm test" }), guard).ok).toBe(true);
    expect(judgeSettled("bash", JSON.stringify({ command: "ls -l" }), guard).ok).toBe(true);
  });
});

describe("wouldRefuse", () => {
  it("refuses a confirm the scope would refuse", () => {
    const guard = makeGuard(scopeOf({ globs: ["src/**"] }), workspace, { prevent: true, detect: true })!;
    expect(wouldRefuse(request({ message: "The fake agent wants to write notes/todo.md" }), guard)).toBe(true);
    expect(wouldRefuse(request(), guard)).toBe(false);
  });

  it("refuses a repo move an approval names, and an unnamed one", () => {
    const guard = makeGuard(scopeOf({}), workspace, { prevent: true, detect: true })!;
    expect(wouldRefuse(request({ title: "Allow tool: bash", message: "git push origin main" }), guard)).toBe(true);
    expect(wouldRefuse(request({ title: "Allow tool: bash", message: "npm test" }), guard)).toBe(false);
  });

  it("never guesses at a read or search ask, whatever its words name", () => {
    const guard = makeGuard(scopeOf({ globs: ["src/**"] }), workspace, { prevent: true, detect: true })!;
    expect(wouldRefuse(request({ title: "Allow tool: read", message: "/etc/passwd" }), guard)).toBe(false);
    expect(wouldRefuse(request({ title: "Allow tool: grep", message: "src" }), guard)).toBe(false);
  });

  it("an incapable harness is never refused preemptively", () => {
    const guard = makeGuard(scopeOf({ globs: ["src/**"] }), workspace, { prevent: false, detect: true })!;
    expect(wouldRefuse(request({ message: "The fake agent wants to write notes/todo.md" }), guard)).toBe(false);
  });
});

describe("the wording", () => {
  it("a blocked row reads as blocked, a landed one as reported", () => {
    expect(blockedNotice("notes/todo.md", "it is outside this task's write scope")).toContain("blocked");
    expect(blockedNotice("notes/todo.md", "x")).toContain("notes/todo.md");
    expect(landedNotice("notes/todo.md", "x")).toContain("reported, not blocked");
    expect(landedNotice("notes/todo.md", "x")).toContain("notes/todo.md");
  });

  it("the note rides the counts, and says nothing when there is nothing to say", () => {
    expect(scopeNote(undefined)).toBeNull();
    expect(scopeNote(scopeOf({}))).toBeNull();
    expect(scopeNote(scopeOf({ globs: ["src/**"] }))).toBe("write scope: src/**");
    const note = scopeNote(scopeOf({ globs: ["src/**"], attempted: 3, blocked: 2, landed: 1 }));
    expect(note).toContain("3 out-of-scope writes (2 blocked, 1 landed)");
    expect(scopeNote(scopeOf({ attempted: 1, blocked: 1, landed: 0 }))).toContain("1 out-of-scope write (1 blocked, 0 landed)");
  });
});

describe("the assignment contract", () => {
  it("carries the scope between the hidden-envelope markers", () => {
    const envelope = assignmentEnvelope(scopeOf({ globs: ["src/**"], scratchDir: "/tmp/s" }));
    expect(envelope.startsWith("<<<AWUI_BOARD_CONTROL")).toBe(true);
    expect(envelope.trimEnd().endsWith("AWUI_BOARD_CONTROL")).toBe(true);
    expect(envelope).toContain('"action": "assignment"');
    expect(envelope).toContain('"writeScope": [');
    expect(envelope).toContain('"src/**"');
    expect(envelope).toContain('"forbidRepoMoves": true');
  });
});

describe("the bounds", () => {
  it("the schema's cap matches the guard's", () => {
    expect(MAX_WRITE_SCOPE_GLOBS).toBe(8);
    expect(normalizeScope(Array.from({ length: 9 }, (_, i) => `dir${i}/**`)).ok).toBe(true);
  });
});
