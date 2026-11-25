// What a notice says about its chat: a bare title and verb until another session shares the title, then the
// project and age that tell the two apart (round 7 showed three "ask please" cards with nothing to choose between).
import { describe, expect, it } from "vitest";
import type { ProjectSession, WorkspaceInfo } from "../../src/shared/protocol.js";
import { noticeText } from "../../src/web/notice-name.js";

const workspaces = [{ id: "ws-demo", path: "/tmp/demo", name: "demo" }] as WorkspaceInfo[];
const now = Date.UTC(2026, 0, 1, 12, 0, 0);

function session(id: string, title: string, over: Partial<ProjectSession> = {}): ProjectSession {
  return { id, harnessId: "fake", title, updatedAt: new Date(now - 7 * 60_000).toISOString(), workspaceId: "ws-demo", ...over } as ProjectSession;
}

describe("what a notice says about its chat", () => {
  it("states a title nothing else shares without qualification", () => {
    const only = session("fake:a", "tidy the dock");
    expect(noticeText(only, "needs you", [only, session("fake:b", "ask please")], workspaces, now)).toBe("“tidy the dock” needs you");
  });

  it("adds the project and age, before the verb, when a second session shares the title", () => {
    const mine = session("fake:a", "ask please");
    const other = session("fake:b", "ask please", { workspaceId: "ws-other" });
    expect(noticeText(mine, "needs you", [mine, other], workspaces, now)).toBe("“ask please” · demo, 7m — needs you");
  });

  it("leaves out a project or age it does not know", () => {
    const mine = session("fake:a", "ask please", { workspaceId: "ws-gone", updatedAt: null });
    expect(noticeText(mine, "finished", [mine, session("fake:b", "ask please")], workspaces, now)).toBe("“ask please” finished");
  });
});
