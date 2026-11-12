// The resource-pressure sampler (src/server/pressure.ts): sustained high samples warn,
// sustained low ones recover, and the cooldown holds the words back — never the state.
import { describe, expect, it } from "vitest";
import { isHigh, PressureMonitor, type PressureReading } from "../../src/server/pressure.js";

const hot: PressureReading = { loadPerCore: 2, memShare: 0.5 };
const hotMemory: PressureReading = { loadPerCore: 0.2, memShare: 0.96 };
const cool: PressureReading = { loadPerCore: 0.2, memShare: 0.5 };

describe("a reading against the limits", () => {
  it("reads high on either load or memory", () => {
    expect(isHigh(hot)).toBe(true);
    expect(isHigh(hotMemory)).toBe(true);
    expect(isHigh(cool)).toBe(false);
  });
});

describe("the sampler's verdicts", () => {
  it("warns on the third high sample and recovers on the sixth low one", () => {
    const m = new PressureMonitor();
    expect(m.push(hot, 0)).toBeNull();
    expect(m.push(hot, 1)).toBeNull();
    expect(m.push(hot, 2)).toBe("warn");
    expect(m.state).toBe("warn");
    for (let i = 0; i < 5; i++) expect(m.push(cool, 3 + i)).toBeNull();
    expect(m.state).toBe("warn");
    // The sixth low one recovers the state, but its toast is inside the warn's cooldown.
    expect(m.push(cool, 9)).toBeNull();
    expect(m.state).toBe("ok");
  });

  it("does not warn on two highs or recover early", () => {
    const m = new PressureMonitor();
    expect(m.push(hot, 0)).toBeNull();
    expect(m.push(hot, 1)).toBeNull();
    expect(m.state).toBe("ok");
    expect(m.push(hot, 2)).toBe("warn");
    for (let i = 0; i < 5; i++) expect(m.push(cool, 3 + i)).toBeNull();
    expect(m.state).toBe("warn");
  });

  it("resets the counts when the pressure eases before warning", () => {
    const m = new PressureMonitor();
    expect(m.push(hot, 0)).toBeNull();
    expect(m.push(hot, 1)).toBeNull();
    // One low sample wipes the high streak; two highs after are not enough.
    expect(m.push(cool, 2)).toBeNull();
    expect(m.push(hot, 3)).toBeNull();
    expect(m.push(hot, 4)).toBeNull();
    expect(m.push(hot, 5)).toBe("warn");
  });

  it("holds a toast within the cooldown, but never the state change", () => {
    const m = new PressureMonitor({ load: 1.25, memory: 0.95 }, { cooldownMs: 60_000 });
    expect(m.push(hot, 0)).toBeNull();
    expect(m.push(hot, 1)).toBeNull();
    expect(m.push(hot, 2)).toBe("warn");
    // Back to cool long before the cooldown ends: the state lands, the words do not.
    for (let i = 0; i < 6; i++) expect(m.push(cool, 3 + i)).toBeNull();
    expect(m.state).toBe("ok");
    // And a later episode can warn again, outside the old cooldown.
    for (let i = 0; i < 3; i++) expect(m.push(hot, 70_000 + i)).toBe(i === 2 ? "warn" : null);
  });
});
