import { describe, expect, it } from "vitest";
import type { ProjectSession, SessionsOverview, WorkspaceInfo } from "../../src/shared/protocol.js";
import { asHarnessId } from "../../src/shared/protocol.js";
import { PROJECT_ROWS, rowEdge, sidebarModel, sidebarNode, type SidebarState } from "../../src/tern/sidebar.js";

const ws = (id: string): WorkspaceInfo => ({ id, path: `/home/u/${id}`, name: id });
const s = (id: string, workspaceId: string, over: Partial<ProjectSession> = {}): ProjectSession => ({
  id,
  harnessId: asHarnessId("pi"),
  title: id,
  updatedAt: "2026-11-10T10:00:00Z",
  workspaceId,
  ...over,
});
const now = Date.parse("2026-11-10T12:00:00Z");
const at = (over: Partial<SidebarState> = {}): SidebarState => ({ harnessId: "pi", here: "webui", current: null, folded: new Set(), expanded: new Set(), now, ...over });

describe("the Tern sidebar's model", () => {
  const overview: SessionsOverview = {
    workspaces: [ws("webui"), ws("dotfiles")],
    sessions: [
      s("ask", "dotfiles", { asking: true }),
      s("w1", "webui", { updatedAt: "2026-11-10T11:00:00Z" }),
      s("d1", "dotfiles"),
      s("omp1", "webui", { harnessId: asHarnessId("omp") }),
      s("old", "webui", { archived: true }),
    ],
    errors: [],
  };

  it("puts what needs you above the projects, scoped to the harness, as the web sidebar does", () => {
    const model = sidebarModel(overview, at());
    expect(model.blocks.map((b) => [b.key, b.rows.map((r) => r.id)])).toEqual([
      ["needs", ["ask"]],
      ["p:webui", ["w1"]],
      ["p:dotfiles", ["d1"]],
    ]);
    expect(model.hidden).toBe(1);
    expect(model.names.get("dotfiles")).toBe("dotfiles");
  });

  it("keeps the session on screen in its project whatever it is doing", () => {
    const model = sidebarModel(overview, at({ current: "ask" }));
    expect(model.blocks.find((b) => b.key === "needs")).toBeUndefined();
    expect(model.blocks.find((b) => b.key === "p:dotfiles")?.rows.map((r) => r.id)).toContain("ask");
  });

  it("shows a project's first rows until it is expanded, and remembers a fold", () => {
    const many: SessionsOverview = { workspaces: [ws("webui")], sessions: Array.from({ length: PROJECT_ROWS + 3 }, (_, i) => s(`w${i}`, "webui")), errors: [] };
    const cut = sidebarModel(many, at({ folded: new Set(["webui"]) })).blocks[0];
    expect([cut?.rows.length, cut?.more, cut?.folded]).toEqual([PROJECT_ROWS, 3, true]);
    const all = sidebarModel(many, at({ expanded: new Set(["webui"]) })).blocks[0];
    expect([all?.rows.length, all?.more, all?.folded]).toEqual([PROJECT_ROWS + 3, 0, false]);
  });

  it("offers Show N more on a cut project and Show fewer on an expanded one", () => {
    const many: SessionsOverview = { workspaces: [ws("webui")], sessions: Array.from({ length: PROJECT_ROWS + 2 }, (_, i) => s(`w${i}`, "webui")), errors: [] };
    const button = (expanded: boolean) => {
      const node = sidebarNode({ model: sidebarModel(many, at({ expanded: new Set(expanded ? ["webui"] : []) })), harnessName: "Pi", current: null, now, on: { open() {}, newChat() {}, fold() {}, more() {}, sessions() {}, hide() {}, pickHarness() {} } });
      return JSON.stringify(node.toJSON()).match(/"text":"(Show [^"]+)"/)?.[1];
    };
    expect(button(false)).toBe("Show 2 more");
    expect(button(true)).toBe("Show fewer");
  });

  it("draws a row's right edge as a toned dot when it is busy (green when only open here), then its narrow age, after its project in a fixed section", () => {
    const words = (spans: { t: string; s?: string }[]) => spans.map((x) => [x.t, x.s]);
    expect(words(rowEdge(s("a", "w", { asking: true, status: "running" }), now))).toEqual([["● ", "warning"], ["2h", "dim"]]);
    expect(words(rowEdge(s("b", "w", { status: "running" }), now))).toEqual([["● ", "accent"], ["2h", "dim"]]);
    expect(words(rowEdge(s("c", "w", { status: "error" }), now))).toEqual([["● ", "error"], ["2h", "dim"]]);
    expect(words(rowEdge(s("d", "w"), now))).toEqual([["2h", "dim"]]);
    expect(words(rowEdge(s("g", "w", { liveChatId: "c1" }), now))).toEqual([["● ", "success"], ["2h", "dim"]]);
    expect(words(rowEdge(s("h", "w", { liveChatId: "c1", status: "running" }), now))).toEqual([["● ", "accent"], ["2h", "dim"]]);
    expect(words(rowEdge(s("e", "w", { updatedAt: "2026-11-10T11:59:40Z" }), now, "alpha"))).toEqual([["alpha · ", "dim"], ["now", "dim"]]);
    expect(words(rowEdge(s("f", "w", { asking: true, updatedAt: "2026-11-10T11:59:40Z" }), now, "alpha"))).toEqual([["alpha ", "dim"], ["● ", "warning"], ["now", "dim"]]);
  });
});
