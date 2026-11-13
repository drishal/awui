// Usage across sessions: each harness's calls read from its file shape, added
// up by day (in the browser's zone), harness, model, and session.
import { afterEach, describe, expect, it } from "vitest";
import { asHarnessId, type ChatSnapshot, type ProjectSession, type UsageReport, usageReportSchema } from "../../src/shared/protocol.js";
import { usageEntries } from "../../src/server/harness/agent-events.js";
import { usageOfEntries } from "../../src/server/harness/claude-sessions.js";
import { fileMessages } from "../../src/server/harness/session-files.js";
import type { UsageEntry } from "../../src/server/harness/types.js";
import { buildReport, dayOf, rangeStart, tokensOf, UsageReader } from "../../src/server/usage-report.js";
import { makeTestApp, openSse, signedIn, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const NOW = Date.parse("2026-10-15T09:00:00Z");
const call = (at: string, tokens: Partial<UsageEntry> = {}): UsageEntry => ({ at: Date.parse(at), model: "m1", input: 100, cachedInput: 0, cacheWrite: 0, output: 10, cost: 0.01, ...tokens });
const session = (id: string, harness = "pi"): ProjectSession => ({ id: `${harness}:${id}`, harnessId: asHarnessId(harness), title: id, updatedAt: "2026-10-15T08:00:00Z", workspaceId: "w" });

describe("usage, from the harnesses' files", () => {
  it("reads every Pi-family call with its time, model, tokens, and price, on any branch", () => {
    const text = [
      JSON.stringify({ type: "session", id: "s", cwd: "/p" }),
      JSON.stringify({ type: "message", id: "1", parentId: null, timestamp: "2026-10-14T10:00:00Z", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "message", id: "2", parentId: "1", timestamp: "2026-10-14T10:00:05Z", message: { role: "assistant", model: "deepseek", usage: { input: 15014, output: 128, cacheRead: 11904, cacheWrite: 0, cost: { total: 0.0023 } } } }),
      // A side branch's call was spent too; one with no tokens is not a call.
      JSON.stringify({ type: "message", id: "3", parentId: "1", timestamp: "2026-10-14T11:00:00Z", message: { role: "assistant", model: "deepseek", timestamp: Date.parse("2026-10-14T11:00:01Z"), usage: { input: 10, output: 5 } } }),
      // All-zero costs are what pi writes for a model it has no price for: not $0.00.
      JSON.stringify({ type: "message", id: "3b", parentId: "3", timestamp: "2026-10-14T11:00:01Z", message: { role: "assistant", model: "claude-opus-5-5", usage: { input: 40, output: 60, cost: { input: 0, output: 0, total: 0 } } } }),
      JSON.stringify({ type: "message", id: "4", parentId: "3", timestamp: "2026-10-14T11:00:02Z", message: { role: "assistant", usage: { input: 0, output: 0 } } }),
      '{"type":"message", torn',
    ].join("\n");
    expect(usageEntries(fileMessages(text))).toEqual([
      { at: Date.parse("2026-10-14T10:00:05Z"), model: "deepseek", input: 15014, cachedInput: 11904, cacheWrite: 0, output: 128, cost: 0.0023 },
      { at: Date.parse("2026-10-14T11:00:01Z"), model: "deepseek", input: 10, cachedInput: 0, cacheWrite: 0, output: 5, cost: null },
      { at: Date.parse("2026-10-14T11:00:01Z"), model: "claude-opus-5-5", input: 40, cachedInput: 0, cacheWrite: 0, output: 60, cost: null },
    ]);
  });

  it("reads Claude Code's calls once per message, the fullest copy, without synthetic ones", () => {
    const entry = (id: string, output: number, model = "claude-opus") => ({ type: "assistant", timestamp: "2026-10-14T10:00:00Z", message: { id, model, usage: { input_tokens: 3, cache_read_input_tokens: 900, cache_creation_input_tokens: 40, output_tokens: output } } });
    const calls = usageOfEntries([entry("a", 1), entry("a", 50), entry("b", 7), entry("c", 9, "<synthetic>"), { type: "user", message: {} }]);
    expect(calls).toEqual([
      { at: Date.parse("2026-10-14T10:00:00Z"), model: "claude-opus", input: 3, cachedInput: 900, cacheWrite: 40, output: 50, cost: null },
      { at: Date.parse("2026-10-14T10:00:00Z"), model: "claude-opus", input: 3, cachedInput: 900, cacheWrite: 40, output: 7, cost: null },
    ]);
  });
});

describe("usage, added up", () => {
  it("puts a call on its day in the browser's zone, and starts the range at that zone's midnight", () => {
    // 23:30 UTC on the 14th is the 15th in UTC+2 (getTimezoneOffset -120).
    expect(dayOf(Date.parse("2026-10-14T23:30:00Z"), 0)).toBe("2026-10-14");
    expect(dayOf(Date.parse("2026-10-14T23:30:00Z"), -120)).toBe("2026-10-15");
    expect(new Date(rangeStart(NOW, 1, 0)).toISOString()).toBe("2026-10-15T00:00:00.000Z");
    expect(new Date(rangeStart(NOW, 7, -120)).toISOString()).toBe("2026-10-08T22:00:00.000Z");
  });

  it("adds up by day, harness, model, and session, every day of the range present", () => {
    const report = buildReport(
      [
        { session: session("a"), entries: [call("2026-10-15T08:00:00Z"), call("2026-10-14T08:00:00Z", { model: "m2", output: 1000 }), call("2026-09-01T08:00:00Z")] },
        { session: session("b", "claude"), entries: [call("2026-10-15T07:00:00Z", { cost: null, cachedInput: 5000 })] },
        { session: session("c"), entries: [call("2026-08-01T08:00:00Z")] },
      ],
      { days: 3, tz: 0, now: NOW, workspaces: [{ id: "w", path: "/p", name: "p" }], unreadable: ["Hermes"], scanned: 3, total: 3, truncated: false },
    );
    expect(report.totals).toMatchObject({ sessions: 2, calls: 3, input: 300, cachedInput: 5000, output: 1020, unpriced: 1 });
    expect(report.totals.cost).toBeCloseTo(0.02);
    expect(report.byDay.map((d) => [d.day, d.totals.calls])).toEqual([
      ["2026-10-13", 0],
      ["2026-10-14", 1],
      ["2026-10-15", 2],
    ]);
    expect(report.byDay[2]?.tokensByHarness).toEqual({ pi: 110, claude: 5110 });
    expect(report.byHarness.map((h) => [h.harnessId, h.sessions])).toEqual([
      ["claude", 1],
      ["pi", 1],
    ]);
    // One row per model name, the harnesses that ran it listed most tokens first.
    expect(report.byModel.map((m) => [m.model, m.harnesses])).toEqual([
      ["m1", ["claude", "pi"]],
      ["m2", ["pi"]],
    ]);
    expect(report.top.map((s) => [s.session.id, tokensOf(s.totals)])).toEqual([
      ["claude:b", 5110],
      ["pi:a", 1210],
    ]);
    expect(report.unreadable).toEqual(["Hermes"]);
  });

  it("skips sessions last active before the range, reads a session once per version, and stops at its budget", async () => {
    const reader = new UsageReader();
    let reads = 0;
    const target = (s: ProjectSession) => ({ session: s, read: async () => (reads++, [call("2026-10-15T08:00:00Z")]) });
    const old = { ...session("old"), updatedAt: "2026-01-01T00:00:00Z" };
    const first = await reader.report([target(session("a")), target(old)], { days: 7, tz: 0, now: NOW, workspaces: [], unreadable: [] });
    expect([first.scanned, first.total, reads]).toEqual([1, 1, 1]);
    await reader.report([target(session("a"))], { days: 7, tz: 0, now: NOW, workspaces: [], unreadable: [] });
    expect(reads).toBe(1);
    const refreshed = await reader.report([target(session("a"))], { days: 7, tz: 0, now: NOW, workspaces: [], unreadable: [], refresh: true });
    expect([reads, refreshed.totals.calls]).toEqual([2, 1]);
    const slow = Array.from({ length: 20 }, (_, i) => ({ session: session(`s${i}`), read: () => new Promise<UsageEntry[]>((r) => setTimeout(() => r([]), 30)) }));
    const cut = await reader.report(slow, { days: 7, tz: 0, now: NOW, workspaces: [], unreadable: [], budgetMs: 40 });
    expect(cut.truncated).toBe(true);
  });

  it("keeps every session of a long history between reports, so a second report reads no file", async () => {
    const reader = new UsageReader();
    let reads = 0;
    const targets = Array.from({ length: 1500 }, (_, i) => ({ session: session(`s${i}`), read: async () => (reads++, [call("2026-10-15T08:00:00Z")]) }));
    const opts = { days: 7, tz: 0, now: NOW, workspaces: [], unreadable: [] };
    await reader.report(targets, opts);
    expect(reads).toBe(1500);
    const again = await reader.report(targets, opts);
    expect([reads, again.totals.calls]).toEqual([1500, 1500]);
  });

  it("validates an explicit report refresh", () => {
    expect(usageReportSchema.safeParse({ refresh: "true" }).success).toBe(false);
    expect(usageReportSchema.parse({ refresh: "1" }).refresh).toBe("1");
  });

  it("answers the route from real chats, in tokens and dollars", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t, chat.chatId, agent.cookie);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "snapshot"));
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "count me" });
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "status" && e.status === "idle"));
    sse.close();
    const report = (await agent.get(`/api/usage?days=7&tz=${new Date().getTimezoneOffset()}`)).body as UsageReport;
    expect(report.totals.sessions).toBe(1);
    expect(report.totals.input).toBe(1200);
    expect(report.totals.cost).toBeGreaterThan(0);
    expect(report.byDay).toHaveLength(7);
    expect(report.byDay[6]?.totals.calls).toBe(1);
    expect(report.top[0]?.session.title).toBe("count me");
    expect((await agent.get("/api/usage?days=0")).status).toBe(400);
  });
});
