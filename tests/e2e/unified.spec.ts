// The pieces that make the app whole, one test each: the shortcut sheet,
// search across every chat, the file viewer, saved prompts, usage, the split
// view, the checkpoint timeline, and chained follow-ups.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { newChat, openChat, sendAndWait, signInAndOpen, expectDraft } from "./helpers.js";

const box = (page: Page) => page.getByRole("textbox", { name: "Message" });

/**
 * Ctrl+K → "Open a file…" → Enter. The action stays disabled ("Choose a project
 * first") until the chat's workspace has loaded, and under load that can happen
 * after the query is typed, so wait for it instead of racing the app.
 */
async function openFile(page: Page): Promise<void> {
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands and sessions" }).fill("open a file");
  await expect(page.getByRole("option", { name: /^Open a file/ })).not.toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Enter");
}

test("? opens the keyboard shortcuts, which a word narrows, and Escape closes them", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  // In the composer, ? is a character…
  await box(page).fill("why?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeHidden();
  // …outside it, the sheet.
  await page.getByRole("heading", { name: /^What should/ }).click();
  await page.keyboard.press("?");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("region", { name: "Composer" })).toContainText("Stash the draft for later");
  await sheet.getByRole("searchbox", { name: "Filter shortcuts" }).fill("stash");
  await expect(sheet.locator(".keys-row")).toHaveCount(1);
  await expect(sheet.locator(".keys-row .keycap")).toHaveText(["Alt", "S"]);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  // Ctrl+/ works from inside the composer too.
  await box(page).focus();
  await page.keyboard.press("Control+/");
  await expect(sheet).toBeVisible();
});

test("$ lists the harness's skills, which leave the / menu, and Tab puts one in", async ({ page }) => {
  await signInAndOpen(page);
  await openChat(page);
  await box(page).fill("/");
  const commands = page.getByRole("listbox", { name: "Commands" });
  await expect(commands.getByRole("option", { name: /fake-status/ })).toBeVisible();
  await expect(commands.getByRole("option", { name: /skill:review/ })).toHaveCount(0);
  await expect(commands).toContainText("1 skill under $");
  await box(page).fill("$rev");
  const skills = page.getByRole("listbox", { name: "Skills" });
  await expect(skills.getByRole("option")).toHaveText([/\$review\s*Review the work so far/]);
  await page.keyboard.press("Tab");
  await expectDraft(box(page)).toBe("/skill:review ");
  // A $ further in is only a character.
  await box(page).fill("costs $5");
  await expect(page.getByRole("listbox", { name: "Skills" })).toHaveCount(0);
});

test("Search every chat finds what a chat said, and opens it with the word found", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "the quokka migration plan");
  await newChat(page);
  await sendAndWait(page, "nothing to see here");
  // From the sidebar's search: its words, looked for in what the chats said.
  await page.getByRole("searchbox", { name: "Search sessions" }).fill("quokka");
  await page.getByRole("button", { name: /Search every chat for/ }).click();
  const dialog = page.getByRole("dialog", { name: "Search every chat" });
  const found = dialog.getByRole("listbox", { name: "Chats found" }).getByRole("option");
  await expect(found).toHaveCount(1);
  await expect(found.first()).toContainText("the quokka migration plan");
  await expect(found.first().locator("mark").first()).toHaveText("quokka");
  // Every word must be in one message; the harness chips narrow it.
  await dialog.getByRole("searchbox", { name: "Search every chat" }).fill("quokka nothing");
  await expect(dialog.getByRole("status")).toContainText("Nothing found");
  await dialog.getByRole("searchbox", { name: "Search every chat" }).fill("quokka plan");
  await expect(found).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("the quokka migration plan");
  await expect(page.getByRole("searchbox", { name: "Find in chat" })).toHaveValue("quokka");
  await expect(page.getByTestId("find-count")).toContainText(/of [1-9]/);
  // Ctrl+Shift+H opens it anywhere.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Shift+H");
  await expect(dialog).toBeVisible();
});

