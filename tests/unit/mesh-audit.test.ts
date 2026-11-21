// Mesh audit log (audit.ts): one append-only JSON line per decision, in order
// even under concurrency, with bounded strings, a no-op null file, a 0600 mode,
// and a write failure that is logged and swallowed instead of thrown.
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog, type AuditEntry } from "../../src/server/mesh/audit.js";

/** A fresh audit file path in its own scratch dir (the mesh dir is created on first append). */
const auditFile = (): string => path.join(mkdtempSync(path.join(tmpdir(), "awui-mesh-audit-")), "mesh", "audit.jsonl");

/** One entry with the given method and any extra fields. */
const entry = (method: string, extra: Partial<Omit<AuditEntry, "ts">> = {}): Omit<AuditEntry, "ts"> => ({
  peer: "lab-vm-3",
  method,
  decision: "deny",
  ...extra,
});

describe("the audit log", () => {
  it("appends one JSON line per entry, in call order, under concurrency", async () => {
    const file = auditFile();
    const log = new AuditLog(file);
    await Promise.all(Array.from({ length: 50 }, (_, i) => log.append(entry(`m${i}`))));
    const all = await log.tail(100);
    // The chain serializes in call order, so the file's order is the appends' order.
    expect(all.map((e) => e.method)).toEqual(Array.from({ length: 50 }, (_, i) => `m${i}`));
    for (const e of all) {
      expect(e.peer).toBe("lab-vm-3");
      expect(e.decision).toBe("deny");
      expect(typeof e.ts).toBe("number");
    }
    // One line per entry on disk, each parseable, with ts added by the log itself.
    const raw = readFileSync(file, "utf8");
    const lines = raw.trimEnd().split("\n");
    expect(lines).toHaveLength(50);
    for (const line of lines) expect(typeof (JSON.parse(line) as AuditEntry).ts).toBe("number");
    // tail(n) returns the last n, oldest first.
    expect((await log.tail(2)).map((e) => e.method)).toEqual(["m48", "m49"]);
  });

  it("keeps every string to 500 chars and escapes newlines and control characters", async () => {
    const file = auditFile();
    const log = new AuditLog(file);
    await log.append(
      entry("fs.read", { peer: "p".repeat(600), target: "t".repeat(600), outcome: "o".repeat(600), detail: `first\nline\ttab${"d".repeat(600)}` }),
    );
    const [one] = await log.tail(1);
    expect(one!.peer).toHaveLength(500);
    expect(one!.target).toHaveLength(500);
    expect(one!.outcome).toHaveLength(500);
    expect(one!.detail).toHaveLength(500);
    expect(one!.detail!.startsWith("first\nline\ttab")).toBe(true);
    // The newline stayed escaped inside the entry's line: still exactly one line.
    expect(readFileSync(file, "utf8").trimEnd().split("\n")).toHaveLength(1);
    // A null peer stays null, not the string "null".
    await log.append(entry("task.run", { peer: null }));
    expect((await log.tail(1))[0]!.peer).toBeNull();
  });

  it("is a no-op with no file, and reads nothing from a missing one", async () => {
    const log = new AuditLog(null);
    await expect(log.append(entry("m"))).resolves.toBeUndefined();
    expect(await log.tail(10)).toEqual([]);
    const missing = new AuditLog(path.join(mkdtempSync(path.join(tmpdir(), "awui-mesh-audit-")), "nope.jsonl"));
    expect(await missing.tail(10)).toEqual([]);
  });

  it("creates its dir 0700 and file 0600 on POSIX", async () => {
    const file = auditFile();
    const log = new AuditLog(file);
    await log.append(entry("m"));
    if (process.platform !== "win32") {
      expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("never throws from append: a failed write is logged and swallowed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "awui-mesh-audit-"));
    // A regular file where the mesh dir should be: every mkdir (and so every append) fails.
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "x");
    const said: string[] = [];
    const log = new AuditLog(path.join(blocker, "mesh", "audit.jsonl"), (message) => said.push(message));
    await expect(log.append(entry("m"))).resolves.toBeUndefined();
    expect(said).toHaveLength(1);
    // The failure does not poison the chain: the same log still appends elsewhere,
    // and a good log is unaffected.
    const goodFile = path.join(dir, "mesh", "audit.jsonl");
    const good = new AuditLog(goodFile);
    await expect(good.append(entry("m"))).resolves.toBeUndefined();
    expect((await good.tail(1)).map((e) => e.method)).toEqual(["m"]);
  });
});
