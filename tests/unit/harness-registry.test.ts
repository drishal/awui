import { describe, expect, it, vi } from "vitest";
import { HarnessRegistry } from "../../src/server/harness/registry.js";
import type { HarnessAdapter } from "../../src/server/harness/types.js";

/**
 * An adapter that answers whatever the test set last: the point is the registry's
 * bookkeeping, not a harness's discovery. `calls` is how many times it was asked.
 */
function stub(answers: { available: boolean; reason?: string }[]) {
  const state = { calls: 0 };
  const adapter = {
    id: "stub",
    displayName: "Stub",
    capabilities: {},
    accent: "link",
    discover: async () => {
      const answer = answers[Math.min(state.calls, answers.length - 1)] ?? { available: false };
      state.calls += 1;
      return { ...answer, warnings: [], overrides: {} };
    },
  } as unknown as HarnessAdapter;
  const registry = new HarnessRegistry();
  registry.register(adapter);
  return { registry, state };
}

describe("HarnessRegistry.recheck", () => {
  it("asks again after a stale verdict, so a harness that came back is usable", async () => {
    const { registry, state } = stub([{ available: false, reason: "a gateway owns the home" }, { available: true }]);
    expect((await registry.refreshStatus())[0]).toMatchObject({ available: false });
    const rechecked = await registry.recheck("stub", true);
    expect(rechecked).toMatchObject({ available: true });
    expect(state.calls).toBe(2);
  });

  it("serves the cached verdict within its throttle, so a broken harness is not spawned per request", async () => {
    const { registry, state } = stub([{ available: false, reason: "not installed" }]);
    await registry.refreshStatus();
    await registry.recheck("stub");
    await registry.recheck("stub");
    expect(state.calls).toBe(1);
    expect(await registry.recheck("nope")).toBeUndefined();
  });

  it("asks again before believing a cached no, and never re-asks a yes", async () => {
    vi.useFakeTimers();
    try {
      const { registry, state } = stub([{ available: false, reason: "starting" }, { available: true }]);
      await registry.refreshStatus();
      // A no inside the throttle is still the cached one: the ask is what the throttle buys.
      expect(await registry.available("stub")).toBe(false);
      expect(state.calls).toBe(1);
      vi.advanceTimersByTime(6_000);
      expect(await registry.available("stub")).toBe(true);
      expect(state.calls).toBe(2);
      // A yes is believed as it stands.
      expect(await registry.available("stub")).toBe(true);
      expect(state.calls).toBe(2);
      expect(await registry.available("nope")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("joins an in-flight discovery instead of starting another", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = { calls: 0 };
    const adapter = {
      id: "stub",
      displayName: "Stub",
      capabilities: {},
      accent: "link",
      discover: async () => {
        state.calls += 1;
        await gate;
        return { available: true, warnings: [], overrides: {} };
      },
    } as unknown as HarnessAdapter;
    const registry = new HarnessRegistry();
    registry.register(adapter);
    const first = registry.recheck("stub", true);
    const second = registry.recheck("stub", true);
    expect(state.calls).toBe(1);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ available: true });
    expect(b).toBe(a);
    expect(state.calls).toBe(1);
  });
});
