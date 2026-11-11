// A routine's precheck (routine-precheck.ts): the project's folder, a non-zero exit
// as a skip with its reason, a timeout as a skip, and a shell that cannot start.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPrecheck } from "../../src/server/routine-precheck.js";

let dir = "";
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "awui-precheck-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("a routine's precheck", () => {
  it("passes on exit 0 and runs in the project folder", async () => {
    writeFileSync(path.join(dir, "marker.txt"), "here");
    expect(await runPrecheck("true", dir)).toEqual({ ok: true, detail: null });
    // `test -f` sees the project's file, so the cwd is the routine's project.
    expect(await runPrecheck("test -f marker.txt", dir)).toEqual({ ok: true, detail: null });
  });

  it("skips on a non-zero exit, naming the code and what the command said", async () => {
    expect(await runPrecheck("false", dir)).toEqual({ ok: false, detail: "precheck exited 1" });
    expect(await runPrecheck("echo nothing to review; exit 3", dir)).toEqual({ ok: false, detail: "precheck exited 3: nothing to review" });
  });

  it("skips a command that overstays the time limit", async () => {
    const started = Date.now();
    const result = await runPrecheck("sleep 30", dir, 250);
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("precheck timed out after 250 ms");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("skips with a reason when the shell cannot start there", async () => {
    const missing = path.join(dir, "gone");
    const result = await runPrecheck("true", missing);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/^precheck could not start: /);
  });

  it("keeps only a line of what a failing command printed", async () => {
    const result = await runPrecheck("head -c 4000 /dev/zero | tr '\\0' x; exit 1", dir);
    expect(result.ok).toBe(false);
    // One line, bounded well under the 4 KB the spawn keeps.
    expect(result.detail?.length ?? 0).toBeLessThan(300);
  });
});
