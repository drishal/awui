import { expect, type Page, test } from "@playwright/test";
import { chooseHarness, commandChat, newChat, openChat, openSettings, send, sendAndWait, showSidebar, signInAndOpen, expectDraft } from "./helpers.js";

const status = (page: Page) => page.getByTestId("chat-status");
const answers = (page: Page) => page.getByTestId("answer");
const prompts = (page: Page) => page.getByTestId("user-prompt");

/** Open a finished turn's "Worked for …" fold. */
async function openFold(page: Page, index = -1) {
  const cards = page.locator(".process-card");
  const card = index < 0 ? cards.last() : cards.nth(index);
  // A single settled call is its own card, with no header to open.
  if (await card.evaluate((el) => el.classList.contains("is-single"))) return;
  const toggle = card.getByTestId("process-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

test("this machine opens straight into the app: no token, no sign-in", async ({ page }) => {
  await page.goto("/");
  // The start screen: a box to type in, no sign-in on this machine.
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Folder: / })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
  const res = await page.request.get("/api/bootstrap");
  expect(res.status()).toBe(200);
  expect((await res.json()).auth.mode).toBe("local");
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
});

test("settings opens from the sidebar gear and shows pairing plus the server", async ({ page }) => {
  await signInAndOpen(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("button", { name: "Pair phone" })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Theme" })).toBeVisible();
  await expect(settings.getByRole("slider", { name: "Chat text size" })).toBeVisible();
  // The e2e server runs without a settings folder, so the server section is read-only.
  await expect(settings).toContainText("nothing to save to");
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
});

test("the status bar can be hidden", async ({ page }) => {
  await signInAndOpen(page);
  const bar = page.locator(".status-bar");
  await expect(bar).toBeVisible();
  // Settings' show_status_bar reaches the page in the bootstrap. The e2e server's
  // config.yml is read-only, so the flag arrives stubbed here; the file's round trip
  // is settings.test.ts's.
  await page.route("**/api/bootstrap", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { ui: Record<string, unknown> };
    await route.fulfill({ response: res, json: { ...body, ui: { ...body.ui, showStatusBar: false } } });
  });
  await page.reload();
  await expect(bar).toBeHidden();
  await page.unroute("**/api/bootstrap");
  await page.reload();
  await expect(bar).toBeVisible();
});

test("a new chat opens as a hero composer; a turn folds its work above a plain answer", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await expect(page.getByRole("heading", { name: /What should Fake do in alpha\?/ })).toBeVisible();
  await expect(page.getByText("It runs with its normal tools")).toBeVisible();
  await expect(page.getByTestId("tools-toggle")).toHaveCount(0);
  await sendAndWait(page, "hello tool **bold**");
  await expect(prompts(page)).toHaveText(["hello tool **bold**"]);
  await expect(answers(page).last().locator("strong", { hasText: "bold" })).toBeVisible();
  // One call is its own card: the row, with no "Used 1 tool" header over it.
  await expect(page.locator(".process-card").last()).toHaveClass(/is-single/);
  await expect(page.getByTestId("process-toggle")).toHaveCount(0);
  const row = page.getByTestId("tool-row").last();
  await expect(row).toHaveAttribute("data-tool", "read");
  await expect(row).toHaveAttribute("data-status", "done");
  await expect(row).toContainText("README.md");
  await row.getByRole("button").first().click();
  await expect(row.locator(".tool-card")).toContainText("# Fake README");
  await expect(page.getByTestId("thought-row").last()).toContainText("Thought");
  await expect(page.getByRole("button", { name: "Copy reply" }).last()).toBeVisible();
});

test("a lone tilde is an approximation: only two strike the text between them", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "growth of ~5% to ~10%, and ~~this part is gone~~");
  const answer = answers(page).last();
  await expect(answer).toContainText("~5% to ~10%");
  await expect(answer.locator("del")).toHaveCount(1);
  await expect(answer.locator("del")).toHaveText("this part is gone");
});

test("raw HTML in an answer reads as the text it is, not as an element", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  // The fake echoes the prompt, so both the tag and the script arrive as answer text.
  await sendAndWait(page, "Hemis wrote <the thought> and <script>alert(1)</script> into the answer");
  const answer = answers(page).last();
  await expect(answer).toContainText("<the thought>");
  await expect(answer).toContainText("<script>alert(1)</script>");
  await expect(answer.locator("script")).toHaveCount(0);
});

test("an edit row carries its +N −M badge", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "please edit the app");
  await openFold(page);
  const row = page.getByTestId("tool-row").last();
  await expect(row).toHaveAttribute("data-tool", "edit");
  await expect(row.getByText("+1", { exact: true })).toBeVisible();
  await expect(row.getByText("−1", { exact: true })).toBeVisible();
  await row.getByRole("button").first().click();
  // Opened, it is the diff: the old line in red, the new in green.
  await expect(row.locator(".diff-line.is-del .diff-text")).toHaveText("a");
  await expect(row.locator(".diff-line.is-add .diff-text")).toHaveText("b");
});

test("a finished turn's line counts show on its fold line and its Changed files row", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "please edit the app, then read a tool");
  const turn = page.getByTestId("turn").last();
  // With the fold closed, the counts stand beside "Worked for …".
  await expect(turn.getByTestId("process-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(turn.getByTestId("process-toggle").getByTestId("change-stat")).toHaveText("+1 −1");
  // The Changed files row carries them with the file count, and still opens its list.
  const changed = turn.getByTestId("changed-files");
  await expect(changed.getByTestId("change-stat")).toHaveText("+1 −1 · 1 file");
  await changed.getByRole("button").first().click();
  await expect(changed.getByRole("button", { name: "src/app.ts", exact: true })).toBeVisible();
});

test("tool cards: the harness's numbered diff, a terminal, a search, a fetch", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "showcase");
  await openFold(page);
  const tool = (name: string) => page.locator(`[data-testid="tool-row"][data-tool="${name}"]`);
  for (const name of ["edit", "write", "bash", "grep", "web_fetch"]) await tool(name).getByRole("button").first().click();
  // Pi's own diff wins over the arguments': its line numbers, its skipped run, the changed words marked.
  const edit = tool("edit");
  await expect(edit.locator(".diff-line.is-add .diff-no").first()).toHaveText("11");
  await expect(edit.locator(".diff-gap")).toHaveCount(1);
  await expect(edit.locator(".diff-line.is-add .diff-word").first()).toHaveText(", host");
  await expect(edit.locator(".drow-aside")).toHaveText("+3 −2");
  await expect(tool("write").locator(".diff-line.is-add")).toHaveCount(4);
  await expect(tool("write").locator(".drow-aside")).toHaveText("+4");
  await expect(tool("bash").locator(".term-command")).toHaveText("$npm test -- --run tool-diff");
  await expect(tool("bash").locator(".term-output")).toContainText("5 passed");
  await expect(tool("grep").locator(".tool-sentence")).toHaveText("Searched for listen\\( in src");
  await expect(tool("web_fetch").getByRole("link", { name: "https://example.com/docs/listen" })).toBeVisible();
  // Todos read as a checklist, never as JSON.
  await expect(tool("TodoWrite").locator(".tool-sentence")).toHaveText("Updated the plan (3 steps)");
  await tool("TodoWrite").getByRole("button").first().click();
  await expect(tool("TodoWrite").locator(".todo-card-row.is-done")).toHaveText("Normalize each harness's diff");
  await expect(tool("TodoWrite").locator(".todo-card-row.is-active")).toHaveText("Ship the diff view");
  await expect(tool("todo_write").locator(".tool-sentence")).toHaveText("Updated the plan");
  await expect(page.getByTestId("process-toggle").last()).toContainText("Used 9 tools");
});

test("an expanded thought shows its text once, not in the header and the body", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "hello thought");
  await openFold(page);
  const thought = page.getByTestId("thought-row").last();
  await expect(thought).toContainText("Considering: Echo: hello thought");
  await thought.getByRole("button").first().click();
  await expect(thought.locator(".thought-body")).toContainText("Considering: Echo: hello thought");
  // The header preview hides once open: the text appears exactly once.
  await expect(thought.getByText("Considering: Echo: hello thought", { exact: false })).toHaveCount(1);
});

