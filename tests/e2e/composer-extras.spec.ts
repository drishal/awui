// Features borrowed from T3 Code, one test each: in the composer, the
// conversation, the sidebar, and the page title.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { commandChat, newChat, openChat, send, sendAndWait, showSidebar, signInAndOpen, expectDraft } from "./helpers.js";

const box = (page: Page) => page.getByRole("textbox", { name: "Message" });

test("↑ and ↓ walk this chat's prompts", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "first recall");
  await sendAndWait(page, "second recall");
  await box(page).focus();
  await page.keyboard.press("ArrowUp");
  await expectDraft(box(page)).toBe("second recall");
  await page.keyboard.press("ArrowUp");
  await expectDraft(box(page)).toBe("first recall");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expectDraft(box(page)).toBe("");
});

test("a long draft shows its estimated size beside the context ring, and the panel says what sending does to the context", async ({ page }) => {
  await signInAndOpen(page);
  await commandChat(page);
  const figure = page.getByTestId("draft-size");
  // Nothing for an empty or a short draft.
  await expect(figure).toHaveCount(0);
  await box(page).fill("a short note");
  await expect(figure).toHaveCount(0);
  // 2,000 characters of prose is about 500 tokens.
  await box(page).fill("word ".repeat(400));
  await expect(figure).toHaveText(/^~\d+(\.\d+)?[kM]? tokens$/);
  await expect(figure).toHaveText(/^~(4[5-9]\d|5\d\d) tokens$/);
  await page.getByTestId("context-ring").click();
  const panel = page.getByRole("dialog", { name: "Context and usage" });
  await expect(panel.getByTestId("draft-row")).toHaveText(/^This message ≈ \d+ tokens → context \d+% → \d+%$/);
  await page.keyboard.press("Escape");
  // Clearing the box takes it away again.
  await box(page).fill("");
  await expect(figure).toHaveCount(0);
});

test("references and quotes show as chips in the sentence, and go as the same text", async ({ page }) => {
  await signInAndOpen(page);
  await openChat(page);
  const draft = "In @src/web/find.ts at @src/web/find.ts:44-58 the comment says\n\n> a fold opens when a match lands\n\n— make it do that.";
  await box(page).fill(draft);
  const chips = box(page).locator(".draft-chip");
  await expect(chips).toHaveCount(3);
  await expect(chips.nth(0)).toHaveText("src/web/find.ts");
  // A range of the file just named says only its lines.
  await expect(chips.nth(1)).toHaveText("44–58");
  await expect(chips.nth(2)).toHaveText("“a fold opens when a match lands”");
  await expectDraft(box(page)).toBe(draft);
  // A reference stays text while it is typed, and becomes a chip once something follows it.
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" Then @src/app.ts");
  await expect(chips).toHaveCount(3);
  await page.keyboard.type(" too");
  await expect(chips).toHaveCount(4);
  // Backspace after a chip takes it out whole; its × does the same.
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Backspace");
  await expect(chips).toHaveCount(3);
  await box(page).getByRole("button", { name: "Remove the quote" }).click();
  await expect(chips).toHaveCount(2);
  await expectDraft(box(page)).toBe("In @src/web/find.ts at @src/web/find.ts:44-58 the comment says — make it do that. Then too");
  // What goes is the text, as before the chips.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("user-prompt").last()).toHaveText("In @src/web/find.ts at @src/web/find.ts:44-58 the comment says — make it do that. Then too");
  await expectDraft(box(page)).toBe("");
});

test("Shift+Enter continues a list, Tab indents it, and an empty item ends it", async ({ page }) => {
  await signInAndOpen(page);
  await openChat(page);
  await box(page).pressSequentially("1. one");
  await page.keyboard.press("Shift+Enter");
  await expectDraft(box(page)).toBe("1. one\n2. ");
  await page.keyboard.press("Tab");
  await expectDraft(box(page)).toBe("1. one\n  2. ");
  await page.keyboard.press("Shift+Enter");
  await expectDraft(box(page)).toBe("1. one\n");
});

