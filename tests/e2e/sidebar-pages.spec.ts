// "Show more" is a bounded page, in the flat list and inside a folder: a non-current folder opens with 4
// rows, the current one with 8, and each "Show N more in <folder>" adds 20 — never a whole history at
// once. It is a fold row at the rows' pitch (44px on a phone): muted words naming what it adds, a 12px
// chevron after them, and the second ink on hover.
import { expect, type Locator, type Page, test } from "@playwright/test";
import { showAllProjects, showSidebar, signInAndOpen, useProjectsView } from "./helpers.js";

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sessions" });
const rowsOf = (group: Locator) => group.locator(".session-item");

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

/** The number in "Show N more in <folder>". */
const hiddenIn = async (button: Locator): Promise<number> => Number(((await button.innerText()).match(/Show (\d+) more in /) ?? [])[1]);

/** Chats sent through the API: the suite shares one server, so the test seeds its own history. */
async function seed(request: Page["request"], path: string, count: number, prefix: string): Promise<void> {
  const ws = (await (await request.post("/api/workspaces/open", { data: { path } })).json()) as { id: string };
  for (let i = 0; i < count; i++) {
    const chat = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: ws.id } })).json()) as { chatId: string };
    await request.post(`/api/chats/${chat.chatId}/messages`, { data: { text: `${prefix} ${String(i + 1).padStart(2, "0")}`, mode: "normal" } });
  }
}

test("a folder that is not the current one opens with 4 rows, and each Show more adds 20", async ({ page, request }) => {
  const root = process.env.AWUI_E2E_ROOT as string;
  await seed(request, `${root}/beta`, 26, "paged row");
  await useProjectsView(page);
  await signInAndOpen(page);
  await showSidebar(page);
  // All projects, so beta is a folder of its own beside the current one.
  await showAllProjects(page);
  const beta = page.getByTestId("project-group").filter({ has: page.locator(".project-name", { hasText: /^beta$/ }) });
  await expect(beta).toBeVisible();
  await expect(rowsOf(beta), "a folder's preview is 4 rows").toHaveCount(4);

  const more = beta.locator(".show-more");
  const hidden = await hiddenIn(more);
  expect(hidden, "the seeded history needs more than one page").toBeGreaterThanOrEqual(20);
  await expect(more, "the fold names what it adds").toHaveText(`Show ${Math.min(hidden, 20)} more in beta`);
  // A fold carries its own chevron, after the words, and takes the second ink under the pointer.
  expect(await more.locator("svg").count(), "one chevron").toBe(1);
  const chevron = await more.evaluate((el) => {
    const svg = el.querySelector("svg")?.getBoundingClientRect();
    const label = el.getBoundingClientRect();
    return svg ? { left: svg.left, labelLeft: label.left } : null;
  });
  expect(chevron?.left ?? 0, "the chevron follows the label").toBeGreaterThan(chevron?.labelLeft ?? 0);
  await expect(more).toHaveCSS("min-height", "32px");
  await more.hover();
  await expect(more).toHaveCSS("color", await painted(page, "--text-2"));

  await more.click();
  const added = Math.min(hidden, 20);
  await expect(rowsOf(beta)).toHaveCount(4 + added);
  const left = hidden - added;
  if (left > 0) {
    await expect(more).toHaveText(`Show ${left} more in beta`);
    await more.click();
    await expect(rowsOf(beta)).toHaveCount(4 + added + left);
    await expect(more).toHaveCount(0);
  }
});

test("the current folder's page is 8 rows, and the same 20-row steps", async ({ page, request }) => {
  const root = process.env.AWUI_E2E_ROOT as string;
  await seed(request, `${root}/beta`, 15, "focused paged");
  // Focus mode needs a second project with a session of its own.
  await seed(request, `${root}/alpha`, 1, "focused paged elsewhere");
  await useProjectsView(page);
  await signInAndOpen(page, "beta");
  await showSidebar(page);
  const focused = page.getByTestId("focused-project");
  await expect(focused).toBeVisible();
  const list = focused.locator("xpath=following-sibling::ul[1]");
  await expect(list.locator(".session-item"), "the current folder's page is 8 rows").toHaveCount(8);
  const more = focused.locator("xpath=following-sibling::ul[1]").locator(".show-more");
  const hidden = await hiddenIn(more);
  await more.click();
  await expect(list.locator(".session-item")).toHaveCount(8 + Math.min(20, hidden));
});
