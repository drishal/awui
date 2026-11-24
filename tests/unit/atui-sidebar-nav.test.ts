// Navigation state does not confuse two displays of one session, or another project's parent.
import { describe, expect, it } from "vitest";
import type { ProjectSession, SessionsOverview } from "../../src/shared/protocol.js";
import { nestDelegated, projectOpen, sidebarFolded, sidebarKey, sidebarParentKey, sidebarRows, sidebarSelectedIndex, sidebarTabRow } from "../../src/atui/sidebar-nav.js";
import { asHarnessId } from "../../src/shared/protocol.js";

const session = (id: string, workspaceId: string, flags: Partial<ProjectSession> = {}): ProjectSession => ({ id, harnessId: asHarnessId("fake"), workspaceId, title: id, updatedAt: null, ...flags });
const overview: SessionsOverview = {
  workspaces: [
    { id: "beta", name: "beta", path: "/work/beta" },
    { id: "alpha", name: "alpha", path: "/work/alpha" },
    { id: "gamma", name: "gamma", path: "/work/gamma" },
    { id: "other", name: "other", path: "/work/other" },
  ],
  sessions: [session("beta-ask", "beta", { asking: true }), session("beta-session", "beta"), session("alpha-session", "alpha"), session("other-harness", "other", { harnessId: asHarnessId("fake-b") })],
  errors: [],
};
const opts = { currentId: "alpha", query: "", harnessId: "fake", isActive: () => false, now: 0 };
const occurrences = (rs: ReturnType<typeof sidebarRows>, id: string, where: "needs" | "project") => {
  // An empty group is not drawn, so the project rows' start is the boundary: what is before the first project row is a global group.
  const firstProject = rs.findIndex((row) => row.kind === "project");
  return rs.filter((row) => row.kind === "session" && row.s.id === id && (where === "needs" ? rs.indexOf(row) < firstProject : rs.indexOf(row) > firstProject)).length;
};

describe("atui sidebar navigation", () => {
  it("folds a project without hiding that project's sessions in global sections", () => {
    const rows = sidebarRows(overview, opts, new Set());
    expect(occurrences(rows, "beta-ask", "needs")).toBe(1);
    // A non-current project starts folded; expanding it lists its own sessions too.
    const betaProject = rows.find((row) => row.kind === "project" && row.workspace.id === "beta")!;
    const opened = sidebarFolded(new Set(), betaProject, "alpha");
    const expanded = sidebarRows(overview, opts, opened);
    expect(occurrences(expanded, "beta-session", "project")).toBe(1);
    expect(occurrences(expanded, "beta-ask", "needs")).toBe(1);
    // Folding the project hides only its own listing; the Needs you occurrence stays.
    const closed = sidebarFolded(opened, betaProject, "alpha");
    const after = sidebarRows(overview, opts, closed);
    expect(occurrences(after, "beta-session", "project")).toBe(0);
    expect(occurrences(after, "beta-ask", "needs")).toBe(1);
    expect(projectOpen(closed, "beta", false)).toBe(false);
  });

  it("retains empty offered projects with the current harness's zero count", () => {
    const rows = sidebarRows(overview, opts, new Set());
    const empty = rows.find((row) => row.kind === "project" && row.workspace.id === "other");
    expect(empty).toEqual({ kind: "project", workspace: { id: "other", path: "/work/other", name: "other" }, count: 0, current: false });
    expect(projectOpen(new Set(), "other", false)).toBe(false);
    expect(projectOpen(sidebarFolded(new Set(), empty!, "alpha"), "other", false)).toBe(true);
  });

  it("uses the selection's own session for a new tab, and a header's first child", () => {
    const rows = sidebarRows(overview, opts, new Set());
    // A header opens its first child; a session opens itself.
    expect((sidebarTabRow(rows, 0) as { s: ProjectSession }).s.id).toBe("beta-ask");
    const ask = rows.findIndex((row) => row.kind === "session" && row.s.id === "beta-ask");
    expect((sidebarTabRow(rows, ask) as { s: ProjectSession }).s.id).toBe("beta-ask");
    // A header before an empty section opens nothing.
    expect(sidebarTabRow(rows, rows.findIndex((row) => row.kind === "section" && row.id === "working"))).toBeUndefined();
    // Expanding beta lists its own session: its header opens it, as does alpha's.
    const opened = sidebarRows(overview, opts, sidebarFolded(new Set(), rows.find((row) => row.kind === "project" && row.workspace.id === "beta")!, "alpha"));
    const listed = opened.findIndex((row) => row.kind === "session" && row.s.id === "beta-session");
    expect((sidebarTabRow(opened, listed) as { s: ProjectSession }).s.id).toBe("beta-session");
    const alpha = opened.findIndex((row) => row.kind === "project" && row.workspace.id === "alpha");
    expect((sidebarTabRow(opened, alpha) as { s: ProjectSession }).s.id).toBe("alpha-session");
  });

  it("keeps the stored selection's key when the list changes around it", () => {
    const rows = sidebarRows(overview, opts, new Set());
    const at = rows.findIndex((row) => row.kind === "session" && row.s.id === "alpha-session");
    const key = sidebarKey(rows[at], at, rows);
    // A session moving into Working (or any new row above) shifts indexes: the key must still resolve.
    const reordered: SessionsOverview = {
      ...overview,
      sessions: [session("fresh-arrival", "alpha"), session("beta-ask", "beta", { asking: true }), session("alpha-session", "alpha"), session("other-harness", "other", { harnessId: asHarnessId("fake-b") })],
    };
    const after = sidebarRows(reordered, opts, new Set());
    expect(sidebarSelectedIndex(after, key)).toBe(after.findIndex((row) => row.kind === "session" && row.s.id === "alpha-session"));
    // Two occurrences of one session keep distinct keys.
    const bothOccurrences = after.map((row, index) => sidebarKey(row, index, after)).filter((item, i, all) => item?.startsWith("s:alpha-session:") && all.indexOf(item) !== i);
    expect(bothOccurrences).toEqual([]);
  });

  it("moves a running delegated child to just after its parent, and leaves one whose parent is elsewhere", () => {
    const lineage = (parentChatId: string) => ({ kind: "delegate" as const, taskId: "t", parentChatId, parentTitle: null, depth: 1 });
    const list = [session("kid", "alpha", { liveChatId: "c-kid", lineage: lineage("c-lead") }), session("other", "alpha"), session("lead", "alpha", { liveChatId: "c-lead" }), session("stray", "alpha", { lineage: lineage("c-gone") })];
    expect(nestDelegated(list).map((x) => `${x.s.id}${x.child ? "*" : ""}`)).toEqual(["other", "lead", "kid*", "stray"]);
  });
});