test("a changed file opens in the viewer, coloured, its added lines marked, and a line goes into the message", async ({ page }) => {
  const project = path.join(process.env.AWUI_E2E_ROOT ?? "", "beta");
  mkdirSync(path.join(project, "src"), { recursive: true });
  writeFileSync(path.join(project, "src", "app.ts"), "// the app\nconst b = 1;\nexport default b;\n");
  await signInAndOpen(page, "beta");
  await newChat(page);
  await sendAndWait(page, "edit please");
  const turn = page.getByTestId("turn").last();
  await turn.getByTestId("changed-files").getByRole("button").first().click();
  await turn.getByTestId("changed-files").getByRole("button", { name: "src/app.ts", exact: true }).click();
  const viewer = page.getByRole("dialog", { name: "File src/app.ts" });
  await expect(viewer).toBeVisible();
  const code = viewer.getByRole("region", { name: "Contents of src/app.ts" });
  await expect(code).toContainText("export default b;");
  await expect(code.locator(".tk-keyword").first()).toHaveText("const");
  await expect(code.locator(".tk-comment")).toHaveText("// the app");
  await expect(viewer).toContainText("Changed in this chat");
  await expect(viewer).toContainText("3 lines");
  // A line's number marks it; Mention puts it into the message.
  await viewer.getByRole("button", { name: "Line 2", exact: true }).click();
  await viewer.getByRole("button", { name: "Mention line 2" }).click();
  await expect(viewer).toBeHidden();
  await expectDraft(box(page)).toBe("@src/app.ts:2");
  // The palette's Open a file: Go to file finds one by name; what git would not list is refused.
  await openFile(page);
  const picker = page.getByRole("dialog", { name: "Open a file" });
  await picker.getByRole("searchbox", { name: "Go to file" }).fill("app");
  await picker.getByRole("listbox", { name: "Files" }).getByRole("option").first().click();
  await expect(page.getByRole("dialog", { name: "File src/app.ts" })).toBeVisible();
});