test("the stash parks a draft and gives it back in another chat", async ({ page }) => {
  await signInAndOpen(page);
  await openChat(page);
  await box(page).fill("park this for later");
  await page.keyboard.press("Alt+KeyS");
  await expectDraft(box(page)).toBe("");
  const stash = page.getByRole("button", { name: /^Stash \(\d+ kept\)$/ });
  await expect(stash).toBeVisible();
  // With nothing to stash, the menu still closes on Escape.
  await stash.click();
  await expect(page.getByRole("menu", { name: "Stash" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Stash" })).toBeHidden();
  await openChat(page);
  await page.getByRole("button", { name: /^Stash/ }).click();
  await page.getByRole("menuitem", { name: /park this for later/ }).click();
  await expectDraft(box(page)).toBe("park this for later");
});

test("Ctrl+F finds in the chat, opening the fold a match is in, and steps through matches", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "read a tool, walrus");
  await sendAndWait(page, "and walrus again");
  await page.locator(".chat-header h1").click();
  await page.keyboard.press("Control+KeyF");
  const find = page.getByRole("searchbox", { name: "Find in chat" });
  await expect(find).toBeFocused();
  await find.fill("WALRUS");
  // Each prompt and each answer echoing it, and, in the folds the query opened, each thought quoting it.
  await expect(page.getByTestId("find-count")).toHaveText("1 of 6");
  await find.press("Enter");
  await expect(page.getByTestId("find-count")).toHaveText("2 of 6");
  await find.press("Shift+Enter");
  await find.press("Shift+Enter");
  await expect(page.getByTestId("find-count")).toHaveText("6 of 6");
  // README.md is the tool's path, inside the first turn's closed fold.
  await find.fill("README");
  await expect(page.getByTestId("find-count")).toHaveText("1 of 1");
  await expect(page.getByText("README.md").first()).toBeVisible();
  await find.press("Escape");
  await expect(find).toBeHidden();
});

test("a proposed plan shows as a card whose Implement sends it on", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "planned work please");
  const card = page.getByTestId("plan-card");
  await expect(card).toContainText("Split the handler");
  await card.getByRole("button", { name: "Show the whole plan" }).click();
  await expect(card).toContainText("Tell the user");
  await card.getByRole("button", { name: "Implement" }).click();
  await expect(page.getByTestId("user-prompt").last()).toHaveText("Implement the plan.");
});

test("a run stopped on a usage limit says when it resets and can continue", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "ratelimit me");
  const banner = page.getByTestId("limit-recovery");
  await expect(banner).toContainText("Usage limit reached");
  await expect(banner).toContainText("resets");
  await banner.getByRole("button", { name: "Continue when it resets" }).click();
  // The appointment is the server's: it survives a reload, with no local state.
  await expect(banner).toContainText("no tab has to stay open");
  await page.reload();
  const again = page.getByTestId("limit-recovery");
  await expect(again).toContainText("no tab has to stay open");
  await again.getByRole("button", { name: "Cancel" }).click();
  await expect(again).toContainText("resets");
  await again.getByRole("button", { name: "Continue now" }).click();
  await expect(page.getByTestId("user-prompt").last()).toHaveText("Continue from where you stopped.");
  await expect(banner).toBeHidden();
});

test("a queued follow-up can be edited or removed before it runs", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "slow stream for the queue");
  await expect(page.getByTestId("chat-status")).toHaveText("Working");
  await box(page).fill("queued one");
  await page.getByRole("button", { name: "Follow-up" }).click();
  await box(page).fill("queued two");
  await page.getByRole("button", { name: "Follow-up" }).click();
  const rows = page.getByTestId("queue-row");
  await expect(rows).toHaveCount(2);
  await rows.first().hover();
  await rows.first().getByRole("button", { name: "Edit the queued follow-up" }).click();
  const edit = rows.first().getByRole("textbox", { name: "Edit the queued follow-up" });
  await edit.fill("queued one, edited");
  await edit.press("Enter");
  await expect(rows.first()).toContainText("queued one, edited");
  await rows.last().hover();
  await rows.last().getByRole("button", { name: "Remove the queued follow-up" }).click();
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId("user-prompt").last()).toHaveText("queued one, edited", { timeout: 20_000 });
});

