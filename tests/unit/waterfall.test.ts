import { describe, expect, it } from "vitest";
import type { ChatItem, ToolItem } from "../../src/shared/protocol.js";
import { buildTurns } from "../../src/web/turns.js";
import { atLabel, niceAxis, niceStep, rowName, tickLabel, turnWaterfall } from "../../src/web/waterfall.js";

const WS = "/work/app";
const T0 = 1_000_000;
const user = (at: number): ChatItem => ({ kind: "user", id: "u", text: "go", at });
const tool = (id: string, name: string, at: number, endedAt: number | undefined, extra: Partial<ToolItem> = {}): ToolItem => ({
  kind: "tool", id, name, args: JSON.stringify({ command: "npm test" }), status: endedAt === undefined ? "running" : "done", output: "", truncated: false,
  category: "command", summary: "npm test", paths: [], at, ...(endedAt !== undefined ? { endedAt } : {}), ...extra,
});
const answer = (at: number, endedAt: number): ChatItem => ({ kind: "assistant", id: "a", text: "Done.", thinking: "", streaming: false, at, endedAt });
const turnOf = (items: ChatItem[], status: "idle" | "running" = "idle") => buildTurns(items, status)[0]!;

describe("niceAxis", () => {
  it("picks 1, 2 or 5 times a power of ten", () => {
    expect(niceStep(38_200)).toBe(10_000);
    expect(niceStep(900)).toBe(200);
    expect(niceStep(12)).toBe(5);
  });
  it("ends on the first round tick at or past the end", () => {
    const a = niceAxis(38_200);
    expect(a.total).toBe(40_000);
    expect(a.ticks.map((t) => t.label)).toEqual(["0", "10 s", "20 s", "30 s", "40 s"]);
    expect(niceAxis(900).ticks.map((t) => t.label)).toEqual(["0", "200 ms", "400 ms", "600 ms", "800 ms", "1 s"]);
  });
  it("has no axis for nothing", () => {
    expect(niceAxis(0)).toEqual({ total: 0, ticks: [] });
  });
  it("labels minutes and halves", () => {
    expect(tickLabel(120_000, 60_000)).toBe("2m");
    expect(tickLabel(1500, 500)).toBe("1.5 s");
  });
});

describe("turnWaterfall", () => {
  it("has rows from the prompt to the settle, in order, with the slowest call marked", () => {
    const t = turnOf([user(T0), tool("t1", "bash", T0 + 400, T0 + 38_600), tool("t2", "bash", T0 + 38_700, T0 + 38_900), answer(T0 + 39_000, T0 + 40_000)]);
    const w = turnWaterfall(t, WS, T0 + 99_000);
    expect(w.rows.map((r) => [r.kind, r.start, r.end, r.slowest])).toEqual([["tool", 400, 38_600, true], ["tool", 38_700, 38_900, false], ["reply", 39_000, 40_000, false]]);
    expect(w.rows[0]!.label).toBe("Ran npm test");
    expect(w.total).toBe(40_000);
    expect(rowName(w.rows[0]!)).toBe("Ran npm test, 400 ms to 38.6 s, slowest call");
  });
  it("marks no slowest for a single call", () => {
    const w = turnWaterfall(turnOf([user(T0), tool("t1", "bash", T0 + 10, T0 + 900)]), WS, T0 + 1000);
    expect(w.rows.some((r) => r.slowest)).toBe(false);
  });
  it("ends a running turn's open call at now", () => {
    const t = turnOf([user(T0), tool("t1", "bash", T0 + 1000, undefined)], "running");
    const w = turnWaterfall(t, WS, T0 + 6000);
    expect(w.rows[0]).toMatchObject({ start: 1000, end: 6000, running: true });
    expect(rowName(w.rows[0]!)).toContain("still running");
    expect(w.total).toBe(6000);
  });
  it("is empty when nothing has a time", () => {
    const bare = tool("t1", "bash", 0, 1);
    delete bare.at;
    delete bare.endedAt;
    const w = turnWaterfall(turnOf([{ kind: "user", id: "u", text: "go" }, bare]), WS, T0);
    expect(w).toEqual({ rows: [], total: 0, span: 0, ticks: [] });
  });
  it("reports the turn's real length beside the axis it rounds up to", () => {
    const w = turnWaterfall(turnOf([{ kind: "user", id: "u", text: "go" }, tool("t1", "bash", 0, 1.7)]), WS, T0);
    expect(w.span).toBeGreaterThan(0);
    expect(w.total).toBeGreaterThanOrEqual(w.span);
  });
  it("folds a subagent call's runs under it, with only the tokens and cost they reported", () => {
    const call = tool("t1", "task", T0 + 500, T0 + 20_500, {
      category: "agent",
      summary: "scout the repo",
      subagents: { runs: [
        { id: "r1", agent: "scout", task: "find   the\nentry point", status: "done", durationMs: 12_000, tokens: 12_400, cost: 0.04 },
        { id: "r2", agent: "worker", task: "", status: "done", durationMs: 8000 },
        { id: "r3", agent: "late", task: "x", status: "done" },
      ] },
    });
    const w = turnWaterfall(turnOf([user(T0), call, answer(T0 + 21_000, T0 + 21_500)]), WS, T0 + 30_000);
    const subs = w.rows.filter((r) => r.depth === 1);
    expect(subs.map((r) => [r.label, r.start, r.end, r.extra])).toEqual([["scout: find the entry point", 500, 12_500, "12k tokens · $0.04"], ["worker", 500, 8500, ""]]);
    expect(w.rows[0]!.kind).toBe("agent");
  });
  it("names thinking and replies", () => {
    const think: ChatItem = { kind: "assistant", id: "k", text: "", thinking: "hm", streaming: false, at: T0 + 100, endedAt: T0 + 900 };
    const w = turnWaterfall(turnOf([user(T0), think, answer(T0 + 1000, T0 + 1500)]), WS, T0 + 2000);
    expect(w.rows.map((r) => r.label)).toEqual(["Thinking", "Answer"]);
  });
});

describe("atLabel", () => {
  it("reads milliseconds, seconds, and minutes", () => {
    expect([atLabel(412), atLabel(38_200), atLabel(125_000)]).toEqual(["412 ms", "38.2 s", "2m 5s"]);
  });
});
