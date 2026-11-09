// Usage and reading: the per-invocation delta keeps "unpriced" distinct from
// zero (a null cost is never $0), room and per-bot rollups add up, and the
// Markdown export and history page come from persisted records only — ordered,
// bounded, and free of native ids and paths.
import { describe, expect, it } from "vitest";
import { makeTestApp } from "../helpers/app.js";
import { agent, botRuns, makeBot, makeRoom, openProject, patchMember, send, snapshot, waitRecords } from "../helpers/board.js";
import { addUsage, createTurnBudget, duplicateKey, emptyUsage, invocationAllowed, noteConsultRequests, noteInvocation, remainingConsultRequests, usageDelta, wallClockExpired } from "../../src/server/boards/budget.js";
import { boundRunItems } from "../../src/server/boards/sessions.js";
import type { ChatItem } from "../../src/shared/protocol.js";
import { BOARD_MAX_INVOCATIONS, BOARD_MAX_INVOCATIONS_PER_MEMBER, BOARD_MAX_CONSULT_REQUESTS, BOARD_TURN_WALL_CLOCK_MS } from "../../src/shared/protocol.js";
import type { RoomBudgets } from "../../src/server/boards/types.js";

const limits: RoomBudgets = {
  maxDirectResponders: 4,
  maxConsultRequests: BOARD_MAX_CONSULT_REQUESTS,
  maxInvocations: BOARD_MAX_INVOCATIONS,
  maxInvocationsPerMember: BOARD_MAX_INVOCATIONS_PER_MEMBER,
  turnWallClockMs: BOARD_TURN_WALL_CLOCK_MS,
  queueMax: 20,
};

describe("turn budgets", () => {
  it("enforces the total, per-member, consultation, and wall-clock caps", () => {
    const budget = createTurnBudget({ ...limits, maxInvocations: 2, maxInvocationsPerMember: 1, maxConsultRequests: 1, turnWallClockMs: 100 }, 0);
    expect(invocationAllowed(budget, "m1", 0)).toEqual({ ok: true });
    noteInvocation(budget, "m1");
    expect(invocationAllowed(budget, "m1", 0)).toMatchObject({ ok: false, reason: expect.stringContaining("already ran 1") });
    expect(invocationAllowed(budget, "m2", 0)).toEqual({ ok: true });
    noteInvocation(budget, "m2");
    expect(invocationAllowed(budget, "m3", 0)).toMatchObject({ ok: false, reason: expect.stringContaining("2 invocations") });
    expect(remainingConsultRequests(budget, 0)).toBe(1);
    noteConsultRequests(budget, 1);
    expect(remainingConsultRequests(budget, 0)).toBe(0);
    expect(wallClockExpired(budget, 100)).toBe(true);
    expect(invocationAllowed(budget, "m4", 100)).toMatchObject({ ok: false, reason: expect.stringContaining("wall clock") });
  });

  it("normalizes whitespace and case for duplicate detection", () => {
    expect(duplicateKey("a", "b", "  Check   THIS ")).toBe(duplicateKey("a", "b", "check this"));
    expect(duplicateKey("a", "b", "check this")).not.toBe(duplicateKey("a", "b", "check that"));
  });

  it("keeps a null cost null (unpriced), never zero, and clamps deltas", () => {
    const unpriced = usageDelta(null, { turns: 1, steps: 2, input: 100, cachedInput: 50, cacheWrite: 10, output: 20, cost: null, llmMs: null, ttftMs: null, tokensPerSecond: null });
    expect(unpriced).toMatchObject({ turns: 1, steps: 2, input: 100, output: 20, cost: null, unpriced: 1 });
    const priced = usageDelta(
      { turns: 1, steps: 1, input: 10, cachedInput: 0, cacheWrite: 0, output: 5, cost: 0.01, llmMs: null, ttftMs: null, tokensPerSecond: null },
      { turns: 2, steps: 3, input: 30, cachedInput: 5, cacheWrite: 1, output: 15, cost: 0.04, llmMs: null, ttftMs: null, tokensPerSecond: null },
    );
    expect(priced).toMatchObject({ turns: 1, steps: 2, input: 20, cachedInput: 5, cacheWrite: 1, output: 10, cost: 0.03, unpriced: 0 });
    // A stale reading cannot make a delta negative.
    expect(usageDelta(
      { turns: 5, steps: 5, input: 500, cachedInput: 0, cacheWrite: 0, output: 50, cost: 1, llmMs: null, ttftMs: null, tokensPerSecond: null },
      { turns: 0, steps: 0, input: 0, cachedInput: 0, cacheWrite: 0, output: 0, cost: 0, llmMs: null, ttftMs: null, tokensPerSecond: null },
    )).toMatchObject({ turns: 0, input: 0, output: 0, cost: 0 });
    expect(addUsage(emptyUsage(), unpriced).cost).toBeNull();
  });
});

