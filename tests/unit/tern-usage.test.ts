import { describe, expect, it } from "vitest";
import type { Node } from "@stencil-hq/tern";
import type { LimitAccount, UsageReport, UsageTotals } from "../../src/shared/protocol.js";
import { accountRows, dayPoints, figures, harnessRows, modelRows, notes, stepRange, usageNode, type UsageCx } from "../../src/tern/usage.js";
import { resetsIn } from "../../src/web/limit-words.js";

const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({ input: 0, cachedInput: 0, cacheWrite: 0, output: 0, cost: 0, calls: 0, unpriced: 0, ...over });
const name = (id: string) => ({ omp: "omp", fake: "Fake" })[id] ?? id;

/** Three days over two harnesses and two models; the last day's calls are all unpriced. */
function report(over: Partial<UsageReport> = {}): UsageReport {
  const day = (d: string, t: Partial<UsageTotals>, tokensByHarness: Record<string, number>) => ({ day: d, totals: totals(t), tokensByHarness });
  return {
    days: 7,
    since: 0,
    totals: { ...totals({ input: 3000, cachedInput: 1000, cacheWrite: 0, output: 2000, cost: 1.5, calls: 6, unpriced: 2 }), sessions: 3 },
    byDay: [
      day("2026-11-01", {}, {}),
      day("2026-11-02", { input: 2000, cachedInput: 1000, output: 1000, cost: 1.5, calls: 4 }, { omp: 3000, fake: 1000 }),
      day("2026-11-03", { input: 1000, output: 1000, calls: 2, unpriced: 2 }, { fake: 2000 }),
    ],
    byHarness: [
      { harnessId: "omp", totals: totals({ input: 2000, cachedInput: 500, output: 500, cost: 1.5, calls: 3 }), sessions: 1 },
      { harnessId: "fake", totals: totals({ input: 1000, cachedInput: 500, output: 1500, calls: 3, unpriced: 3 }), sessions: 2 },
    ],
    byModel: [
      { model: "gpt-x", harnesses: ["omp"], totals: totals({ input: 2000, cachedInput: 500, output: 500, cost: 1.5, calls: 3 }) },
      { model: "echo", harnesses: ["fake", "omp"], totals: totals({ input: 1000, cachedInput: 500, output: 1500, calls: 3, unpriced: 3 }) },
    ],
    top: [],
    workspaces: [],
    unreadable: [],
    scanned: 3,
    total: 3,
    truncated: false,
    ...over,
  };
}

const all = (n: Node): Node[] => [n, ...n.children.flatMap(all)];
const text = (n: Node): string => all(n).map((x) => JSON.stringify(x.props)).join("\n");

describe("the Tern Usage screen's figures", () => {
  it("steps through the ranges and stops at the ends", () => {
    expect(stepRange(30, 1)).toBe(90);
    expect(stepRange(90, 1)).toBe(90);
    expect(stepRange(30, -1)).toBe(7);
    expect(stepRange(7, -1)).toBe(7);
  });

  it("words the totals as the web dialog does, and prices only what was priced", () => {
    const [tokens, output, cache, cost, chats] = figures(report());
    expect(tokens).toMatchObject({ label: "Tokens", value: "6.0k", sub: "6 model calls" });
    expect(output).toMatchObject({ value: "2.0k", sub: "3.0k fresh input" });
    expect(cache).toMatchObject({ value: "25%", sub: "1.0k input tokens" });
    expect(cost).toMatchObject({ value: "$1.50", sub: "2 calls not priced" });
    expect(chats).toMatchObject({ value: "3", sub: "with calls in 7 days" });
  });

  it("invents no cost when nothing was priced, and no cache share without input", () => {
    const none = report({ totals: { ...totals({ calls: 1, unpriced: 1, output: 5 }), sessions: 1 } });
    const [, , cache, cost] = figures(none);
    expect(cost).toMatchObject({ value: "—", sub: "1 call not priced" });
    expect(cache?.value).toBe("—");
    expect(figures(report({ totals: { ...totals({ input: 10, calls: 1 }), sessions: 1 } }))[3]).toMatchObject({ value: "$0.00", sub: "every call priced" });
  });

  it("makes a bar a day, labels some days, and names each harness's part in the hover", () => {
    const points = dayPoints(report(), name);
    expect(points.map((p) => p.value)).toEqual([0, 4000, 2000]);
    // Seven days are each labelled; only a day with several harnesses has a split in its hover.
    expect(points[2]?.label).toBe("Nov 3");
    expect(points[1]?.title).toBe("2026-11-02: 4.0k tokens (omp 3.0k, Fake 1.0k)");
    expect(points[2]?.title).toBe("2026-11-03: 2.0k tokens");
  });

  it("lists harnesses and models with their share of the largest, and names a model's several harnesses", () => {
    expect(harnessRows(report(), name)).toEqual([
      { id: "omp", name: "omp", share: 1, tokens: "3.0k", cost: "$1.50" },
      { id: "fake", name: "Fake", share: 1, tokens: "3.0k", cost: "—" },
    ]);
    const models = modelRows(report(), name);
    expect(models.map((m) => m.name)).toEqual(["gpt-x", "echo (Fake, omp)"]);
    expect(models.map((m) => m.cost)).toEqual(["$1.50", "—"]);
    expect(harnessRows(report({ byHarness: [] }), name)).toEqual([]);
  });

  it("says what the numbers leave out", () => {
    expect(notes(report())).toEqual(["Read from the harnesses' own session files, never by starting one."]);
    const more = notes(report({ unreadable: ["Hermes"], truncated: true, scanned: 40, total: 90 }));
    expect(more[1]).toBe("Hermes keeps sessions in a database of its own, so its calls are not counted.");
    expect(more[2]).toBe("Stopped after 40 of 90 chats to stay quick.");
  });

  it("words when a limit resets", () => {
    expect(resetsIn(1000 + 40 * 60_000, 1000)).toBe("in 40m");
    expect(resetsIn(1000 + 192 * 60_000, 1000)).toBe("in 3h 12m");
    expect(resetsIn(1000 + (52 * 60 + 5) * 60_000, 1000)).toBe("in 2d 4h");
    expect(resetsIn(0, 1000)).toBe("in 0m");
  });

  it("rows each account's windows, with a status-only window shown without a figure", () => {
    const account: LimitAccount = {
      id: "claude",
      source: "Claude Code",
      provider: "anthropic",
      plan: "Max",
      limited: false,
      at: 0,
      windows: [
        { label: "5 hours", used: 0.42, resetsAt: 130 * 60_000 },
        { label: "7 days", used: null, resetsAt: null },
      ],
    };
    const [row] = accountRows([account, { ...account, id: "b", limited: true, plan: undefined }], 0);
    expect(row).toMatchObject({ name: "Claude · Max", limited: false });
    expect(row?.windows).toEqual([
      { id: "0", label: "Claude 5 hours", used: 0.42, total: "42% · resets in 2h 10m" },
      { id: "1", label: "Claude 7 days", used: null, total: "no figure" },
    ]);
    expect(accountRows([{ ...account, limited: true, plan: undefined }], 0)[0]?.name).toBe("Claude · limited");
  });
});

