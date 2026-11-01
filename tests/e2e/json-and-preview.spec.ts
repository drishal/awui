import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { newChat, sendAndWait, signInAndOpen } from "./helpers.js";

/** Open a finished turn's "Worked for …" fold. */
async function openFold(page: Page) {
  const toggle = page.getByTestId("process-toggle").last();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

test("an MCP-like call shows its arguments and its JSON result as folding trees", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "showcase");
  await openFold(page);
  const row = page.locator('[data-testid="tool-row"][data-tool="mcp__tracker__triage_ticket"]');
  await row.getByRole("button").first().click();
  const input = row.getByRole("tree", { name: "Input as JSON" });
  await expect(input.getByText("labels", { exact: true })).toBeVisible();
  await expect(input.locator(".tk-key", { hasText: "filter" })).toBeVisible();
  const output = row.getByRole("tree", { name: "Output as JSON" });
  // Two levels are open: the items array lists its objects, still folded, so no title shows yet.
  const items = output.getByRole("button", { name: "items, [2]" });
  await expect(output.getByRole("button", { name: "0, {4}" })).toBeVisible();
  await expect(output.getByText('"Listen ignores the host"')).toHaveCount(0);
  await output.getByRole("button", { name: "0, {4}" }).click();
  await expect(output.getByText('"Listen ignores the host"')).toBeVisible();
  // A fold toggles: the items array closes and its rows go.
  await items.click();
  await expect(output.getByRole("button", { name: "0, {4}" })).toHaveCount(0);
  await items.click();
  await expect(output.getByRole("button", { name: "0, {4}" })).toBeVisible();
  // The raw text stays reachable: Copy hands back the JSON, not the drawn tree.
  await expect(output.getByRole("button", { name: /Copy JSON/ })).toBeAttached();
});

test("resting on a file's path shows its first lines, and a click still opens the viewer", async ({ page }) => {
  const dir = path.join(process.env.AWUI_E2E_ROOT as string, "alpha", "src");
  mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: 30 }, (_, i) => `export const value${i + 1} = ${i + 1};`);
  writeFileSync(path.join(dir, "net.ts"), `// preview probe\n${lines.join("\n")}\n`);
  try {
    await signInAndOpen(page);
    await newChat(page);
    await sendAndWait(page, "showcase");
    await openFold(page);
    const row = page.locator('[data-testid="tool-row"][data-tool="read"]');
    await row.getByRole("button").first().click();
    // Hover once the panel has grown: while it grows the chat scrolls to keep its end in view, moving the link from under the pointer.
    await expect(row.locator(".collapse.is-settled").first()).toBeAttached();
    const link = row.getByRole("button", { name: "src/net.ts", exact: true });
    await link.hover();
    const card = page.getByRole("tooltip");
    await expect(card).toContainText("// preview probe");
    await expect(card).toContainText("export const value10 = 10;");
    // Only the first dozen lines, with the file's size and line count.
    await expect(card).not.toContainText("value12 =");
    await expect(card).toContainText("31 lines");
    await expect(card.locator(".tk-keyword").first()).toHaveText("export");
    await page.mouse.move(900, 20);
    await expect(card).toBeHidden();
    // The click still opens the viewer.
    await link.click();
    await expect(page.getByRole("dialog").getByText("export const value30 = 30;")).toBeVisible();
  } finally {
    rmSync(path.join(dir, "net.ts"), { force: true });
  }
});
