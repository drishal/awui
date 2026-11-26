// Chrome checks for the compact sidebar, its filter disclosure, search, footer,
// and touch drawer. Row geometry remains sidebar-separation.spec's responsibility.
import { expect, test } from "@playwright/test";
import { newChat, send, sendAndWait, showSidebar, signInAndOpen } from "./helpers.js";

async function painted(page: import("@playwright/test").Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const canvas = document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;
    const probe = document.createElement("span");
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(name);
    document.body.append(probe);
    canvas.fillStyle = getComputedStyle(probe).color;
    probe.remove();
    canvas.fillRect(0, 0, 1, 1);
    const [r, g, b] = canvas.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  }, token);
}

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

test("a selected quick filter is one token; view and room commands stay reachable", async ({ page }) => {
  await signInAndOpen(page);
  const sidebar = page.locator(".sidebar");
  await sidebar.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name: /^Today/ }).click();
  await expect(sidebar.getByRole("button", { name: "Clear Today filter" })).toBeVisible();
  await expect(page.locator(".filter-view")).toBeHidden();
  await page.locator(".filter-menu").getByRole("button", { name: "New room", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New room" })).toBeVisible();
  await page.keyboard.press("Escape");
  await sidebar.getByRole("button", { name: /^Filters/ }).click();
  await expect(page.getByRole("button", { name: "Refresh sessions", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await sidebar.getByRole("button", { name: "Clear Today filter" }).click();
  await expect(sidebar.locator(".quick-filters")).toHaveCount(0);
  await sidebar.getByRole("button", { name: "Sidebar view: Recent" }).click();
  await expect(page.getByRole("button", { name: "Sidebar view: Recent" })).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("menuitemradio", { name: "Projects", exact: true }).click();
  await expect(sidebar.getByRole("button", { name: "Sidebar view: Projects" })).toHaveAttribute("aria-expanded", "false");
  await sidebar.getByRole("button", { name: "Sidebar view: Projects" }).click();
  await page.getByRole("menuitemradio", { name: "Recent", exact: true }).click();
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
  for (const row of await popover.locator(".filter-row:visible").all()) {
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
  // Group headings share the controls' edge; view choices are no longer inside this dialog.
  await expect(popover.getByRole("group", { name: "View" })).toHaveCount(0);
  const heading = (await popover.locator(".filter-heading:visible").first().boundingBox())!;
  const control = (await popover.locator(".filter-row input:visible").first().boundingBox())!;
  expect(Math.round(heading.x)).toBe(Math.round(control.x));
  // Zero dims only its words, not the radio ring or the row's hit area.
  const zero = popover.locator('.filter-row[data-count="0"]').first();
  await expect(zero).toHaveCSS("opacity", "1");
  await expect(zero.locator(".filter-label")).toHaveCSS("color", await painted(page, "--muted"));
  await expect(zero.getByRole("radio")).toBeEnabled();
  // Actions read as plain menu rows in the second ink, not a wrapping button bar.
  await expect(popover.locator(".filter-actions")).toHaveCSS("flex-direction", "column");
  // Focus inside the popover never lights the search field's ring: while a checkbox has it, the field's
  // box-shadow stays none (the global :focus-visible ring used to reach the field through the popover).
  await sleeping.focus();
  await expect(sleeping).toBeFocused();
  expect(await sidebar.locator(".search-field").evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none");

  // Tab walks the shared Show stop, four Hide choices and two commands, then leaves this form.
  const running = popover.getByRole("radio", { name: /^Running/ });
  await running.focus();
  const walked = [];
  for (let i = 0; i < 7; i++) {
    walked.push(await page.evaluate(() => {
      const el = document.activeElement as HTMLInputElement | HTMLButtonElement;
      return el.tagName === "INPUT" ? `${el.type}:${el.getAttribute("aria-describedby") ?? el.name}` : (el.textContent ?? "").trim();
    }));
    await page.keyboard.press("Tab");
  }
  expect(walked).toEqual(["radio:sidebar-quick-filter", "checkbox:filter-hint-sleeping", "checkbox:filter-hint-defaultBranch", "checkbox:filter-hint-automation", "checkbox:filter-hint-agent", "New room", "Refresh sessions"]);
  await running.focus();
  await page.keyboard.press("ArrowDown");
  await expect(popover.getByRole("radio", { name: /^Needs you/ })).toBeChecked();
  await expect(sidebar.getByRole("button", { name: "Clear Needs you filter" })).toBeVisible();
  // The popover covers the token while it is open (the pointer lands on the popover's own rows), so the
  // token is not clicked here: Escape closes the popover and returns the focus to the chip.
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  // The chip's name now says a filter is on, so the exact "Filters" locator no longer matches it.
  await expect(sidebar.locator(".filter-chip")).toBeFocused();
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

test("the list's bottom fade is a scrim under the rows, and the list masks nothing", async ({ page, request }) => {
  const root = process.env.AWUI_E2E_ROOT as string;
  // Its own rows: 14, so the list scrolls and its page leaves a fold — the control that measured 1.35:1
  // inside the fade at the drawer's end.
  const ws = (await (await request.post("/api/workspaces/open", { data: { path: `${root}/alpha` } })).json()) as { id: string };
  await Promise.all(
    Array.from({ length: 14 }, async (_, i) => {
      const chat = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: ws.id } })).json()) as { chatId: string };
      await request.post(`/api/chats/${chat.chatId}/messages`, { data: { text: `fade row ${String(i + 1).padStart(2, "0")}`, mode: "normal" } });
    }),
  );
  await page.setViewportSize({ width: 1280, height: 520 });
  await signInAndOpen(page);
  await showSidebar(page);
  await page.getByRole("searchbox", { name: "Search sessions" }).fill("fade row");
  const sidebar = page.locator(".sidebar");
  const list = sidebar.locator(".session-list");
  await expect(sidebar.locator(".flat-group .session-item")).toHaveCount(12, { timeout: 20_000 });

  // The scroller is not a masked stacking context any more. A mask on it clipped every fixed popup drawn
  // inside it: the row menu's foot faded into the footer, and the hover card beside the rail disappeared
  // whole, leaving its shadow as a band on the list's edge. Playwright's visibility ignores masks, which is
  // how both shipped.
  await expect(list).toHaveCSS("mask-image", "none");
  await expect(list).toHaveCSS("-webkit-mask-image", "none");

  // The fade is the list's last child: a sticky scrim, as tall as the footer tray, with the scroller's own
  // tail set to it, so the fade covers the tail at the end and never a row.
  const fade = await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>(".sidebar .session-list");
    const tray = list?.querySelector<HTMLElement>(".list-tray");
    if (!list || !tray) return null;
    const style = getComputedStyle(tray);
    return { position: style.position, bottom: style.bottom, height: style.height, gradient: style.backgroundImage, last: list.lastElementChild === tray, tail: getComputedStyle(list).paddingBottom };
  });
  expect(fade, "the list ends in its tray").not.toBeNull();
  const tray = fade as { position: string; bottom: string; height: string; gradient: string; last: boolean; tail: string };
  expect(tray.position, "a sticky scrim, not a mask").toBe("sticky");
  expect(tray.bottom).toBe("0px");
  expect(tray.last, "the tray is the list's last child, so it paints over the rows").toBe(true);
  expect(tray.gradient).toContain("gradient");
  expect(tray.height, "the fade is the footer tray's own height").toBe(await sidebar.locator(".sidebar-footer").evaluate((el) => getComputedStyle(el).height));
  expect(tray.tail, "the scroller's tail is the fade's height").toBe(tray.height);

  // The hover card opens beside the rail, past the list's right edge: the popup a mask on the scroller ate.
  const first = sidebar.locator(".flat-group .session-item").first();
  await first.hover();
  await expect(page.locator(".session-card")).toBeVisible();
  const card = await page.evaluate(() => {
    const card = document.querySelector(".session-card")?.getBoundingClientRect();
    const list = document.querySelector(".sidebar .session-list")?.getBoundingClientRect();
    return card && list ? { cardRight: card.right, listRight: list.right } : null;
  });
  expect(card, "the hover card drew").not.toBeNull();
  expect((card as { cardRight: number }).cardRight, "the card reaches past the list").toBeGreaterThan((card as { listRight: number }).listRight + 40);

  // At the end of the list nothing sits inside the fade: the last row and the fold under it rest above it,
  // where before the tail was 12px and the fade 36, so the fold was drawn through it.
  const rest = await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>(".sidebar .session-list");
    if (!list) return null;
    list.scrollTop = list.scrollHeight;
    const trayTop = list.querySelector(".list-tray")?.getBoundingClientRect().top ?? null;
    const items = [...list.querySelectorAll<HTMLElement>(".session-item, .show-more")];
    const bottom = items[items.length - 1]?.getBoundingClientRect().bottom ?? null;
    return { trayTop, bottom, scrolls: list.scrollHeight > list.clientHeight + 40 };
  });
  expect(rest?.scrolls, "the list has more rows than its height").toBe(true);
  expect(rest?.bottom ?? 99, "the end of the list rests above the fade").toBeLessThanOrEqual((rest?.trayTop ?? 0) + 0.5);

  // A menu from the last row runs to the window's own edge: its foot is a real item under the pointer, not
  // a faded band (S04 lost "Archive" in the tray).
  const last = sidebar.locator(".flat-group .session-item").last();
  await last.hover();
  await last.getByRole("button", { name: /^More for / }).click();
  const menu = page.locator(".row-menu");
  await expect(menu).toBeVisible();
  const foot = await page.evaluate(() => {
    const menu = document.querySelector<HTMLElement>(".row-menu");
    const box = menu?.getBoundingClientRect();
    if (!menu || !box) return null;
    // The last item the menu actually shows: a menu taller than the room under its row scrolls.
    const shown = [...menu.querySelectorAll<HTMLElement>("[role='menuitem']")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5;
    });
    const item = shown[shown.length - 1];
    if (!item) return null;
    const r = item.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { inside: Boolean(hit?.closest(".row-menu")), label: (item.textContent ?? "").trim() };
  });
  expect(foot, "the menu drew").not.toBeNull();
  // Its foot is a real target under the pointer, not a band the list's fade painted over.
  expect(foot?.inside, `the menu's last row ("${foot?.label}") is a real target`).toBe(true);
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
    await expect(drawer.locator(".sidebar-view-control")).toBeHidden();
    await filter.click();
    await expect(page.getByRole("radiogroup", { name: "View", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Filters", exact: true })).toHaveCount(0);
    await expect(drawer).toHaveClass(/is-open/);
    await expect(newChat).toBeVisible();
    await expect(newChat).toHaveCSS("border-radius", "10px");
    await page.setViewportSize({ width: 345, height: 844 });
    await expect(drawer.locator(".sidebar-view-control")).toBeVisible();
    expect((await drawer.getByRole("searchbox", { name: "Search sessions" }).boundingBox())!.width).toBeGreaterThanOrEqual(149.5);
    await expect(drawer.locator(".view-switch")).toHaveCSS("height", "44px");
    await page.setViewportSize({ width: 390, height: 844 });
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
    expect(radius).toBe("10px");
    await expect(newChat).toHaveCSS("border-radius", radius);
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
    // Scrolled past its own position it sticks, and an 18px fade covers a 16px passing subline.
    await list.evaluate((el) => { el.scrollTop = 600; });
    await expect.poll(async () => fade.evaluate((el) => getComputedStyle(el).height)).toBe("18px");
    expect(await fade.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
    // Back at rest the fade goes again: only a stuck heading has an edge.
    await list.evaluate((el) => { el.scrollTop = 0; });
    await expect.poll(async () => fade.evaluate((el) => getComputedStyle(el).display)).toBe("none");
  });

  test("a scrolled phone drawer keeps a waiting chat one tap away", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 520 });
    await signInAndOpen(page);
    await newChat(page);
    await send(page, "please ask first for the phone shortcut");
    await expect(page.getByTestId("approval-card")).toBeVisible();
    for (const n of [1, 2, 3, 4]) {
      await newChat(page);
      await sendAndWait(page, `phone attention filler ${n}`);
    }
    await showSidebar(page);
    const shortcut = page.locator(".sidebar .needs-you-shortcut");
    await expect(shortcut).toBeHidden();
    const list = page.locator(".sidebar .session-list");
    await list.evaluate((el) => { el.scrollTop = 600; });
    await expect(shortcut).toBeVisible();
    await expect(shortcut).toHaveCSS("height", "44px");
    await expect(shortcut).toHaveCSS("border-radius", "12px");
    const pill = await page.locator(".sidebar .drawer-new-chat").boundingBox();
    const above = await shortcut.boundingBox();
    expect(above!.y + above!.height).toBeLessThanOrEqual(pill!.y + 0.5);
    await expect(shortcut).toHaveText("1 needs you");
    await shortcut.click();
    await expect(page.getByTestId("approval-card")).toBeVisible();
  });
});

