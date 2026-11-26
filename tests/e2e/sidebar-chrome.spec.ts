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
  // New chat is a plus, not the pencil this app uses for rename and edit.
  const compose = sidebar.getByRole("button", { name: "New chat", exact: true });
  await expect(compose.locator("svg path")).toHaveAttribute("d", "M8 3v10M3 8h10");
  await expect(compose).toHaveAttribute("aria-keyshortcuts", "Control+N Meta+N");
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

test("the filter is a glyph in the field, and its popover is a short rail-wide dialog", async ({ page }) => {
  await signInAndOpen(page);
  const sidebar = page.locator(".sidebar");
  const filter = sidebar.getByRole("button", { name: "Filters", exact: true });
  // 24 px, no frame of its own: the search box is the control.
  await expect(filter).toHaveCSS("width", "24px");
  await expect(filter).toHaveCSS("border-top-width", "0px");
  await expect(filter).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await filter.hover();
  await expect(filter).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  // Its content is form controls, so it is announced as a dialog — and the role agrees this time.
  await expect(filter).toHaveAttribute("aria-haspopup", "dialog");
  await filter.click();
  const popover = page.getByRole("dialog", { name: "Filters", exact: true });
  await expect(popover).toBeVisible();
  // It ends inside the rail, not over the chat, and it is a menu's height, not a settings page's.
  const box = (await popover.boundingBox())!;
  const side = (await sidebar.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(8);
  expect(Math.round(box.x + box.width), "the popover ends inside the sidebar").toBeLessThanOrEqual(Math.round(side.x + side.width));
  expect(box.height, "a short menu, not 631px of hints").toBeLessThanOrEqual(470);
  // Every row and action is on one 32px pitch.
  for (const row of await popover.locator(".filter-row").all()) {
    expect(Math.round((await row.boundingBox())!.height)).toBe(32);
  }
  for (const action of await popover.locator(".filter-actions button").all()) {
    expect(Math.round((await action.boundingBox())!.height)).toBe(32);
  }
  // No visible hint lines, no "✓ Show everything": what a toggle takes out is its tooltip and description.
  await expect(popover.locator(".filter-hint")).toHaveCount(0);
  await expect(popover.locator(".filter-clear")).toHaveCount(0);
  const sleeping = popover.getByRole("checkbox", { name: "Sleeping 0", exact: true });
  await expect(sleeping).toHaveAttribute("aria-describedby", "filter-hint-sleeping");
  await expect(sleeping.locator("..")).toHaveAttribute("title", "No run, no question, and nothing said for a day");
  // Nothing is hidden yet, so there is no Reset.
  await expect(popover.getByRole("button", { name: "Reset", exact: true })).toHaveCount(0);
  // An unchecked radio is a ring, not a filled disc (Chromium rounds the declared 1.5px border to 1px).
  const radio = popover.getByRole("radio", { name: /^Running/ });
  await expect(radio).toHaveCSS("appearance", "none");
  await expect(radio).toHaveCSS("border-top-style", "solid");
  await expect(radio).toHaveCSS("border-radius", "50%");
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
  // The actions read as plain menu rows in the second ink, not a wrapping button bar of muted text.
  await expect(popover.locator(".filter-actions")).toHaveCSS("flex-direction", "column");

  // Focus inside the popover never lights the search field's ring: while a checkbox has it, the field's
  // box-shadow stays none (the global :focus-visible ring used to reach the field through the popover).
  await sleeping.focus();
  await expect(sleeping).toBeFocused();
  expect(await sidebar.locator(".search-field").evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none");

  // The arrows walk View (the segment's buttons) → Show → Hide → actions as one tab stop.
  await popover.getByRole("button", { name: "Recent", exact: true }).focus();
  const walked: string[] = [];
  for (let i = 0; i < 12; i++) {
    walked.push(
      await page.evaluate(() => {
        const el = document.activeElement as HTMLInputElement | HTMLButtonElement | null;
        if (!el) return "";
        return el.tagName === "INPUT" ? `${el.type}:${el.getAttribute("aria-describedby") ?? el.name}` : (el.textContent ?? "").trim();
      }),
    );
    await page.keyboard.press("ArrowDown");
  }
  expect(walked[0]).toBe("Recent");
  expect(walked).toContain("Projects");
  expect(walked).toContain("radio:sidebar-quick-filter");
  expect(walked).toContain("checkbox:filter-hint-sleeping");
  expect(walked).toContain("Refresh sessions");
  // Escape returns the focus to the chip.
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(filter).toBeFocused();
});

test("the Hide heading's Reset shows only while something is hidden, and clears the toggles", async ({ page }) => {
  await signInAndOpen(page, "gamma");
  const sidebar = page.locator(".sidebar");
  await sidebar.getByRole("button", { name: "Filters", exact: true }).click();
  const popover = page.getByRole("dialog", { name: "Filters", exact: true });
  await popover.getByRole("checkbox", { name: /On the default branch/ }).check();
  const reset = popover.getByRole("button", { name: "Reset", exact: true });
  await expect(reset).toBeVisible();
  await expect(reset).toHaveCSS("font-size", "11.5px");
  await expect(reset).toHaveCSS("font-weight", "500");
  await reset.click();
  await expect(reset).toHaveCount(0);
  await expect(popover.getByRole("checkbox", { name: /On the default branch/ })).not.toBeChecked();
  await page.keyboard.press("Escape");
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
    // one: the head's compose button is gone.
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

  test("a stuck date heading fades the rows scrolling under it", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 520 });
    await signInAndOpen(page);
    for (const n of [1, 2, 3, 4]) {
      await newChat(page);
      await sendAndWait(page, `a row for the stuck heading ${n}`);
    }
    await showSidebar(page);
    const list = page.locator(".sidebar .session-list");
    const divider = list.locator(".date-divider").first();
    await expect(divider).toBeVisible();
    // Before any scroll the heading is not stuck, and its fade is not drawn.
    const fade = divider.locator(".date-fade");
    await expect.poll(async () => fade.evaluate((el) => getComputedStyle(el).display)).toBe("none");
    // Scrolled past its own position it sticks to the top, and an 8px fade of the heading's surface lies
    // over the rows passing under it: no more descenders peeking out mid-glyph.
    await list.evaluate((el) => { el.scrollTop = 600; });
    await expect.poll(async () => fade.evaluate((el) => getComputedStyle(el).height)).toBe("8px");
    expect(await fade.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
    // Back at rest the fade goes again: only a stuck heading has an edge.
    await list.evaluate((el) => { el.scrollTop = 0; });
    await expect.poll(async () => fade.evaluate((el) => getComputedStyle(el).display)).toBe("none");
  });
});

test("the row whose ⋯ menu is open keeps a wash, so the menu names its row", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "menu owner row");
  // A second chat on screen, so the row under test is an ordinary one (the open session has a wash of its
  // own, drawn behind the list).
  await newChat(page);
  await sendAndWait(page, "the chat on screen");
  await showSidebar(page);
  const item = page.getByRole("complementary", { name: "Sessions" }).locator(".session-item", { hasText: "menu owner row" }).first();
  const session = item.locator(".session");
  // At rest the row is the panel's own surface, with no wash of its own.
  await expect(session).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  // Opened from the keyboard, so the pointer is nowhere near the row: what lights it is the open menu.
  await session.press("Shift+F10");
  await expect(page.getByRole("menu")).toBeVisible();
  // Its 90ms fade runs; once it has finished, the row sits on the same wash the pointer gives it.
  await expect.poll(async () => session.evaluate((el) => el.getAnimations().length)).toBe(0);
  const open = await session.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(open, "the menu's own row stays lit while it is open").not.toBe("rgba(0, 0, 0, 0)");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await session.hover();
  await expect.poll(async () => session.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(open);
});
