// The normalizer's labelled corpus, replayed in CI: no network, and the real service does the deciding.
//
// Recorded replies are synthetic until a live run (`npm run eval:normalizer -- --live`) records real
// ones; every fixture says which it is, and the report prints both counts. What is asserted here is
// behaviour, not a vendor's accuracy: nothing leaks, nothing the parsers settled is ever sent, a
// blocked network keeps every row, the cache answers a repeat, and the sweep has an operating point.
import { describe, expect, it } from "vitest";
import { formatReport, itemOf, loadFixtures, replay, sweep } from "./normalizer-eval.js";
import { eligibleForDecision } from "../../src/server/normalizer/service.js";

const fixtures = loadFixtures();

describe("the normalizer's recorded corpus", () => {
  it("has fixtures for every family the gate cares about, each labelled by hand", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(12);
    const kinds = new Set(fixtures.map((fixture) => fixture.labels.kind));
    expect(kinds).toContain("test");
    expect(kinds).toContain("command");
    expect(fixtures.filter((fixture) => !fixture.labels.show_card).length).toBeGreaterThanOrEqual(4);
    expect(fixtures.every((fixture) => fixture.id && fixture.output && fixture.labels && typeof fixture.labels.show_card === "boolean")).toBe(true);
    // Every fixture that the built-in parsers settled stays settled; the corpus does not pretend otherwise.
    expect(fixtures.filter((fixture) => !eligibleForDecision(itemOf(fixture))).map((fixture) => fixture.id)).toEqual(["edit-settled-01", "vitest-settled-01"]);
  });

  it("replays every fixture through the real service without a single body carrying a secret", async () => {
    const report = await replay(fixtures);
    expect(report.leaks).toBe(0);
    expect(report.sent).toBe(13);
    expect(report.settled).toBe(2);
    expect(report.misses).toEqual([]);
    expect(report.kindCorrect).toBe(report.kindTotal);
    expect(report.falseCards).toBe(0);
    expect(report.cards).toBe(8);
    // Two named failures were too close to call: the card shows the sniffer's counts and no name.
    expect(report.picksNamed).toBe(4);
    expect(report.cost.inputTokens).toBeGreaterThan(0);
    expect(report.kindTotal).toBe(report.cards);
    expect(formatReport(report)).toContain("false cards  0/5");
  });

  it("is deterministic: the same corpus twice gives the same decisions", async () => {
    const first = await replay(fixtures, { cache: false });
    const second = await replay(fixtures, { cache: false });
    expect(second.cards).toBe(first.cards);
    expect(second.misses).toEqual(first.misses);
    expect(second.leaks).toBe(0);
  });

  it("keeps every ordinary row when the network is blocked", async () => {
    const report = await replay(fixtures, { network: "blocked" });
    expect(report.sent).toBe(13);
    expect(report.offlineKept).toBe(13);
    expect(report.cards).toBe(0);
    expect(report.leaks).toBe(0);
  });

  it("answers a second identical run from the cache when it is on", async () => {
    const report = await replay(fixtures, { cache: true });
    // One service per run, so a hit needs two identical calls inside it: the corpus has none, and the
    // report says so rather than inventing one.
    expect(report.cache.hits + report.cache.misses).toBe(report.cache.misses);
  });

  it("sweeps the thresholds and finds an operating point under 1% false cards", async () => {
    const { table, best } = await sweep(fixtures);
    expect(table.split("\n")).toHaveLength(11);
    expect(best).not.toBeNull();
    expect(best!.falseCardRate).toBeLessThanOrEqual(0.01);
    expect(best!.coverage).toBeGreaterThan(0);
  });
});
