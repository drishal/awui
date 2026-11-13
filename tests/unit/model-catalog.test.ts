import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ModelCatalog } from "../../src/server/model-catalog.js";
import { asHarnessId, type ModelInfo } from "../../src/shared/protocol.js";
import { tempDir } from "../helpers/app.js";

/** A harness whose answers the test controls: each ask is counted, and can be held open or made to fail. */
function harness(id: string) {
  const state = {
    asks: 0,
    forgotten: 0,
    fail: false,
    gate: null as Promise<void> | null,
    models: [{ key: `${id}/one`, provider: id, id: "one", name: "One" }] as ModelInfo[],
    fallback: `${id}/one`,
  };
  const adapter = {
    id: asHarnessId(id),
    async listModels() {
      state.asks += 1;
      if (state.gate) await state.gate;
      if (state.fail) throw new Error("no login");
      return state.models;
    },
    async listThinkingLevels() {
      return ["low", "high"];
    },
    async defaultModel() {
      return { model: state.fallback, thinkingLevel: null };
    },
    forgetModels() {
      state.forgotten += 1;
    },
  };
  return { adapter, state };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("model catalog", () => {
  it("asks once, then answers from what it kept; a stale answer is served and refreshed behind it", async () => {
    let now = 1_000;
    const catalog = new ModelCatalog(null, () => now);
    const { adapter, state } = harness("pi");
    const [a, b] = await Promise.all([catalog.get(adapter, "/p"), catalog.get(adapter, "/p")]);
    expect(state.asks).toBe(1);
    expect(a).toEqual({ models: state.models, thinkingLevels: ["low", "high"], defaultModel: { model: "pi/one", thinkingLevel: null } });
    expect(b).toEqual(a);
    await catalog.get(adapter, "/p");
    expect(state.asks).toBe(1);

    // Past a minute: this answer is the old one, at once, and the harness is asked behind it.
    now += 61_000;
    state.models = [{ key: "pi/two", provider: "pi", id: "two", name: "Two" }];
    state.fallback = "pi/two";
    const stale = await catalog.get(adapter, "/p");
    expect(stale.defaultModel?.model).toBe("pi/one");
    await settle();
    expect(state.asks).toBe(2);
    expect((await catalog.get(adapter, "/p")).defaultModel?.model).toBe("pi/two");
  });

  it("keeps the last answer when a refresh behind it fails, and fails only with nothing to serve", async () => {
    let now = 0;
    const catalog = new ModelCatalog(null, () => now);
    const { adapter, state } = harness("claude");
    await catalog.get(adapter, "/p");
    state.fail = true;
    now += 61_000;
    expect((await catalog.get(adapter, "/p")).models).toHaveLength(1);
    await settle();
    expect((await catalog.get(adapter, "/p")).models).toHaveLength(1);
    await expect(catalog.get(adapter, "/other")).rejects.toThrow("no login");
  });

  it("asks the harness now on Refresh, after any ask already on its way", async () => {
    const catalog = new ModelCatalog(null);
    const { adapter, state } = harness("grok");
    await catalog.get(adapter, "/p");
    state.models = [{ key: "grok/new", provider: "grok", id: "new", name: "New" }];
    const fresh = await catalog.get(adapter, "/p", true);
    expect(state.forgotten).toBe(1);
    expect(state.asks).toBe(2);
    expect(fresh.models.map((m) => m.key)).toEqual(["grok/new"]);
  });

  it("serves a restart the answers it saved, and refreshes them behind the first look", async () => {
    const dir = tempDir("awui-catalog-");
    const file = path.join(dir, "model-catalog.json");
    const first = harness("omp");
    const before = new ModelCatalog(file);
    await before.get(first.adapter, "/p");
    await before.saved();
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1 });

    const second = harness("omp");
    second.state.gate = new Promise(() => undefined); // the harness never answers: only the saved answer can
    // The restarted server's clock is past the saved answer's minute: it is served, and asked behind.
    const answer = await new ModelCatalog(file, () => Date.now() + 61_000).get(second.adapter, "/p");
    expect(answer.defaultModel?.model).toBe("omp/one");
    expect(second.state.asks).toBe(1);
  });

  it("ignores a saved file that is not its own shape", async () => {
    const dir = tempDir("awui-catalog-");
    const file = path.join(dir, "model-catalog.json");
    writeFileSync(file, JSON.stringify({ version: 1, entries: { "pi\0/p": { at: 1, models: [{ key: 7 }, "x"], defaultModel: "nope" } } }));
    const { adapter } = harness("pi");
    const answer = await new ModelCatalog(file, () => 2).get(adapter, "/p");
    expect(answer).toMatchObject({ models: [], defaultModel: null });
  });

  it("warms the answers a project has none of, one harness at a time", async () => {
    const catalog = new ModelCatalog(null);
    const pi = harness("pi");
    const omp = harness("omp");
    const claude = harness("claude");
    await catalog.get(pi.adapter, "/p");
    let release!: () => void;
    omp.state.gate = new Promise((r) => (release = r));
    const warmed = catalog.warm([pi.adapter, omp.adapter, claude.adapter], "/p");
    await settle();
    // pi already had one; omp is being asked; claude waits its turn behind omp.
    expect([pi.state.asks, omp.state.asks, claude.state.asks]).toEqual([1, 1, 0]);
    release();
    await warmed;
    expect(claude.state.asks).toBe(1);
    expect(await catalog.has("claude", "/p")).toBe(true);
  });

  it("refreshes the stale answers of the projects asked about last, one harness at a time", async () => {
    let now = 0;
    const catalog = new ModelCatalog(null, () => now);
    const pi = harness("pi");
    const omp = harness("omp");
    const claude = harness("claude");
    await catalog.get(pi.adapter, "/oldest");
    now = 1_000;
    await catalog.get(pi.adapter, "/a");
    now = 2_000;
    await catalog.get(omp.adapter, "/b");
    now = 3_000;
    await catalog.get(claude.adapter, "/c");

    now = 200_000;
    let release!: () => void;
    claude.state.gate = new Promise((r) => (release = r));
    // The two projects asked about last: /c (claude) and /b (omp). Nothing in /a or /oldest is touched.
    const warming = catalog.warmSaved([pi.adapter, omp.adapter, claude.adapter], { projects: 2 });
    await settle();
    expect([pi.state.asks, omp.state.asks, claude.state.asks]).toEqual([2, 1, 2]);
    release();
    await warming;
    expect([pi.state.asks, omp.state.asks, claude.state.asks]).toEqual([2, 2, 2]);

    // Fresh answers are not asked for again, and a harness handed in that has no saved answer is left alone.
    now = 210_000;
    const extra = harness("grok");
    await catalog.warmSaved([pi.adapter, omp.adapter, claude.adapter, extra.adapter], { projects: 2 });
    expect([pi.state.asks, omp.state.asks, claude.state.asks, extra.state.asks]).toEqual([2, 2, 2, 0]);
  });

  it("fills the first project's answers when nothing is saved, and reports a failing harness once", async () => {
    const catalog = new ModelCatalog(null);
    const pi = harness("pi");
    const omp = harness("omp");
    pi.state.fail = true;
    const errors: unknown[] = [];
    await catalog.warmSaved([pi.adapter, omp.adapter], { fallbackCwd: "/root", onError: (error) => errors.push(error) });
    expect([pi.state.asks, omp.state.asks]).toEqual([1, 1]);
    expect(await catalog.has("omp", "/root")).toBe(true);
    expect(errors).toHaveLength(1);
  });

  it("asks two stale projects again, says once when the harness fails for both, and keeps the last answers", async () => {
    let now = 0;
    const catalog = new ModelCatalog(null, () => now);
    const pi = harness("pi");
    const omp = harness("omp");
    await catalog.get(pi.adapter, "/a");
    await catalog.get(pi.adapter, "/b");
    await catalog.get(omp.adapter, "/a");
    now = 200_000;
    pi.state.fail = true;
    const errors: unknown[] = [];
    await catalog.warmSaved([pi.adapter, omp.adapter], { onError: (error) => errors.push(error) });
    expect([pi.state.asks, omp.state.asks]).toEqual([4, 2]);
    expect(errors).toHaveLength(1);
    expect((await catalog.get(pi.adapter, "/a")).models).toHaveLength(1);
  });
});