test("switch harness without reloading; capabilities change the composer", async ({ page }) => {
  await signInAndOpen(page);
  await openChat(page, "Fake B");
  await expect(page.locator(".chat-sub .badge")).toHaveText("Fake B");
  await expect(page.getByTestId("permission-picker")).toHaveCount(0);
  await send(page, "slow please");
  await expect(page.getByRole("button", { name: "Stop and send" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Steer" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Message" }).fill("change of plan");
  await page.getByRole("button", { name: "Stop and send" }).click();
  await expect(answers(page).last()).toContainText("Echo: change of plan", { timeout: 15_000 });
  await expect(status(page)).toHaveText("Idle", { timeout: 15_000 });
  await chooseHarness(page, "Fake");
  await expect(page.locator(".chat-sub .badge")).toHaveText("Fake B");
});

test("the harness menu lists every harness in its own colour and works from the keyboard", async ({ page }) => {
  await signInAndOpen(page);
  await showSidebar(page);
  const row = page.getByRole("complementary", { name: "Sessions" }).getByRole("button", { name: "Harness" });
  await expect(row).toContainText("Fake");
  await row.focus();
  await page.keyboard.press("ArrowDown");
  const menu = page.getByRole("listbox", { name: "Harness" });
  await expect(menu).toBeFocused();
  await expect(menu.getByRole("option", { name: "Fake", exact: true })).toHaveAttribute("aria-selected", "true");
  // Colours come from the server's accents, one per harness, not from per-harness CSS.
  const dots = menu.locator(".harness-dot");
  const colours = await dots.evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
  expect(new Set(colours).size).toBe(2);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(row).toContainText("Fake B");
  await expect(row).toBeFocused();
  // Escape closes without changing anything.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(row).toContainText("Fake B");
});

test("steer and follow-up while running, shown in the status stack", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "slow work");
  const box = page.getByRole("textbox", { name: "Message" });
  await box.fill("then summarize");
  await page.getByRole("button", { name: "Follow-up" }).click();
  await expect(page.getByTestId("queue-row").filter({ hasText: "then summarize" })).toBeVisible();
  await box.fill("focus on tests");
  await page.getByRole("button", { name: "Steer" }).click();
  await expect(status(page)).toHaveText("Idle", { timeout: 20_000 });
  await expect(prompts(page)).toHaveText(["slow work", "focus on tests", "then summarize"]);
  await expect(page.getByTestId("queue-row")).toHaveCount(0);
});

test("stop shows Stopping, then settles with the turn marked stopped", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "slow and long");
  await expect(status(page)).toHaveText("Working");
  await page.getByRole("button", { name: "Stop the agent" }).click();
  await expect(status(page)).toHaveText(/Stopping|Idle/);
  await expect(status(page)).toHaveText("Idle", { timeout: 15_000 });
  await expect(page.locator(".stopped-pill")).toHaveText("Stopped");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
});

test("an approval takes over the composer and is recorded in the turn", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "ask before reading");
  const card = page.getByTestId("approval-card");
  await expect(card).toContainText("Waiting for approval");
  await expect(card).toContainText("Allow tool: read");
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
  await expect(card.getByRole("button")).toHaveText(["Stop", "Deny", "Approve"]);
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card).toHaveCount(0);
  await expect(status(page)).toHaveText("Idle", { timeout: 15_000 });
  await openFold(page);
  await expect(page.getByTestId("request-row")).toContainText("Approved");
  await expect(page.locator('[data-testid="tool-row"][data-status="done"]')).toHaveCount(1);
});

test("a question lists its options as numbered rows, and a number picks one", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "quiz please");
  const card = page.getByTestId("approval-card");
  await expect(card).toContainText("Waiting for your answer");
  await expect(card.locator(".approval-chip")).toHaveText("1 of 2");
  await expect(card.locator(".approval-headline")).toHaveText("Move both theme AND text size into config.yml?");
  await expect(card.locator(".choice-label")).toHaveText(["Both sharedRecommended", "Only text size shared, theme stays per-device", "Other (type your own)"]);
  await expect(card.locator(".choice.is-recommended")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("2");
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("answer").last()).toContainText("Chose: Only text size shared, theme stays per-device");

  await send(page, "quiz described");
  await expect(card.locator(".approval-chip")).toHaveText("Settings");
  await expect(card.locator(".approval-headline")).toHaveText("Should the theme and the text size both move into config.yml?");
  await expect(card.locator(".choice-detail")).toHaveText(["Every device gets the same look.", "The theme stays per device.", "Keep both in each browser."]);
  await card.getByRole("button", { name: "Dismiss" }).click();
  await expect(card).toHaveCount(0);
});

test("a prompt's actions show on hover: edit replaces it in place, retry branches where the harness cannot", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "first idea");
  await sendAndWait(page, "second idea");
  const second = page.locator(".turn-prompt").nth(1);
  const actions = second.getByTestId("prompt-actions");
  await expect(page.locator(".turn-prompt").nth(0).getByTestId("prompt-actions")).toHaveCSS("opacity", "0.45");
  await second.hover();
  await expect(actions).toHaveCSS("opacity", "1");
  await actions.getByRole("button", { name: "Edit" }).click();
  const editor = page.getByRole("textbox", { name: "Edit message" });
  await expect(editor).toHaveValue("second idea");
  await expect(page.locator(".prompt-editor-note")).toHaveText("Replaces this message and everything after it");
  await editor.fill("a better second idea");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("user-prompt")).toHaveText(["first idea", "a better second idea"]);
  await expect(page.getByTestId("answer").last()).toContainText("Echo: a better second idea", { timeout: 15_000 });
  await expect(page.getByTestId("turn")).toHaveCount(2);

  // Fake B cannot replace a message: Retry runs it again in a branch, and the original stays.
  await newChat(page, "Fake B");
  await sendAndWait(page, "only question");
  const first = page.locator(".turn-prompt").first();
  await first.hover();
  await first.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator(".banner")).toContainText("Branched from before message 1");
  await expect(page.getByTestId("answer").last()).toContainText("Echo: only question", { timeout: 15_000 });
});

test("hovering a turn shows when it was sent and how fast it went", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "when was this");
  // A settled turn's card shuts on its spring: let it land, so the rows below are measured at rest.
  await expect(page.getByTestId("turn").last().locator(".collapse")).toHaveCount(0);
  const turn = page.getByTestId("turn").last();
  // The prompt's time sits among its actions, with the full date on its title.
  const when = turn.locator(".prompt-time");
  await turn.getByTestId("user-prompt").hover();
  await expect(turn.getByTestId("prompt-actions")).toHaveCSS("opacity", "1");
  await expect(when).toHaveText(/\d{1,2}:\d{2}/);
  await expect(when).toHaveAttribute("title", /\d/);
  // The answer's row says how long the turn took, and only once the answer is hovered or focused.
  const timing = turn.getByTestId("answer-timing");
  await expect(timing).toHaveText(/\d+(\.\d+)?s/);
  await expect(timing).toHaveCSS("opacity", "0");
  const row = timing.locator("..");
  const before = await row.boundingBox();
  await turn.getByTestId("answer").hover();
  await expect(timing).toHaveCSS("opacity", "1");
  // Hovering fades the timing in; the row itself must not move (within a pixel: sub-pixel rounding is noise).
  const after = await row.boundingBox();
  for (const edge of ["x", "y", "width", "height"] as const) expect(Math.abs(after![edge] - before![edge])).toBeLessThan(1);
  // Keyboard focus anywhere in the answer shows it too.
  await page.mouse.move(0, 0);
  await expect(timing).toHaveCSS("opacity", "0");
  await turn.getByRole("button", { name: "Copy reply" }).focus();
  await expect(timing).toHaveCSS("opacity", "1");
});

test("a divider marks the turn where the model changed", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "on the first model");
  await sendAndWait(page, "still the first");
  await expect(page.getByTestId("model-switch")).toHaveCount(0);
  await page.getByTestId("model-picker").click();
  await page.getByRole("combobox", { name: "Search models" }).fill("slow");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("model-picker")).toHaveAccessibleName("Model: Fake Slow");
  await sendAndWait(page, "now on another");
  await expect(page.getByTestId("model-switch")).toHaveCount(1);
  await expect(page.getByTestId("model-switch")).toHaveText("Switched to Fake Slow");
  await expect(page.locator(".turn").nth(2).locator("xpath=preceding-sibling::*[1]")).toHaveAttribute("data-testid", "model-switch");
});

test("a folded live turn keeps its latest thought in view", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "slow stream please");
  await expect(page.getByTestId("process-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("live-thought")).toHaveCount(0);
  await page.getByTestId("process-toggle").click();
  await expect(page.getByTestId("live-thought")).toContainText("Considering: Echo: slow stream please");
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 20_000 });
  await expect(page.getByTestId("live-thought")).toHaveCount(0);
});

test("a chip offers to compact a full context before the next message", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "a small start");
  await expect(page.getByTestId("compact-chip")).toHaveCount(0);
  await sendAndWait(page, "bloat it");
  const chip = page.getByTestId("compact-chip");
  await expect(chip).toHaveText(/^Full \d+k$/);
  await chip.click();
  await expect(chip).toHaveText(/^Compact \d+k$/);
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await send(page, "now compact first");
  await expect(page.getByTestId("chat-status")).toHaveText("Compacting");
  await expect(page.getByTestId("answer").last()).toContainText("Echo: now compact first", { timeout: 20_000 });
  await expect(chip).toHaveCount(0);
});

test("selecting text in an answer offers to quote it into the message", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "something to quote");
  await page.getByTestId("answer").last().locator("p").first().evaluate((p) => {
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
  await page.getByTestId("quote-btn").click();
  const box = page.getByRole("textbox", { name: "Message" });
  await expectDraft(box).toBe("> Echo: something to quote\n\n");
  await expect(box).toBeFocused();
  await page.keyboard.type("Why?");
  await page.keyboard.press("Enter");
  const bubble = page.getByTestId("user-prompt").last();
  await expect(bubble.locator(".bubble-quote")).toHaveText("Echo: something to quote");
  await expect(bubble.locator(".bubble-text")).toHaveText("Why?");
});