test("search in project finds a line and puts it into the message as @path:line", async ({ page }) => {
  await signInAndOpen(page);
  await openChat(page);
  const root = await page.locator(".chat-path").getAttribute("title");
  expect(root).toBeTruthy();
  writeFileSync(path.join(root as string, "search-me.txt"), "nothing\nthe zebra-quartz line\n");
  await page.keyboard.press("Control+Shift+KeyF");
  const dialog = page.getByRole("dialog", { name: "Search in project" });
  await dialog.getByRole("searchbox", { name: "Search the project's files" }).fill("zebra-quartz");
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await expect(dialog.getByRole("option")).toContainText("the zebra-quartz line");
  await dialog.getByRole("searchbox").press("Enter");
  await expect(dialog).toBeHidden();
  await expectDraft(box(page)).toBe("@search-me.txt:2");
  // One Escape closes it, even with a query typed.
  await page.keyboard.press("Control+Shift+KeyF");
  await dialog.getByRole("searchbox").fill("zebra");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("resting on a session row shows its hover card", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  // Long enough that the card's prompt excerpt clamps.
  await sendAndWait(page, "hover card prompt " + "many more words to wrap ".repeat(12));
  await newChat(page);
  await showSidebar(page);
  await page.locator(".session", { hasText: "hover card prompt" }).first().hover();
  const card = page.getByRole("tooltip");
  await expect(card).toContainText("hover card prompt");
  await expect(card).toContainText("1 turn");
  // The clamp sits on a box with no padding: a clamp clips at the content box, so with
  // padding on the same element the next line's top shows in the bottom padding (Gecko
  // painted that half line under the bubble until the two were split).
  const clamp = await card.locator(".session-card-clamp").evaluate((el) => {
    const cs = getComputedStyle(el);
    return { padding: `${cs.paddingTop} ${cs.paddingBottom}`, height: el.getBoundingClientRect().height, line: Number.parseFloat(cs.lineHeight), max: cs.maxHeight };
  });
  expect(clamp.padding).toBe("0px 0px");
  expect(clamp.height).toBeLessThanOrEqual(3 * clamp.line + 0.5);
  expect(clamp.max).toBe("54px");
  await page.mouse.move(800, 400);
  await expect(card).toBeHidden();
});

test("a prompt link fills the start screen's box, hidden characters taken out", async ({ page }) => {
  await signInAndOpen(page);
  await page.goto(`/?prompt=${encodeURIComponent("look at the logs​ please")}`);
  await expect(page.getByRole("heading", { name: /^What should .* do in / })).toBeVisible();
  await expectDraft(box(page)).toBe("look at the logs please");
  await expect(page.getByText("From a link: read it before you send it. 1 hidden character was taken out.")).toBeVisible();
  await expect(page).not.toHaveURL(/prompt=/);
  // Nothing spawns until the user sends.
  await expect(page.getByTestId("user-prompt")).toHaveCount(0);
  await box(page).press("Enter");
  await expect(page.getByTestId("user-prompt")).toHaveText(["look at the logs please"]);
});

test("the page title and favicon count a chat that finished out of sight", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "slow please for the title");
  await page.getByRole("button", { name: "New chat in a new tab" }).click();
  await expect(page).toHaveTitle(/^\(1\) /, { timeout: 20_000 });
  await expect.poll(() => page.locator('link[rel="icon"]').first().getAttribute("href")).toMatch(/^data:image\/png/);
  await page.getByRole("tablist", { name: "Open tabs" }).getByRole("tab", { name: /slow please for the title/ }).click();
  await expect(page).not.toHaveTitle(/^\(\d+\) /);
});

test("the prompt box can be dragged taller, and a reload keeps it", async ({ page }) => {
  await signInAndOpen(page);
  // A real chat: the start screen's composer has no card to resize yet.
  await openChat(page);
  await page.getByRole("textbox", { name: "Message" }).fill("");
  const box = page.getByRole("textbox", { name: "Message" });
  const height = async () => ((await box.boundingBox()) as { height: number }).height;
  const before = await height();
  const handle = page.getByRole("separator", { name: "Resize the prompt box" });
  const grip = (await handle.boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y - 90, { steps: 6 });
  await page.mouse.up();
  await expect.poll(height).toBeGreaterThan(before + 50);
  const tall = await height();
  await page.reload();
  // The box comes back with the restored chat, which can take a moment under load.
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => (await page.getByRole("textbox", { name: "Message" }).boundingBox())?.height ?? 0, { timeout: 20_000 })
    .toBeGreaterThan(tall - 6);
});

