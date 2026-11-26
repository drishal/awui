// A sidebar row's one muted subline (session-state.ts): the project a row is out of, the status its
// agent set, or a branch that is not the folder's trunk — and the row stays one line when none applies.
import { describe, expect, it } from "vitest";
import { asHarnessId, type ProjectSession } from "../../src/shared/protocol.js";
import type { ProjectTag } from "../../src/web/recent-view.js";
import { rowSubline } from "../../src/web/session-state.js";

const s = (extra: Partial<ProjectSession> = {}): ProjectSession => ({
  id: "x",
  harnessId: asHarnessId("pi"),
  title: "a chat",
  updatedAt: "2026-11-26T10:00:00Z",
  workspaceId: "webui",
  ...extra,
});

const tag: ProjectTag = { id: "wt", name: "awui-wt", branch: "feat/sidebar" };

describe("rowSubline", () => {
  it("says which project a row is out of, when the list is across projects", () => {
    expect(rowSubline(s(), { tag })).toEqual({ kind: "tag", tag });
    // A tag wins over the agent's line: the flat list is read by project first.
    expect(rowSubline(s({ agentStatus: { state: "done", comment: "", at: 1 } }), { tag })).toEqual({ kind: "tag", tag });
  });

  it("says what the agent reported, inside its project", () => {
    const line = (extra: Partial<ProjectSession>) => rowSubline(s(extra), {});
    expect(line({ agentStatus: { state: "review", comment: "ready to merge", at: 7 } })).toEqual({ kind: "agent", text: "ready to merge", state: "review", line: "ready for review · ready to merge", at: 7 });
    // With no sentence of its own the row says the state's word.
    expect(line({ agentStatus: { state: "blocked", comment: "", at: 7 } })).toEqual({ kind: "agent", text: "blocked", state: "blocked", line: "blocked", at: 7 });
  });

  it("says a branch only when it is not the trunk's", () => {
    expect(rowSubline(s(), { branch: "feat/sidebar" })).toEqual({ kind: "branch", text: "feat/sidebar" });
    expect(rowSubline(s(), { branch: "main" })).toBeNull();
    expect(rowSubline(s(), { branch: null })).toBeNull();
    // A detached HEAD has no branch to say.
    expect(rowSubline(s(), {})).toBeNull();
  });
});
