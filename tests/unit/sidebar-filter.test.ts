import { describe, expect, it } from "vitest";
import type { ProjectSession, SessionsOverview } from "../../src/shared/protocol.js";
import { asHarnessId } from "../../src/shared/protocol.js";
import { applyHidden, applyQuick, asHideGroups, asQuickFilter, chipsShown, escapeClears, hideCounts, hiddenBy, HIDE_GROUPS, isSleeping, isOnDefaultBranch, matchesQuick, provenanceOf, quickCounts, SLEEPING_AFTER_MS } from "../../src/web/sidebar-filter.js";

// Noon, local time: midnight is 12 hours behind it whatever the zone.
const now = new Date(2026, 9, 27, 12, 0, 0).getTime();
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
  workspaces: [{ id: "w", path: "/w", name: "w" }],
  sessions: [
    s("run", { liveChatId: "c1", status: "running" }),
    s("ask", { liveChatId: "c2", status: "idle", asking: true, updatedAt: at(30) }),
    s("old", { updatedAt: at(100) }),
    s("undated", { updatedAt: null }),
    s("other", { harnessId: asHarnessId("omp"), liveChatId: "c3", status: "running" }),
    s("done", { settled: true, updatedAt: at(2) }),
    s("gone", { archived: true, updatedAt: at(2) }),
  ],
  errors: [],
};
const opts = { currentId: null, query: "", harnessId: "pi", now };

describe("matchesQuick", () => {
  it("runs on the chat's status, or on what the caller knows of it", () => {
    expect(matchesQuick(s("a", { status: "running" }), "running", now)).toBe(true);
    expect(matchesQuick(s("a", { status: "compacting" }), "running", now)).toBe(true);
    expect(matchesQuick(s("a", { status: "idle" }), "running", now)).toBe(false);
    expect(matchesQuick(s("a", { status: "idle" }), "running", now, () => true)).toBe(true);
  });

  it("needs you is a live chat asking, as the title's count has it", () => {
    expect(matchesQuick(s("a", { asking: true, liveChatId: "c" }), "needs", now)).toBe(true);
    expect(matchesQuick(s("a", { asking: true }), "needs", now)).toBe(false);
    expect(matchesQuick(s("a", { liveChatId: "c" }), "needs", now)).toBe(false);
  });

  it("today is last activity since local midnight", () => {
    expect(matchesQuick(s("a", { updatedAt: at(11) }), "today", now)).toBe(true);
    expect(matchesQuick(s("a", { updatedAt: at(13) }), "today", now)).toBe(false);
    expect(matchesQuick(s("a", { updatedAt: null }), "today", now)).toBe(false);
  });
});

describe("quickCounts", () => {
  it("counts the selected harness's listed sessions: not another harness's, archived, or settled ones", () => {
    expect(quickCounts(overview, opts)).toEqual({ running: 1, needs: 1, today: 1 });
  });

  it("does not move with the text search", () => {
    expect(quickCounts(overview, { ...opts, query: "nothing like it" })).toEqual({ running: 1, needs: 1, today: 1 });
  });
});

describe("applyQuick", () => {
  it("is the same overview with no filter", () => {
    expect(applyQuick(overview, null, now)).toBe(overview);
  });

  it("keeps only the sessions that pass, and everything else of the overview", () => {
    const out = applyQuick(overview, "needs", now);
    expect(out.sessions.map((x) => x.id)).toEqual(["ask"]);
    expect(out.workspaces).toBe(overview.workspaces);
    expect(applyQuick(overview, "running", now).sessions.map((x) => x.id)).toEqual(["run", "other"]);
  });
});

describe("chipsShown", () => {
  it("hides Running and Needs you at zero, keeps Today, and keeps the one that is on", () => {
    expect(chipsShown({ running: 0, needs: 0, today: 0 }, null)).toEqual(["today"]);
    expect(chipsShown({ running: 2, needs: 0, today: 3 }, null)).toEqual(["running", "today"]);
    expect(chipsShown({ running: 0, needs: 0, today: 0 }, "needs")).toEqual(["needs", "today"]);
  });
});

describe("escapeClears", () => {
  it("clears the search, then the filter", () => {
    expect(escapeClears("x", "today")).toBe("query");
    expect(escapeClears("", "today")).toBe("filter");
    expect(escapeClears("", null)).toBeNull();
  });
});

describe("asQuickFilter", () => {
  it("reads only the chips' names", () => {
    expect(asQuickFilter("needs")).toBe("needs");
    expect(asQuickFilter("everything")).toBeNull();
    expect(asQuickFilter(3)).toBeNull();
  });
});

// A repository's own tree on main, and a managed worktree on its task branch. Neither is
// the helper's default workspace ("w"), so a plain session is on neither.
const checkouts = {
  main: { repo: "r", branch: "main", primary: true },
  wt: { repo: "r", branch: "awui/fix-1234abcd", primary: false },
};

