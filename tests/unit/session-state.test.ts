// A sidebar row's one muted subline (session-state.ts): the project a row is out of, the fact its
// agent stated, how it began when no person did, or a branch that is not the folder's trunk — and the
// row stays one line when none applies.
import { describe, expect, it } from "vitest";
import { asHarnessId, type ProjectSession } from "../../src/shared/protocol.js";
import type { ProjectTag } from "../../src/web/recent-view.js";
import { originWords, rowState, rowSubline, runElapsed } from "../../src/web/session-state.js";

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
    expect(rowSubline(s(), { tag })).toEqual({ kind: "tag", tag, fact: null });
  });

  it("puts the agent's own line first, in the branch's place", () => {
    // What the agent reported is the fact that changed, so it leads: badge, fact, then the project.
    expect(rowSubline(s({ agentStatus: { state: "review", comment: "ready to merge", at: 7 } }), { tag })).toEqual({ kind: "tag", tag: { ...tag, branch: null }, fact: { kind: "words", text: "ready to merge" } });
    // With no sentence of its own, the state's word.
    expect(rowSubline(s({ agentStatus: { state: "blocked", comment: "", at: 7 } }), { tag })).toEqual({ kind: "tag", tag: { ...tag, branch: null }, fact: { kind: "state", word: "blocked", note: null } });
    // A branch is one more annotation than a 16px subline holds, so the fact takes its place.
    expect(rowSubline(s({ agentStatus: { state: "done", comment: "shipped", at: 7 } }), { tag, groupBranch: "test" })).toEqual({ kind: "tag", tag: { ...tag, branch: null }, fact: { kind: "words", text: "shipped" } });
  });

  it("says a blocked agent's state before the note under it", () => {
    // The state is the fact and the comment is a note under it: a row that only said "waiting on CI" read
    // as a finished one, so `blocked` stays its own word (the row colours it and never cuts it).
    expect(rowSubline(s({ agentStatus: { state: "blocked", comment: "waiting on CI", at: 7 } }), { tag })).toEqual({ kind: "tag", tag: { ...tag, branch: null }, fact: { kind: "state", word: "blocked", note: "waiting on CI" } });
    // Every other state's comment already says what it is: it is the line, with no word beside it.
    expect(rowSubline(s({ agentStatus: { state: "working", comment: "running the tests", at: 7 } }), { tag })).toEqual({ kind: "tag", tag: { ...tag, branch: null }, fact: { kind: "words", text: "running the tests" } });
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

  it("lets the group head say the common branch, while a different worktree says its own", () => {
    // The head is always asked to show a branch it has, even without sharesRepo.
    expect(rowSubline(s(), { branch: "test", groupBranch: "test" })).toBeNull();
    expect(rowSubline(s(), { branch: "feat/worktree", groupBranch: "test" })).toEqual({ kind: "branch", text: "feat/worktree" });
    expect(rowSubline(s(), { tag, groupBranch: tag.branch })).toEqual({ kind: "tag", tag: { ...tag, branch: null }, fact: null });
    expect(rowSubline(s(), { tag, groupBranch: "test" })).toEqual({ kind: "tag", tag, fact: null });
  });

  it("says how a routine woke its session, inside its own project", () => {
    // Nothing here repeats the project (its group's head names it) or the harness (the leading dot
    // says that): how the session began is the one line such a row has to add.
    expect(rowSubline(s({ origin: "routine" }), {})).toEqual({ kind: "origin", text: "Scheduled routine" });
    expect(originWords(s({ origin: "routine" }))).toBe("Scheduled routine");
  });

  it("says whose task a delegated session is, and does not claim a parent it lost", () => {
    const child = (parentTitle: string | null) => s({ origin: "agent", lineage: { kind: "delegate", taskId: "t1", parentChatId: "c0", parentTitle, depth: 1 } });
    expect(rowSubline(child("Fix CI"), {})).toEqual({ kind: "origin", text: "From Fix CI" });
    // A reaped parent chat is gone from the listing, so the row says all it still knows.
    expect(rowSubline(child(null), {})).toEqual({ kind: "origin", text: "From another agent" });
  });

  it("keeps the agent's own status ahead of how the session began", () => {
    // The status is what changed and what the person acts on; a lineage or a routine is context.
    const r = rowSubline(s({ origin: "routine", agentStatus: { state: "review", comment: "ready to merge", at: 7 } }), {});
    expect(r).toEqual({ kind: "agent", text: "ready to merge", state: "review", line: "ready for review · ready to merge", at: 7 });
    // Only with the status gone does the origin take the line, which is what makes the order visible.
    expect(rowSubline(s({ origin: "routine" }), {})).toEqual({ kind: "origin", text: "Scheduled routine" });
  });

  it("puts how a session began in the branch's place, on a tagged row, before the project", () => {
    expect(rowSubline(s({ origin: "routine" }), { tag })).toEqual({ kind: "tag", tag: { ...tag, branch: null }, fact: { kind: "words", text: "Scheduled routine" } });
    expect(originWords(s({ origin: "agent" }))).toBe("From another agent");
  });

  it("leaves the row one line when nothing on it has anything to say", () => {
    // The guard: no status, nobody who started it, and the trunk's branch — where the branch alone is
    // today's answer, and a second line invented for it would make every row two lines.
    expect(originWords(s())).toBeNull();
    expect(rowSubline(s(), { branch: "main" })).toBeNull();
  });
});