describe("the Tern Usage overlay", () => {
  const account: LimitAccount = { id: "claude", source: "Claude Code", provider: "anthropic", limited: false, at: 0, windows: [{ label: "5 hours", used: 0.5, resetsAt: null }, { label: "7 days", used: null, resetsAt: null }] };
  const cx = (over: Partial<UsageCx> = {}, screen: Partial<UsageCx["screen"]> = {}): UsageCx => ({
    screen: { days: 7, report: report(), error: null, busy: false, ...screen },
    limits: { accounts: [account], errors: ["omp: not signed in"] },
    name,
    supports: () => true,
    now: 0,
    on: { close: () => undefined },
    ...over,
  });

  it("draws tiles, bars, tables, and a meter a window with every kind announced", () => {
    const node = usageNode(cx());
    expect(node.kind).toBe("overlay");
    expect(node.props).toMatchObject({ head: "Usage", meta: "last 7 days" });
    const nodes = all(node);
    expect(nodes.find((n) => n.kind === "stats")?.props.items).toHaveLength(5);
    const chart = nodes.find((n) => n.kind === "chart");
    expect(chart?.props).toMatchObject({ kind: "bars" });
    expect(chart?.props.series).toHaveLength(3);
    expect(nodes.filter((n) => n.kind === "table")).toHaveLength(2);
    // Only the window with a figure is a meter; the status-only one is a line.
    expect(nodes.filter((n) => n.kind === "meter").map((n) => n.props.value)).toEqual([0.5]);
    expect(text(node)).toContain("Claude 7 days");
    expect(text(node)).toContain("omp: not signed in");
  });

  it("falls back to key-value rows, then to plain text, for a terminal without the kinds", () => {
    const kv = all(usageNode(cx({ supports: (k) => k === "kv" })));
    expect(kv.filter((n) => n.kind === "kv")).toHaveLength(3);
    expect(kv.some((n) => ["stats", "chart", "table", "meter"].includes(n.kind))).toBe(false);

    const plain = usageNode(cx({ supports: () => false }));
    expect(all(plain).some((n) => ["stats", "kv", "chart", "table", "meter"].includes(n.kind))).toBe(false);
    const written = text(plain);
    for (const want of ["Tokens: 6.0k", "Cost: $1.50", "2026-11-02: 4.0k tokens", "gpt-x  3.0k", "Claude 5 hours"]) expect(written).toContain(want);
  });

  it("shows the wait, then the error, never a blank overlay", () => {
    const waiting = usageNode(cx({}, { report: null, busy: true }));
    expect(all(waiting).some((n) => n.kind === "spinner")).toBe(true);
    expect(text(waiting)).toContain("Reading sessions");
    expect(all(waiting).some((n) => n.kind === "stats")).toBe(false);

    const failed = usageNode(cx({ limits: null }, { report: null, error: "Cannot reach the awui server" }));
    expect(text(failed)).toContain("Could not read usage: Cannot reach the awui server");
    expect(all(failed).some((n) => n.kind === "spinner")).toBe(false);

    // Moving to another range keeps the last report in view with the wait above it.
    const next = usageNode(cx({}, { days: 30, busy: true }));
    expect(all(next).some((n) => n.kind === "spinner")).toBe(true);
    expect(all(next).some((n) => n.kind === "stats")).toBe(true);
    expect(text(next)).toContain("Reading the last 30 days");
  });

  it("says when a range has no calls", () => {
    const empty = report({ byHarness: [], byModel: [], byDay: [], totals: { ...totals(), sessions: 0 } });
    expect(text(usageNode(cx({}, { report: empty })))).toContain("No calls in this range");
  });
});
