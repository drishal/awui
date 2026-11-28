// A fixture's sandbox must be reclaimed after all its resources close. Allowing
// thousands of these temporary roots to linger can exhaust /tmp's inode limit.
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { makeTestApp, tempDir } from "../helpers/app.js";

describe("fixture cleanup", () => {
  it("removes only the owning app's root after closing its resources", async () => {
    const otherRoot = tempDir("awui-other-fixture-");
    const app = await makeTestApp();
    const root = app.root;
    expect(existsSync(root)).toBe(true);
    try {
      await app.close();
      expect(existsSync(root)).toBe(false);
      expect(existsSync(otherRoot)).toBe(true);
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});
