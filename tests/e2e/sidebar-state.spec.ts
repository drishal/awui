// Section rows state their Needs-you / Working status once: the leading mark plus the age.
// Elsewhere the age may carry a state word. Unread is weight and full ink, with visually
// hidden supporting text for assistive technology, not a second accent dot. See docs/ui.md.
import { expect, type Page, test } from "@playwright/test";
import { newChat, send, sendAndWait, showSidebar, signInAndOpen, useProjectsView } from "./helpers.js";

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

test("a row waiting in Needs you wears the amber mark and age, not a repeated word", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "ask please approve the state row");
  await expect(page.getByTestId("approval-card")).toBeVisible();
  // Off the asking tab: only an inactive session belongs in the section above the list.
  await page.getByRole("button", { name: "New chat in a new tab" }).click();
  await sendAndWait(page, "ordinary state row");
  await showSidebar(page);

  const waiting = page.getByTestId("needs-group").locator(".session-item", { hasText: "ask please approve the state row" });
  await expect(waiting.locator(".session-asking-dot")).toBeVisible();
  await expect(waiting.locator(".session-state")).toHaveCount(0);
  await expect(waiting.locator(".session-time")).toHaveCSS("color", await painted(page, "--warn"));
  // Needs-you and idle titles share the same full width; the old state word and gutter are gone.
  const ordinary = row(page, "ordinary state row");
  const widths = await Promise.all([waiting, ordinary].map((item) => item.locator(".session-title").evaluate((el) => el.getBoundingClientRect().width)));
  expect(widths[0]).toBe(widths[1]);
  expect(widths[0]).toBeGreaterThan(200);
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
  await expect(target.locator(".session-unread")).toHaveCount(0);
  await expect(target.locator(".visually-hidden", { hasText: "Unread" })).toHaveCount(1);
  await target.locator(".session").click();
  await expect(target.locator(".session-title")).toHaveCSS("font-weight", "400");
  await expect(target.locator(".visually-hidden", { hasText: "Unread" })).toHaveCount(0);
});
