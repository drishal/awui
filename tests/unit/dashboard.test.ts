// The agent dashboard's board: columns, nesting of delegated children, the project and
// pull-request filters, and the one-line preview a card shows.
import { describe, expect, it } from "vitest";
import { asHarnessId, type ProjectSession, type SessionsOverview } from "../../src/shared/protocol.js";
import { boardCards, boardCounts, boardProjects, cardStatusLine, columnOf, prBadge, prStateOf } from "../../src/web/dashboard.js";
import { previewLine } from "../../src/web/session-preview.js";

const now = Date.parse("2026-10-27T12:00:00.000Z");
const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
const s = (id: string, extra: Partial<ProjectSession> = {}): ProjectSession => ({
  id,
  harnessId: asHarnessId("pi"),
  title: id,
  updatedAt: at(1),
  workspaceId: "w",
  ...extra,
});

const overview: SessionsOverview = {
  workspaces: [
    { id: "w", path: "/w", name: "alpha" },
    { id: "v", path: "/v", name: "beta" },
  ],
  sessions: [
    s("ask", { asking: true, liveChatId: "c-ask", updatedAt: at(2) }),
    s("busy", { status: "running", liveChatId: "c-busy", updatedAt: at(1) }),
    s("quiet", { status: "idle", liveChatId: "c-quiet", updatedAt: at(3) }),
    s("gone", { archived: true }),
    s("other", { workspaceId: "v", liveChatId: "c-other", updatedAt: at(4) }),
    // A child of "busy": nests under its card. A child whose parent is not listed is its own card.
    s("kid", { liveChatId: "c-kid", status: "running", updatedAt: at(0.5), lineage: { kind: "delegate", taskId: "t1", parentChatId: "c-busy", parentTitle: null, depth: 1 } }),
    s("orphan", { liveChatId: "c-orphan", lineage: { kind: "delegate", taskId: "t2", parentChatId: "c-elsewhere", parentTitle: null, depth: 1 } }),
  ],
  errors: [],
};

describe("the board's columns", () => {
  it("puts what asks for you first, then what runs, then the rest — archived aside", () => {
    const cards = boardCards(overview);
    expect(cards.needs.map((c) => c.session.id)).toEqual(["ask"]);
    expect(cards.working.map((c) => c.session.id)).toEqual(["busy"]);
    // A child whose parent is not on the board is its own card, in its own column.
    expect(cards.done.map((c) => c.session.id)).toEqual(["orphan", "quiet", "other"]);
    expect(boardCounts(cards)).toEqual({ needs: 1, working: 1, done: 3 });
    // The caller's own notion of working (the open chat's live status) is used when given.
    expect(columnOf(s("x", { status: "idle" }), () => true)).toBe("working");
    // A session that is both asking and running needs you.
    expect(columnOf(s("x", { asking: true, status: "running" }))).toBe("needs");
  });

  it("nests a delegated child under its parent's card, sorted newest first", () => {
    const cards = boardCards(overview);
    const parent = cards.working.find((c) => c.session.id === "busy");
    expect(parent?.children.map((c) => c.id)).toEqual(["kid"]);
    // Not listed twice: the child is not a card of its own.
    expect([...cards.needs, ...cards.working, ...cards.done].map((c) => c.session.id)).not.toContain("kid");
    // Its parent is not on the board, so it stands alone (and says so).
    expect(cards.done.find((c) => c.session.id === "orphan")?.children).toEqual([]);
    expect(overview.sessions.find((x) => x.id === "orphan")?.origin).toBeUndefined();
  });

  it("narrows to one project", () => {
    const cards = boardCards(overview, { project: "v" });
    expect([...cards.needs, ...cards.working, ...cards.done].map((c) => c.session.id)).toEqual(["other"]);
  });
});

describe("pull requests as a filter", () => {
  it("reads a pull request's state, and treats nothing found as none", () => {
    expect(prStateOf({ url: "https://x/1", title: "", state: "OPEN", isDraft: false })).toBe("open");
    expect(prStateOf({ url: "https://x/1", title: "", state: "OPEN", isDraft: true })).toBe("draft");
    expect(prStateOf({ url: "https://x/1", title: "", state: "MERGED", isDraft: false })).toBe("merged");
    expect(prStateOf({ url: "https://x/1", title: "", state: "CLOSED", isDraft: false })).toBe("closed");
    expect(prStateOf(null)).toBe("none");
  });

  it("hides a project with no pull request, and never hides one it has not read yet", () => {
    const open = boardCards(overview, { pr: "open", prStates: { w: "open", v: "none" } });
    expect([...open.needs, ...open.working, ...open.done].map((c) => c.session.id)).toEqual(["ask", "busy", "orphan", "quiet"]);
    const none = boardCards(overview, { pr: "none", prStates: { w: "open", v: "none" } });
    expect([...none.needs, ...none.working, ...none.done].map((c) => c.session.id)).toEqual(["other"]);
    // A project whose pull request has not been read yet stays on the board.
    expect(boardCards(overview, { pr: "open", prStates: {} }).done.map((c) => c.session.id)).toEqual(["orphan", "quiet", "other"]);
  });

  it("badges a card with its project's pull request", () => {
    const prs = { w: { url: "https://x/1", title: "", state: "OPEN", isDraft: true } };
    expect(prBadge(s("a"), prs)).toEqual({ words: "PR draft", url: "https://x/1" });
    expect(prBadge(s("a"), { w: null })).toBeNull();
    expect(prBadge(s("a"), undefined)).toBeNull();
  });
});

describe("the board's headings and cards", () => {
  it("lists the projects with sessions, biggest first", () => {
    // The archived one counts for no project.
    expect(boardProjects(overview).map((w) => [w.name, w.count])).toEqual([["alpha", 5], ["beta", 1]]);
  });

  it("shows the line an agent set, and clamps a preview to one short line", () => {
    expect(cardStatusLine(s("a", { agentStatus: { state: "blocked", comment: "waiting on CI", at: 1 } }))).toBe("waiting on CI");
    expect(cardStatusLine(s("a", { agentStatus: { state: "done", comment: "", at: 1 } }))).toBe("done");
    expect(cardStatusLine(s("a"))).toBeNull();
    expect(previewLine(null)).toBeNull();
    expect(previewLine({ prompt: "a\n  prompt ", answer: null, turns: 1, model: null, files: [] })).toBe("a prompt");
    const long = previewLine({ prompt: null, answer: "x".repeat(400), turns: 1, model: null, files: [] });
    expect(long).toHaveLength(220);
    expect(long?.endsWith("…")).toBe(true);
  });
});
