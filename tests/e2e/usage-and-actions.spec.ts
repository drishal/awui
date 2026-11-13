// The Usage heatmap of days, and the quieter action rows under a prompt and an answer.
import { expect, test, type Locator } from "@playwright/test";
import { newChat, sendAndWait, signInAndOpen } from "./helpers.js";

const totals = (tokens: number, cost: number) => ({ input: tokens, cachedInput: 0, cacheWrite: 0, output: 0, cost, calls: tokens > 0 ? 1 : 0, unpriced: 0 });

/** A report of `days` days ending today in the browser's zone: the busiest day for tokens is 12 days back, the dearest for cost 3 days back, and one idle day. */
function fakeReport(days: number) {
  const day = (back: number) => {
    const d = new Date();
    d.setDate(d.getDate() - back);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const byDay = Array.from({ length: days }, (_, i) => {
    const back = days - 1 - i;
    const tokens = back === 12 ? 900_000 : back === 7 ? 0 : (i + 1) * 1000;
    const cost = back === 3 ? 12.5 : back === 7 ? 0 : 0.1 * (i + 1);
    return { day: day(back), totals: totals(tokens, cost), tokensByHarness: { fake: tokens } };
  });
  return {
    days,
    since: Date.now() - days * 86_400_000,
    totals: { ...totals(1_000_000, 20), sessions: 1 },
    byDay,
    byHarness: [{ harnessId: "fake", totals: totals(1_000_000, 20), sessions: 1 }],
    byModel: [{ model: "echo", harnesses: ["fake"], totals: totals(1_000_000, 20) }],
    top: [],
    workspaces: [],
    unreadable: [],
    scanned: 1,
    total: 1,
    truncated: false,
  };
}

test("Usage draws a heatmap of the days, shaded by tokens or by cost, and the arrow keys walk it", async ({ page }) => {
  await page.route("**/api/usage?*", (route) => route.fulfill({ json: fakeReport(Number(new URL(route.request().url()).searchParams.get("days"))) }));
  await signInAndOpen(page);
  await newChat(page);
  await page.getByRole("button", { name: /^Usage/ }).click();
  const usage = page.getByRole("dialog", { name: "Usage" });
  const heat = usage.getByRole("region", { name: "Activity by day" });
  const grid = heat.getByRole("grid");
  await expect(grid.getByRole("gridcell")).toHaveCount(30);
  // Tokens: the busiest day is the darkest shade, the idle one has none.
  await expect(grid.locator('[data-level="4"][aria-label*="900k tokens"]')).toHaveCount(1);
  await expect(grid.locator('[aria-label*="· 1.0k tokens ·"]')).toHaveAttribute("data-level", "1");
  await expect(grid.locator('[data-level="0"]')).toHaveCount(1);
  await page.emulateMedia({ colorScheme: "light" });
  const colors = await grid.evaluate(el => [0,1,2,3,4].map(level => getComputedStyle(el.querySelector(`[data-level="${level}"]`) ?? el).backgroundColor));
  expect(new Set(colors).size).toBe(colors.length);
  const card = await grid.locator('[data-level="0"]').evaluate(el => getComputedStyle(el.closest(".usage-heat") as Element).backgroundColor);
  expect(colors[0]).not.toBe(card);
  await page.emulateMedia({ colorScheme: "dark" });
  // Cost: the dearest day takes the darkest shade.
  await heat.getByRole("button", { name: "Cost" }).click();
  await expect(grid.locator('[data-level="4"][aria-label$="$12.50"]')).toHaveCount(1);
  // One cell is in the tab order (today); the arrows walk the days: a week sideways, a day up and down.
  const named = (back: number) => {
    const d = new Date();
    d.setDate(d.getDate() - back);
    return grid.locator(`[aria-label^="${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ·"]`);
  };
  await expect(named(0)).toHaveAttribute("tabindex", "0");
  await expect(named(0)).toHaveClass(/is-today/);
  await expect(grid.locator('[tabindex="0"]')).toHaveCount(1);
  await named(0).focus();
  await expect(heat.locator(".usage-heat-caption")).toContainText("tokens");
  await page.keyboard.press("ArrowLeft");
  await expect(named(7)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(named(8)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(named(7)).toBeFocused();
  // The range switch still works, and the grid follows it.
  await usage.getByRole("button", { name: "90 days" }).click();
  await expect(grid.getByRole("gridcell")).toHaveCount(90);
  await usage.getByRole("button", { name: "7 days" }).click();
  await expect(grid.getByRole("gridcell")).toHaveCount(7);
});

const opacityOf = (loc: Locator) => loc.evaluate((el) => Number(getComputedStyle(el).opacity));

test("the rows under a prompt and an answer sit quiet until the turn is wanted, and Copy reply says Copied and goes back", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "first question");
  await sendAndWait(page, "second question");
  const turns = page.getByTestId("turn");
  await expect(turns).toHaveCount(2);
  const [older, latest] = [turns.nth(0), turns.nth(1)];
  // At rest the older turn's rows are faint and the latest turn's are full.
  await page.mouse.move(2, 2);
  await expect.poll(() => opacityOf(older.locator(".answer-actions"))).toBeCloseTo(0.45, 1);
  await expect.poll(() => opacityOf(older.getByTestId("prompt-actions"))).toBeCloseTo(0.45, 1);
  await expect.poll(() => opacityOf(latest.locator(".answer-actions"))).toBe(1);
  // Hovering the turn lights both its rows; so does focus inside it.
  await older.hover();
  await expect.poll(() => opacityOf(older.locator(".answer-actions"))).toBe(1);
  await expect.poll(() => opacityOf(older.getByTestId("prompt-actions"))).toBe(1);
  await page.mouse.move(2, 2);
  await expect.poll(() => opacityOf(older.locator(".answer-actions"))).toBeCloseTo(0.45, 1);
  await older.getByRole("button", { name: "Copy reply" }).focus();
  await expect.poll(() => opacityOf(older.locator(".answer-actions"))).toBe(1);
  // Copy reply becomes Copied (announced), the clipboard has the reply, then the name comes back.
  await older.getByRole("button", { name: "Copy reply" }).click();
  await expect(older.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect(older.getByRole("status").filter({ hasText: "Copied" })).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe("");
  await expect(older.getByRole("button", { name: "Copy reply" })).toBeVisible();
  // The prompt's two copies say their own names.
  await older.getByRole("button", { name: "Copy prompt link" }).click();
  await expect(older.getByRole("button", { name: "Link copied" })).toBeVisible();
  await older.getByRole("button", { name: "Copy message" }).click();
  await expect(older.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect(older.getByRole("button", { name: "Copy message" })).toBeVisible();
});

test("with reduced motion the rows under a turn are simply visible", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "first question");
  await sendAndWait(page, "second question");
  await page.mouse.move(2, 2);
  const older = page.getByTestId("turn").nth(0);
  expect(await opacityOf(older.locator(".answer-actions"))).toBe(1);
  expect(await opacityOf(older.getByTestId("prompt-actions"))).toBe(1);
});