test("the needs-you shortcut is the phone drawer's: a desktop list never draws it", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "please ask first for the desktop shortcut");
  await expect(page.getByTestId("approval-card")).toBeVisible();
  // The chat on screen stays out of Needs you, so look at the list from another chat.
  await newChat(page);
  await sendAndWait(page, "another chat on screen");
  await showSidebar(page);
  await expect(page.locator('.sidebar [data-testid="needs-group"]')).toBeVisible();
  await expect(page.locator(".sidebar .needs-you-shortcut")).toBeHidden();
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

test("the open row's wash takes one step less on a light page", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "the open row");
  await showSidebar(page);
  // The wash is drawn behind the list (`.session-active-bg`), so the row keeps its own transparent box.
  // Other lists (a folded section) can hold a wash of their own that is not drawn: take the visible one.
  const wash = page.locator(".session-active-bg:visible").first();
  await expect(wash).toBeVisible();
  const dark = await wash.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(dark, "the open row sits on a wash, not on the panel").not.toBe("rgba(0, 0, 0, 0)");
  // The same hue, one step quieter: 8% of the harness colour instead of 12%.
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await expect.poll(async () => wash.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(dark);
  // The 2px rule is what carries the state either way, so it stays in both schemes.
  await expect(wash).toHaveCSS("box-shadow", /2px 0px 0px 0px inset$/);
});