test("a one-line shell block in an answer runs in the project and its output can join the message", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await page.getByRole("textbox", { name: "Message" }).fill("try this:\n```bash\necho hello from $(basename \"$PWD\")\n```");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const block = page.getByTestId("answer").last().locator(".code-block");
  await expect(block).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 20_000 });
  await block.hover();
  await block.getByRole("button", { name: "Run" }).click();
  const out = page.getByTestId("run-output");
  await expect(out.locator(".run-text")).toHaveText("hello from alpha");
  await expect(out.locator(".run-meta")).toContainText("exit 0");
  await out.getByRole("button", { name: "Add to message" }).click();
  await expectDraft(page.getByRole("textbox", { name: "Message" })).toMatch(/^```\n\$ echo hello from .*\nhello from alpha\n```\n\(exit 0\)\n\n$/);
});

test("a code block in an answer has a header with its language (none without one), line numbers on a long block, and a Wrap toggle", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  const long = Array.from({ length: 8 }, (_, i) => `const v${i + 1} = ${i + 1};`).join("\n");
  await send(page, `blocks:\n\`\`\`typescript\n${long}\n\`\`\`\n\n\`\`\`\nplain one\nplain two\n\`\`\``);
  const blocks = page.getByTestId("answer").last().locator(".code-block");
  await expect(blocks).toHaveCount(2, { timeout: 15_000 });
  await expect(status(page)).toHaveText("Idle", { timeout: 20_000 });
  const [typed, plain] = [blocks.nth(0), blocks.nth(1)];
  await expect(typed.locator(".code-lang")).toHaveText("TypeScript");
  await expect(plain.locator(".code-lang")).toHaveCount(0);
  // With no language there is no blank header band: the code starts at the block's top, and Copy floats over its corner.
  const [plainBox, plainPre] = [await plain.boundingBox(), await plain.locator("pre").boundingBox()];
  expect(Math.abs(plainBox!.y - plainPre!.y)).toBeLessThan(1);
  await plain.hover();
  await expect(plain.getByRole("button", { name: "Copy code" })).toBeVisible();
  // Eight lines get a gutter drawn by CSS (so it is never copied); two do not, and a keyword is coloured.
  await expect(typed.locator("pre")).toHaveClass(/has-numbers/);
  await expect(typed.locator(".cl")).toHaveCount(8);
  expect(await typed.locator(".cl").nth(2).evaluate((el) => getComputedStyle(el, "::before").content)).toBe("counter(line)");
  await expect(typed.locator(".tk-keyword").first()).toHaveText("const");
  await expect(plain.locator("pre")).not.toHaveClass(/has-numbers/);
  // Wrap is one choice for every block, kept in the browser.
  const wrap = typed.getByRole("button", { name: "Wrap" });
  await expect(wrap).toHaveAttribute("aria-pressed", "false");
  await expect(typed).not.toHaveClass(/is-wrapped/);
  await typed.hover();
  await wrap.click();
  await expect(wrap).toHaveAttribute("aria-pressed", "true");
  await expect(typed).toHaveClass(/is-wrapped/);
  await expect(plain).toHaveClass(/is-wrapped/);
  expect(await page.evaluate(() => window.localStorage.getItem("awui.codeWrap"))).toBe("true");
  await wrap.click();
  await expect(typed).not.toHaveClass(/is-wrapped/);
});

test("reconnects after going offline without duplicating messages", async ({ page, context }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "slow stream");
  await expect(status(page)).toHaveText("Working");
  await context.setOffline(true);
  await expect(page.getByTestId("connection")).toHaveText("Disconnected");
  await expect(page.locator(".conn-banner")).toBeVisible();
  await page.waitForTimeout(800);
  await context.setOffline(false);
  await expect(page.getByTestId("connection")).toHaveText("Connected", { timeout: 15_000 });
  await expect(status(page)).toHaveText("Idle", { timeout: 20_000 });
  await expect(prompts(page)).toHaveCount(1);
  await expect(answers(page)).toHaveCount(1);
  const text = await answers(page).first().innerText();
  expect(text.match(/Echo: slow stream/g)).toHaveLength(1);
});

test("a run keeps going after the browser closes, and another device can watch it finish", async ({ browser }) => {
  const laptop = await browser.newContext();
  const page = await laptop.newPage();
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "slow background run");
  await expect(status(page)).toHaveText("Working");
  // The browser goes away mid-run.
  await laptop.close();

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobile = await phone.newPage();
  await signInAndOpen(mobile);
  await showSidebar(mobile);
  await mobile.locator(".session", { hasText: "slow background run" }).first().click();
  await expect(prompts(mobile)).toHaveText(["slow background run"]);
  // It ran to the end on its own: the whole answer, not a "Stopped" one.
  await expect(answers(mobile).last()).toContainText("line 60", { timeout: 20_000 });
  await expect(status(mobile)).toHaveText("Idle", { timeout: 20_000 });
  await expect(mobile.getByText("Stopped")).toHaveCount(0);
  await phone.close();
});

test("reload re-attaches, and the session list resumes the same live chat", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "remember me");
  const url = page.url();
  await page.reload();
  expect(page.url()).toBe(url);
  await expect(prompts(page)).toHaveText(["remember me"]);
  const row = page.locator(".session", { hasText: "remember me" });
  await expect(row).toBeVisible();
  await expect(row.locator(".live-dot")).toBeVisible();
  await row.click();
  await expect(prompts(page)).toHaveText(["remember me"]);
  await page.getByRole("button", { name: "Chat actions" }).click();
  await page.getByRole("menuitem", { name: "Close chat" }).click();
  await expect(page.getByRole("heading", { name: "alpha", level: 2 })).toBeVisible();
  await page.locator(".session", { hasText: "remember me" }).click();
  await expect(prompts(page)).toHaveText(["remember me"]);
  await expect(answers(page)).toContainText("Echo: remember me");
});

test("model and thinking changes apply while idle", async ({ page }) => {
  await signInAndOpen(page);
  await openChat(page);
  await page.getByTestId("model-picker").click();
  await page.getByRole("combobox", { name: "Search models" }).fill("slow");
  await expect(page.getByRole("dialog", { name: "Choose a model" }).getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("model-picker")).toHaveAccessibleName("Model: Fake Slow");
  // The effort slider: End goes to the strongest level, which applies once the knob settles.
  await page.getByTestId("thinking-picker").click();
  const effort = page.getByRole("slider", { name: "Thinking" });
  await expect(effort).toBeFocused();
  await page.keyboard.press("End");
  await expect(effort).toHaveAttribute("aria-valuetext", "high");
  await expect(page.getByTestId("thinking-picker")).toHaveAccessibleName("Thinking: high");
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByTestId("model-picker")).toHaveAccessibleName("Model: Fake Slow");
  await expect(page.getByTestId("thinking-picker")).toHaveAccessibleName("Thinking: high");
  await expect(page.getByTestId("connection")).toContainText("Connected");
  await expect(page.locator(".status-bar")).toContainText("Fake · Fake Slow · high");
  // A click on the track jumps to the nearest stop: the weakest, at its left end.
  await page.getByTestId("thinking-picker").click();
  // The panel unfurls from its chip on a spring: measure the track once it has landed.
  await page.getByRole("dialog", { name: "Thinking effort" }).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const track = page.locator(".effort-track");
  const box = (await track.boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.click(box.x + 4, box.y + box.height / 2);
  await expect(page.getByRole("slider", { name: "Thinking" })).toHaveAttribute("aria-valuetext", "off");
  await expect(page.getByTestId("thinking-picker")).toHaveAccessibleName("Thinking: off");
});

test("the permission mode changes mid-run, from its picker, by keyboard, and from the palette", async ({ page }) => {
  await signInAndOpen(page);
  await openChat(page);
  const picker = page.getByTestId("permission-picker");
  await expect(picker).toHaveAccessibleName("Permissions: Ask first");
  // While a run goes the model and thinking wait for it; the permission mode does not.
  await send(page, "slow permissions");
  await expect(status(page)).toHaveText("Working");
  await expect(page.getByTestId("model-picker")).toBeDisabled();
  await picker.click();
  const list = page.getByRole("listbox", { name: "Permission mode" });
  await expect(list.getByRole("option")).toHaveText([/Ask first/, /Accept edits/, /Bypass/]);
  await list.getByRole("option", { name: "Accept edits" }).click();
  await expect(list).toBeHidden();
  await expect(picker).toHaveAccessibleName("Permissions: Accept edits");
  await expect(picker).toBeFocused();
  await expect(status(page)).toHaveText("Working");
  // By keyboard: ↓ opens the list on the current mode, End and Enter pick the last.
  await page.keyboard.press("ArrowDown");
  await expect(list).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(picker).toHaveAccessibleName("Permissions: Bypass");
  await expect(status(page)).toHaveText("Idle", { timeout: 20_000 });
  // A reload (or another device) shows the mode the harness is in.
  await page.reload();
  await expect(picker).toHaveAccessibleName("Permissions: Bypass");
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands and sessions" }).fill("permissions ask");
  await page.keyboard.press("Enter");
  await expect(picker).toHaveAccessibleName("Permissions: Ask first");
});

