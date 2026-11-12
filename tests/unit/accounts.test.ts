// Account choices are opaque provider/position indexes, not raw credential payloads.
import { expect, test } from "vitest";
import { parseProviderList, accountIdSchema } from "../../src/server/accounts.js";

test("list contains only native ids and 1-based indexes", () => {
  const rows = parseProviderList("anthropic", `1. name@example.com\n2. account-balance\n3. private enterprise\n`);
  expect(rows.map((row) => row.id)).toEqual(["anthropic:1", "anthropic:2", "anthropic:3"]);
  expect(JSON.stringify(rows)).not.toContain("name@example.com");
  expect(rows.every((row) => row.index > 0)).toBe(true);
  expect(accountIdSchema.safeParse("anthropic:2").success).toBe(true);
  expect(accountIdSchema.safeParse("anthropic:0").success).toBe(false);
});
