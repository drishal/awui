import { expect, test } from "@playwright/test";
import { newChat, send, sendAndWait, signInAndOpen } from "./helpers.js";

// The tool card's later touches: every call in a long run, a test run's own glyph, the working label's mark.

test("a long run shows every call without a more-calls fold", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "manycalls");
  const toggle = page.getByTestId("process-toggle").last();
  await expect(toggle).toContainText("Used 12 tools");
  await toggle.click();
  const rows = page.getByTestId("tool-row");
  await expect(rows).toHaveCount(12);
  await expect(rows.nth(2).locator(".tool-sentence")).toContainText("part-3.ts");
  await expect(rows.nth(10).locator(".tool-sentence")).toContainText("part-11.ts");
  await expect(page.getByRole("button", { name: /^Show \d+ more calls?$/ })).toHaveCount(0);
});

test("find in chat reaches a call inside a closed card", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "manycalls");
  await page.locator(".chat-header h1").click();
  await page.keyboard.press("Control+KeyF");
  await page.getByRole("searchbox", { name: "Find in chat" }).fill("part-7.ts");
  await expect(page.getByTestId("process-toggle").last()).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("tool-row")).toHaveCount(12);
  await expect(page.getByRole("button", { name: /^Show \d+ more calls?$/ })).toHaveCount(0);
});

test("a test run wears the test icon in its row and in the header stack", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  // With another call beside it, so the card has a header and its stack.
  await sendAndWait(page, "tool testrun");
  const toggle = page.getByTestId("process-toggle").last();
  await expect(toggle.getByTestId("kind-stack").locator(".kind-chip.is-test")).toHaveCount(1);
  await toggle.click();
  await expect(page.locator('[data-tool="bash"] .kind-chip.is-test')).toHaveCount(1);
});

test("the working mark is eight rays, and gives way to a check that draws itself", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  // Two calls: a settled card of one call drops its header, and the check is the header's.
  await send(page, "tool ticking");
  const toggle = page.getByTestId("process-toggle").last();
  await expect(toggle.locator(".rays path")).toHaveCount(8);
  const ray = await toggle.locator(".rays path").nth(3).evaluate((el) => getComputedStyle(el).animationName);
  expect(ray).toBe("ray-fade");
  await expect(toggle).toHaveText(/Worked for/, { timeout: 20_000 });
  await expect(toggle.locator(".rays")).toHaveCount(0);
  const check = toggle.locator(".check-draw path");
  await expect(check).toHaveAttribute("pathLength", "1");
  expect(await check.evaluate((el) => getComputedStyle(el).strokeDasharray)).toBe("1px, 2px");
});

test("a turn loaded from history shows no check", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "tool edit");
  await page.reload();
  await expect(page.getByTestId("process-toggle").last()).toContainText("Worked for");
  await expect(page.locator(".check-draw")).toHaveCount(0);
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("the rays and the check do not animate", async ({ page }) => {
    await signInAndOpen(page);
    await newChat(page);
    await send(page, "tool ticking");
    const toggle = page.getByTestId("process-toggle").last();
    expect(await toggle.locator(".rays path").first().evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
    await expect(toggle).toHaveText(/Worked for/, { timeout: 20_000 });
    expect(await toggle.locator(".check-draw path").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  });
});
