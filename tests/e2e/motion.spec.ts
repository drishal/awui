// Gentle motion: a turn that arrives live rises in (a loaded history does not),
// a streaming answer carries a soft caret until it settles, and none of it runs
// when the system asks for reduced motion.
import { expect, type Locator, type Page, test } from "@playwright/test";
import { newChat, send, sendAndWait, signInAndOpen } from "./helpers.js";

const animation = (el: Locator) => el.evaluate((node) => ({ name: getComputedStyle(node).animationName, duration: getComputedStyle(node).animationDuration }));
const caret = (page: Page) =>
  page.locator(".answer.is-streaming .md li:last-child").evaluate((node) => {
    const after = getComputedStyle(node, "::after");
    return { content: after.content, name: after.animationName, duration: after.animationDuration };
  });

test("a chat's history loads still; a prompt sent live rises in; reduced motion turns it off", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  for (const n of [1, 2, 3]) await sendAndWait(page, `motion history ${n}`);
  // Opened from the server's record, every turn is there at once and none animates.
  await page.reload();
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 20_000 });
  await expect(page.getByTestId("user-prompt")).toHaveText(["motion history 1", "motion history 2", "motion history 3"]);
  await expect(page.locator(".is-arriving")).toHaveCount(0);

  // A prompt sent now arrives live: its bubble and the answer take the entrance.
  await sendAndWait(page, "motion live");
  const bubble = page.locator(".turn-prompt.is-arriving .bubble");
  await expect(bubble).toHaveCount(1);
  await expect(bubble).toContainText("motion live");
  expect(await animation(bubble)).toEqual({ name: "turn-in", duration: "0.38s" });
  const answer = page.locator(".answer.is-arriving");
  await expect(answer).toHaveCount(1);
  expect((await animation(answer)).name).toBe("turn-in");

  // With reduced motion the same entrance has no duration at all.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await sendAndWait(page, "motion reduced");
  const quiet = page.locator(".turn-prompt.is-arriving .bubble", { hasText: "motion reduced" });
  await expect(quiet).toHaveCount(1);
  expect(await animation(quiet)).toEqual({ name: "none", duration: "0s" });
});

test("a caret follows the streaming text and is gone once the answer settles", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "slow caret");
  await expect(page.locator(".answer.is-streaming .md li").first()).toBeVisible({ timeout: 20_000 });
  // One read decides all three: a new list item takes the caret over between two reads, so a second read can land on one that has none yet.
  await expect.poll(() => caret(page).then((c) => c.name === "stream-caret" && c.content !== "none" && c.duration === "1s")).toBe(true);
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 30_000 });
  await expect(page.locator(".answer.is-streaming")).toHaveCount(0);
  const done = await page.locator(".answer .md li:last-child").evaluate((node) => getComputedStyle(node, "::after").content);
  expect(done).toBe("none");
});

test("the caret does not run with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "slow quiet caret");
  await expect(page.locator(".answer.is-streaming .md li").first()).toBeVisible({ timeout: 20_000 });
  expect((await caret(page)).name).toBe("none");
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 30_000 });
});
