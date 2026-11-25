// Shared-element shell motion: one delayed loader, one active wash, one title handoff.
// These read the running animations, not just the stylesheet's promises. The suite shares one server, so
// each test names its own sessions and picks its row from the list it is drawn in.
import { expect, type Locator, type Page, test } from "@playwright/test";
import { newChat, sendAndWait, showSidebar, signInAndOpen } from "./helpers.js";

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sessions" });

/** The row titled `title` in the project's own list (it can be in Working too). */
const row = (page: Page, title: string): Locator => sidebar(page).locator(".session-sublist").last().locator(".session", { hasText: title });

async function openSessions(page: Page, tag: string): Promise<void> {
  await signInAndOpen(page);
  for (const word of ["first", "second", "third"]) {
    await newChat(page);
    await sendAndWait(page, `${tag} ${word} session`);
  }
  await showSidebar(page);
  await expect(row(page, `${tag} first session`)).toBeVisible();
}

test("a session switch has one delayed loader and no triple exposure", async ({ page }) => {
  await openSessions(page, "loader");
  // A fresh page has no cached snapshot, so the open goes through the loading surface.
  await page.reload();
  await showSidebar(page);
  await expect(page.getByTestId("user-prompt").filter({ hasText: "loader third session" })).toBeVisible();
  await page.route("**/api/chats/*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });
  await row(page, "loader first session").click();
  // The old thread leaves before a loading surface appears; there is never an old answer beside it.
  await expect(page.getByTestId("user-prompt").filter({ hasText: "loader third session" })).toHaveCount(0);
  await expect(page.locator(".switch-splash")).toHaveCount(0);
  await expect(page.locator(".switch-splash")).toBeVisible({ timeout: 2_000 });
  await expect(page.getByTestId("user-prompt").filter({ hasText: "loader third session" })).toHaveCount(0);
  await expect(page.locator(".switch-splash")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId("user-prompt").filter({ hasText: "loader first session" })).toBeVisible();
});

test("selection glides and the session title lands in the header, without replaying row entrances", async ({ page }) => {
  await openSessions(page, "glide");
  const list = sidebar(page).locator(".session-sublist").last();
  const wash = list.locator(".session-active-bg");
  await expect(wash).toBeVisible();
  const target = row(page, "glide first session");
  await target.click();
  const header = page.locator(".chat-title h1");
  await expect.poll(() => header.evaluate((el) => el.getAnimations().map((a) => a.id))).toContain("morph:sidebar-title");
  await expect.poll(() => wash.evaluate((el) => el.getAnimations().map((a) => a.id))).toContain("morph:session-active");
  await expect.poll(async () => {
    const a = (await wash.boundingBox())?.y ?? -1000;
    const b = (await target.boundingBox())?.y ?? 1000;
    return Math.abs(a - b);
  }).toBeLessThan(2);
  await page.waitForTimeout(350);
  // Every existing row has finished. Only the indicator and header moved; nothing re-enters as a list.
  const entrances = await sidebar(page).locator(".session-item").evaluateAll((rows) => rows.flatMap((r) => r.getAnimations().map((a) => a.id)));
  expect(entrances).toEqual([]);
  await expect(page.locator("main.main.is-swapping")).toHaveCount(0);
});

test("reduced motion makes the same session switch instant", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSessions(page, "still");
  const wash = sidebar(page).locator(".session-sublist").last().locator(".session-active-bg");
  await row(page, "still first session").click();
  await expect(page.getByTestId("user-prompt").filter({ hasText: "still first session" })).toBeVisible();
  expect(await page.locator(".chat-title h1").evaluate((el) => el.getAnimations().map((a) => a.id))).toEqual([]);
  expect(await wash.evaluate((el) => el.getAnimations().map((a) => a.id))).toEqual([]);
});
