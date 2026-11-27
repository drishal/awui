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

test("a row waiting in Needs you wears the amber mark, and its age stays muted", async ({ page }) => {
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
  // The section's head and the row's dot are the state's cues, so the age keeps the muted ink (the amber
  // age beside the amber dot and the amber heading said one fact three times).
  const rowMuted = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--muted-text)";
    document.querySelector(".sidebar")?.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  });
  await expect(waiting.locator(".session-time")).toHaveCSS("color", rowMuted);
  // Needs-you and idle titles share the same full width; the old state word and gutter are gone.
  const ordinary = row(page, "ordinary state row");
  const widths = await Promise.all([waiting, ordinary].map((item) => item.locator(".session-title").evaluate((el) => el.getBoundingClientRect().width)));
  expect(widths[0]).toBe(widths[1]);
  expect(widths[0]).toBeGreaterThan(200);
  // The section's head is laid on its rows' columns: the icon centred on the marks, the label on the
  // titles' edge, and the count ending where the ages do.
  const columns = await page.getByTestId("needs-group").evaluate((group) => {
    const box = (sel: string) => group.querySelector(sel)?.getBoundingClientRect();
    const [icon, label, count, mark, title, age] = [".section-icon", ".section-name", ".group-count", ".session-asking-dot", ".session-title", ".session-meta"].map(box);
    return icon && label && count && mark && title && age
      ? { icon: icon.left + icon.width / 2, mark: mark.left + mark.width / 2, label: label.left, title: title.left, count: count.right, age: age.right }
      : null;
  });
  expect(columns, "the section has a head and a row").not.toBeNull();
  const c = columns as NonNullable<typeof columns>;
  expect(Math.abs(c.icon - c.mark)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(c.label - c.title)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(c.count - c.age)).toBeLessThanOrEqual(0.5);
  // No green "live" dot: being open on this server is not a state the list paints.
  await expect(sidebar(page).locator(".live-dot")).toHaveCount(0);
});

test("an unread row is heavier at full ink, not another dot", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  // Settled first: a running row sits in the (open) Working section and moves when it ends, which would
  // replace the very element these reads hold.
  await sendAndWait(page, "the unread one");
  await newChat(page);
  await sendAndWait(page, "the read one");
  await showSidebar(page);
  // The read one is the chat on screen; the unread one is not, so its title is the dimmed read ink.
  const target = row(page, "the unread one");
  const ink = () => target.locator(".session-title").evaluate((el) => ({ weight: getComputedStyle(el).fontWeight, color: getComputedStyle(el).color, row: el.closest(".session")?.className ?? "" }));
  expect((await ink()).weight, "a read title is regular weight").toBe("400");
  const readColor = (await ink()).color;
  // One step below full ink, not two: at 78% half the list read as disabled beside the bold rows (86% of the
  // text ink measures 11.2:1 on the panel in dark and 16.9:1 in light).
  const readInk = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "color-mix(in srgb, var(--text) 86%, var(--muted-text))";
    document.querySelector(".sidebar")?.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  });
  expect(readColor, "a read title sits at 86% of the text ink").toBe(readInk);

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
