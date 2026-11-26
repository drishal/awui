// The sidebar's two views (sidebar-view.ts). The default is Recent: one flat list across every project
// of the shown harness — what needs you and what is working above it, then date headings, each row
// tagged with the project it is out of — a page at a time. Projects is the grouped list with the folder
// heads. The saved view lives in this browser, so the Projects test sets it the way the switch does.
import { expect, type Page, test } from "@playwright/test";
import { signInAndOpen } from "./helpers.js";

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sessions" });
/** The flat list's own rows: the group Recent draws as one list, whatever the sections above hold. */
const flatRows = (page: Page) => sidebar(page).locator(".flat-group .session-item");
const row = (page: Page, title: string) => sidebar(page).locator(".session-item", { hasText: title });

/** The sidebar's saved view, set before the app boots: exactly what the switch in the filter menu writes. */
async function savedView(page: Page, view: "recent" | "projects"): Promise<void> {
  await page.addInitScript((v) => window.localStorage.setItem("awui.sidebarView", JSON.stringify(v)), view);
}

/** A chat sent through the API: the suite shares one server, so a test seeds its own rows. */
async function chat(request: Page["request"], path: string, text: string): Promise<void> {
  const ws = (await (await request.post("/api/workspaces/open", { data: { path } })).json()) as { id: string };
  const created = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: ws.id } })).json()) as { chatId: string };
  await request.post(`/api/chats/${created.chatId}/messages`, { data: { text, mode: "normal" } });
}

test("the default view is one flat list across projects, a page at a time", async ({ page, request }) => {
  const root = process.env.AWUI_E2E_ROOT as string;
  await chat(request, `${root}/alpha`, "flat alpha row");
  await chat(request, `${root}/beta`, "flat beta row");
  await signInAndOpen(page);

  // Both projects' rows are in the one list, and each says which project it is out of.
  await expect(flatRows(page).filter({ hasText: "flat alpha row" })).toHaveCount(1);
  await expect(flatRows(page).filter({ hasText: "flat beta row" })).toHaveCount(1);
  await expect(row(page, "flat beta row").locator(".session-sub")).toContainText("beta");
  // No folder heads: the list is grouped by date, not by project.
  await expect(sidebar(page).locator(".flat-group .date-divider").first()).toBeVisible();
  await expect(page.getByTestId("project-group")).toHaveCount(0);

  // A page is 12 rows; "Show more" is plain text that adds the next 20 at a time.
  await page.getByRole("searchbox", { name: "Search sessions" }).fill("paging row");
  const seeded = Array.from({ length: 13 }, (_, i) => chat(request, `${root}/beta`, `paging row ${String(i + 1).padStart(2, "0")}`));
  await Promise.all(seeded);
  await expect(flatRows(page)).toHaveCount(12, { timeout: 20_000 });
  // The page stopped inside the day, so its heading says how much of the day it drew, and how much it holds.
  const today = sidebar(page).locator(".flat-group .date-divider .date-count").first();
  await expect(today).toHaveText("12 of 13 sessions");
  await expect(today).toHaveAttribute("title", "1 more session");
  await expect(today.locator(".date-part")).toHaveCSS("font-size", "11px");
  const more = sidebar(page).locator(".flat-group .show-more");
  await expect(more).toHaveText("Show 1 more");
  await more.click();
  await expect(flatRows(page)).toHaveCount(13);
  // The whole bucket is on screen now: the heading says the bare size again.
  await expect(today).toHaveText("13 sessions");
  await expect(today).not.toHaveAttribute("title", /.+/);
  await expect(sidebar(page).locator(".flat-group .show-more")).toHaveCount(0);
});

test("the Projects view groups the same sessions under their folder", async ({ page, request }) => {
  await savedView(page, "projects");
  await chat(request, `${process.env.AWUI_E2E_ROOT as string}/beta`, "grouped beta row");
  await signInAndOpen(page, "beta");
  // The current folder's own head, then its rows under it.
  await expect(page.getByTestId("focused-project")).toBeVisible();
  await expect(sidebar(page).locator(".session-item", { hasText: "grouped beta row" })).toHaveCount(1);
  await expect(sidebar(page).locator(".flat-group")).toHaveCount(0);
});
