// Sessions that were mid-run at shutdown (resume-intent.ts): recorded when the server
// stops, taken once when the chat is next opened, and dropped when they go stale.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INTENT_TTL_MS, MAX_INTENTS, ResumeIntents } from "../../src/server/resume-intent.js";

describe("a run interrupted by a restart", () => {
  it("is recorded once, and taken once", async () => {
    const store = ResumeIntents.inMemory();
    await store.markMany(["fake:s1", "fake:s2"], 1000);
    expect(store.all(1000)).toEqual(["fake:s1", "fake:s2"]);
    expect(await store.take("fake:s1", 1000)).toBe(true);
    expect(await store.take("fake:s1", 1000)).toBe(false);
    expect(store.all(1000)).toEqual(["fake:s2"]);
  });

  it("forgets what nobody reopened within a day", async () => {
    const store = ResumeIntents.inMemory();
    await store.markMany(["fake:s1"], 1000);
    expect(await store.take("fake:s1", 1000 + INTENT_TTL_MS + 1)).toBe(false);
    expect(store.all(1000 + INTENT_TTL_MS + 1)).toEqual([]);
  });

  it("keeps the newest, and never more than the cap", async () => {
    const store = ResumeIntents.inMemory();
    const ids = Array.from({ length: MAX_INTENTS + 10 }, (_, i) => `fake:s${i}`);
    await store.markMany(ids, 1000);
    // markMany records at most MAX_INTENTS in one call.
    expect(store.all(1000)).toHaveLength(MAX_INTENTS);
    expect(store.all(1000)[0]).toBe("fake:s0");
    // A later shutdown adds the newest and drops the oldest.
    await store.markMany(["fake:new"], 2000);
    const kept = store.all(2000);
    expect(kept).toHaveLength(MAX_INTENTS);
    expect(kept).toContain("fake:new");
    // The one that went is the last of the earlier batch (ties keep the order they were recorded in).
    expect(kept).toContain("fake:s0");
    expect(kept).not.toContain(`fake:s${MAX_INTENTS - 1}`);
  });

  it("reads what a previous process wrote, and ignores junk", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "awui-resume-"));
    try {
      writeFileSync(path.join(dir, "resume-intents.json"), JSON.stringify({ "fake:s1": 1000, junk: "soon", "": 5 }));
      const store = await ResumeIntents.open(dir);
      expect(store.all(1000)).toEqual(["fake:s1"]);
      expect(await store.take("fake:s1", 1000)).toBe(true);
      // Taking it again after a reopen of the file is a fresh read: nothing left.
      expect((await ResumeIntents.open(dir)).all(1000)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