test("a saved prompt goes in with # and its blanks are filled in with Tab; any device sees it", async ({ page, browser }) => {
  await signInAndOpen(page);
  await openChat(page);
  // Saved from a draft, through the stash menu.
  await box(page).fill("Review {{file}} for {{risk}}");
  await page.getByRole("button", { name: /^Stash/ }).click();
  await page.getByRole("menuitem", { name: "Save the draft as a prompt…" }).click();
  const manager = page.getByRole("dialog", { name: "Saved prompts" });
  await expect(manager.getByRole("textbox", { name: "Prompt" })).toHaveValue("Review {{file}} for {{risk}}");
  await expect(manager.locator(".blank-chip")).toHaveText(["file", "risk"]);
  await manager.getByRole("textbox", { name: "Name" }).fill("risky");
  await manager.getByRole("button", { name: "Save prompt" }).click();
  await expect(manager.getByRole("list", { name: "Your saved prompts" })).toContainText("#risky");
  await page.keyboard.press("Escape");
  await expect(manager).toBeHidden();
  // # puts it in, the first blank selected: typing fills it, Tab goes to the next.
  await box(page).fill("#ris");
  await expect(page.getByRole("listbox", { name: "Saved prompts" }).getByRole("option")).toHaveText([/#risky\s*Review ‹file› for ‹risk›/]);
  await page.keyboard.press("Enter");
  await expectDraft(box(page)).toBe("Review {{file}} for {{risk}}");
  await page.keyboard.type("app.ts");
  await page.keyboard.press("Tab");
  await page.keyboard.type("races");
  await expectDraft(box(page)).toBe("Review app.ts for races");
  // Another browser (another device) has it too.
  const other = await browser.newPage();
  await signInAndOpen(other);
  await openChat(other);
  await other.getByRole("textbox", { name: "Message" }).fill("#");
  await expect(other.getByRole("listbox", { name: "Saved prompts" })).toContainText("#risky");
  await other.close();
});

test("Usage shows the plan limits, then adds up the calls by day, harness, and model, and opens a chat that used much", async ({ page }) => {
  // The fake harnesses report no plan limits: these stand in, xAI's two limits on one window among them.
  const week = Date.now() + 3 * 86_400_000;
  await page.route("**/api/limits", (route) =>
    route.fulfill({
      json: {
        accounts: [
          { id: "claude", source: "Claude Code", provider: "Anthropic", plan: "pro", limited: false, at: Date.now(), windows: [{ label: "5 hours", used: 0.41, resetsAt: week }, { label: "7 days", used: 0.86, resetsAt: week }] },
          { id: "omp:xai-oauth:0", source: "omp", provider: "xai-oauth", limited: false, at: Date.now(), windows: [{ label: "SuperGrok Weekly Credits", used: 0.34, resetsAt: week }, { label: "GrokChat (Weekly)", used: 0.34, resetsAt: week }] },
        ],
        errors: [],
      },
    }),
  );
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "spend some tokens on the usage report");
  // One row in the sidebar: Usage, with the fullest limit.
  const row = page.getByRole("button", { name: /^Usage/ });
  await expect(row).toContainText("Claude 7 days · 86%");
  await row.click();
  const usage = page.getByRole("dialog", { name: "Usage" });
  const limits = usage.getByRole("region", { name: "Plan limits" });
  await expect(limits.locator(".limits-account")).toHaveCount(2);
  await expect(limits.getByRole("meter")).toHaveCount(4);
  await expect(limits.locator(".limits-account").nth(1)).toContainText("SuperGrok Weekly Credits");
  await expect(limits.locator(".limits-account").nth(1)).toContainText("GrokChat (Weekly)");
  await expect(usage.locator(".usage-card").first()).toContainText(/Tokens\s*[\d.]+k?/);
  await expect(usage.getByRole("region", { name: "Tokens by day" }).locator(".usage-day")).toHaveCount(30);
  await usage.getByRole("button", { name: "7 days" }).click();
  await expect(usage.getByRole("region", { name: "Tokens by day" }).locator(".usage-day")).toHaveCount(7);
  await expect(usage.getByRole("region", { name: "By harness" })).toContainText("Fake");
  await expect(usage.getByRole("region", { name: "By model" })).toContainText("echo");
  await expect(usage.locator(".usage-card", { hasText: "Cost" })).toContainText("$");
  // The chat that used the most (whichever it is, with the other tests' chats about) opens on a click.
  const top = usage.getByRole("region", { name: "Chats that used the most" }).getByRole("button").first();
  const title = (await top.locator(".usage-chat-title").textContent()) ?? "";
  await top.click();
  await expect(usage).toBeHidden();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
});


test("a chat opens beside the main one, streams and takes messages there, and swaps with Make main", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "the left one");
  await newChat(page);
  await sendAndWait(page, "the right one");
  await page.getByRole("button", { name: "Open a chat beside", exact: true }).click();
  const side = page.getByRole("region", { name: "Chat beside" });
  // The shown chat cannot open beside itself.
  await expect(side.getByRole("button", { name: /the right one/ })).toBeDisabled();
  await side.getByRole("button", { name: /the left one/ }).click();
  await expect(side.getByRole("heading", { level: 2 })).toHaveText("the left one");
  await side.getByRole("textbox", { name: "Message" }).fill("slow reply beside");
  await side.getByRole("button", { name: "Send", exact: true }).click();
  await expect(side.getByTestId("side-status")).toHaveText("Working");
  await expect(side.getByTestId("turn")).toHaveCount(2);
  await expect(side.getByTestId("side-status")).toHaveText("Idle", { timeout: 20_000 });
  await side.getByRole("textbox", { name: "Message" }).fill("draft stays with its chat while swapping");
  const separator = page.getByRole("separator", { name: "Resize chat panes", exact: true });
  await separator.focus();
  const widthBefore = (await page.locator('[data-pane="main"]').boundingBox())?.width ?? 0;
  await separator.press("ArrowRight");
  await expect.poll(async () => (await page.locator('[data-pane="main"]').boundingBox())?.width ?? 0).toBeGreaterThan(widthBefore + 10);
  await separator.press("Enter");
  // The main chat did not move, and its URL still names it.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("the right one");
  const hash = await page.evaluate(() => location.hash);
  await side.getByRole("button", { name: "Make main" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("the left one");
  await expect(side.getByRole("heading", { level: 2 })).toHaveText("the right one");
  await expectDraft(page.locator('[data-pane="main"]').getByRole("textbox", { name: "Message" })).toBe("draft stays with its chat while swapping");
  // A real server-issued paste and its original native chat id travel together,
  // not through a text-only mock. Remove is explicitly draft-only, not a route echo.
  const origin = await page.evaluate(() => location.hash.slice(6));
  await page.locator('[data-pane="main"]').getByRole("textbox", { name: "Message" }).click();
  await page.locator('[data-pane="main"]').getByRole("textbox", { name: "Message" }).evaluate((el) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "with real pasted file\n".repeat(800));
    (el as HTMLElement).dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  await page.getByRole("group", { name: "Large paste" }).getByRole("button", { name: "Attach as file" }).click();
  await page.locator('[data-pane="main"]').getByRole("button", { name: "Remove paste #1" }).waitFor();
  await side.getByRole("button", { name: "Make main", exact: true }).click();
  await expect(side.getByRole("button", { name: "Remove paste #1" })).toBeVisible();
  const removedPath = await side.locator(".paste-label").getAttribute("title");
  expect(removedPath).toMatch(new RegExp(`/awui-pastes/${origin}/.+\\.txt$`));
  expect(existsSync(removedPath!)).toBe(true);
  await side.getByRole("button", { name: "Remove paste #1" }).click();
  await expect(side.getByRole("button", { name: "Remove paste #1" })).toHaveCount(0);
  expect(existsSync(removedPath!)).toBe(false);
  // The second Make main restores the original main chat identity, never a second writer.
  expect(await page.evaluate(() => location.hash)).toBe(hash);
  await side.getByRole("button", { name: "Close the chat beside" }).click();
  await expect(side).toHaveCount(0);
});

test("the file timeline compares any two points of a chat's checkpoints, and offers to undo to one", async ({ page }) => {
  const project = path.join(process.env.AWUI_E2E_ROOT ?? "", "timeline-repo");
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, "app.ts"), "const a = 1;\n");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project });
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "init");
  await signInAndOpen(page, "timeline-repo");
  await newChat(page);
  await sendAndWait(page, "first step");
  writeFileSync(path.join(project, "app.ts"), "const a = 2;\nconst b = 3;\n");
  await sendAndWait(page, "second step");
  writeFileSync(path.join(project, "notes.md"), "# notes\n");
  await page.getByRole("button", { name: "Chat actions" }).click();
  await page.getByRole("menuitem", { name: "File timeline" }).click();
  const timeline = page.getByRole("dialog", { name: "File timeline" });
  const rail = timeline.getByRole("navigation", { name: "Points" });
  await expect(rail.getByRole("button")).toHaveText(["#1", "#2", "Now"]);
  // At first: from before the first prompt to now, every file the chat saw change.
  await expect(timeline.getByTestId("timeline-file")).toHaveCount(2);
  await expect(timeline.getByTestId("timeline-file").first()).toContainText("app.ts");
  await expect(timeline.getByTestId("timeline-file").first()).toContainText("const b = 3;");
  await rail.getByRole("button", { name: /Before prompt 2/ }).click();
  await expect(timeline.getByTestId("timeline-file")).toHaveCount(1);
  await expect(timeline.getByTestId("timeline-file")).toContainText("notes.md");
  await expect(timeline.getByTestId("timeline-file")).toContainText("added");
  await timeline.getByRole("button", { name: "Undo to before #2…" }).click();
  await expect(timeline).toBeHidden();
  await expect(page.getByRole("dialog").filter({ hasText: "notes.md" })).toBeVisible();
});

