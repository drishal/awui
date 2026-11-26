import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Show the sidebar's grouped Projects view in this browser, before the app boots: the sidebar's saved
 * view is Recent by default, and the folder heads, focus mode and drag order belong to Projects.
 */
export async function useProjectsView(page: Page): Promise<void> {
  await page.addInitScript(() => window.localStorage.setItem("awui.sidebarView", JSON.stringify("projects")));
}

/** Leave a focused project for the all-projects list: the head is one switch button whose menu starts with "All projects". */
export async function showAllProjects(page: Page): Promise<void> {
  await page.locator(".focus-switch").click();
  await page.getByRole("menuitem", { name: "All projects" }).click();
}

/**
 * Make the sidebar usable. On phones it is a drawer; `isVisible()` is not a
 * reliable signal mid-transition, so decide by layout and the drawer's state.
 */
export async function showSidebar(page: Page): Promise<void> {
  // Wait for the app shell; before bootstrap finishes neither layout exists yet.
  await expect(page.locator(".chat-header")).toBeVisible();
  const menu = page.getByRole("button", { name: "Open menu" });
  if (!(await menu.isVisible())) return;
  const sidebar = page.locator(".sidebar");
  if (!(await sidebar.evaluate((el) => el.classList.contains("is-open")))) await menu.click();
  await expect(sidebar).toBeInViewport({ ratio: 0.95 });
}

/**
 * The New chat control this layout shows: the head's pencil on a pointer, and on a phone the drawer's
 * own sticky pill (its head keeps only the harness title and the close button).
 */
async function clickNewChat(page: Page): Promise<void> {
  const head = page.getByRole("button", { name: "New chat", exact: true });
  if (await head.isVisible()) await head.click();
  else await page.getByRole("button", { name: "New chat in folder" }).click();
}

/** Open the app (this machine needs no sign-in) and pick a project through the folder browser. */
export async function signInAndOpen(page: Page, project = "alpha"): Promise<void> {
  await page.goto("/");
  await showSidebar(page);
  // "New chat" shows the start screen with the folder picker open over it (a
  // restored tab shows its chat instead, and New chat leaves that tab open).
  await clickNewChat(page);
  const dialog = page.getByRole("dialog", { name: "Choose a project folder" });
  // The picker opens wherever the server last had a folder open (shared across
  // tests), so name the folder outright instead of trusting its start point.
  await dialog.getByLabel("Or type a path").fill(`${process.env.AWUI_E2E_ROOT as string}/${project}`);
  await dialog.getByRole("button", { name: "Open", exact: true }).click();
  await expect(dialog).toBeHidden();
  // The folder picked, not the one the dialog started in: a chat sent now belongs to it.
  await expect(page.getByRole("heading", { name: new RegExp(`^What should .* (do in|work on) ${project}\\?$`) })).toBeVisible();
}
/** Pick the sidebar's harness from its menu. */
export async function chooseHarness(page: Page, harness: string): Promise<void> {
  await page.getByRole("complementary", { name: "Sessions" }).getByRole("button", { name: /^Harness: / }).click();
  await page.getByRole("listbox", { name: "Harness" }).getByRole("option", { name: harness, exact: true }).click();
}


/** Open the Settings dialog (gear left of the collapse button). */
export async function openSettings(page: Page): Promise<void> {
  await showSidebar(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
}

export async function newChat(page: Page, harness?: string): Promise<void> {
  await showSidebar(page);
  if (harness) await chooseHarness(page, harness);
  await clickNewChat(page);
  // The folder picker opens over the start screen; Escape keeps the current folder.
  const picker = page.getByRole("dialog", { name: "Choose a project folder" });
  await expect(picker).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  // A fresh chat always opens as the hero; wait for it rather than for "Idle",
  // which the previous chat may already show.
  await expect(page.getByRole("heading", { name: /^What should .*(do in|work on)/ })).toBeVisible();
  // A chat exists here (a restored tab, or the box already sent once), so the
  // status and the stream are live; the start screen has neither.
  const status = page.getByTestId("chat-status");
  if (await status.isVisible()) {
    await expect(status).toHaveText("Idle");
    await expect(page.getByTestId("connection")).toHaveText("Connected");
  }
}

export async function send(page: Page, text: string): Promise<void> {
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

/** Send and wait until that turn's answer has finished (not just the "Idle" label). */
export async function sendAndWait(page: Page, text: string): Promise<void> {
  const turns = page.getByTestId("turn");
  const before = await turns.count();
  await send(page, text);
  await expect(turns).toHaveCount(before + 1, { timeout: 15_000 });
  await expect(turns.last().getByTestId("answer")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 20_000 });
}

/**
 * A chat, so its composer exists: New chat shows the start screen (agent and
 * folder chips only), and the model, thinking, permission, stash, and menu
 * controls belong to a chat. One prompt makes one.
 */
export async function openChat(page: Page, harness?: string): Promise<void> {
  await newChat(page, harness);
  await sendAndWait(page, "hello");
}

/** A chat with no model call in it yet: a harness command answers, so its usage panel has no token sections. */
export async function commandChat(page: Page): Promise<void> {
  await newChat(page);
  await send(page, "/fake-status");
  await expect(page.getByTestId("chat-status")).toHaveText("Idle");
}

/**
 * The chat composer's draft, to assert on (`.toBe`, `.toMatch`). Its box is
 * contenteditable (ChipEditor, for the chips in the sentence), which
 * `toHaveValue` does not read, so this polls the `value` the element carries.
 */
export function expectDraft(box: Locator) {
  return expect.poll(() => box.evaluate((el) => (el as unknown as { value: string }).value));
}
