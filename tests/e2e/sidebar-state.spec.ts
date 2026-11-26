// A sidebar row's state, in the two slots it keeps (session-state.ts): the leading mark, and the
// right-hand slot — the age, or ONE word in its place (Needs you, Working, Done). Nothing in the list is
// a colour-only dot: liveness is the server's own detail and lives in the hover card, and unread is the
// title's weight. The colour contract is in docs/ui.md.
import { expect, type Page, test } from "@playwright/test";
import { newChat, send, showSidebar, signInAndOpen } from "./helpers.js";

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sessions" });
const row = (page: Page, title: string) => sidebar(page).locator(".session-item", { hasText: title }).first();

/** A theme colour as the browser paints it (a token can be a hex, a mix, or a color() function). */
const painted = (page: Page, token: string): Promise<string> =>
  page.evaluate((name) => {
    const ctx = (document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D);
    const probe = document.createElement("span");
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(name);
    document.body.append(probe);
    ctx.fillStyle = getComputedStyle(probe).color;
    probe.remove();
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  }, token);

test("a row waiting on you wears the amber mark and one word where its age would be", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  // The fake harness raises an approval for a prompt that asks for one.
  await send(page, "ask please approve the state row");
  await expect(page.getByTestId("approval-card")).toBeVisible();
  await showSidebar(page);

  const waiting = row(page, "ask please approve the state row");
  await expect(waiting.locator(".session-asking-dot")).toBeVisible();
  // One word in the age's place, in the attention colour, and no age beside it.
  const word = waiting.locator(".session-state");
  await expect(word).toHaveText("Needs you");
  await expect(word).toHaveCSS("color", await painted(page, "--warn"));
  await expect(waiting.locator(".session-time")).toHaveCount(0);
  // No green "live" dot: being open on this server is not a state the list paints.
  await expect(sidebar(page).locator(".live-dot")).toHaveCount(0);
});

test("an unread row is heavier at full ink, not another dot", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "the unread one");
  await newChat(page);
  await send(page, "the read one");
  await showSidebar(page);
  // The read one is the chat on screen; the unread one is not, so its title is the dimmed read ink.
  const target = row(page, "the unread one");
  const ink = () => target.locator(".session-title").evaluate((el) => ({ weight: getComputedStyle(el).fontWeight, color: getComputedStyle(el).color, row: el.closest(".session")?.className ?? "" }));
  expect((await ink()).weight, "a read title is regular weight").toBe("400");
  const readColor = (await ink()).color;

  await target.locator(".session").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mark unread" }).click();
  await expect.poll(async () => (await ink()).weight).toBe("600");
  const unread = await ink();
  expect(unread.row).toContain("is-unread");
  expect(unread.color, "an unread title takes the row's full ink").not.toBe(readColor);
  expect(unread.color, "and it is the theme's own text colour").toBe(await painted(page, "--text"));
});