test("Undo restores files only after a held press; a tap does nothing", async ({ page }) => {
  const project = path.join(process.env.AWUI_E2E_ROOT ?? "", "hold-repo");
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, "app.ts"), "const a = 1;\n");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project });
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "init");
  await signInAndOpen(page, "hold-repo");
  await newChat(page);
  await sendAndWait(page, "first turn");
  await sendAndWait(page, "second turn");
  // Change the file only after both prompts, so undoing to before #2 must put it back.
  writeFileSync(path.join(project, "app.ts"), "const a = 2;\n");
  await page.getByRole("button", { name: "Chat actions" }).click();
  await page.getByRole("menuitem", { name: "File timeline" }).click();
  const timeline = page.getByRole("dialog", { name: "File timeline" });
  await expect(timeline).toBeVisible();
  await timeline.getByRole("navigation", { name: "Points" }).getByRole("button", { name: /Before prompt 2/ }).click();
  await timeline.getByRole("button", { name: "Undo to before #2…" }).click();
  const restore = page.getByRole("dialog", { name: "Undo file changes" });
  await expect(restore).toBeVisible();
  await expect(restore.getByRole("list", { name: "Files" })).toContainText("app.ts");
  const hold = restore.getByRole("button", { name: /Undo 1 file/ });

  // A quick press lets go too early: nothing restored yet.
  const boxB = (await hold.boundingBox())!;
  await page.mouse.move(boxB.x + boxB.width / 2, boxB.y + boxB.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(200);
  await page.mouse.up();
  expect(readFileSync(path.join(project, "app.ts"), "utf8")).toBe("const a = 2;\n");

  // A held press fires: 700ms covers the 600ms fill.
  await page.mouse.down();
  await page.waitForTimeout(750);
  await page.mouse.up();
  await expect(page.getByRole("status").filter({ hasText: "Undid changes" })).toBeVisible({ timeout: 10_000 });
  expect(readFileSync(path.join(project, "app.ts"), "utf8")).toBe("const a = 1;\n");
});