describe("rowState", () => {
  const state = (extra: Partial<ProjectSession> = {}, opts: Partial<{ working: boolean; showHarness: boolean; section: "needs" | "working" | null; now: number }> = {}) =>
    rowState(s(extra), { working: false, showHarness: false, now: 1_000, ...opts });
  it("puts a run's ring or the amber question in the leading slot, and nothing when neither is true", () => {
    expect(state({ status: "running" }, { working: true }).mark).toBe("working");
    // Waiting on a person is not work in progress: the row shows one or the other.
    expect(state({ asking: true, status: "running" }, { working: true }).mark).toBe("needs");
    expect(state().mark).toBe("blank");
    // A list that mixes harnesses keeps the harness dot, muted by the adapter's colour.
    expect(state({}, { showHarness: true }).mark).toBe("harness");
  });

  it("says one word in the age's place: Needs you, Working, or the agent's Done", () => {
    expect(state({ asking: true }).word).toEqual({ text: "Needs you", tone: "warn" });
    expect(state({ status: "running" }, { working: true }).word).toEqual({ text: "Working", tone: "accent" });
    expect(state({ agentStatus: { state: "done", comment: "", at: 1 } }).word).toEqual({ text: "Done", tone: "ok" });
    expect(state({ agentStatus: { state: "review", comment: "ready", at: 1 } }).word).toEqual({ text: "Done", tone: "ok" });
    // A blocked agent is nobody's answer to give: its words are the subline, and the age stays.
    expect(state({ agentStatus: { state: "blocked", comment: "waiting on CI", at: 1 } }).word).toBeNull();
    expect(state().word).toBeNull();
    // A snoozed row keeps its wake time in that slot, which is the state it is in.
    expect(state({ asking: true, snoozedUntil: 5_000 }).word).toBeNull();
    // A snooze that has already ended is an ordinary row again.
    expect(state({ snoozedUntil: 500 }).word).toBeNull();
  });

  it("says the state once inside its own section, and keeps the age instead", () => {
    expect(rowState(s({ asking: true }), { working: false, showHarness: false, section: "needs", now: 1_000 }).word).toBeNull();
    expect(rowState(s({ status: "running" }), { working: true, showHarness: false, section: "working", now: 1_000 }).word).toBeNull();
    // The section wins over an old agent status: its row never substitutes a second word either.
    expect(rowState(s({ asking: true, agentStatus: { state: "done", comment: "", at: 1 } }), { working: false, showHarness: false, section: "needs", now: 1_000 }).word).toBeNull();
    // Search results and Projects-view folders still say Needs you / Working.
    expect(rowState(s({ asking: true }), { working: false, showHarness: false, section: "working", now: 1_000 }).word).toEqual({ text: "Needs you", tone: "warn" });
    expect(rowState(s({ status: "running" }), { working: true, showHarness: false, section: "needs", now: 1_000 }).word).toEqual({ text: "Working", tone: "accent" });
  });

  it("collapses parked, herdr and handover into one glyph, handover first", () => {
    expect(state({ handover: true, handoverCommand: "pi --resume x", herdr: { paneId: "w1:p1", status: "idle" }, parked: true }).glyph).toEqual({
      kind: "handover",
      className: "session-handover",
      label: "Handed to a terminal: pi --resume x",
    });
    expect(state({ herdr: { paneId: "w1:p2", status: "working" }, parked: true }).glyph).toEqual({
      kind: "herdr",
      className: "session-herdr is-working",
      label: "Open in herdr, pane w1:p2 (working)",
    });
    expect(state({ parked: true }).glyph?.kind).toBe("parked");
    // A live chat here is this server's own writer: it is not parked.
    expect(state({ parked: true, liveChatId: "c1" }).glyph).toBeNull();
    expect(state().glyph).toBeNull();
  });

  it("marks unread, which the title draws as weight", () => {
    expect(state({ unread: true }).unread).toBe(true);
    expect(state().unread).toBe(false);
  });
});

describe("runElapsed", () => {
  // The row's own clock: its last activity is the message that started the run, so 10:00:00 against a
  // reading of 10:01:04 is a run going for 1 minute and 4 seconds.
  const at = (now: string) => Date.parse(now);
  it("counts how long the run has been going, in the age slot's words", () => {
    expect(runElapsed(s(), at("2026-11-26T10:00:12Z"))).toBe("12s");
    expect(runElapsed(s(), at("2026-11-26T10:01:04Z"))).toBe("1m 4s");
    expect(runElapsed(s(), at("2026-11-26T10:05:00Z"))).toBe("5m");
    expect(runElapsed(s(), at("2026-11-26T11:30:00Z"))).toBe("1h 30m");
    // A run the reader catches just as it starts is under a second, not "0s" (which reads as the letter O).
    expect(runElapsed(s(), at("2026-11-26T10:00:00Z"))).toBe("<1s");
  });

  it("keeps the age when no start is known, rather than inventing one", () => {
    // A listing with no activity says nothing about when the run began.
    expect(runElapsed(s({ updatedAt: null }), at("2026-11-26T10:00:00Z"))).toBeNull();
    expect(runElapsed(s({ updatedAt: "not a time" }), at("2026-11-26T10:00:00Z"))).toBeNull();
    // A clock that reads ahead of ours is not a start either: the elapsed number would be negative.
    expect(runElapsed(s(), at("2026-11-26T09:59:00Z"))).toBeNull();
  });
});
