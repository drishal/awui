// The sidebar's headings and folder marks: a calendar heading and the Needs you / Working sections are
// sentence-case signposts at 11.5px in the muted ink (the attention colour stays on the needs-you icon
// alone), and every one of them puts its words on the rows' titles' edge; a folder head is the folder's
// own name at 13px in the second ink, its badge a 16px rounded square with no ring, and its count shows
// only while the group is collapsed — an open group's rows are the count. A folder's first few rows
// carry no date headings until the folder is opened.
import { expect, type Page, test } from "@playwright/test";
import { newChat, sendAndWait, showSidebar, signInAndOpen, useProjectsView } from "./helpers.js";

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sessions" });

/** A theme colour as the browser paints it (a token can be a hex, a mix, or a color() function). */
const painted = (page: Page, token: string): Promise<string> =>
  page.evaluate((name) => {
    const ctx = document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;
    const probe = document.createElement("span");
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(name);
    document.body.append(probe);
    ctx.fillStyle = getComputedStyle(probe).color;
    probe.remove();
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  }, token);

test("a calendar heading is a sentence-case signpost, not a title", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "a row for today's heading");
  await showSidebar(page);
  const heading = sidebar(page).locator(".date-divider").first();
  await expect(heading).toBeVisible();
  await expect(heading).toHaveCSS("text-transform", "none");
  await expect(heading).toHaveCSS("font-size", "11.5px");
  await expect(heading).toHaveCSS("font-weight", "500");
  await expect(heading).toHaveCSS("color", await painted(page, "--muted-text"));
  await expect(heading).toHaveCSS("position", "sticky");
  await expect(heading).toHaveCSS("background-color", await painted(page, "--surface"));
  // One text edge in Recent: the heading's text starts on the rows' titles' edge, and so does a section
  // head's label. Only marks hang in the mark column, 16px left of that edge.
  const edges = await page.evaluate(() => {
    const date = (document.querySelector(".flat-group .date-divider .date-label") ?? document.querySelector(".flat-group .date-divider")) as HTMLElement | null;
    const title = document.querySelector(".flat-group .session-item .session-title") as HTMLElement | null;
    if (!date || !title) return null;
    const inkLeft = (el: HTMLElement) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().left;
    };
    return { dateText: inkLeft(date), titleLeft: title.getBoundingClientRect().left };
  });
  expect(edges, "the list has a heading and a row under it").not.toBeNull();
  expect(Math.abs((edges?.dateText ?? 0) - (edges?.titleLeft ?? 99)), "a heading's text starts on the titles' edge").toBeLessThanOrEqual(0.5);
  // Sentence case, not the uppercase label it used to be.
  await expect(heading.locator(".date-label")).toHaveText(/^Today$/);
  // Its bucket's size ends the heading on the rows' age column, so the dates' numbers and the ages form
  // one column down the panel.
  const column = await page.evaluate(() => {
    const count = document.querySelector(".flat-group .date-divider .date-count")?.getBoundingClientRect();
    const age = document.querySelector(".flat-group .session-time")?.getBoundingClientRect();
    const text = document.querySelector(".flat-group .date-divider .date-count")?.textContent ?? "";
    return count && age ? { countRight: count.right, ageRight: age.right, text } : null;
  });
  expect(column, "the heading carries its bucket's count").not.toBeNull();
  expect(column?.text, "the count says how many, and what it counts").toMatch(/^\d+ sessions?$/);
  expect(Math.abs((column?.countRight ?? 0) - (column?.ageRight ?? 99)), "the count ends on the age column").toBeLessThanOrEqual(0.5);
});