test("Then queues a message on the server for after the run, and a stop pauses the chain until Resume", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await box(page).fill("slow first, for the chain");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("Working");
  await box(page).fill("the second, by itself");
  await page.getByRole("button", { name: "Then", exact: true }).click();
  await expectDraft(box(page)).toBe("");
  const chain = page.getByTestId("chain");
  await expect(chain.getByTestId("chain-row")).toHaveText([/Then\s*the second, by itself/]);
  // With the page reloaded mid-run, the server still holds it, and runs it once the run is over.
  await page.reload();
  await expect(page.getByTestId("turn")).toHaveCount(2, { timeout: 20_000 });
  await expect(page.getByTestId("turn").last()).toContainText("the second, by itself");
  await expect(page.getByTestId("chain")).toHaveCount(0);
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 20_000 });
  // A stop pauses what is left.
  await box(page).fill("slow again");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("Working");
  await box(page).fill("not yet");
  await page.keyboard.press("Control+Shift+Enter");
  await expect(page.getByTestId("chain-row")).toHaveCount(1);
  await page.getByRole("button", { name: "Stop the agent" }).click();
  await expect(page.getByTestId("chain")).toContainText("Paused: Stopped");
  await page.getByTestId("chain").getByRole("button", { name: "Resume" }).click();
  await expect(page.getByTestId("turn").last()).toContainText("not yet", { timeout: 20_000 });
});

test("a Markdown file opens as source, then as the page it describes", async ({ page, request }) => {
  const root = process.env.AWUI_E2E_ROOT as string;
  const ws = (await (await request.post("/api/workspaces/open", { data: { path: `${root}/gamma` } })).json()) as { id: string };
  const chat = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: ws.id } })).json()) as { chatId: string };
  await page.goto(`/#chat=${chat.chatId}`);

  await openFile(page);
  const picker = page.getByRole("dialog", { name: "Open a file" });
  await picker.getByRole("searchbox", { name: "Go to file" }).fill("notes");
  await picker.getByRole("listbox", { name: "Files" }).getByRole("option").first().click();
  const viewer = page.getByRole("dialog", { name: "File notes.md" });
  await expect(viewer).toBeVisible();
  // Source first: the Markdown is text.
  await expect(viewer).toContainText("**bold**");
  await viewer.getByRole("button", { name: "Preview" }).click();
  await expect(viewer.getByRole("heading", { name: "Notes", exact: true })).toBeVisible();
  await expect(viewer.locator("strong")).toHaveText("bold");
  await viewer.getByRole("button", { name: "Code" }).click();
  await expect(viewer.getByRole("heading", { name: "Notes", exact: true })).toHaveCount(0);
  await expect(viewer).toContainText("**bold**");
});

