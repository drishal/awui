// Chrome checks for the compact sidebar, its filter disclosure, search, footer,
// and touch drawer. Row geometry remains sidebar-separation.spec's responsibility.
import { expect, test } from "@playwright/test";
import { signInAndOpen } from "./helpers.js";

test("the two-row head and footer keep the controls on the new chrome", async ({ page }) => {
  // Other specs create rooms on the shared server; this geometry check starts empty.
  await page.route("**/api/rooms", (route) => route.fulfill({ contentType: "application/json", body: "[]" }));
  await signInAndOpen(page);
  const sidebar = page.locator(".sidebar");
  const head = await sidebar.locator(".sidebar-head").boundingBox();
  const search = await sidebar.getByRole("searchbox", { name: "Search sessions" }).boundingBox();
  expect(head!.height).toBeLessThanOrEqual(36);
  expect(search!.y - head!.y).toBeLessThan(50);
  await expect(sidebar.locator(".quick-filters")).toHaveCount(0);
  await expect(sidebar.getByTestId("rooms-group")).toHaveCount(0);
  await expect(sidebar.locator(".harness-row-meta")).toHaveCount(0);
  const filter = sidebar.getByRole("button", { name: "Filters", exact: true });
  expect((await filter.boundingBox())!.width).toBe(24);
  expect((await filter.boundingBox())!.height).toBe(24);
  await expect(sidebar.locator(".sidebar-footer")).toHaveCSS("height", "36px");
  await sidebar.getByRole("button", { name: "Usage", exact: true }).click();
  await expect(page.getByRole("dialog", { name: /Usage/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await sidebar.getByRole("button", { name: /^Theme: / }).click();
  await expect(page.getByRole("menu", { name: "Theme" })).toBeVisible();
  await page.keyboard.press("Escape");
  await sidebar.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
});

test("a selected quick filter is one token; view and room commands live in Filters", async ({ page }) => {
  await signInAndOpen(page);
  const sidebar = page.locator(".sidebar");
  await sidebar.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name: /^Today/ }).click();
  await expect(sidebar.getByRole("button", { name: "Clear Today filter" })).toBeVisible();
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("button", { name: "Projects", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.locator(".filter-menu").getByRole("button", { name: "New room", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New room" })).toBeVisible();
  await page.keyboard.press("Escape");
  await sidebar.getByRole("button", { name: /^Filters/ }).click();
  await expect(page.getByRole("button", { name: "Refresh sessions", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await sidebar.getByRole("button", { name: "Clear Today filter" }).click();
  await expect(sidebar.locator(".quick-filters")).toHaveCount(0);
  await sidebar.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByRole("button", { name: "Recent", exact: true }).click();
});

test("search has no inner shadow and Enter searches an empty local result", async ({ page }) => {
  await signInAndOpen(page);
  const search = page.getByRole("searchbox", { name: "Search sessions" });
  await search.focus();
  await expect(search).toHaveCSS("box-shadow", "none");
  await search.fill("a title that cannot match 63e75e1");
  await expect(page.locator(".search-all")).toHaveCSS("border-top-style", "none");
  await expect(page.locator(".search-all-hint")).toHaveText("↵");
  await search.press("Enter");
  await expect(page.getByRole("dialog", { name: "Search every chat" })).toBeVisible();
});

test.describe("phone drawer", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("the phone drawer has a bottom New chat and 44px filter/search targets", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInAndOpen(page);
    await page.getByRole("button", { name: "Open menu" }).click();
    const drawer = page.locator(".sidebar");
    await expect(drawer.getByRole("button", { name: "Close menu" })).toBeVisible();
    const newChat = drawer.getByRole("button", { name: "New chat in folder" });
    await expect(newChat).toBeVisible();
    await expect(newChat).toHaveCSS("height", "44px");
    const action = await newChat.boundingBox();
    const footer = await drawer.locator(".sidebar-footer").boundingBox();
    expect(action!.y + action!.height).toBeLessThanOrEqual(footer!.y);
    await expect(drawer.locator(".search-field")).toHaveCSS("height", "44px");
    expect((await drawer.getByRole("button", { name: "Filters", exact: true }).boundingBox())!.height).toBe(44);
    await page.setViewportSize({ width: 320, height: 740 });
    await expect(newChat).toBeVisible();
  });
});
