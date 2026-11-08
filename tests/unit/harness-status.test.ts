import { describe, expect, it } from "vitest";
import type { Bootstrap, HarnessStatus } from "../../src/shared/protocol.js";
import { mergeHarnesses } from "../../src/web/harness-status.js";

// Only the fields mergeHarnesses looks at; the rest of a status is the server's to fill.
const status = (id: string, available: boolean, version?: string) =>
  ({ id, displayName: id, available, warnings: [], capabilities: {}, overrides: {}, accent: "link", ...(version ? { version } : {}) }) as unknown as HarnessStatus;

const boot = (harnesses: HarnessStatus[]): Bootstrap =>
  ({
    harnesses,
    ui: {},
    theme: { active: "built-in" },
    auth: { mode: "local" },
    roots: [],
    home: "/home",
    version: "1",
    build: "b",
    pairing: { urls: [] },
    limits: { maxMessageChars: 10 },
  }) as unknown as Bootstrap;

describe("mergeHarnesses", () => {
  it("replaces the rows it has answers for, and keeps every other row as it was", () => {
    const before = boot([status("pi", true, "1.0.0"), status("hermes", false)]);
    const merged = mergeHarnesses(before, [status("hermes", true, "0.23.0")]);
    expect(merged.harnesses.map((h) => [h.id, h.available, h.version])).toEqual([
      ["pi", true, "1.0.0"],
      ["hermes", true, "0.23.0"],
    ]);
    // The rest of the payload is the bootstrap's own.
    expect(merged.ui).toBe(before.ui);
    expect(merged.home).toBe("/home");
  });

  it("answers nothing with the same payload (no render for a poll that learned nothing)", () => {
    const before = boot([status("hermes", false)]);
    expect(mergeHarnesses(before, [])).toBe(before);
  });

  it("keeps the same payload when a poll's rows match what is already shown", () => {
    const before = boot([status("hermes", false), status("pi", true, "1.0.0")]);
    expect(mergeHarnesses(before, [status("hermes", false)])).toBe(before);
  });
});