test("a chat's harness can be restarted without losing the conversation", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "restart me");
  const before = await page.evaluate(() => location.hash);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands and sessions" }).fill("restart agent");
  await page.keyboard.press("Enter");
  // The restart replaces the chat: its URL names the new one, and the old chat is
  // "Idle" too, so wait for the id rather than for the status.
  await expect.poll(() => page.evaluate(() => location.hash), { timeout: 20_000 }).not.toBe(before);
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 20_000 });
  await expect(page.getByTestId("user-prompt").last()).toHaveText("restart me");
  await sendAndWait(page, "after the restart");
});

test("Ctrl+Z and Ctrl+Shift+Z undo and redo the draft, across Enter, a paste, and a chip's removal", async ({ page }) => {
  await signInAndOpen(page);
  await openChat(page);
  await box(page).focus();
  await page.keyboard.type("one two");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("three");
  await expectDraft(box(page)).toBe("one two\nthree");
  await page.keyboard.press("Control+z");
  await expectDraft(box(page)).toBe("one two\n");
  await page.keyboard.press("Control+z");
  await expectDraft(box(page)).toBe("one two");
  await page.keyboard.press("Control+Shift+Z");
  await expectDraft(box(page)).toBe("one two\n");
  await page.keyboard.press("Control+y");
  await expectDraft(box(page)).toBe("one two\nthree");

  // A paste is one step.
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/plain", " pasted text");
    document.querySelector('[role="textbox"]')?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expectDraft(box(page)).toBe("one two\nthree pasted text");
  await page.keyboard.press("Control+z");
  await expectDraft(box(page)).toBe("one two\nthree");
});

test("Ctrl+Z brings back a chip taken out with Backspace", async ({ page }) => {
  await signInAndOpen(page);
  await openChat(page);
  const draft = "see @src/web/find.ts here";
  await box(page).fill(draft);
  const chips = box(page).locator(".draft-chip");
  await expect(chips).toHaveCount(1);
  await box(page).focus();
  await page.keyboard.press("Control+End");
  // " here" is five steps back; the caret then sits just after the chip.
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Backspace");
  await expect(chips).toHaveCount(0);
  await expectDraft(box(page)).toBe("see here");
  await page.keyboard.press("Control+z");
  await expect(chips).toHaveCount(1);
  await expectDraft(box(page)).toBe(draft);
  await page.keyboard.press("Control+Shift+Z");
  await expect(chips).toHaveCount(0);
  await expectDraft(box(page)).toBe("see here");
});

/** Paste `text` into the composer's box the way the browser does: one plain-text clipboard event. */
async function pasteText(page: Page, text: string) {
  await page.evaluate((t) => {
    const data = new DataTransfer();
    data.setData("text/plain", t);
    document.querySelector('[role="textbox"]')?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

test("a long paste is one chip, goes as the full text, and Backspace and Ctrl+Z take it out and back", async ({ page }) => {
  await signInAndOpen(page);
  await openChat(page);
  const rows = Array.from({ length: 30 }, (_, i) => `row ${i + 1}`).join("\n");
  await box(page).focus();
  await pasteText(page, rows);
  const chip = box(page).locator(".draft-chip", { hasText: "Pasted 30 lines" });
  await expect(chip).toHaveCount(1);
  // The text is all still in the draft; the chip is only how it is drawn.
  await expectDraft(box(page)).toBe(rows);
  await expect(box(page)).not.toContainText("row 15");

  // Backspace beside it removes the whole paste, and Ctrl+Z puts it back as a chip.
  await page.keyboard.press("Backspace");
  await expect(chip).toHaveCount(0);
  await expectDraft(box(page)).toBe("");
  await page.keyboard.press("Control+z");
  await expect(chip).toHaveCount(1);
  await expectDraft(box(page)).toBe(rows);
  await page.keyboard.press("Control+Shift+Z");
  await expect(chip).toHaveCount(0);
  await expectDraft(box(page)).toBe("");
  await page.keyboard.press("Control+z");
  await expect(chip).toHaveCount(1);

  // Sent, it reaches the agent whole: the fake harness echoes what it received.
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("answer").last()).toContainText("row 30", { timeout: 20_000 });
  await expect(page.getByTestId("answer").last()).toContainText("row 15");
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 20_000 });
  await expect(chip).toHaveCount(0);
  await expectDraft(box(page)).toBe("");
});