test("the model picker searches across providers, remembers recents, and works by keyboard", async ({ page }) => {
  await signInAndOpen(page);
  await openChat(page);
  const picker = page.getByTestId("model-picker");
  await picker.click();
  const dialog = page.getByRole("dialog", { name: "Choose a model" });
  await expect(dialog).toContainText("Current Fake Echo · fake");
  const search = page.getByRole("combobox", { name: "Search models" });
  await expect(search).toBeFocused();
  await page.getByRole("button", { name: "Refresh models" }).click();
  await expect(dialog.getByRole("option", { name: /Fake Fresh/ })).toBeVisible();
  await expect(dialog.getByRole("option", { name: /Fake Echo/ }).locator(".model-tag")).toHaveText("high");
  // Grouped by provider, the current provider first.
  await expect(dialog.getByRole("group")).toHaveCount(3);
  await expect(dialog.getByRole("group").first()).toHaveAccessibleName("fake");
  // Punctuation-insensitive: "gpt55" finds GPT-5.5 and GPT-5.5 Mini.
  await search.fill("gpt55");
  await expect(dialog.getByRole("option")).toHaveText([/GPT-5\.5/, /GPT-5\.5 Mini/]);
  await expect(dialog.getByRole("option").first().locator(".model-tag")).toHaveText("xhigh");
  await page.keyboard.press("ArrowDown");
  await expect(dialog.getByRole("option", { selected: true })).toContainText("GPT-5.5 Mini");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(picker).toHaveAccessibleName("Model: GPT-5.5 Mini");
  await expect(picker).toBeFocused();
  // Recently used models show first next time (excluding the current one).
  await picker.click();
  await search.fill("glm flash");
  await page.keyboard.press("Enter");
  await expect(picker).toHaveAccessibleName("Model: GLM-5.3-Flash");
  await picker.click();
  await expect(dialog.getByRole("group").first()).toHaveAccessibleName("Recent");
  await expect(dialog.getByRole("group").first().getByRole("option")).toHaveText([/GPT-5\.5 Mini/]);
  await search.fill("zzz");
  await expect(dialog).toContainText("No models match “zzz”");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // Clicking outside closes it too.
  await picker.click();
  await page.locator(".chat-header").click({ position: { x: 20, y: 20 } });
  await expect(dialog).toBeHidden();
});

test("the model picker opens as a bottom sheet on phones", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAndOpen(page);
  await page.keyboard.press("Escape");
  await openChat(page);
  // A phone folds the composer's pickers into one chip; the model lives in its sheet.
  // The card rests folded to one row while idle, so the box takes focus first.
  await page.getByRole("textbox", { name: "Message" }).click();
  await page.getByTestId("config-chip").click();
  await page.getByRole("dialog", { name: "Chat settings" }).getByTestId("model-picker").click();
  const dialog = page.getByRole("dialog", { name: "Choose a model" });
  await expect(dialog).toBeInViewport();
  const box = (await dialog.boundingBox()) as { x: number; y: number; width: number; height: number };
  expect(box.x).toBeLessThanOrEqual(9);
  expect(box.x + box.width).toBeGreaterThanOrEqual(381);
  await dialog.getByRole("option", { name: /GLM-5\.3-Flash/ }).click();
  await expect(page.getByTestId("config-chip")).toContainText("GLM-5.3-Flash");
});

test("markdown never renders raw HTML or unsafe links", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, 'x [bad](javascript:alert(1)) [ok](https://example.com) <img src=x onerror="window.pwned=1"> ![pic](https://example.com/p.png)');
  const md = answers(page).last().locator(".md");
  await expect(md.locator("a", { hasText: "ok" })).toHaveAttribute("href", "https://example.com");
  await expect(md.locator("a", { hasText: "bad" })).toHaveCount(0);
  await expect(md.locator("img")).toHaveCount(0);
  await expect(md.locator(".md-image")).toHaveText("[image: pic]");
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
});

test("a reply written before a tool call shows as a reply, in order, with only the work folded", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "interleaved please");
  const turn = page.getByTestId("turn").last();
  const reply = turn.getByTestId("interim-reply");
  await expect(reply).toContainText("this is reply block 1");
  // The reply stays in view, above the card holding the command (one call, so the card is its row), and the answer comes after.
  const fold = turn.locator(".process-card");
  await expect(fold.last()).toContainText("Ran sleep 1");
  const top = async (l: ReturnType<typeof page.locator>) => (await l.boundingBox())?.y ?? 0;
  expect(await top(reply)).toBeLessThan(await top(fold.last()));
  expect(await top(fold.last())).toBeLessThan(await top(turn.getByTestId("answer")));
  await expect(turn.getByTestId("answer")).toContainText("Echo: interleaved please");
});

test("work the agent runs after its answer keeps its place below the reply", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "do it afterreply please");
  const turn = page.getByTestId("turn").last();
  const answer = turn.getByTestId("answer");
  await expect(answer).toContainText("The answer comes first");
  // The command that ran after the reply is a fold below it, not above.
  const after = turn.getByTestId("work-after");
  await expect(after).toBeVisible();
  await expect(after.getByTestId("tool-row")).toContainText("npm run lint");
  const top = (l: ReturnType<typeof page.locator>) => l.boundingBox().then((b) => b?.y ?? 0);
  expect(await top(after)).toBeGreaterThan(await top(answer));
});

test("todos from the harness show in the status stack, which can be hidden", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "make a todo list");
  const stack = page.getByTestId("status-stack");
  await expect(stack).toContainText("Todos");
  await expect(stack).toContainText("1/3");
  await expect(stack.locator(".stack-row")).toHaveCount(3);
  // The harness's phases are a tree: a numbered row with its count, the tasks under it.
  const phases = stack.getByRole("list", { name: "Todo phases" });
  await expect(phases.getByRole("button", { name: /I\. Plan 1\/2/ })).toHaveAttribute("aria-expanded", "true");
  await expect(phases.getByRole("button", { name: /II\. Verify 0\/1/ })).toBeVisible();
  // A click folds a phase away.
  await phases.getByRole("button", { name: /I\. Plan/ }).click();
  await expect(stack.getByText("Read the code")).toBeHidden();
  await phases.getByRole("button", { name: /I\. Plan/ }).click();
  await expect(stack.getByText("Read the code")).toBeVisible();
  // The run has settled: the step left in progress shows a still mark, not a spinner.
  await expect(stack.getByRole("img", { name: "Started, not running now" })).toHaveCount(1);
  await expect(stack.locator(".todo-in_progress .spinner")).toHaveCount(0);
  await stack.getByRole("button", { name: "Hide status" }).click();
  await expect(stack.locator(".stack-row")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("status-stack").getByRole("button", { name: "Show status" })).toBeVisible();
});

test("a rpiv-todo list shows in the status stack, and its call reads as the action it took", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "todolist");
  // The tool's result carries the whole list; the row says which action it was, not "the plan".
  await expect(page.locator('[data-tool="todo"] .tool-sentence')).toHaveText("Updated #2 to in progress");
  const stack = page.getByTestId("status-stack");
  await expect(stack).toContainText("Todos");
  await expect(stack).toContainText("1/3");
  await expect(stack.locator(".stack-row")).toHaveCount(3);
  await expect(stack).toContainText("Draw the reason inline");
  await expect(stack).toContainText("Run the suite");
});

test("a long Working says why: the harness's own status line shows above the composer until it clears", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "please wait for the provider");
  const line = page.getByTestId("harness-status");
  await expect(line).toHaveText("Provider temporarily unavailable — retrying in 2s (cycle 1/5)");
  await expect(page.getByTestId("chat-status")).toHaveText("Working");
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 15_000 });
  await expect(line).toHaveCount(0);
});