test("a folder head names the folder at 13px, and its count shows only while collapsed", async ({ page }) => {
  await useProjectsView(page);
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "a row for the folder head");
  await showSidebar(page);
  // A folder group: the Rooms / Needs you / Working sections are project-groups too.
  const group = sidebar(page).locator(".project-group:not(.section-group)").first();
  await expect(group).toBeVisible();
  const name = group.locator(".project-name").first();
  await expect(name).toHaveCSS("text-transform", "none");
  await expect(name).toHaveCSS("font-size", "13px");
  await expect(name).toHaveCSS("font-weight", "600");
  await expect(name).toHaveCSS("color", await painted(page, "--text-2"));

  // Open, the rows are the count (or the focused head, which never collapses).
  if ((await page.getByTestId("focused-project").count()) === 0) {
    await expect(group.locator(".group-count")).toHaveCount(0);
    await group.locator(".project-toggle").first().click();
    await expect(group.locator(".group-count")).toHaveCount(1);
    await group.locator(".project-toggle").first().click();
    await expect(group.locator(".group-count")).toHaveCount(0);
  }
  // A folder's first rows carry no date headings: the age on each row already says when.
  const preview = sidebar(page).locator('[data-testid="project-group"]').filter({ hasNot: page.locator(".flat-group") });
  for (const list of await preview.all()) {
    if (await list.getByRole("button", { name: /^Show \d+ more in / }).count()) await expect(list.locator(".date-divider")).toHaveCount(0);
  }
});

test("a project's badge is a 16px rounded square with no ring, and the needs-you colour stays on its icon", async ({ page, request }) => {
  await useProjectsView(page);
  // A second project with a session, so focus mode draws a folder head (and its badge).
  const beta = (await (await request.post("/api/workspaces/open", { data: { path: `${process.env.AWUI_E2E_ROOT as string}/beta` } })).json()) as { id: string };
  const chat = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: beta.id } })).json()) as { chatId: string };
  await request.post(`/api/chats/${chat.chatId}/messages`, { data: { text: "a beta row for the head", mode: "normal" } });
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "a row for the badge");
  // One chat waiting on you, for the needs-you section's icon.
  await newChat(page);
  await page.getByRole("textbox", { name: "Message" }).fill("ask please approve the heading check");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("approval-card")).toBeVisible();
  // Off the asking chat's tab: a chat on screen stays where it is, so only one that is not shows up there.
  await newChat(page);
  await showSidebar(page);

  const badge = sidebar(page).locator(".project-head .project-badge").first();
  await expect(badge).toBeVisible();
  const box = await badge.boundingBox();
  expect(Math.round((box as { width: number }).width)).toBe(16);
  expect(Math.round((box as { height: number }).height)).toBe(16);
  await expect(badge).toHaveCSS("border-radius", "4px");
  await expect(badge).toHaveCSS("box-shadow", "none");
  await expect(badge).toHaveCSS("font-size", "10px");
  await expect(badge).toHaveCSS("font-weight", "700");

  // The attention colour is the section's icon, not its name.
  const needs = page.getByTestId("needs-group");
  await expect(needs.locator(".project-toggle .icon:not(.group-chevron)").first()).toHaveCSS("color", await painted(page, "--warn"));
  // A section names a state where a date names a time, so the section outranks it: second ink at 600,
  // against a date heading's muted ink at 500.
  await expect(needs.locator(".section-name")).toHaveCSS("color", await painted(page, "--text-2"));
  await expect(needs.locator(".section-name")).toHaveCSS("font-weight", "600");
  await expect(needs.locator(".group-count")).toHaveCSS("color", await painted(page, "--text-2"));
});

test("a section head outranks a date heading: second ink at 600 against muted at 500", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "a row under today's heading");
  // One chat waiting on you, so the Needs you section is drawn above the flat list's dates.
  await newChat(page);
  await page.getByRole("textbox", { name: "Message" }).fill("ask please approve the rank check");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("approval-card")).toBeVisible();
  await newChat(page);
  await showSidebar(page);
  const needs = page.getByTestId("needs-group").locator(".section-name");
  await expect(needs).toHaveCSS("color", await painted(page, "--text-2"));
  await expect(needs).toHaveCSS("font-weight", "600");
  const date = sidebar(page).locator(".flat-group .date-divider").first();
  await expect(date).toHaveCSS("color", await painted(page, "--muted-text"));
  await expect(date).toHaveCSS("font-weight", "500");
});
