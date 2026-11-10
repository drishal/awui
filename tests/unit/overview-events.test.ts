import { describe, expect, it } from "vitest";
import { mergeRoomOverview, mergeSessionOverview } from "../../src/shared/overview-events.js";
import type { OverviewEvent, ProjectSession, RoomSummary, SessionsOverview } from "../../src/shared/protocol.js";

import { asHarnessId } from "../../src/shared/protocol.js";
const harnessId = asHarnessId("fake");
const session: ProjectSession = { id: "fake:abc", harnessId, workspaceId: "w1", title: "Old", updatedAt: "2026-01-01T00:00:00.000Z" };
const usage = { turns: 0, steps: 0, input: 0, cachedInput: 0, cacheWrite: 0, output: 0, cost: null, unpriced: 0 };
const base: SessionsOverview = { workspaces: [], sessions: [session], errors: [] };
const room: RoomSummary = { id: "r1", name: "Room", topic: null, archived: false, leadName: "A", memberCount: 2, status: "idle", pendingCount: 0, lastActivityAt: 1, usage };

describe("lightweight overview reconciliation", () => {
  it("creates native-session ids exactly as harness-scoped, and clears live status on disposal", () => {
    const start: OverviewEvent = { type: "session", nativeId: "abc", harnessId: "fake", workspaceId: "w1", title: "Working", updatedAt: "2026-01-01T00:01:00.000Z", liveChatId: "c1", status: "running" };
    const running = mergeSessionOverview(base, start);
    expect(running.refresh).toBe(false);
    expect(running.overview.sessions[0]).toMatchObject({ id: "fake:abc", liveChatId: "c1", status: "running" });
    expect(running.overview.sessions[0]?.pinned).toBeUndefined();
    const done = mergeSessionOverview(running.overview, { type: "session", nativeId: "abc", harnessId: "fake", workspaceId: "w1", title: "Working", updatedAt: "2026-01-01T00:02:00.000Z", status: "disposed", disposed: true });
    expect(done.overview.sessions[0]).not.toHaveProperty("liveChatId");
    expect(done.overview.sessions[0]?.status).toBe("disposed");
    expect(done.refresh).toBe(false);
  });

  it("keeps a session's saved title while its live chat has none yet", () => {
    const next = mergeSessionOverview(base, { type: "session", nativeId: "abc", harnessId: "fake", workspaceId: "w1", title: "", updatedAt: null, liveChatId: "c1", status: "running" });
    expect(next.overview.sessions[0]?.title).toBe("Old");
  });

  it("keeps harnesses with the same native ID separate", () => {
    const both: SessionsOverview = { ...base, sessions: [session, { ...session, id: "omp:abc", harnessId: asHarnessId("omp") }] };
    const next = mergeSessionOverview(both, { type: "session", nativeId: "abc", harnessId: asHarnessId("omp"), workspaceId: "w1", title: "Other", updatedAt: null, status: "running" });
    expect(next.overview.sessions[0]?.title).toBe("Old");
    expect(next.overview.sessions[1]?.title).toBe("Other");
  });

  it("adds only the actually archived room to the archive fold projection", () => {
    const actual = mergeRoomOverview([room], { type: "room", room: { ...room, id: "r2", archived: true } });
    expect(actual.filter((r) => r.archived)).toHaveLength(1);
    expect(actual.filter((r) => !r.archived)).toHaveLength(1);
  });

  it("keeps room answers from destroying usage data", () => {
    const current: RoomSummary = { ...room, pendingCount: 1, status: "waiting", usage: { ...usage, turns: 2 } };
    const answer = mergeRoomOverview([current], { type: "room", room: { ...room, status: "idle", pendingCount: 0 } });
    expect(answer[0]).toMatchObject({ id: "r1", pendingCount: 0, status: "idle" });
  });
});