test("clicking a paste chip, or Enter on its label, turns it back into plain text; a short paste stays text", async ({ page }) => {
  await signInAndOpen(page);
  await openChat(page);
  const rows = Array.from({ length: 12 }, (_, i) => `row ${i + 1}`).join("\n");
  await box(page).focus();
  await pasteText(page, "a few\nshort\nlines");
  await expect(box(page).locator(".draft-chip")).toHaveCount(0);
  await expectDraft(box(page)).toBe("a few\nshort\nlines");
  await box(page).fill("");
  await page.keyboard.type("see ");
  await pasteText(page, rows);
  const chip = box(page).locator(".draft-chip", { hasText: "Pasted 12 lines" });
  await expect(chip).toHaveCount(1);
  // Typing after it leaves it one chip.
  await page.keyboard.type("more ");
  await expect(chip).toHaveCount(1);
  await expectDraft(box(page)).toBe(`see ${rows}more `);
  await chip.click();
  await expect(box(page).locator(".draft-chip")).toHaveCount(0);
  await expectDraft(box(page)).toBe(`see ${rows}more `);
  await expect(box(page)).toContainText("row 7");

  // The same from the keyboard: the chip's label takes focus, Enter.
  await box(page).fill("");
  await pasteText(page, rows);
  await expect(chip).toHaveCount(1);
  await chip.getByRole("button", { name: "Pasted 12 lines: show the text" }).focus();
  await page.keyboard.press("Enter");
  await expect(box(page).locator(".draft-chip")).toHaveCount(0);
  await expectDraft(box(page)).toBe(rows);
});

/** Dragover (and, unless `over` only, the drop) of files on the composer card, as a browser sends them. */
async function dropFiles(page: Page, files: Array<{ name: string; type: string; text?: string; bytes?: number }>, only?: "over" | "leave") {
  await page.evaluate(
    ({ files, only }) => {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(new File([f.bytes ? new Uint8Array(f.bytes) : (f.text ?? "x\n")], f.name, { type: f.type }));
      const card = document.querySelector(".composer-card") as HTMLElement;
      const fire = (type: string) => card.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
      fire("dragover");
      if (only === "leave") fire("dragleave");
      else if (only !== "over") fire("drop");
    },
    { files, only },
  );
}

