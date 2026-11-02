// The start screen: the main pane with no chat — one question, a box, and the
// agent and folder chips. Nothing spawns until a send.
import { expect, test } from "@playwright/test";
import { newChat, send, sendAndWait, showSidebar, signInAndOpen } from "./helpers.js";

const box = "Message";
const folderChip = (page: import("@playwright/test").Page) => page.getByRole("button", { name: /^Folder: / });
const tabs = (page: import("@playwright/test").Page) => page.getByRole("tablist", { name: "Open chats" }).getByRole("tab");

test("a fresh browser lands on the start screen: a box, and a folder chip asking for one", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /What should Fake work on\?/ })).toBeVisible();
  await expect(page.getByRole("textbox", { name: box })).toBeVisible();
  const chip = folderChip(page);
  await expect(chip).toHaveText(/Choose a folder/);
  await expect(chip).toHaveClass(/is-needed/);
  // No folder is needed to show the start screen, so New chat works at once.
  await showSidebar(page);
  await expect(page.getByRole("button", { name: "New chat", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  // The agent chip lists every harness this server knows.
  await page.getByRole("button", { name: "Agent for this chat" }).click();
  const menu = page.getByRole("listbox", { name: "Agent" });
  await expect(menu.getByRole("option", { name: "Fake", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(menu.getByRole("option", { name: "Fake B" })).toBeVisible();
});

test("sending with no folder asks for one, keeps the draft, and the next Enter starts the chat", async ({ page }) => {
  await page.goto("/");
  const input = page.getByRole("textbox", { name: box });
  await input.fill("fix the flaky test");
  await input.press("Enter");
  // The folder picker opens; the draft survives the detour.
  const dialog = page.getByRole("dialog", { name: "Choose a project folder" });
  await expect(dialog).toBeVisible();
  // By path: what the Recent and Browse lists hold depends on what other tests opened on the shared server.
  await dialog.getByLabel("Or type a path").fill(`${process.env.AWUI_E2E_ROOT as string}/alpha`);
  await dialog.getByRole("button", { name: "Open", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(input).toHaveValue("fix the flaky test");
  await expect(page.getByRole("heading", { name: /What should Fake do in alpha\?/ })).toBeVisible();
  // No chat was created by the detour.
  await expect(page.getByTestId("user-prompt")).toHaveCount(0);
  await input.press("Enter");
  await expect(page.getByTestId("user-prompt")).toHaveText(["fix the flaky test"]);
  await expect(page.getByTestId("answer").last()).toContainText("Echo: fix the flaky test");
});

test("typing and Enter create exactly one chat, with its prompt and answer", async ({ page }) => {
  await signInAndOpen(page);
  await expect(page.getByRole("heading", { name: /What should Fake do in alpha\?/ })).toBeVisible();
  const input = page.getByRole("textbox", { name: box });
  await input.fill("hello from the start");
  await input.press("Enter");
  await expect(page.getByTestId("user-prompt")).toHaveText(["hello from the start"]);
  await expect(page.getByTestId("answer").last()).toContainText("Echo: hello from the start");
  // One tab, one session, and the start screen is gone.
  await expect(tabs(page)).toHaveCount(1);
  await expect(page.getByRole("heading", { name: /What should/ })).toHaveCount(0);
  await showSidebar(page);
  await expect(page.locator(".session", { hasText: "hello from the start" })).toBeVisible();
});

test("the start screen picks the model the chat starts on", async ({ page }) => {
  await signInAndOpen(page);
  // The chip reads its list from the harness for this folder; until a pick it names the harness's own default.
  const picker = page.locator(".start-screen").getByTestId("model-picker");
  await expect(picker).toHaveAccessibleName("Model: Fake Echo · low");
  await picker.click();
  const dialog = page.getByRole("dialog", { name: "Choose a model" });
  await dialog.getByRole("combobox", { name: "Search models" }).fill("slow");
  await dialog.getByRole("option", { name: /Fake Slow/ }).click();
  await expect(picker).toHaveAccessibleName("Model: Fake Slow");
  await page.getByRole("textbox", { name: box }).fill("on the slow model");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("user-prompt")).toHaveText(["on the slow model"]);
  // The chat opened on the picked model, not the harness's default.
  await expect(page.locator(".composer-controls").getByTestId("model-picker")).toHaveAccessibleName("Model: Fake Slow");
});

test("the start screen's thinking level carries into the chat", async ({ page }) => {
  await signInAndOpen(page);
  // The model chip's footer offers the harness's thinking levels before any chat exists.
  await page.locator(".start-screen").getByTestId("model-picker").click();
  const dialog = page.getByRole("dialog", { name: "Choose a model" });
  const thinking = dialog.getByRole("group", { name: "Thinking level" });
  await expect(thinking).toBeVisible();
  await thinking.getByRole("button", { name: "high", exact: true }).click();
  await expect(thinking.getByRole("button", { name: "high", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: box }).fill("think hard");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("user-prompt")).toHaveText(["think hard"]);
  // The chat opened on the picked thinking level.
  await expect(page.locator(".composer-controls").getByTestId("thinking-picker")).toHaveAccessibleName(/high/);
});

test("a double Enter (or double click) makes exactly one chat", async ({ page }) => {
  await signInAndOpen(page);
  const input = page.getByRole("textbox", { name: box });
  await input.fill("only once");
  await input.press("Enter");
  await input.press("Enter");
  await expect(page.getByTestId("user-prompt")).toHaveText(["only once"]);
  await expect(tabs(page)).toHaveCount(1);
  await showSidebar(page);
  await expect(page.locator(".session", { hasText: "only once" })).toHaveCount(1);
});

test("the agent chip and the sidebar's harness row pick the same thing", async ({ page }) => {
  await signInAndOpen(page, "beta");
  const chip = page.getByRole("button", { name: "Agent for this chat" });
  const row = page.getByRole("complementary", { name: "Sessions" }).getByRole("button", { name: "Harness" });
  await showSidebar(page);
  // The chip switches the harness; the sidebar's row follows.
  await chip.click();
  await page.getByRole("listbox", { name: "Agent" }).getByRole("option", { name: "Fake B" }).click();
  await expect(row).toContainText("Fake B");
  await expect(page.getByRole("heading", { name: /What should Fake B do in beta\?/ })).toBeVisible();
  // And the other way round.
  await row.click();
  await page.getByRole("listbox", { name: "Harness" }).getByRole("option", { name: "Fake", exact: true }).click();
  await expect(chip).toContainText("Fake");
  await expect(page.getByRole("heading", { name: /What should Fake do in beta\?/ })).toBeVisible();
});

test("the folder chip switches between recent folders without the dialog", async ({ page }) => {
  await signInAndOpen(page);
  await signInAndOpen(page, "beta");
  const chip = folderChip(page);
  await expect(chip).toContainText("beta");
  await chip.click();
  const menu = page.getByRole("menu", { name: "Folder" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /alpha/ })).toBeVisible();
  await menu.getByRole("menuitem", { name: /alpha/ }).click();
  await expect(menu).toBeHidden();
  await expect(chip).toContainText("alpha");
  await expect(page.getByRole("heading", { name: /What should Fake do in alpha\?/ })).toBeVisible();
  // The browser still opens from the chip's last entry.
  await chip.click();
  await menu.getByRole("menuitem", { name: "Choose another folder…" }).click();
  await expect(page.getByRole("dialog", { name: "Choose a project folder" })).toBeVisible();
});

test("New chat opens the folder picker over the start screen, and the picked folder lands in the box", async ({ page }) => {
  await signInAndOpen(page);
  await sendAndWait(page, "first chat");
  await showSidebar(page);
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Choose a project folder" });
  await expect(dialog).toBeVisible();
  // Escape keeps the folder the start screen already had.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: /What should Fake do in alpha\?/ })).toBeVisible();
  // Picking another folder switches the start screen to it, with the cursor in the box.
  await showSidebar(page);
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  // By path: what the Recent and Browse lists hold depends on what other tests opened on the shared server.
  await dialog.getByLabel("Or type a path").fill(`${process.env.AWUI_E2E_ROOT as string}/beta`);
  await dialog.getByRole("button", { name: "Open", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: /What should Fake do in beta\?/ })).toBeVisible();
  await expect(page.getByRole("textbox", { name: box })).toBeFocused();
  // The first chat's tab is still open.
  await expect(tabs(page)).toHaveCount(1);
});

test("a project's + shows the start screen in that folder and starts nothing", async ({ page }) => {
  await signInAndOpen(page);
  await sendAndWait(page, "a chat in alpha");
  await signInAndOpen(page, "beta");
  await sendAndWait(page, "a chat in beta");
  const before = await tabs(page).count();
  await showSidebar(page);
  // The list is focused on beta; alpha's + is in All projects.
  await page.getByTestId("focused-project").getByRole("button", { name: "All projects" }).click();
  await page.getByRole("button", { name: "New chat in alpha" }).click();
  await expect(page.getByRole("heading", { name: /What should Fake do in alpha\?/ })).toBeVisible();
  await expect(page.getByTestId("user-prompt")).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(before);
  await expect(page.getByRole("textbox", { name: box })).toBeFocused();
  await sendAndWait(page, "second chat in alpha");
  await expect(page.getByTestId("user-prompt")).toHaveText(["second chat in alpha"]);
});

test("a share's text and image wait in the start screen's box and go with the first message", async ({ page }) => {
  await signInAndOpen(page);
  await page.keyboard.press("Escape");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.evaluate(() => navigator.serviceWorker.controller !== null || new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", () => r(true))));
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==";
  const status = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const form = new FormData();
    form.append("text", "look at this screenshot");
    form.append("images", new File([bytes], "shot.png", { type: "image/png" }));
    const res = await fetch("/share", { method: "POST", body: form, redirect: "manual" });
    return res.type === "opaqueredirect" ? 303 : res.status;
  }, png);
  expect(status).toBe(303);
  await page.goto("/?share=1");
  await expect(page.getByRole("textbox", { name: box })).toHaveValue("look at this screenshot");
  await expect(page.getByRole("list", { name: "Attached images" }).getByRole("listitem")).toHaveCount(1);
  // Nothing exists until the send; then the image goes with the message.
  await expect(page.getByTestId("user-prompt")).toHaveCount(0);
  await send(page, "describe it");
  await expect(page.getByTestId("user-prompt")).toHaveText(["describe it"]);
});

test("an image pasted or dropped on the start screen's box waits there and goes with the first message", async ({ page }) => {
  await signInAndOpen(page);
  await page.keyboard.press("Escape");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==";
  const attached = page.getByRole("list", { name: "Attached images" }).getByRole("listitem");
  // As the browser sends a pasted screenshot: a file on the clipboard and no text.
  await page.evaluate((b64) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], "pasted.png", { type: "image/png" }));
    document.querySelector('textarea[aria-label="Message"]')?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, png);
  await expect(attached).toHaveCount(1);
  // And one dropped on the card.
  await page.evaluate((b64) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], "dropped.png", { type: "image/png" }));
    const card = document.querySelector(".start-screen .composer-card") as HTMLElement;
    for (const type of ["dragover", "drop"]) card.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
  }, png);
  await expect(attached).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Attach images" })).toBeEnabled();
  // Nothing exists until the send; then both images go with the message.
  await expect(page.getByTestId("user-prompt")).toHaveCount(0);
  await send(page, "what do these show");
  await expect(page.getByTestId("user-prompt")).toHaveText(["what do these show"]);
  await expect(page.getByRole("img", { name: /image #2/i })).toBeVisible();
});

test("at full chat width the start screen's box keeps a gutter from the sidebar and the pane's edge", async ({ page }) => {
  await signInAndOpen(page);
  await page.keyboard.press("Escape");
  // What Settings → Chat width → Full sets.
  await page.evaluate(() => document.documentElement.style.setProperty("--chat-col", "100%"));
  const pane = (await page.locator(".start-screen").boundingBox())!;
  const card = (await page.locator(".start-screen .composer-card").boundingBox())!;
  expect(card.x - pane.x).toBeGreaterThanOrEqual(12);
  expect(pane.x + pane.width - (card.x + card.width)).toBeGreaterThanOrEqual(12);
});

test("the start screen fits a phone: chips wrap, and sending works at 360 px", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await signInAndOpen(page);
  await page.keyboard.press("Escape");
  const hero = page.locator(".start-screen");
  await expect(hero).toBeVisible();
  // Nothing scrolls sideways.
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(scroll).toBeLessThanOrEqual(0);
  // The chips row wraps inside the card instead of overflowing it.
  const row = page.locator(".start-screen .composer-bar");
  const card = page.locator(".start-screen .composer-card");
  expect((await row.boundingBox())!.width).toBeLessThanOrEqual((await card.boundingBox())!.width);
  await page.getByRole("textbox", { name: box }).fill("hello from a phone");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("user-prompt")).toHaveText(["hello from a phone"]);
  await expect(page.getByTestId("answer").last()).toContainText("Echo: hello from a phone");
});
