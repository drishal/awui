// Chrome checks for the compact sidebar, its filter disclosure, search, footer,
// and touch drawer. Row geometry remains sidebar-separation.spec's responsibility.
import { expect, test } from "@playwright/test";
import { newChat, sendAndWait, showSidebar, signInAndOpen } from "./helpers.js";

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

test("the filter is a glyph in the field, and its popover is one left edge of controls", async ({ page }) => {
  await signInAndOpen(page);
  const sidebar = page.locator(".sidebar");
  const filter = sidebar.getByRole("button", { name: "Filters", exact: true });
  // 24 px, no frame of its own: the search box is the control.
  await expect(filter).toHaveCSS("width", "24px");
  await expect(filter).toHaveCSS("border-top-width", "0px");
  await expect(filter).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await filter.hover();
  await expect(filter).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  // Its content is form controls, so it is announced as a dialog.
  await expect(filter).toHaveAttribute("aria-haspopup", "dialog");
  await filter.click();
  const popover = page.locator(".filter-menu");
  await expect(popover).toBeVisible();
  // On screen at all: the popover hangs from the field's left edge, and its frame is inside the viewport.
  const box = (await popover.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(8);
  expect(Math.round(box.x + box.width)).toBeLessThanOrEqual(page.viewportSize()!.width - 8);
  // The segment, the headings and the rows stand on one left edge (the heading's text on the row's control).
  const segment = (await popover.locator(".view-segment").boundingBox())!;
  const firstRow = (await popover.locator(".filter-row").first().boundingBox())!;
  expect(Math.round(segment.x)).toBe(Math.round(firstRow.x));
  const heading = (await popover.locator(".filter-heading").first().boundingBox())!;
  const control = (await popover.locator(".filter-row input").first().boundingBox())!;
  expect(Math.round(heading.x)).toBe(Math.round(control.x));
  // A count of nothing dims its row but never disables it.
  const zero = popover.locator('.filter-row[data-count="0"]').first();
  await expect(zero).toHaveCSS("opacity", "0.55");
  await expect(zero.getByRole("radio")).toBeEnabled();
  // Each hide option says what it takes out, under its label.
  const hints = popover.locator(".filter-hide .filter-hint");
  await expect(hints).toHaveCount(4);
  await expect(hints.first()).toBeVisible();
  await expect(hints.first()).toHaveCSS("font-size", "11px");
  await expect(hints.first()).toContainText("No run, no question");
  // "Show everything" is an item like its neighbours, with a glyph.
  await expect(popover.locator(".filter-clear svg")).toHaveCount(1);

  // Tab moves inside the popover without lighting the search field's ring.
  await page.keyboard.press("Tab");
  await expect(popover).toContainText("View");
  expect(await sidebar.locator(".search-field").evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none");
  // The arrows walk its controls as one tab stop; Escape returns the focus to the chip.
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(filter).toBeFocused();
});

test("the harness title is its name and chevron, and its own label", async ({ page }) => {
  await signInAndOpen(page);
  const sidebar = page.locator(".sidebar");
  const trigger = sidebar.locator(".sidebar-head .harness-row");
  // A screen reader hears the harness it switches, not a bare "Harness".
  await expect(trigger).toHaveAttribute("aria-label", /^Harness: .+/);
  const name = (await sidebar.locator(".sidebar-head .harness-row-name").boundingBox())!;
  const chevron = (await sidebar.locator(".sidebar-head .harness-label > svg").boundingBox())!;
  expect(Math.round(chevron.x - (name.x + name.width)), "the chevron hugs the name").toBe(4);
  // The trigger is the words, not the empty half of the row: the hover pill hugs them.
  const field = (await sidebar.locator(".search-field").boundingBox())!;
  const own = (await trigger.boundingBox())!;
  expect(own.width).toBeLessThan(field.width / 2);
  // Its menu's heading is a label in sentence case, like every other heading.
  await trigger.click();
  const head = page.locator(".harness-menu-head");
  await expect(head).toHaveCSS("text-transform", "none");
  await expect(head).toHaveCSS("font-size", "11.5px");
  await expect(head).toHaveCSS("font-weight", "500");
});

test("the list's bottom fade is the footer tray's own height", async ({ page }) => {
  await signInAndOpen(page);
  const sidebar = page.locator(".sidebar");
  const tray = await sidebar.evaluate((el) => getComputedStyle(el).getPropertyValue("--sid-tray").trim());
  const footer = await sidebar.locator(".sidebar-footer").evaluate((el) => getComputedStyle(el).height);
  expect(tray).toBe(footer);
  const mask = await sidebar.locator(".session-list").evaluate((el) => getComputedStyle(el).maskImage);
  expect(mask).toContain(footer);
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
    // The filter is a glyph flush in the field's end, not a bordered 44 px square beside it: the field is the
    // box, the chip is the target. Polled, since the drawer slides in for 160 ms.
    const filter = drawer.getByRole("button", { name: "Filters", exact: true });
    await expect(filter).toHaveCSS("position", "absolute");
    await expect(filter).toHaveCSS("border-top-width", "0px");
    await expect
      .poll(async () => {
        const field = (await drawer.locator(".search-field").boundingBox())!;
        const chip = (await filter.boundingBox())!;
        return {
          end: Math.round(chip.x + chip.width - (field.x + field.width - 4)),
          fill: Math.round(chip.height - field.height),
          top: Math.round(chip.y - field.y),
        };
      })
      .toEqual({ end: 0, fill: 0, top: 0 });
    // The head is a 44 px touch row with 40 px controls, and the sticky New chat pill is the only way to start
    // one: the head's pencil is gone.
    const head = (await drawer.locator(".sidebar-head").boundingBox())!;
    expect(Math.round(head.height)).toBe(44);
    const close = (await drawer.getByRole("button", { name: "Close menu" }).boundingBox())!;
    expect([Math.round(close.width), Math.round(close.height)]).toEqual([40, 40]);
    await expect(drawer.getByRole("button", { name: "New chat", exact: true })).toBeHidden();
    // The pill takes the medium radius, as every other control of its size does.
    const radius = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--r-md").trim());
    await expect(newChat).toHaveCSS("border-radius", radius);
    await page.setViewportSize({ width: 320, height: 740 });
    await expect(newChat).toBeVisible();
  });

  test("a row's menu stays inside a 390 and a 360 px viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInAndOpen(page);
    await newChat(page);
    await sendAndWait(page, "a row for the phone menu clamp");
    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 844 });
      await showSidebar(page);
      const row = page.locator(".sidebar .session").first();
      await expect(row).toBeVisible();
      // A phone has no hover: the long press's context menu is the row menu's own gesture.
      await row.evaluate((el) => {
        const box = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.right - 30, clientY: box.top + 20 }));
      });
      const menu = page.locator(".sidebar .row-menu");
      await expect(menu).toBeVisible();
      const box = (await menu.boundingBox())!;
      expect(box.x, "the menu starts inside the left edge").toBeGreaterThanOrEqual(8);
      expect(Math.round(box.x + box.width), "and ends inside the right one").toBeLessThanOrEqual(width - 8);
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
    }
  });

  test("the drawer's list fades under the head only once it has scrolled", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 520 });
    await signInAndOpen(page);
    // A short window, and rows enough to scroll past it: the fade is for a list that runs under the head.
    for (const n of [1, 2, 3, 4]) {
      await newChat(page);
      await sendAndWait(page, `a row for the drawer fade ${n}`);
    }
    await showSidebar(page);
    const list = page.locator(".sidebar .session-list");
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight + 24), "the seeded rows overflow").toBe(true);
    await expect(list.locator(".list-scrim")).toHaveCount(0);
    await list.evaluate((el) => { el.scrollTop = 120; });
    const scrim = list.locator(".list-scrim");
    await expect(scrim).toBeVisible();
    expect((await scrim.boundingBox())!.height, "a 12 px fade").toBe(12);
    await list.evaluate((el) => { el.scrollTop = 0; });
    await expect(list.locator(".list-scrim")).toHaveCount(0);
  });
});
