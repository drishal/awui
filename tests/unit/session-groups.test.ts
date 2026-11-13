import { describe, expect, it } from "vitest";
import type { ProjectSession, SessionsOverview, WorkspaceInfo } from "../../src/shared/protocol.js";
import { asHarnessId } from "../../src/shared/protocol.js";
import { archivedCount, dateGroup, focusProject, groupByProject, headCutoff, isBusy, isWorking, movedOrder, pinnedSessions, placeOf, plainPreview, projectRows, sessionScope } from "../../src/web/session-groups.js";

const ws = (id: string): WorkspaceInfo => ({ id, path: `/home/u/${id}`, name: id });
const s = (id: string, workspaceId: string, harness: string, updatedAt: string, title = id): ProjectSession => ({
  id,
  harnessId: asHarnessId(harness),
  title,
  updatedAt,
  workspaceId,
});

const overview: SessionsOverview = {
  workspaces: [ws("webui"), ws("dotfiles"), ws("notes")],
  sessions: [
    s("d1", "dotfiles", "omp", "2026-10-02T10:00:00Z", "Fix waybar"),
    s("w1", "webui", "pi", "2026-10-01T10:00:00Z", "Model picker"),
    s("d2", "dotfiles", "pi", "2026-09-20T10:00:00Z", "Stylix theme"),
  ],
  errors: [],
};

describe("groupByProject", () => {
  it("orders projects by their newest session", () => {
    const groups = groupByProject(overview, { currentId: "webui", query: "", harnessId: "pi" });
    expect(groups.map((g) => [g.workspace.name, g.current, g.sessions.map((x) => x.id)])).toEqual([
      ["webui", true, ["w1"]],
      ["dotfiles", false, ["d2"]],
    ]);
  });

  it("scopes the list to the selected harness, and a search stays inside it", () => {
    const omp = groupByProject(overview, { currentId: "notes", query: "", harnessId: "omp" });
    expect(omp.map((g) => [g.workspace.name, g.sessions.map((x) => x.id)])).toEqual([
      ["dotfiles", ["d1"]],
      ["notes", []],
    ]);
    // A pi session does not show up while omp is selected, even by exact title.
    const search = groupByProject(overview, { currentId: "notes", query: "  WAYBAR ", harnessId: "pi" });
    expect(search.map((g) => [g.workspace.name, g.sessions.map((x) => x.id)])).toEqual([]);
    const own = groupByProject(overview, { currentId: "notes", query: "stylix", harnessId: "pi" });
    expect(own.map((g) => [g.workspace.name, g.sessions.map((x) => x.id)])).toEqual([["dotfiles", ["d2"]]]);
  });

  it("drops projects a search leaves empty, and keeps the empty current project otherwise, last", () => {
    const all = groupByProject(overview, { currentId: "notes", query: "", harnessId: "pi" });
    expect(all.map((g) => [g.workspace.name, g.sessions.map((x) => x.id)])).toEqual([
      ["webui", ["w1"]],
      ["dotfiles", ["d2"]],
      ["notes", []],
    ]);
    const search = groupByProject(overview, { currentId: "notes", query: "model picker", harnessId: "pi" });
    expect(search.map((g) => [g.workspace.name, g.sessions.map((x) => x.id)])).toEqual([["webui", ["w1"]]]);
  });
});

describe("pinned and archived sessions", () => {
  const marked: SessionsOverview = {
    ...overview,
    sessions: [
      { ...s("p1", "dotfiles", "pi", "2026-10-03T10:00:00Z", "Pinned one"), pinned: true },
      { ...s("a1", "webui", "pi", "2026-10-02T10:00:00Z", "Old idea"), archived: true },
      ...overview.sessions,
    ],
  };
  const opts = { currentId: "webui", query: "", harnessId: "pi" };

  it("lifts pinned sessions out of their projects and leaves archived ones out", () => {
    expect(pinnedSessions(marked, opts).map((x) => x.id)).toEqual(["p1"]);
    expect(groupByProject(marked, opts).map((g) => [g.workspace.name, g.sessions.map((x) => x.id)])).toEqual([
      ["webui", ["w1"]],
      ["dotfiles", ["d2"]],
    ]);
    expect(archivedCount(marked, "pi")).toBe(1);
    expect(archivedCount(marked, "omp")).toBe(0);
  });

  it("shows archived sessions in place on request", () => {
    const groups = groupByProject(marked, { ...opts, showArchived: true });
    expect(groups.map((g) => [g.workspace.name, g.sessions.map((x) => x.id)])).toEqual([
      ["webui", ["a1", "w1"]],
      ["dotfiles", ["d2"]],
    ]);
  });

  it("finds pinned and archived sessions where they live while searching", () => {
    expect(pinnedSessions(marked, { ...opts, query: "pinned" })).toEqual([]);
    expect(groupByProject(marked, { ...opts, query: "o" }).map((g) => [g.workspace.name, g.sessions.map((x) => x.id)])).toEqual([
      ["dotfiles", ["p1"]],
      ["webui", ["a1", "w1"]],
    ]);
  });
});