test("context ring, edited files, and the turn rail", async ({ page }) => {
  await signInAndOpen(page);
  await commandChat(page);
  // A fresh chat shows what fills the window, not zero-filled token and timing sections.
  await page.getByTestId("context-ring").click();
  await expect(page.getByRole("dialog", { name: "Context and usage" }).getByRole("region")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await sendAndWait(page, "please edit the app");
  await expect(page.getByTestId("changed-files")).toContainText("Changed 1 file");
  await expect(page.getByTestId("changed-files")).toContainText("src/app.ts");
  await expect(page.getByTestId("tool-row").last()).toContainText("src/app.ts");
  await expect(page.getByTestId("context-ring")).toBeVisible();
  await expect(page.getByTestId("context-ring")).toHaveAccessibleName(/% of context used · .* tokens/);
  // One panel: what fills the window, the session's tokens, and model timing.
  await page.getByTestId("context-ring").click();
  const panel = page.getByRole("dialog", { name: "Context and usage" });
  await expect(panel.getByRole("region", { name: "Context" })).toContainText(/of context used/);
  await expect(panel).not.toContainText("~");
  await expect(panel.locator(".usage-label")).toContainText(["System prompt", "Tool definitions", "Messages", "Cache hit"]);
  await expect(panel.getByRole("region", { name: "Tokens" })).toContainText("Tokens this session");
  await expect(panel.getByRole("region", { name: "Session" })).toContainText(/1 turn · \d+ steps?/);
  await expect(panel.getByRole("region", { name: "Session" })).toContainText(/Tokens per second\s*\d+ tok\/s/);
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await sendAndWait(page, "second turn");
  await sendAndWait(page, "third turn");
  const rail = page.getByRole("navigation", { name: "Jump to turn" });
  await expect(rail.getByRole("button")).toHaveCount(await prompts(page).count());
  await rail.getByRole("button").first().click();
  await expect(prompts(page).first()).toBeInViewport();
  // A rail jump scrolls only the conversation: it must never scroll the app frame
  // (`.app`/`.main`) up by the header's height, which left a blank band below the
  // composer. Regression for the turn-rail jump dragging the whole page.
  await expect.poll(async () =>
    page.evaluate(() => {
      const app = document.querySelector(".app");
      const main = document.querySelector(".main");
      // With the bug, scrollIntoView scrolls `.app` (its overflow shows a stray page
      // scrollbar) and `.main` slides up by the header's height (~-97), leaving a blank
      // band at the bottom.
      return {
        appScroll: Math.round((app as HTMLElement).scrollTop),
        mainTop: Math.round((main as HTMLElement).getBoundingClientRect().top),
      };
    }),
  ).toEqual({ appScroll: 0, mainTop: 0 });
});

test("chat text size comes from config.yml, read-only without a settings folder", async ({ page }) => {
  await signInAndOpen(page);
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings" });
  const slider = settings.getByRole("slider", { name: "Chat text size" });
  await expect(slider).toBeVisible();
  await expect(slider).toBeDisabled();
  await expect(settings.getByText("100%", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Close" }).click();
});

test("the stylix theme file drives colors and passes contrast", async ({ page }) => {
  await signInAndOpen(page);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(29, 32, 33)");
  const ratio = await page.evaluate(() => {
    const parse = (c: string) => (c.match(/\d+/g) ?? []).slice(0, 3).map(Number);
    const lum = (rgb: number[]) => {
      const [r, g, b] = rgb.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const fg = lum(parse(getComputedStyle(document.body).color));
    const back = lum(parse(getComputedStyle(document.body).backgroundColor));
    return (Math.max(fg, back) + 0.05) / (Math.min(fg, back) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
  // Secondary text is readable where it actually sits: the page, cards, and chips.
  const muted = await page.evaluate(() => {
    const hex = (name: string) => {
      const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim().replace("#", "");
      return [0, 2, 4].map((i) => Number.parseInt(value.slice(i, i + 2), 16));
    };
    const lum = (rgb: number[]) => {
      const [r, g, b] = rgb.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: number[], b: number[]) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    const fg = hex("--muted-text");
    return ["--bg", "--surface", "--surface-2"].map((name) => ratio(fg, hex(name)));
  });
  for (const value of muted) expect(value).toBeGreaterThanOrEqual(4.5);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#1d2021");
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 320, height: 640 },
]) {
  test(`mobile ${viewport.width}px: drawer, composer, no horizontal scroll`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await signInAndOpen(page, "beta");
    // Picking a project lands on the start screen; the drawer closed behind it.
    await expect(page.locator(".sidebar")).not.toBeInViewport();
    await newChat(page);
    await expect(page.locator(".sidebar")).not.toBeInViewport();
    await expect(page.locator(".status-bar")).toBeHidden();
    await sendAndWait(page, "hello from the phone tool");
    await expect(page.getByRole("textbox", { name: "Message" })).toBeInViewport();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // The ring can wrap to the start of the control row; its panel stays on screen.
    await page.getByTestId("context-ring").click();
    const panel = page.getByRole("dialog", { name: "Context and usage" });
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(page.getByRole("navigation", { name: "Jump to turn" })).toBeHidden();
    await showSidebar(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".sidebar")).not.toBeInViewport();
  });
}

test("work the agent does after writing its reply stays below the reply", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "the reply comes first, then afterreply");
  const turn = page.getByTestId("turn").last();
  const answer = turn.getByTestId("answer");
  const after = turn.getByTestId("work-after");
  await expect(answer).toContainText("The answer comes first.");
  await expect(after).toContainText("npm run lint");
  // In the page, not in the fold above.
  const reply = await answer.boundingBox();
  const work = await after.boundingBox();
  expect(work!.y).toBeGreaterThan(reply!.y);
});

test("several pending requests stack; answering the front one reveals the next", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "ask twice please");
  const card = page.getByTestId("approval-card");
  await expect(card).toContainText("1 more");
  await expect(card).toHaveClass(/behind-1/);
  const first = (await card.locator(".approval-headline").innerText()).trim();
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card.locator(".approval-headline")).not.toHaveText(first);
  await expect(card).not.toContainText("more");
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card).toHaveCount(0);
  await expect(status(page)).toHaveText("Idle", { timeout: 15_000 });
});

test("the sidebar focuses the current project and opens its sessions across harnesses", async ({ page }) => {
  await signInAndOpen(page, "beta");
  // Other specs share this server and this folder, so count what this one adds to it.
  await chooseHarness(page, "Fake");
  const otherFake = await page.locator(".focus-group .session").count();
  await newChat(page, "Fake B");
  await sendAndWait(page, "xproj one");
  for (const text of ["xproj two", "xproj three", "xproj four", "xproj five", "xproj six"]) {
    await newChat(page, "Fake");
    await sendAndWait(page, text);
  }
  // While beta is open its sessions are the focused list, the selected harness's to begin with.
  await chooseHarness(page, "Fake");
  const list = page.locator(".focus-group");
  const focused = page.getByTestId("focused-project");
  await expect(focused.locator(".project-name")).toHaveText("beta");
  await expect(list.locator(".session-title").first()).toHaveText("xproj six");
  await expect(list.locator(".session")).toHaveCount(otherFake + 5);

  // The harness filter scopes it: only that harness's sessions of this folder show.
  await expect(list.locator(".session", { hasText: "xproj one" })).toHaveCount(0);
  await chooseHarness(page, "Fake B");
  await expect(focused.locator(".project-name")).toHaveText("beta");
  await expect(list.locator(".session")).toHaveCount(1);
  await expect(list.locator(".session", { hasText: "xproj one" }).locator(".harness-dot")).toHaveAttribute("aria-label", "Fake B");
  await expect(list.locator(".session", { hasText: "xproj six" })).toHaveCount(0);

  // A search covers every chat in one unscoped list: a Fake session in beta found from alpha's folder.
  await signInAndOpen(page, "alpha");
  await chooseHarness(page, "Fake");
  await expect(focused.locator(".project-name")).toHaveText("alpha");
  await page.getByRole("searchbox", { name: "Search sessions" }).fill("xproj four");
  await expect(page.locator(".session")).toHaveCount(1);
  await expect(page.locator(".session", { hasText: "xproj four" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search sessions" }).fill("xproj one");
  await expect(page.getByText("No matching sessions")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search sessions" }).fill("");

  // All projects lists each folder; opening a session in beta refocuses the list on it.
  await focused.getByRole("button", { name: "All projects" }).click();
  const groups = page.getByTestId("project-group");
  await expect(groups).toHaveCount(2);
  const beta = groups.filter({ has: page.locator(".project-name", { hasText: /^beta$/ }) });
  // The folded sessions of a folder open from "Show N more".
  await beta.getByRole("button", { name: /^Show \d+ more in beta$/ }).click();
  await beta.locator(".session", { hasText: "xproj four" }).click();
  await expect(prompts(page)).toHaveText(["xproj four"]);
  await expect(page.locator(".chat-header .chat-path")).toHaveText("beta");
  await expect(focused.locator(".project-name")).toHaveText("beta");
  await expect(list.locator(".session")).toHaveCount(otherFake + 5);

  // A session moves inside its date section from its menu, and keeps its place for every device.
  await list.getByRole("button", { name: "More for xproj five" }).click();
  await page.getByRole("menuitem", { name: "Move up" }).click();
  await expect(list.locator(".session-title").first()).toHaveText("xproj five");
  await page.reload();
  await expect(page.getByTestId("focused-project").locator(".project-name")).toHaveText("beta");
  await expect(list.locator(".session-title").first()).toHaveText("xproj five");
});

/**
 * Click something in the sidebar and report the transform the session list's
 * slide starts from. Sampled inside the page: a 190 ms move is gone before a
 * Playwright round trip can see it.
 */
async function slideFrom(page: Page, selector: string): Promise<string> {
  return page.evaluate(async (sel) => {
    const el = document.querySelector(".session-list");
    // A slide already running (the folder opened moments ago) would be read instead.
    el?.getAnimations().forEach((a) => a.cancel());
    (document.querySelector(sel) as HTMLElement | null)?.click();
    // Opening a folder can take a request first; wait up to ~2.5 s for the slide.
    for (let i = 0; i < 150; i++) {
      const a = el?.getAnimations()[0];
      if (a) return String((a.effect as KeyframeEffect | null)?.getKeyframes()[0]?.transform ?? "");
      await new Promise((r) => requestAnimationFrame(r));
    }
    return "none";
  }, selector);
}

test("the sidebar's list slides back when it returns to all projects", async ({ page }) => {
  await signInAndOpen(page);
  // Back out to all projects: the list comes from the left.
  expect(await slideFrom(page, '[data-testid="focused-project"] .focus-back')).toBe("translateX(-22px)");
  await expect(page.getByTestId("focused-project")).toHaveCount(0);
  // Into another folder, then ask for reduced motion: it returns the same way, without the slide.
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose a project folder" });
  await picker.getByLabel("Or type a path").fill(`${process.env.AWUI_E2E_ROOT as string}/beta`);
  await picker.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByTestId("focused-project").locator(".project-name")).toHaveText("beta");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await slideFrom(page, '[data-testid="focused-project"] .focus-back')).toBe("none");
  await expect(page.getByTestId("focused-project")).toHaveCount(0);
});

test("a deploy while the page stays open offers a reload", async ({ page, request }) => {
  await signInAndOpen(page);
  const { build } = (await (await request.get("/api/health")).json()) as { build: string };
  // The server now serves another build; the page still runs the one it loaded.
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true, build: `${build}-next` } }));
  // What happens when the app comes back to the foreground (an installed PWA has no reload button).
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByText("A new build is available.")).toBeVisible();
  // The palette carries the same escape hatch for a keyboard without a reload key.
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands and sessions" }).fill("reload the app");
  await expect(page.getByRole("option", { name: /Reload the app/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.unroute("**/api/health");
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  // Reloaded onto the real build: the strip is gone.
  await expect(page.getByText("A new build is available.")).toHaveCount(0);
});

test("a working session spins in the sidebar, also while another chat is open", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "slow spinner run");
  const row = page.locator(".session", { hasText: "slow spinner run" });
  await expect(row.getByRole("img", { name: "Working" })).toBeVisible();
  // Switch away: the run carries on in the background, in the folded Working section, and
  // spins there until it settles; then it is back in its project.
  await newChat(page);
  const working = page.getByTestId("working-group");
  await expect(working.locator(".working-ring").first()).toBeVisible();
  await working.getByRole("button", { name: /Working/ }).click();
  await expect(working.locator(".session", { hasText: "slow spinner run" }).getByRole("img", { name: "Working" })).toBeVisible();
  await expect(working).toHaveCount(0, { timeout: 15_000 });
  await expect(row.getByRole("img", { name: "Working" })).toHaveCount(0);
  await expect(row.locator(".live-dot")).toBeVisible();
});