test("a dropped file that is not an image becomes an @path when the project has it, and is added when it does not", async ({ page }) => {
  const project = path.join(process.env.AWUI_E2E_ROOT ?? "", "drop-files");
  mkdirSync(path.join(project, "web"), { recursive: true });
  mkdirSync(path.join(project, "server"), { recursive: true });
  writeFileSync(path.join(project, "plan.md"), "# plan\n");
  writeFileSync(path.join(project, "web", "find.ts"), "export {};\n");
  writeFileSync(path.join(project, "server", "find.ts"), "export {};\n");
  // A dot-file is on disk but not in the project's list (the @ list skips them), so adding it meets a 409.
  writeFileSync(path.join(project, ".local.txt"), "mine\n");
  await signInAndOpen(page, "drop-files");
  await openChat(page);
  const card = page.locator(".composer-card");

  // The card says what a drop does: images attach, other files are referenced.
  await dropFiles(page, [{ name: "shot.png", type: "image/png" }], "over");
  await expect(card.getByText("Drop images to attach", { exact: true })).toBeVisible();
  await dropFiles(page, [{ name: "shot.png", type: "image/png" }, { name: "plan.md", type: "text/markdown" }], "leave");
  await expect(card.getByText("Drop images to attach, or files to reference")).toHaveCount(0);
  await dropFiles(page, [{ name: "plan.md", type: "text/markdown" }], "over");
  await expect(card.getByText("Drop images to attach, or files to reference")).toBeVisible();
  await dropFiles(page, [{ name: "plan.md", type: "text/markdown" }], "leave");

  // The one file of that name: a chip at the caret.
  await dropFiles(page, [{ name: "plan.md", type: "text/markdown" }]);
  await expectDraft(box(page)).toBe("@plan.md ");
  await expect(box(page).locator(".draft-chip")).toHaveCount(1);

  // Two of that name: pick one in the composer's note.
  await dropFiles(page, [{ name: "find.ts", type: "video/mp2t" }]);
  const which = card.getByRole("group", { name: "Which file" });
  await expect(which).toContainText("find.ts is in 2 places");
  await which.getByRole("button", { name: "web/find.ts" }).click();
  await expect(which).toHaveCount(0);
  await expectDraft(box(page)).toBe("@plan.md @web/find.ts ");

  // None: offered first, and nothing is written until Add.
  await dropFiles(page, [{ name: "scratch.json", type: "application/json", text: '{"a":1}\n' }]);
  const add = card.getByRole("group", { name: "Add to the project" });
  await expect(add).toContainText("scratch.json is not in the project — Add it to the project?");
  expect(() => readFileSync(path.join(project, "scratch.json"))).toThrow();
  const uploaded = page.waitForResponse((r) => r.url().includes("/upload?name=scratch.json") && r.request().method() === "POST");
  await add.getByRole("button", { name: "Add", exact: true }).click();
  expect((await uploaded).status()).toBe(201);
  await expect(add).toHaveCount(0);
  await expectDraft(box(page)).toBe("@plan.md @web/find.ts @scratch.json ");
  expect(readFileSync(path.join(project, "scratch.json"), "utf8")).toBe('{"a":1}\n');

  // Cancel leaves the project and the draft alone.
  await dropFiles(page, [{ name: "other.json", type: "application/json" }]);
  await expect(add).toBeVisible();
  await add.getByRole("button", { name: "Cancel" }).click();
  await expect(add).toHaveCount(0);
  await expectDraft(box(page)).toBe("@plan.md @web/find.ts @scratch.json ");
  expect(() => readFileSync(path.join(project, "other.json"))).toThrow();

  // A name already on disk (the list leaves it out): referenced all the same, and the note says so.
  await dropFiles(page, [{ name: ".local.txt", type: "text/plain" }]);
  await add.getByRole("button", { name: "Add", exact: true }).click();
  await expect(card.getByRole("status")).toContainText(".local.txt was already in the project; referenced it");
  await expectDraft(box(page)).toBe("@plan.md @web/find.ts @scratch.json @.local.txt ");
  expect(readFileSync(path.join(project, ".local.txt"), "utf8")).toBe("mine\n");

  // Past the upload limit: said before anything is sent, and no Add is offered.
  const sent: string[] = [];
  page.on("request", (r) => r.url().includes("/upload") && sent.push(r.url()));
  await dropFiles(page, [{ name: "huge.bin", type: "application/octet-stream", bytes: 8 * 1024 * 1024 + 1 }]);
  await expect(card.getByRole("status")).toContainText("huge.bin is 8.0 MB; a file added to the project can be at most 8 MB");
  await expect(add).toHaveCount(0);
  expect(sent).toEqual([]);
});

test("several dropped files are each handled, and images in the same drop still attach", async ({ page }) => {
  const project = path.join(process.env.AWUI_E2E_ROOT ?? "", "drop-files-many");
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, "known.txt"), "k\n");
  await signInAndOpen(page, "drop-files-many");
  await openChat(page);
  const card = page.locator(".composer-card");
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  await page.evaluate((b64) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], "shot.png", { type: "image/png" }));
    dt.items.add(new File(["k\n"], "known.txt", { type: "text/plain" }));
    dt.items.add(new File(["1\n"], "one.txt", { type: "text/plain" }));
    dt.items.add(new File(["2\n"], "two.txt", { type: "text/plain" }));
    const target = document.querySelector(".composer-card") as HTMLElement;
    for (const t of ["dragover", "drop"]) target.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, PNG);
  await expect(page.getByRole("list", { name: "Attached images" }).getByRole("img")).toHaveCount(1);
  await expectDraft(box(page)).toBe("@known.txt ");
  const add = card.getByRole("group", { name: "Add to the project" });
  await expect(add).toContainText("2 files are not in the project — Add them to the project?");
  await add.getByRole("button", { name: "Add", exact: true }).click();
  await expect(add).toHaveCount(0);
  await expectDraft(box(page)).toBe("@known.txt @one.txt @two.txt ");
  expect(readFileSync(path.join(project, "one.txt"), "utf8")).toBe("1\n");
  expect(readFileSync(path.join(project, "two.txt"), "utf8")).toBe("2\n");
});
