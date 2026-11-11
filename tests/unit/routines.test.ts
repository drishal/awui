// The routines store (routines.ts): ids, next runs, what is due, the cap, and the last outcome.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_ROUTINES, Routines } from "../../src/server/routines.js";

const base = { name: "Nightly review", prompt: "Review today's commits", harnessId: "pi", workspaceId: "w1" };
const daily = { kind: "daily", hour: 9, minute: 0 } as const;
const same = (got: number | undefined, want: Date) => expect(new Date(got ?? 0).toString()).toBe(want.toString());

describe("the routines store", () => {
  it("saves with an id and a first run ahead, and lists by next run", async () => {
    const r = Routines.inMemory();
    const now = new Date(2026, 9, 9, 8, 0).getTime();
    const saved = await r.save({ ...base, cadence: daily }, now);
    expect(saved.id).toBeTruthy();
    expect(saved.enabled).toBe(true);
    expect(saved.lastRunAt).toBeNull();
    same(saved.nextRunAt, new Date(2026, 9, 9, 9, 0));
    expect(r.all().map((x) => x.id)).toEqual([saved.id]);
    expect(r.due(now)).toEqual([]);
    expect(r.due(saved.nextRunAt)).toHaveLength(1);
  });

  it("keeps the id when it is edited", async () => {
    const r = Routines.inMemory();
    const created = await r.save({ ...base, cadence: daily }, 1000);
    const edited = await r.save({ ...base, id: created.id, name: "Renamed", cadence: created.cadence }, 2000);
    expect(edited.id).toBe(created.id);
    expect(edited.name).toBe("Renamed");
    expect(r.all()).toHaveLength(1);
  });

  it("markRan moves it forward, a disabled one never runs, and remove forgets it", async () => {
    const r = Routines.inMemory();
    const at = new Date(2026, 9, 9, 9, 0).getTime();
    const saved = await r.save({ ...base, cadence: daily }, at - 3_600_000);
    const ran = await r.markRan(saved.id, at);
    expect(ran?.lastRunAt).toBe(at);
    same(ran?.nextRunAt, new Date(2026, 9, 10, 9, 0));
    await r.save({ ...base, id: saved.id, cadence: saved.cadence, enabled: false }, at);
    expect(r.due(at + 86_400_000)).toEqual([]);
    expect(await r.remove(saved.id)).toBe(true);
    expect(await r.remove(saved.id)).toBe(false);
  });

  it("refuses one more than the cap", async () => {
    const r = Routines.inMemory();
    for (let i = 0; i < MAX_ROUTINES; i++) await r.save({ ...base, name: `r${i}`, cadence: { kind: "hourly", minute: 0 } }, 1000);
    await expect(r.save({ ...base, name: "one more", cadence: { kind: "hourly", minute: 0 } }, 1000)).rejects.toThrow(/At most/);
  });

  it("records how the last slot ended, and keeps it through an edit", async () => {
    const r = Routines.inMemory();
    const saved = await r.save({ ...base, cadence: daily, precheck: "git diff --quiet HEAD" }, 1000);
    expect(saved.precheck).toBe("git diff --quiet HEAD");
    expect(saved.lastRunOutcome).toBeNull();
    const at = new Date(2026, 9, 9, 9, 0).getTime();
    await r.markRan(saved.id, at);
    const skipped = await r.markOutcome(saved.id, "skipped", "precheck exited 1");
    expect(skipped?.lastRunOutcome).toBe("skipped");
    expect(skipped?.lastRunDetail).toBe("precheck exited 1");
    // A dialog save (the whole routine again) does not forget how the last slot went.
    const edited = await r.save({ ...base, id: saved.id, cadence: daily, precheck: "true", name: "Renamed" }, at + 1000);
    expect(edited).toMatchObject({ precheck: "true", lastRunOutcome: "skipped", lastRunDetail: "precheck exited 1", lastRunAt: at });
    // The detail is one bounded line; nothing longer reaches the list.
    expect((await r.markOutcome(saved.id, "failed", "x".repeat(1000)))?.lastRunDetail).toHaveLength(300);
  });

  it("opens a file written before prechecks and outcomes existed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "awui-routines-"));
    try {
      const old = {
        r1: { id: "r1", name: "Old", prompt: "go", harnessId: "pi", workspaceId: "w1", cadence: daily, enabled: true, nextRunAt: 1000, lastRunAt: null },
      };
      writeFileSync(path.join(dir, "routines.json"), JSON.stringify(old));
      const r = await Routines.open(dir);
      expect(r.get("r1")).toMatchObject({ id: "r1", precheck: "", lastRunOutcome: null, lastRunDetail: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