test("/ opens the command menu: it filters, completes, runs, and closes", async ({ page }) => {
  await signInAndOpen(page);
  await openChat(page);
  const box = page.getByRole("textbox", { name: "Message" });
  const menu = page.getByRole("listbox", { name: "Commands" });
  await box.fill("/");
  // Skills wait under "$", not here.
  await expect(menu.getByRole("option")).toHaveText([/^\/new/, /^\/compact/, /^\/rename/, /^\/fake-status/]);
  // Typing filters; Enter completes the highlighted command, a second Enter runs it.
  await box.pressSequentially("fake");
  await expect(menu.getByRole("option")).toHaveCount(1);
  await box.press("Enter");
  await expectDraft(box).toBe("/fake-status ");
  await expect(menu).toBeHidden();
  await box.press("Enter");
  await expect(prompts(page).last()).toHaveText("/fake-status");
  await expect(page.getByText("fake status: all good")).toBeVisible();
  await expect(status(page)).toHaveText("Idle");
  // An app command, the same on every harness.
  await box.fill("/rename Better title");
  await box.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Better title");
  // Esc closes the menu and keeps the text.
  await box.fill("/re");
  await expect(menu).toBeVisible();
  await box.press("Escape");
  await expect(menu).toBeHidden();
  await expectDraft(box).toBe("/re");
});

test("a finished turn forks into a new chat holding just that turn", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "first question");
  await sendAndWait(page, "second question");
  await expect(prompts(page)).toHaveText(["first question", "second question"]);
  // The fork button lives on a finished answer; the copy opens in its place.
  await page.getByTestId("answer").first().getByRole("button", { name: "Fork from here" }).click();
  await expect(prompts(page)).toHaveText(["first question"]);
  await expect(status(page)).toHaveText("Idle");
  await expect(page.getByTestId("turn")).toHaveCount(1);
});

test("composer harness chip hands the chat off to another harness", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "first tool question");
  await expect(prompts(page)).toHaveText(["first tool question"]);
  // The chip shows the current harness; its menu lists the others.
  await page.getByRole("button", { name: "Hand off to another harness" }).click();
  const targets = page.getByRole("listbox", { name: "Hand off to" });
  // The chat's own harness is listed but cannot be picked; a target says how it continues.
  await expect(targets.getByRole("option", { name: "Fake", exact: true })).toHaveAttribute("aria-disabled", "true");
  await expect(targets.getByRole("option", { name: "Fake B", exact: true })).toContainText("Copies the conversation");
  await targets.getByRole("option", { name: "Fake B", exact: true }).click();
  await expect(page.locator(".chat-sub .badge")).toHaveText("Fake B");
  await expect(prompts(page)).toHaveText(["first tool question"]);
  await expect(status(page)).toHaveText("Idle");
  await expect(page.getByText(/Continued in .*model reset to default/)).toBeVisible();
});

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("images can be pasted, dropped, or picked, then removed or sent with the prompt", async ({ page }) => {
  await signInAndOpen(page);
  await openChat(page);
  const box = page.getByRole("textbox", { name: "Message" });
  const strip = page.getByRole("list", { name: "Attached images" });
  const fire = (type: "paste" | "drop", selector: string) =>
    page.evaluate(
      ({ type, selector, b64 }) => {
        const dt = new DataTransfer();
        dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], "shot.png", { type: "image/png" }));
        const target = document.querySelector(selector) as HTMLElement;
        if (type === "paste") target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
        else for (const t of ["dragover", "drop"]) target.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
      },
      { type, selector, b64: PNG_1X1 },
    );

  // A screenshot on the clipboard, a dropped file, and one from the picker.
  await fire("paste", ".composer-input");
  await expect(strip.getByRole("img")).toHaveCount(1);
  // Each thumbnail carries its number and size, to refer to it by.
  await expect(strip.locator(".image-label strong")).toHaveText("#1");
  await expect(strip.locator(".image-label span")).toHaveText("1×1");
  await page.getByRole("button", { name: "View image #1" }).click();
  const viewer = page.getByRole("dialog", { name: "Image #1" });
  await expect(viewer.getByRole("img", { name: "Image #1, 1×1" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  await fire("drop", ".composer-card");
  await expect(strip.getByRole("img")).toHaveCount(2);
  await expect(strip.locator(".image-label strong")).toHaveText(["#1", "#2"]);
  // The viewer steps through them with the arrow keys.
  await page.getByRole("button", { name: "View image #1" }).click();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("dialog", { name: "Image #2" })).toContainText("2 of 2");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.locator('.composer input[type="file"]').setInputFiles({ name: "c.png", mimeType: "image/png", buffer: Buffer.from(PNG_1X1, "base64") });
  await expect(strip.getByRole("img")).toHaveCount(3);
  await page.getByRole("button", { name: "Remove image #3" }).click();
  await page.getByRole("button", { name: "Remove image #2" }).click();
  await expect(strip.getByRole("img")).toHaveCount(1);
  await expect(box).toHaveAttribute("aria-placeholder", "Say what to do with the image…");

  // A text-only model is called out.
  const pick = async (query: string) => {
    await page.getByTestId("model-picker").click();
    await page.getByRole("combobox", { name: "Search models" }).fill(query);
    await page.keyboard.press("Enter");
  };
  await pick("glm");
  await expect(page.getByText(/GLM-5\.3-Flash does not take image input/)).toBeVisible();
  await pick("fake echo");
  await expect(page.getByText(/does not take image input/)).toHaveCount(0);

  // An image needs words to go with it; then both are sent.
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await sendAndWait(page, "what is in this screenshot?");
  await expect(strip).toHaveCount(0);
  // The prompt keeps the picture itself, numbered, and it opens in the viewer.
  const sent = page.getByTestId("turn").last().getByRole("list", { name: "Images" });
  const loaded = (list: typeof sent) => list.getByRole("img", { name: "Image #1" }).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
  await expect.poll(() => loaded(sent)).toBe(true);
  await expect(sent.locator(".image-label strong")).toHaveText("#1");
  await expect(sent.locator(".image-label span")).toHaveText("1×1");
  await sent.getByRole("button", { name: "View image #1" }).click();
  await expect(page.getByRole("dialog", { name: "Image #1" })).toContainText("1×1");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  // After a reload it comes back from the session.
  await page.reload();
  const again = page.getByTestId("turn").last().getByRole("list", { name: "Images" });
  await expect.poll(() => loaded(again)).toBe(true);
});

