// Small motions shared across the app: every copy button morphing the same way, checks that draw themselves,
// status words that blur in, and folds that grow without a measured height.
import { expect, test } from "@playwright/test";
import { newChat, send, sendAndWait, signInAndOpen } from "./helpers.js";

test("a labelled copy button (a tool output sheet's Copy) says Copied for a moment and goes back", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "hello big");
  // One call is its own card, already open.
  const rows = page.getByTestId("tool-row");
  const count = await rows.count();
  let opened = false;
  for (let i = 0; i < count && !opened; i++) {
    const row = rows.nth(i);
    await row.getByRole("button").first().click();
    const button = row.getByRole("button", { name: "Full output" });
    if ((await button.count()) > 0) {
      await button.click();
      opened = true;
    }
  }
  expect(opened).toBe(true);
  const sheet = page.getByRole("dialog", { name: /^Output · / });
  await sheet.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(sheet.getByRole("button", { name: "Copied" })).toHaveText("Copied");
  await expect(sheet.getByRole("status").filter({ hasText: "Copied" })).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe("");
  await expect(sheet.getByRole("button", { name: "Copy", exact: true })).toHaveText("Copy");
});

test("a run that settles in view draws its check, and a chat opened later has the plain check", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "slow tool ticking");
  // A call's row draws no mark of its own; the card's header marks the run, and it draws the check in view.
  const drawn = page.locator('[data-testid="process-status"] svg.check-draw path');
  await expect(drawn.first()).toBeAttached();
  await expect(drawn.first()).toHaveAttribute("pathLength", "1");
  await expect.poll(() => drawn.first().evaluate((el) => getComputedStyle(el).animationName)).toBe("check-draw");
  await page.reload();
  await expect(page.locator('[data-testid="process-status"] svg.check-draw')).toHaveCount(0);
});

test("the header's status word blurs in when it changes, not on first paint", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  const status = page.getByTestId("chat-status");
  await send(page, "slow tool");
  await expect(status.locator(".word-in")).toHaveCount(1);
  await expect.poll(() => status.locator(".word-in").evaluate((el) => getComputedStyle(el).animationName)).toBe("word-in");
  await expect(status).toHaveText("Idle");
  await page.reload();
  await expect(page.getByTestId("chat-status")).toHaveText("Idle");
  await expect(page.getByTestId("chat-status").locator(".word-in")).toHaveCount(0);
});

test("with reduced motion the drawn check and the blurred word are plain", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "slow tool ticking");
  await expect(page.locator('[data-testid="process-status"] svg.check-draw path').first()).toBeAttached();
  await expect.poll(() => page.locator('[data-testid="process-status"] svg.check-draw path').first().evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  await expect(page.getByTestId("chat-status").locator(".word-in")).toHaveCount(1);
  await expect.poll(() => page.getByTestId("chat-status").locator(".word-in").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  // Let the run settle here: left going, it finishes under the next test, whose page shows a "finished" notice over it.
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 15_000 });
});