test("an HTML file previews with its scripts switched off", async ({ page, request }) => {
  const root = process.env.AWUI_E2E_ROOT as string;
  const ws = (await (await request.post("/api/workspaces/open", { data: { path: `${root}/gamma` } })).json()) as { id: string };
  const chat = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: ws.id } })).json()) as { chatId: string };
  await page.goto(`/#chat=${chat.chatId}`);
  await openFile(page);
  const picker = page.getByRole("dialog", { name: "Open a file" });
  await picker.getByRole("searchbox", { name: "Go to file" }).fill("page");
  await picker.getByRole("listbox", { name: "Files" }).getByRole("option").first().click();
  const viewer = page.getByRole("dialog", { name: "File page.html" });
  await viewer.getByRole("button", { name: "Preview" }).click();
  const frame = viewer.frameLocator("iframe");
  await expect(frame.getByRole("heading", { name: "Preview" })).toBeVisible();
  // sandbox="" has no allow-scripts: the page's own script never runs.
  await expect(frame.locator("body")).not.toHaveAttribute("data-ran", "1");
});

test("an image file shows as the picture it is", async ({ page, request }) => {
  const root = process.env.AWUI_E2E_ROOT as string;
  const ws = (await (await request.post("/api/workspaces/open", { data: { path: `${root}/gamma` } })).json()) as { id: string };
  const chat = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: ws.id } })).json()) as { chatId: string };
  await page.goto(`/#chat=${chat.chatId}`);
  await openFile(page);
  const picker = page.getByRole("dialog", { name: "Open a file" });
  await picker.getByRole("searchbox", { name: "Go to file" }).fill("pic");
  await picker.getByRole("listbox", { name: "Files" }).getByRole("option").first().click();
  const img = page.getByRole("dialog", { name: "File pic.png" }).getByRole("img", { name: "pic.png" });
  await expect(img).toBeVisible();
  // It came through the confined media route and decoded, not a broken link.
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
});

test("a file dropped on the viewer is added to the project and opens", async ({ page, request }) => {
  const root = process.env.AWUI_E2E_ROOT as string;
  const ws = (await (await request.post("/api/workspaces/open", { data: { path: `${root}/gamma` } })).json()) as { id: string };
  const chat = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: ws.id } })).json()) as { chatId: string };
  await page.goto(`/#chat=${chat.chatId}`);
  await openFile(page);
  await expect(page.getByRole("dialog", { name: "Open a file" })).toBeVisible();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["dropped\n"], "dropped.txt", { type: "text/plain" }));
    const dialog = document.querySelector("dialog.viewer") as HTMLElement;
    for (const type of ["dragover", "drop"]) dialog.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  const viewer = page.getByRole("dialog", { name: "File dropped.txt" });
  await expect(viewer).toBeVisible();
  await expect(viewer).toContainText("dropped");
});

test("a saved prompt asks in place before it is deleted; Escape backs out", async ({ page }) => {
  await signInAndOpen(page);
  await openChat(page);
  await box(page).fill("Delete-test prompt {{x}}");
  await page.getByRole("button", { name: /^Stash/ }).click();
  await page.getByRole("menuitem", { name: "Save the draft as a prompt…" }).click();
  const manager = page.getByRole("dialog", { name: "Saved prompts" });
  await manager.getByRole("textbox", { name: "Name" }).fill("delme");
  await manager.getByRole("button", { name: "Save prompt" }).click();
  await expect(manager.getByRole("list", { name: "Your saved prompts" })).toContainText("#delme");

  // Clicking Delete doesn't: the button itself asks "Sure? ✓ ✕".
  await manager.getByRole("button", { name: /Delete the prompt/ }).click();
  const yes = manager.getByRole("button", { name: /Confirm: Delete the prompt/ });
  await expect(manager.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(yes).toBeFocused();

  // Escape backs out, leaving the prompt alone.
  await page.keyboard.press("Escape");
  await expect(manager.getByRole("button", { name: /Delete the prompt/ })).toBeFocused();
  await expect(manager.getByRole("list", { name: "Your saved prompts" })).toContainText("#delme");

  // And the ✓ actually deletes.
  await manager.getByRole("button", { name: /Delete the prompt/ }).click();
  await yes.click();
  // Saved prompts are the server's, shared with the other tests: only this one must be gone.
  await expect(manager.getByRole("list", { name: "Your saved prompts" })).not.toContainText("#delme");
  await page.keyboard.press("Escape");
});