describe("what to hide", () => {
  const ctx = { now, checkouts };

  it("sleeping is quiet for a day: no live chat, no question, and no activity", () => {
    expect(isSleeping(s("a", { updatedAt: new Date(now - SLEEPING_AFTER_MS - 1000).toISOString() }), now)).toBe(true);
    // A live chat, even a quiet one, is not sleeping.
    expect(isSleeping(s("a", { liveChatId: "c", updatedAt: at(30) }), now)).toBe(false);
    // Neither is one waiting for an answer, nor one that just ran.
    expect(isSleeping(s("a", { asking: true, updatedAt: at(30) }), now)).toBe(false);
    expect(isSleeping(s("a", { updatedAt: at(2) }), now)).toBe(false);
    // An undated session cannot be said to be sleeping.
    expect(isSleeping(s("a", { updatedAt: null }), now)).toBe(false);
  });

  it("default branch means the repository's own tree on its trunk, not a worktree or a feature branch", () => {
    expect(isOnDefaultBranch(s("a", { workspaceId: "main" }), checkouts)).toBe(true);
    expect(isOnDefaultBranch(s("a", { workspaceId: "wt" }), checkouts)).toBe(false);
    expect(isOnDefaultBranch(s("a", { workspaceId: "main" }), { main: { repo: "r", branch: "release", primary: true } })).toBe(false);
    expect(isOnDefaultBranch(s("a", { workspaceId: "unknown" }), checkouts)).toBe(false);
    expect(isOnDefaultBranch(s("a", { workspaceId: "main" }), undefined)).toBe(false);
  });

  it("reads an origin the server recorded, and never a live or on-screen session", () => {
    const old = at(30);
    expect(hiddenBy(s("a", { origin: "routine", updatedAt: old }), ["automation"], ctx)).toBe("automation");
    expect(hiddenBy(s("a", { origin: "agent", updatedAt: old }), ["agent"], ctx)).toBe("agent");
    expect(hiddenBy(s("a", { updatedAt: old }), ["agent"], ctx)).toBeNull();
    // The session on screen stays whatever the toggles say.
    expect(hiddenBy(s("a", { workspaceId: "main", updatedAt: old }), ["defaultBranch"], { ...ctx, keep: () => true })).toBeNull();
    expect(hiddenBy(s("a", { updatedAt: at(1) }), HIDE_GROUPS, ctx)).toBeNull();
  });

  it("narrows the overview and counts what each toggle would take out", () => {
    const list: SessionsOverview = {
      ...overview,
      sessions: [
        s("quiet", { updatedAt: at(30) }),
        s("routine", { origin: "routine", updatedAt: at(1) }),
        s("main", { workspaceId: "main", updatedAt: at(1) }),
        s("worktree", { workspaceId: "wt", updatedAt: at(1) }),
      ],
    };
    expect(applyHidden(list, [], ctx)).toBe(list);
    expect(applyHidden(list, ["sleeping"], ctx).sessions.map((x) => x.id)).toEqual(["routine", "main", "worktree"]);
    expect(applyHidden(list, ["automation", "defaultBranch"], ctx).sessions.map((x) => x.id)).toEqual(["quiet", "worktree"]);
    expect(hideCounts(list, ctx)).toEqual({ sleeping: 1, defaultBranch: 1, automation: 1, agent: 0 });
    // The archived are already out of the list: they are no toggle's business.
    expect(hideCounts({ ...list, sessions: [s("gone", { archived: true, origin: "routine" })] }, ctx)).toEqual({ sleeping: 0, defaultBranch: 0, automation: 0, agent: 0 });
  });

  it("says on hover how a row began, and nothing for an ordinary one", () => {
    expect(provenanceOf(s("a", { updatedAt: at(1) }), ctx)).toBeNull();
    expect(provenanceOf(s("a", { origin: "routine", updatedAt: at(1) }), ctx)).toBe("Started by a scheduled routine");
    expect(provenanceOf(s("a", { origin: "agent", updatedAt: at(1) }), ctx)).toBe("Started by another agent");
    expect(provenanceOf(s("a", { updatedAt: at(70) }), ctx)).toBe("Sleeping for 2 days");
    expect(provenanceOf(s("a", { workspaceId: "main", updatedAt: at(1) }), ctx)).toBe("On main");
    expect(provenanceOf(s("a", { origin: "routine", updatedAt: at(30) }), ctx)).toBe("Started by a scheduled routine · Sleeping for 1 day");
  });

  it("reads stored toggles leniently", () => {
    expect(asHideGroups(["sleeping", "nonsense", "agent"])).toEqual(["sleeping", "agent"]);
    expect(asHideGroups("sleeping")).toEqual([]);
    expect(asHideGroups(null)).toEqual([]);
  });
});