describe("a repository's projects", () => {
  // webui and its worktree on a branch, its main checkout, and an unrelated project between them in time.
  const repo: SessionsOverview = {
    workspaces: [ws("webui-main"), ws("webui-feat"), ws("webui-fix"), ws("notes")],
    sessions: [
      s("n1", "notes", "pi", "2026-10-05T10:00:00Z"),
      s("f1", "webui-feat", "pi", "2026-10-04T10:00:00Z"),
      s("m1", "webui-main", "pi", "2026-10-01T10:00:00Z"),
      s("x1", "webui-fix", "pi", "2026-10-03T10:00:00Z"),
    ],
    errors: [],
    checkouts: {
      "webui-main": { repo: "r1", branch: "main", primary: true },
      "webui-feat": { repo: "r1", branch: "feat", primary: false },
      "webui-fix": { repo: "r1", branch: "fix", primary: false },
    },
  };

  it("stay together: the one you are in, then the main branch, then the others by activity", () => {
    const groups = groupByProject(repo, { currentId: "webui-fix", query: "", harnessId: "pi" });
    expect(groups.map((g) => [g.workspace.name, g.sharesRepo])).toEqual([
      ["notes", false],
      ["webui-fix", true],
      ["webui-main", true],
      ["webui-feat", true],
    ]);
  });

  it("are placed by the newest of them", () => {
    const later = { ...repo, sessions: [...repo.sessions, s("m2", "webui-main", "pi", "2026-10-06T10:00:00Z")] };
    expect(groupByProject(later, { currentId: null, query: "", harnessId: "pi" }).map((g) => g.workspace.name)).toEqual(["webui-main", "webui-feat", "webui-fix", "notes"]);
  });
});

describe("date groups", () => {
  const now = new Date(2026, 9, 21, 15, 0).getTime(); // Wed 21 Oct 2026, local time
  const at = (m: number, d: number, h = 12, y = 2026) => new Date(y, m, d, h).getTime();
  const label = (t: number, weekStartsOn = 1) => dateGroup(t, now, weekStartsOn).label;

  it("follow the calendar: Today, Yesterday, this week, last week, this month, then months", () => {
    expect(label(at(9, 21, 1))).toBe("Today");
    expect(label(at(9, 20))).toBe("Yesterday");
    expect(label(at(9, 19))).toBe("Earlier this week");
    expect(label(at(9, 18))).toBe("Last week");
    expect(label(at(9, 12))).toBe("Last week");
    expect(label(at(9, 11))).toBe("Earlier this month");
    expect(label(at(8, 14))).toBe("September");
    expect(label(at(7, 3, 12, 2025))).toBe("August 2025");
    expect(label(0)).toBe("Older");
  });

  it("start the week on the locale's day", () => {
    expect(label(at(9, 18), 0)).toBe("Earlier this week");
    expect(label(at(9, 17), 0)).toBe("Last week");
  });
});

describe("the unlabelled run of recent sessions", () => {
  const now = new Date(2026, 9, 21, 15, 0).getTime();
  const min = 60_000;

  it("ends at a real pause near five sessions down", () => {
    // Six in a burst, a 2-hour pause, then two more an hour apart: the cut is at the pause.
    const times = [0, 5, 10, 15, 20, 25, 145, 205].map((m) => now - m * min);
    expect(headCutoff(times, now)).toBe(now - 25 * min);
  });

  it("is the whole list when there is no pause, and none when it would only top its own date group", () => {
    expect(headCutoff([now, now - 5 * min, now - 10 * min], now)).toBe(-Infinity);
    // One session today, then a 10-hour silence to sessions that are also today.
    const today = new Date(2026, 9, 21, 23, 0).getTime();
    expect(headCutoff([today, today - 10 * 60 * min, today - 11 * 60 * min], today)).toBe(Infinity);
  });
});

