// The Recent view (recent-view.ts): one flat list across projects, newest first under calendar
// headings, each row tagged with its project; what needs you, what works and what is pinned live
// above it; and pages of 12 then 20. Pure, so the order, the headings, and the tag rule are pinned.
import { describe, expect, it } from "vitest";
import type { ProjectSession, SessionsOverview, WorkspaceInfo } from "../../src/shared/protocol.js";
import { asHarnessId } from "../../src/shared/protocol.js";
import { RECENT_PAGE, SHOW_MORE, projectTag, recentRows } from "../../src/web/recent-view.js";

const NOW = new Date("2026-11-26T12:00:00Z").getTime();
const at = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();

const ws = (id: string, name = id): WorkspaceInfo => ({ id, path: `/home/u/${name}`, name });
const s = (id: string, workspaceId: string, harness: string, updatedAt: string, extra: Partial<ProjectSession> = {}): ProjectSession => ({
  id,
  harnessId: asHarnessId(harness),
  title: id,
  updatedAt,
  workspaceId,
  ...extra,
});

const opts = { currentId: "webui", query: "", harnessId: "pi", now: NOW };

const ids = (rows: ReturnType<typeof recentRows>["rows"]) => rows.flatMap((r) => (r.kind === "session" ? [r.s.id] : []));
const labels = (rows: ReturnType<typeof recentRows>["rows"]) => rows.flatMap((r) => (r.kind === "divider" ? [r.label] : []));

