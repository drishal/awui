import { expect, test } from "@playwright/test";
import { newChat, sendAndWait, signInAndOpen } from "./helpers.js";

// Cold resume: a chat idle past its prompt cache's expiry offers a compaction before the next
// prompt. The fake harness's "coldcache" scenario is a 260k-token session whose cache went cold
// half an hour ago.

test("an idle chat past its prompt cache's expiry offers a compaction, and compacting clears it", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "coldcache please");
  const hint = page.locator(".cold-resume");
  await expect(hint).toBeVisible();
  await expect(hint).toContainText("The prompt cache expired 30m ago: the next prompt re-sends 260,000 tokens.");
  await hint.getByRole("button", { name: "Compact first" }).click();
  await expect(page.getByText("Compacted conversation")).toBeVisible({ timeout: 15_000 });
  // The session is smaller now and its cache is warm again, so there is nothing left to offer.
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 20_000 });
  await expect(page.locator(".cold-resume")).toBeHidden();
});

test("its \"Don't ask again\" is remembered on the device", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "coldcache please");
  const hint = page.locator(".cold-resume");
  await expect(hint).toBeVisible();
  await hint.getByRole("button", { name: "Don't ask again" }).click();
  await expect(hint).toBeHidden();
  await page.reload();
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 20_000 });
  await expect(page.locator(".cold-resume")).toBeHidden();
});

test("a session below the token floor gets no hint", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "hello there");
  await expect(page.getByTestId("chat-status")).toHaveText("Idle");
  await expect(page.locator(".cold-resume")).toBeHidden();
});