describe("a project's rows", () => {
  const now = new Date(2026, 9, 21, 15, 0).getTime();
  const iso = (m: number, d: number, h = 12) => new Date(2026, m, d, h).toISOString();
  const sessions = [
    s("today", "webui", "pi", new Date(now - 10 * 60_000).toISOString()),
    s("lw1", "webui", "pi", iso(9, 16)),
    s("lw2", "webui", "pi", iso(9, 15)),
    s("lw3", "webui", "pi", iso(9, 14)),
    s("sep", "webui", "pi", iso(8, 3)),
  ];
  const shape = (rows: ReturnType<typeof projectRows>) => rows.map((r) => (r.kind === "divider" ? `— ${r.label}` : r.s.id));

  it("leave the recent run unlabelled and put a divider between calendar groups", () => {
    expect(shape(projectRows(sessions, { now }))).toEqual(["today", "— Last week", "lw1", "lw2", "lw3", "— September", "sep"]);
  });

  it("follow a hand order inside a group, never across groups", () => {
    const rows = projectRows(sessions, { now, order: ["sep", "lw3", "today", "lw1"] });
    expect(shape(rows)).toEqual(["today", "— Last week", "lw3", "lw2", "lw1", "— September", "sep"]);
  });

  it("move only inside their group", () => {
    const rows = projectRows(sessions, { now });
    expect(movedOrder(rows, "lw3", { delta: -1 })).toEqual(["today", "lw1", "lw3", "lw2", "sep"]);
    expect(movedOrder(rows, "lw1", { delta: -1 })).toBeNull();
    expect(movedOrder(rows, "lw1", { target: "lw3", place: "after" })).toEqual(["today", "lw2", "lw3", "lw1", "sep"]);
    expect(movedOrder(rows, "lw1", { target: "sep", place: "before" })).toBeNull();
  });
});

describe("the current project's focused view", () => {
  const now = new Date(2026, 9, 21, 15, 0).getTime(); // Wed 21 Oct 2026
  const iso = (m: number, d: number, h = 12) => new Date(2026, m, d, h).toISOString();
  const ov: SessionsOverview = {
    workspaces: [ws("dotfiles"), ws("webui"), ws("notes")],
    sessions: [
      s("today", "dotfiles", "pi", new Date(now - 10 * 60_000).toISOString(), "Today one"),
      s("lw", "dotfiles", "pi", iso(9, 15), "Last week one"),
      s("other", "webui", "pi", iso(9, 20), "Elsewhere"),
      s("omp", "dotfiles", "omp", iso(9, 20), "Another agent"),
    ],
    errors: [],
  };
  const opts = { currentId: "dotfiles", query: "", harnessId: "pi", now };

  it("lists the focused project's sessions as date sections, newest first", () => {
    const f = focusProject(ov, "dotfiles", opts);
    expect(f?.workspace.name).toBe("dotfiles");
    expect(f?.sections.map((sec) => [sec.label, sec.sessions.map((x) => x.id)])).toEqual([
      ["", ["today"]],
      ["Last week", ["lw"]],
    ]);
  });

  it("counts and lists the projects an All-projects view would show", () => {
    const f = focusProject(ov, "dotfiles", opts);
    // The other agent's session in dotfiles is out (the harness filter), the rest count.
    expect(f?.allCount).toBe(3);
    expect(f?.rest.map((g) => g.workspace.name)).toEqual(["webui"]);
  });

  it("is null for a project the overview does not have", () => {
    expect(focusProject(ov, "ghost", opts)).toBeNull();
  });

  it("marks the current project in the scope switcher", () => {
    expect(sessionScope(ov, opts).map((x) => [x.workspace.name, x.count, x.current])).toEqual([
      ["dotfiles", 2, true],
      ["webui", 1, false],
    ]);
  });
});

describe("the hover card's answer", () => {
  it("reads as plain text", () => {
    expect(plainPreview("## Done\n\n- line 1 with **markdown**\n- see [docs](https://x)\n```ts\ncode\n```\nend")).toBe("Done\n\n• line 1 with markdown\n• see docs\n\nend");
  });
});

describe("what counts as working", () => {
  it("leaves out a chat whose harness is only starting, which is busy but not on a turn", () => {
    expect(isBusy("starting")).toBe(true);
    expect(isWorking("starting")).toBe(false);
    for (const status of ["running", "stopping", "compacting"] as const) expect(isWorking(status)).toBe(true);
    for (const status of ["idle", "error", "disposed", null, undefined] as const) expect(isWorking(status)).toBe(false);
  });
  it("keeps a resumed chat out of the Working list until it runs a turn", () => {
    const none = { currentId: null, query: "", harnessId: null };
    const resumed: ProjectSession = { ...s("r1", "webui", "pi", "2026-10-01T10:00:00Z"), liveChatId: "c1", status: "starting" };
    expect(placeOf(resumed, none)).not.toBe("working");
    expect(placeOf({ ...resumed, status: "running" }, none)).toBe("working");
  });
});