describe("run item bounds", () => {
  it("keeps the first and last items and marks what was cut", () => {
    const items: ChatItem[] = Array.from({ length: 450 }, (_, i) => ({ kind: "notice", id: `n${i}`, level: "info", text: `item ${i}` }));
    const bounded = boundRunItems(items, "inv-1");
    expect(bounded).toHaveLength(400);
    expect(bounded[0]?.id).toBe("n0");
    expect(bounded[100]?.id).toBe("inv-1:truncated");
    expect(bounded[bounded.length - 1]?.id).toBe("n449");
  });

  it("keeps a run's items portable: a picture's id names bytes this process holds, so the record keeps the text", () => {
    const tool: ChatItem = {
      kind: "tool",
      id: "inv-1:t1",
      name: "read",
      args: "{}",
      status: "done",
      output: "Read image file [image/png]",
      truncated: false,
      category: "read",
      summary: "docs/screenshots/usage.png",
      paths: ["docs/screenshots/usage.png"],
      images: [{ id: "0123456789abcdef0123456789abcdef", mimeType: "image/png" }],
    };
    const bounded = boundRunItems([tool], "inv-1");
    expect(bounded).toHaveLength(1);
    expect(bounded[0]).toMatchObject({ output: "Read image file [image/png]" });
    expect((bounded[0] as { images?: unknown }).images).toBeUndefined();
  });
});

describe("room usage and export", () => {
  it("attributes usage per invocation, preserves null cost, and rolls up by member", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const priced = await makeBot(a, { name: "Atlas", harnessId: "fake", model: "fake/echo" });
      const unpriced = await makeBot(a, { name: "Scout", harnessId: "fake", model: "fake/slow" });
      const room = await makeRoom(a, ws.id, [
        { botId: priced.id, handle: "atlas", rank: 0 },
        { botId: unpriced.id, handle: "scout", rank: 1 },
      ]);
      await send(a, room.room.id, "usagevary", room.room.members.map((member) => member.id));
      const snap = await waitRecords(a, room.room.id, (s) => s.activeTurn === null && botRuns(s).length === 2);
      const runs = botRuns(snap);
      const pricedRun = runs.find((run) => run.memberId === room.room.members[0]?.id);
      const unpricedRun = runs.find((run) => run.memberId === room.room.members[1]?.id);
      expect(pricedRun?.usage?.cost).toBeGreaterThan(0);
      expect(unpricedRun?.usage?.cost).toBeNull();
      expect(unpricedRun?.usage?.unpriced).toBe(1);
      expect(snap.usage.cost).toBeNull();
      expect(snap.usage.unpriced).toBe(1);
      const usage = await a.get(`/api/rooms/${room.room.id}/usage`);
      expect(usage.status).toBe(200);
      expect(usage.body.byMember).toHaveLength(2);
      expect(usage.body.byMember.find((entry: { memberId: string }) => entry.memberId === room.room.members[1]?.id).totals.cost).toBeNull();
    } finally {
      await t.close();
    }
  });

  it("exports the room as Markdown from records, consultations nested, with no native ids", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas", harnessId: "fake" });
      const scout = await makeBot(a, { name: "Scout", harnessId: "fake-b" });
      const room = await makeRoom(a, ws.id, [
        { botId: lead.id, handle: "atlas", canLead: true },
        { botId: scout.id, handle: "scout" },
      ]);
      await patchMember(a, room.room.id, room.room.members[0]!.id, { consultants: [room.room.members[1]!.id] });
      await send(a, room.room.id, "consult");
      await waitRecords(a, room.room.id, (s) => s.activeTurn === null && botRuns(s).length === 3);
      const owned = t.manager.list().find((chat) => chat.owner);
      const exported = await a.get(`/api/rooms/${room.room.id}/export`);
      expect(exported.status).toBe(200);
      expect(exported.headers["content-type"]).toContain("text/markdown");
      expect(exported.headers["content-disposition"]).toContain("attachment");
      const body = exported.text;
      expect(body).toContain("# Room");
      expect(body).toContain("## Turn 1");
      expect(body).toContain("### @atlas");
      expect(body).toContain("#### Consultation @atlas → @scout: answered");
      expect(body).toContain("Final answer after consultations");
      expect(body).not.toContain(owned!.nativeId as string);
      expect(body).not.toContain("/proj");
    } finally {
      await t.close();
    }
  });

  it("pages older records with before and keeps the page ordered and bounded", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas", harnessId: "fake" });
      const room = await makeRoom(a, ws.id, [{ botId: lead.id, handle: "atlas" }]);
      await send(a, room.room.id, "first");
      await waitRecords(a, room.room.id, (s) => s.activeTurn === null && botRuns(s).length === 1);
      await send(a, room.room.id, "second");
      const snap = await waitRecords(a, room.room.id, (s) => s.activeTurn === null && botRuns(s).length === 2);
      const all = await snapshot(a, room.room.id);
      const newest = all.records[all.records.length - 1]!;
      const page = await a.get(`/api/rooms/${room.room.id}/history`).query({ before: newest.seq, limit: 1 });
      expect(page.status).toBe(200);
      expect(page.body.records).toHaveLength(1);
      expect(page.body.records[0].seq).toBeLessThan(newest.seq);
      expect(snap.records.length).toBe(all.records.length);
    } finally {
      await t.close();
    }
  });
});