test("a window is captured straight into the composer, and a refusal is one line", async ({ page }) => {
  // The real picker would hang the test: a canvas stream stands in for the screen.
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
      configurable: true,
      value: async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 18;
        const context = canvas.getContext("2d") as CanvasRenderingContext2D;
        context.fillStyle = "#7daea3";
        context.fillRect(0, 0, 32, 18);
        return canvas.captureStream(5);
      },
    });
  });
  await signInAndOpen(page);
  await openChat(page);
  const strip = page.getByRole("list", { name: "Attached images" });
  const box = page.getByRole("textbox", { name: "Message" });
  await page.getByRole("button", { name: "Capture a screenshot" }).click();
  await expect(strip.getByRole("img")).toHaveCount(1);
  await expect(strip.locator(".image-label strong")).toHaveText("#1");
  await expect(strip.locator(".image-label span")).toHaveText("32×18");
  await expect(box).toHaveAttribute("aria-placeholder", "Say what to do with the image…");

  // A capture that fails says why; closing the picker leaves no note at all.
  await page.evaluate(() => {
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
      configurable: true,
      value: async () => {
        throw new DOMException("Could not start video source", "NotReadableError");
      },
    });
  });
  await page.getByRole("button", { name: "Capture a screenshot" }).click();
  await expect(page.locator(".composer-note", { hasText: "Could not start video source" })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
      configurable: true,
      value: async () => {
        throw new DOMException("closed", "NotAllowedError");
      },
    });
  });
  await page.getByRole("button", { name: "Capture a screenshot" }).click();
  await expect(page.locator(".composer-note")).toHaveCount(0);
  await expect(strip.getByRole("img")).toHaveCount(1);
});

test("the capture button stays out of a browser that cannot capture", async ({ page }) => {
  await page.addInitScript(() => {
    if (navigator.mediaDevices) Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", { configurable: true, value: undefined });
  });
  await signInAndOpen(page);
  await openChat(page);
  await expect(page.getByRole("button", { name: "Capture a screenshot" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Attach images" })).toBeVisible();
});

test("buttons show a Material ripple from the press point; reduced motion turns it off", async ({ page }) => {
  await signInAndOpen(page);
  const btn = page.getByRole("button", { name: "Refresh sessions" });
  const box = (await btn.boundingBox()) as { x: number; y: number; width: number; height: number };
  const px = box.x + 6;
  const py = box.y + box.height / 2;
  await page.mouse.move(px, py);
  await page.mouse.down();
  const ink = btn.locator(".ripple");
  await expect(ink).toHaveCount(1);
  const inkBox = (await ink.boundingBox()) as { x: number; y: number; width: number; height: number };
  expect(Math.abs(inkBox.x + inkBox.width / 2 - px)).toBeLessThan(3);
  expect(Math.abs(inkBox.y + inkBox.height / 2 - py)).toBeLessThan(3);
  await expect(btn).toHaveAccessibleName("Refresh sessions");
  await page.mouse.up();
  await expect(ink).toHaveCount(0, { timeout: 3000 });
  await btn.focus();
  await page.keyboard.press("Enter");
  await expect(ink).toHaveCount(1);
  await expect(ink).toHaveCount(0, { timeout: 3000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.mouse.down();
  await page.mouse.up();
  await expect(ink).toHaveCount(0);
  expect(await btn.locator(".ripple").count()).toBe(0);
});

test("a button that re-renders on its own click keeps its ripple inside it", async ({ page }) => {
  await signInAndOpen(page);
  await showSidebar(page);
  await page.getByRole("button", { name: /^Usage/ }).first().click();
  // Choosing a range re-renders its button (is-on) while the ink is still fading: the clip must survive that.
  const btn = page.getByRole("dialog", { name: "Usage" }).getByRole("button", { name: "90 days" });
  await expect(btn).toBeVisible();
  await btn.click();
  const clip = btn.locator(".ripple-clip");
  await expect(clip).toHaveCount(1);
  expect(await clip.evaluate((el) => getComputedStyle(el).overflow)).toBe("hidden");
  const [inner, outer] = [await clip.boundingBox(), await btn.boundingBox()];
  expect(Math.abs(inner!.width - outer!.width)).toBeLessThan(1);
  expect(Math.abs(inner!.height - outer!.height)).toBeLessThan(1);
  await expect(clip).toHaveCount(0, { timeout: 3000 });
});

test("the sidebar collapses and expands from its header, and stays that way", async ({ page }) => {
  await signInAndOpen(page);
  const sidebar = page.locator(".sidebar");
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(sidebar).toBeHidden();
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeFocused();
  const mainLeft = () => page.locator(".main").evaluate((el) => el.getBoundingClientRect().left);
  await expect.poll(mainLeft).toBeLessThan(2);
  await page.reload();
  await expect(page.locator(".chat-header")).toBeVisible();
  await expect(sidebar).toBeHidden();
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(sidebar).toBeVisible();
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toHaveCount(0);
  await expect.poll(mainLeft).toBeGreaterThan(200);
  // Phones keep the drawer: no collapse toggle there.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeHidden();
});

test("narrow windows fold the sidebar away, and a sidebar collapsed by hand stays collapsed", async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 860 });
  await signInAndOpen(page);
  const sidebar = page.locator(".sidebar");
  const expand = page.getByRole("button", { name: "Expand sidebar" });
  await expect(sidebar).toBeVisible();
  // A vertical monitor or a tiled half screen.
  await page.setViewportSize({ width: 1080, height: 1800 });
  await expect(sidebar).toBeHidden();
  // Reopened by hand, it stays open in the narrow window, until the width crosses back and forth.
  await expand.click();
  await expect(sidebar).toBeVisible();
  await page.setViewportSize({ width: 1360, height: 860 });
  await expect(sidebar).toBeVisible();
  await page.setViewportSize({ width: 980, height: 1060 });
  await expect(sidebar).toBeHidden();
  // Collapsed with the button: resizing does nothing.
  await expand.click();
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await page.setViewportSize({ width: 1360, height: 860 });
  await expect(sidebar).toBeHidden();
  await page.setViewportSize({ width: 1080, height: 1800 });
  await expect(sidebar).toBeHidden();
});

test("the sidebar is resizable by drag and keyboard, and remembers its width", async ({ page }) => {
  await page.goto("/");
  const sidebar = page.locator(".sidebar");
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  const width = async () => (await sidebar.boundingBox())?.width ?? 0;
  expect(Math.round(await width())).toBe(272);
  const box = (await handle.boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + 200, { steps: 6 });
  await page.mouse.up();
  expect(Math.round(await width())).toBe(392);
  await page.reload();
  expect(Math.round(await width())).toBe(392);
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  expect(Math.round(await width())).toBe(376);
  await page.keyboard.press("Home");
  expect(Math.round(await width())).toBe(200);
  // Dragging far past the limit clamps instead of swallowing the chat.
  const b2 = (await handle.boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.move(b2.x + 3, b2.y + 200);
  await page.mouse.down();
  await page.mouse.move(b2.x + 1200, b2.y + 200, { steps: 4 });
  await page.mouse.up();
  expect(Math.round(await width())).toBe(560);
  await handle.dblclick();
  expect(Math.round(await width())).toBe(272);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(handle).toBeHidden();
});

test("the model picker keeps its search and Current line intact when the list overflows", async ({ page }) => {
  // A short window forces the list to scroll inside the minimum-height popover.
  await page.setViewportSize({ width: 1360, height: 420 });
  await signInAndOpen(page);
  await openChat(page);
  await page.getByTestId("model-picker").click();
  const dialog = page.getByRole("dialog", { name: "Choose a model" });
  await expect(dialog).toBeVisible();
  const clipped = await dialog.evaluate((el) => {
    const parts = [".model-search", ".model-current"].map((sel) => el.querySelector(sel) as HTMLElement);
    const list = el.querySelector(".model-list") as HTMLElement;
    return {
      parts: parts.map((p) => ({ clipped: p.scrollHeight > p.clientHeight + 1, height: p.getBoundingClientRect().height })),
      listScrolls: list.scrollHeight > list.clientHeight,
    };
  });
  expect(clipped.listScrolls).toBe(true);
  for (const part of clipped.parts) {
    expect(part.clipped).toBe(false);
    expect(part.height).toBeGreaterThan(24);
  }
  await expect(dialog.locator(".model-current")).toBeInViewport({ ratio: 1 });
});

test("an extension's message (a memory recall) shows as a labelled row, not its raw envelope", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "recall what you know");
  await page.getByTestId("process-toggle").last().click();
  const row = page.getByTestId("extension-message").last();
  // Closed, it is just its label; the text is one click away, without the envelope.
  await expect(row).toHaveText("Memory");
  await expect(page.getByText("<memory>")).toHaveCount(0);
  // It sits in the card's gutter: its icon lines up with every other row's, not at the card's edge.
  const centres = await page.locator(".process-card").filter({ has: row }).evaluate((card) =>
    [...card.querySelectorAll(".process-body .drow-lead, .process-body .kind-chip")].map((n) => {
      const box = n.getBoundingClientRect();
      return Math.round(box.left + box.width / 2);
    }),
  );
  expect(centres.length).toBeGreaterThan(1);
  expect(new Set(centres).size).toBe(1);
  await row.getByRole("button").first().click();
  await expect(row).toContainText("Your memory book: notes about the user.");
  await expect(row).toContainText("- prefers tabs over spaces");
});

test("a MoA reference's advice opens as formatted Markdown under its model", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "moaref please");
  await page.getByTestId("process-toggle").last().click();
  const first = page.getByTestId("extension-message").filter({ hasText: "MoA · opencode-go:glm-5.3-flash" });
  await expect(first).toContainText("opencode-go:glm-5.3-flash (1/2)");
  await first.locator(".drow-head").click();
  // The advice is the model's Markdown, not its source: a heading and inline code render.
  await expect(first.locator(".notice-markdown h2")).toHaveText("Advice one");
  await expect(first.locator(".notice-markdown code")).toHaveText("cache");
  const second = page.getByTestId("extension-message").filter({ hasText: "deepseek-v4.1-flash" });
  await second.locator(".drow-head").click();
  await expect(second.locator(".notice-markdown li")).toHaveText(["fast", "cheap"]);
});