describe("recentRows", () => {
  it("is one list across projects, newest first, each row tagged with the project it is out of", () => {
    const overview: SessionsOverview = {
      workspaces: [ws("webui"), ws("dotfiles")],
      sessions: [s("d1", "dotfiles", "pi", at(0)), s("w1", "webui", "pi", at(1)), s("d2", "dotfiles", "pi", at(2))],
      errors: [],
    };
    const { rows } = recentRows(overview, opts);
    expect(ids(rows)).toEqual(["d1", "w1", "d2"]);
    const tags = rows.flatMap((r) => (r.kind === "session" ? [r.tag?.name] : []));
    expect(tags).toEqual(["dotfiles", "webui", "dotfiles"]);
  });

  it("heads each run of rows with its calendar day, the first one too", () => {
    const overview: SessionsOverview = {
      workspaces: [ws("webui")],
      sessions: [s("today", "webui", "pi", at(0)), s("yesterday", "webui", "pi", at(1)), s("lastweek", "webui", "pi", at(9))],
      errors: [],
    };
    const { rows } = recentRows(overview, opts);
    expect(ids(rows)).toEqual(["today", "yesterday", "lastweek"]);
    // The heading where the sections above end says the rest is today's.
    expect(labels(rows)).toEqual(["Today", "Yesterday", "Last week"]);
    expect(rows[0]?.kind).toBe("divider");
  });

  it("leaves what needs you, what is working, and what is pinned to the sections above it", () => {
    const overview: SessionsOverview = {
      workspaces: [ws("webui")],
      sessions: [
        s("asking", "webui", "pi", at(0), { asking: true }),
        s("running", "webui", "pi", at(1), { status: "running" }),
        s("pinned", "webui", "pi", at(2), { pinned: true }),
        s("plain", "webui", "pi", at(3)),
      ],
      errors: [],
    };
    expect(ids(recentRows(overview, opts).rows)).toEqual(["plain"]);
  });

  it("keeps settled, snoozed and archived rows for their toggle, and shows every match of a search", () => {
    const later = new Date(NOW + 3_600_000).getTime();
    const overview: SessionsOverview = {
      workspaces: [ws("webui")],
      sessions: [
        s("settled", "webui", "pi", at(1), { settled: true }),
        s("snoozed", "webui", "pi", at(2), { snoozedUntil: later }),
        s("archived", "webui", "pi", at(3), { archived: true }),
        s("plain", "webui", "pi", at(4)),
      ],
      errors: [],
    };
    expect(ids(recentRows(overview, opts).rows)).toEqual(["plain"]);
    expect(ids(recentRows(overview, { ...opts, showSettled: true, showSnoozed: true, showArchived: true }).rows)).toEqual(["settled", "snoozed", "archived", "plain"]);
    // A search is the caller's own list: it shows the matches wherever they would have sat.
    expect(ids(recentRows(overview, { ...opts, query: "ed" }).rows)).toEqual(["settled", "snoozed", "archived"]);
  });

  it("shows one page at a time: 12 rows first, then 20 more per page", () => {
    const sessions = Array.from({ length: RECENT_PAGE + SHOW_MORE + 3 }, (_, i) => s(`r${String(i).padStart(2, "0")}`, "webui", "pi", at(0)));
    const first = recentRows(overview(sessions), opts);
    expect(ids(first.rows)).toHaveLength(RECENT_PAGE);
    expect(first.hidden).toBe(SHOW_MORE + 3);
    const second = recentRows(overview(sessions), opts, RECENT_PAGE + SHOW_MORE);
    expect(ids(second.rows)).toHaveLength(RECENT_PAGE + SHOW_MORE);
    expect(second.hidden).toBe(3);
    const all = recentRows(overview(sessions), opts, RECENT_PAGE + SHOW_MORE + 3);
    expect(all.hidden).toBe(0);
    // A page that cuts a day in half still heads its rows, with the whole bucket's size.
    expect(all.rows[0]).toEqual({ kind: "divider", key: "today", label: "Today", count: RECENT_PAGE + SHOW_MORE + 3 });
  });

  it("gives each heading its bucket's size, whatever the page shows", () => {
    const overview: SessionsOverview = {
      workspaces: [ws("webui")],
      sessions: [s("t1", "webui", "pi", at(0)), s("t2", "webui", "pi", at(0)), s("y1", "webui", "pi", at(1)), s("w1", "webui", "pi", at(9))],
      errors: [],
    };
    expect(recentRows(overview, opts).rows.flatMap((r) => (r.kind === "divider" ? [`${r.label}:${r.count}`] : []))).toEqual(["Today:2", "Yesterday:1", "Last week:1"]);
    // A page of two still says what the buckets hold: two today, so nothing is cut here, but the sizes
    // do not follow the limit.
    expect(recentRows(overview, opts, 1).rows.flatMap((r) => (r.kind === "divider" ? [`${r.label}:${r.count}`] : []))).toEqual(["Today:2"]);
  });

  it("scopes to the shown harness and to the text search", () => {
    const overview: SessionsOverview = {
      workspaces: [ws("webui"), ws("dotfiles")],
      sessions: [s("a", "webui", "pi", at(0), { title: "sidebar fix" }), s("b", "dotfiles", "omp", at(1), { title: "sidebar fix" }), s("c", "webui", "pi", at(2))],
      errors: [],
    };
    expect(ids(recentRows(overview, opts).rows)).toEqual(["a", "c"]);
    expect(ids(recentRows(overview, { ...opts, query: "sidebar" }).rows)).toEqual(["a"]);
  });

  it("has no tag for a harness with no projects", () => {
    const overview: SessionsOverview = { workspaces: [], sessions: [s("only", "elsewhere", "pi", at(0))], errors: [] };
    const { rows } = recentRows(overview, opts);
    expect(rows.flatMap((r) => (r.kind === "session" ? [r.tag] : []))).toEqual([null]);
  });
});

function overview(sessions: ProjectSession[]): SessionsOverview {
  return { workspaces: [ws("webui")], sessions, errors: [] };
}

describe("projectTag", () => {
  const base: SessionsOverview = {
    workspaces: [ws("webui", "awui"), ws("wt", "awui-wt")],
    sessions: [],
    errors: [],
    checkouts: {
      webui: { repo: "awui", branch: "main", primary: true },
      wt: { repo: "awui", branch: "feat/sidebar", primary: false },
    },
  };
  it("says a name, and a branch only when it is not the trunk's", () => {
    expect(projectTag(base, s("x", "webui", "pi", at(0)))).toEqual({ id: "webui", name: "awui", branch: null });
    expect(projectTag(base, s("x", "wt", "pi", at(0)))).toEqual({ id: "wt", name: "awui-wt", branch: "feat/sidebar" });
  });

  it("has nothing to say without a checkout, or for a project the overview does not list", () => {
    const bare: SessionsOverview = { workspaces: [ws("webui", "awui")], sessions: [], errors: [] };
    expect(projectTag(bare, s("x", "webui", "pi", at(0)))?.branch).toBeNull();
    expect(projectTag(bare, s("x", "gone", "pi", at(0)))).toBeNull();
  });
});