test("subagents show live, then their answers, and open their own transcripts", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "run subagents please");
  // Seen working, the delegation is open: one agent running, the other queued.
  const row = page.locator('[data-testid="tool-row"][data-tool="subagent"]');
  await expect(row.locator(".run-status.is-running")).toHaveCount(1);
  // The running agent's latest command, whichever of the two runs when this looks (the scout first, then the worker).
  await expect(row.locator(".run-activity")).toContainText(/bash (rg -n listen src|sed -n 1,40p src\/server\.ts)/);
  // The job strip above the composer mirrors the run, and leaves when it settles.
  await expect(page.getByTestId("job-progress")).toContainText(/1 running agents/);
  await expect(page.locator(".answer-actions")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("job-progress")).toHaveCount(0);
  await openFold(page);
  // Settled, it opens like any other row (one call is its own card, which may have stayed open from the run).
  const head = row.getByRole("button").first();
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  await expect(row.locator(".runs")).toBeVisible();
  await expect(row.locator(".tool-sentence")).toHaveText("Ran 2 agents: scout, worker");
  await expect(row.locator(".tool-card-meta")).toHaveText("2/2 done");
  await expect(row.locator(".run-agent")).toHaveText(["scout", "worker"]);
  await row.locator(".run-head").first().click();
  await expect(row.locator(".run-brief")).toContainText("Find where the server starts listening.");
  await expect(row.locator(".run-output")).toContainText("src/server.ts:13");
  await row.getByRole("button", { name: "Open transcript" }).click();
  const panel = page.getByRole("dialog", { name: "Transcript of 0" });
  await expect(panel.locator(".run-panel-brief")).toContainText("Task: Find where the server starts listening.");
  await expect(panel.getByTestId("tool-row")).toHaveAttribute("data-tool", "bash");
  await expect(panel.locator(".run-panel-text")).toContainText("calls listen(port, host)");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

test("a chat's link opens it in its own project, in a browser that never chose one", async ({ page, browser }) => {
  await signInAndOpen(page, "beta");
  await newChat(page);
  await sendAndWait(page, "hello from beta");
  const hash = await page.evaluate(() => window.location.hash);
  expect(hash).toMatch(/^#chat=/);
  // A fresh browser (no remembered project), as when following the link atui or awui tern print on quitting.
  const context = await browser.newContext();
  const fresh = await context.newPage();
  await fresh.goto(`/${hash}`);
  await expect(fresh.getByTestId("answer").last()).toContainText("Echo: hello from beta");
  await showSidebar(fresh);
  await expect(fresh.locator(".project-name", { hasText: "beta" })).toBeVisible();
  await context.close();
});

test("a tool's full output opens in its own sheet, with Copy", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  // An output longer than its row shows: a short one is all there already, with no button for more.
  await sendAndWait(page, "hello big");
  await openFold(page);
  // A tool row's body (and its button) shows once that row is opened; take the first with output.
  const rows = page.getByTestId("tool-row");
  const count = await rows.count();
  let opened = false;
  for (let i = 0; i < count && !opened; i++) {
    const row = rows.nth(i);
    await row.getByRole("button").first().click();
    const button = row.getByRole("button", { name: "Full output" });
    if ((await button.count()) > 0) {
      await button.click();
      opened = true;
    }
  }
  expect(opened).toBe(true);
  const sheet = page.getByRole("dialog", { name: /^Output · / });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".output-body")).not.toBeEmpty();
  await expect(sheet.getByRole("button", { name: "Copy" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});

test("a sticky bar names the prompt once it has scrolled off, and goes back to it", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await signInAndOpen(page);
  await newChat(page);
  // "slow" makes a long answer, so the chat ends with the prompt far above the view.
  await sendAndWait(page, "slow sticky walrus");
  const bar = page.getByRole("button", { name: /^Back to prompt #1: slow sticky walrus/ });
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("#1");
  await expect(bar).toContainText("slow sticky walrus");
  await expect(prompts(page).first()).not.toBeInViewport();
  // It overlays the top of the conversation: it takes no room from the thread.
  const conversation = page.locator(".conversation");
  const [barBox, viewBox] = [await bar.boundingBox(), await conversation.boundingBox()];
  expect(barBox!.y).toBeCloseTo(viewBox!.y, 0);
  expect(barBox!.height).toBeLessThanOrEqual(32);
  // Find owns the top corner while it is open.
  await page.locator(".chat-header h1").click();
  await page.keyboard.press("Control+KeyF");
  await expect(page.getByRole("searchbox", { name: "Find in chat" })).toBeFocused();
  await expect(bar).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("searchbox", { name: "Find in chat" })).toBeHidden();
  await expect(bar).toBeVisible();
  // Click: back at the prompt, and the bar is gone.
  await bar.click();
  await expect(prompts(page).first()).toBeInViewport();
  await expect(bar).toBeHidden();
  // Down into the answer again: it returns. A second turn is named #2 once its own prompt scrolls off.
  await page.locator(".conversation").evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(bar).toBeVisible();
  await sendAndWait(page, "slow sticky wombat");
  await expect(page.getByRole("button", { name: /^Back to prompt #2: slow sticky wombat/ })).toBeVisible();
});

test("the sticky bar goes back at once under reduced motion, and from the keyboard", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1200, height: 700 });
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "slow sticky reading");
  const bar = page.getByRole("button", { name: /^Back to prompt #1:/ });
  await expect(bar).toBeVisible();
  await bar.focus();
  await page.keyboard.press("Enter");
  await expect(prompts(page).first()).toBeInViewport();
  await expect(bar).toBeHidden();
});

test("Copy turn as Markdown puts the prompt, a line per tool call, and the answer on the clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "please edit the app");
  const turn = page.getByTestId("turn").last();
  await turn.getByRole("button", { name: "Copy turn as Markdown" }).click();
  // The button says so, briefly, as the reply's Copy does.
  await expect(turn.getByRole("button", { name: "Turn copied" })).toBeVisible();
  const md = () => page.evaluate(() => navigator.clipboard.readText());
  await expect.poll(md).toContain("## Prompt\n\nplease edit the app");
  const text = await md();
  expect(text).toContain("## Work");
  expect(text).toMatch(/^- \*\*Edit\*\* `src\/app\.ts` \(\+1 −1\)$/m);
  expect(text).toContain("## Answer");
  // Only the one-line summaries: the edit's diff and output are not in it.
  expect(text).not.toContain("Edited src/app.ts");
});

test("each stretch of a turn's work opens on its own", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  // Work, a reply, then more work: two folds in one turn (each of more than one call, so each has its header).
  await sendAndWait(page, "showcase interleaved ticking");
  const folds = page.getByTestId("process-toggle");
  await expect(folds).toHaveCount(2);
  await expect(folds.nth(0)).toHaveAttribute("aria-expanded", "false");
  await expect(folds.nth(1)).toHaveAttribute("aria-expanded", "false");
  await folds.nth(0).click();
  await expect(folds.nth(0)).toHaveAttribute("aria-expanded", "true");
  await expect(folds.nth(1)).toHaveAttribute("aria-expanded", "false");
  await folds.nth(1).click();
  await folds.nth(0).click();
  await expect(folds.nth(0)).toHaveAttribute("aria-expanded", "false");
  await expect(folds.nth(1)).toHaveAttribute("aria-expanded", "true");
});

test("a thought reads itself out while it streams, then folds to one line when the tool call starts", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "slowthought please");
  // The answer has a thought row of its own later; pin this one by its text.
  const thought = page.getByTestId("thought-row").filter({ hasText: "Looking for the card's model" });
  const head = thought.locator(".drow-head");
  // Streaming: it is open by itself, so its text is readable as it arrives.
  await expect(head).toHaveAttribute("aria-expanded", "true");
  await expect(thought.locator(".thought-body")).toBeVisible();
  // The command starts: the row folds back to its first line, without a click.
  await expect(head).toHaveAttribute("aria-expanded", "false", { timeout: 20_000 });
  await expect(thought).toContainText("Looking for the card's model");
  await expect(thought.locator(".thought-body")).toBeHidden();
  // Once it is past, a click still opens it for reading.
  await head.click();
  await expect(thought.locator(".thought-body")).toBeVisible();
});

test("work above a reply folds away as the reply lands, while the work after it stays open", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "workreply slow please");
  const turn = page.getByTestId("turn").last();
  const cards = turn.locator(".process-card");
  await expect(turn.getByTestId("interim-reply")).toContainText("The build is fine");
  // The stretch the agent is working in holds the command, and stays open...
  await expect(cards.last()).toContainText("npm test");
  await expect(cards.last().getByTestId("process-toggle")).toHaveAttribute("aria-expanded", "true");
  // ...while the one that ended in the reply has been read, so it folds shut on its own.
  await expect(cards.first().getByTestId("process-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 20_000 });
  // Settled, everything is shut, as an old chat opens.
  await expect(cards.first().getByTestId("process-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(cards.last().getByTestId("process-toggle")).toHaveAttribute("aria-expanded", "false");
});
