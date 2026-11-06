import { expect, test } from "@playwright/test";
import { newChat, send, sendAndWait, signInAndOpen } from "./helpers.js";

// The tool card: a run of calls as one card with a header, sentence rows, facts, and a status column.

test("a run of calls is one card: a header that counts and stacks the kinds, a sentence and a mark per row", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "showcase");
  const toggle = page.getByTestId("process-toggle").last();
  await expect(toggle).toContainText("Used 9 tools");
  // More kinds of tool than the stack draws: the rest are counted.
  const stack = toggle.getByTestId("kind-stack");
  await expect(stack.locator(".kind-chip")).toHaveCount(4);
  await expect(stack.locator(".kind-more")).toHaveText("+5");
  await toggle.click();
  const rows = page.getByTestId("tool-row");
  await expect(rows).toHaveCount(9);
  await expect(rows.first().locator(".tool-sentence")).toHaveText("Edited src/server.ts");
  await expect(page.locator('[data-tool="bash"] .tool-sentence')).toHaveText("Ran npm test -- --run tool-diff");
  await expect(page.locator('[data-tool="bash"] .tool-fact')).toHaveText("5 passed");
  await expect(page.locator('[data-tool="grep"] .tool-fact')).toHaveText("2 results in 2 files");
  await expect(page.locator('[data-tool="web_fetch"] .tool-sentence')).toHaveText("Fetched example.com/docs/listen");
  // Every row has its mark in one column, and the button's name is the whole sentence and its state.
  await expect(rows.locator('.tool-status[aria-label="done"]')).toHaveCount(9);
  await expect(page.locator('[data-tool="grep"] .tool-head')).toHaveAccessibleName("Searched for listen\\( in src, 2 results in 2 files, done");
});

test("a test run's summary is read from its output: the counts and the failing test", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  // One call is its own card: its row is in view without opening anything.
  await sendAndWait(page, "testrun");
  const row = page.locator('[data-tool="bash"]');
  await expect(row.locator(".tool-fact")).toHaveText("1 passed · 1 failed");
  await expect(row.getByTestId("tool-error")).toHaveText("keeps the order of two lists");
});

test("an opened call is one tile: the sentence keeps its verb and facts, the body says the command and the reason once", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "testrun");
  const row = page.locator('[data-tool="bash"]');
  const head = row.locator(".tool-head");
  await expect(head.locator(".tool-target")).toBeVisible();
  await expect(row.getByTestId("tool-error")).toBeVisible();
  await head.click();
  // The whole command is in the body, so the sentence leaves it out; the failing test is in the output.
  await expect(row.locator(".term-command")).toBeVisible();
  await expect(head.locator(".tool-target")).toBeHidden();
  await expect(head.locator(".tool-verb")).toHaveText("Ran");
  await expect(head.locator(".tool-fact")).toHaveText("1 passed · 1 failed");
  await expect(row.getByTestId("tool-error")).toBeHidden();
  // The button still names the whole call.
  await expect(head).toHaveAccessibleName(/^Ran npm test/);
  // Shut again, the sentence says it all.
  await head.click();
  await expect(head.locator(".tool-target")).toBeVisible();
  await expect(row.getByTestId("tool-error")).toBeVisible();
});

test("thinking shaped like narration folds as a Thought, and its wide line wraps inside the card once opened", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  // Two calls with thinking between that has a list, bold, and a code line far wider than the column: still a thought.
  await sendAndWait(page, "widethought");
  const card = page.locator(".process-card").last();
  const toggle = card.getByTestId("process-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(card.locator(".process-text")).toHaveCount(0);
  const thought = card.getByTestId("thought-row").filter({ hasText: "Key findings:" });
  await expect(thought).toHaveCount(1);
  const body = thought.locator(".thought-body");
  await expect(body).toBeHidden();
  await thought.getByRole("button").first().click();
  await expect(body).toBeVisible();
  // Settled (the card's fold and the thought's both), the bodies stop clipping; the thought's column must still be the card's.
  await expect(card.locator(".collapse.is-unfurl.is-settled")).toHaveCount(1);
  await expect(thought.locator(".collapse.is-settled")).toHaveCount(1);
  const [cardWidth, bodyWidth] = await Promise.all([card.evaluate((el) => el.clientWidth), body.evaluate((el) => el.getBoundingClientRect().width)]);
  expect(bodyWidth).toBeLessThanOrEqual(cardWidth);
});

test("a failed call tints its row with the reason, opens its card, and the tally goes to it", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  // Two calls, so the card has a header and its tally.
  await sendAndWait(page, "tool toolfail");
  const toggle = page.getByTestId("process-toggle").last();
  // Settled, the card is shut like every other one: the failure shows as the tally and the tint...
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("failed-tally")).toHaveText("1 failed");
  await page.getByTestId("failed-tally").click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const row = page.locator('[data-tool="bash"]');
  await expect(row).toHaveAttribute("data-status", "error");
  await expect(row.locator(".tool-sentence")).toContainText("Couldn't run npm run e2e");
  await expect(row.getByTestId("tool-error")).toHaveText("Error: port 4791 is already in use");
  // One line: the reason shares the sentence's line, and the row is no taller than its head.
  const [sentenceBox, reasonBox] = [await row.locator(".tool-sentence").boundingBox(), await row.getByTestId("tool-error").boundingBox()];
  expect(reasonBox!.y).toBeLessThan(sentenceBox!.y + sentenceBox!.height);
  const [rowBox, headBox] = [await row.boundingBox(), await row.locator(".tool-head").boundingBox()];
  expect(rowBox!.height).toBeLessThanOrEqual(headBox!.height + 2);
  await expect(row.locator('.tool-status[aria-label="failed"]')).toBeVisible();
  // The harness reported exit 1, so the row carries it as a fact beside the reason.
  await expect(row.locator(".tool-fact")).toHaveText("exit 1");
  // The row's name carries the reason, since the name replaces the text inside it.
  await expect(row.locator(".tool-head")).toHaveAccessibleName(/Couldn't run npm run e2e, exit 1, Error: port 4791 is already in use,\s*(?:[^,]+, )?failed/);
  const tint = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(tint).not.toBe("rgba(0, 0, 0, 0)");
  // Closed, the tally opens the card and puts focus on the failed row.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.getByTestId("failed-tally").click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(row.locator(".tool-head")).toBeFocused();
  // A body that has fully left after closing (its rows unmount 330 ms later) must still take the focus.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.waitForTimeout(400);
  await page.getByTestId("failed-tally").click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(row.locator(".tool-head")).toBeFocused();
});

test("find in chat opens a closed card that holds the match", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "showcase");
  const toggle = page.getByTestId("process-toggle").last();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.locator(".chat-header h1").click();
  await page.keyboard.press("Control+KeyF");
  await page.getByRole("searchbox", { name: "Find in chat" }).fill("results in 2 files");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('[data-tool="grep"] .tool-fact')).toBeVisible();
});

test("a running call reads in the present tense with a spinner, then settles with its mark", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await page.getByRole("textbox", { name: "Message" }).fill("ticking");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const row = page.locator('[data-tool="bash"]');
  await expect(row.locator(".tool-sentence")).toHaveText("Running npm test");
  await expect(row.locator('.tool-status[aria-label="running"]')).toBeVisible();
  await expect(row.locator(".tool-sentence")).toHaveText("Ran npm test", { timeout: 20_000 });
  await expect(row.locator('.tool-status[aria-label="done"]')).toBeVisible();
});

test("Ask to retry sends a prompt naming the call when idle, and only the latest turn has it", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "toolfail");
  const retry = page.getByRole("button", { name: "Ask the agent to retry running npm run e2e" });
  await expect(retry).toBeVisible();
  await expect(retry).toHaveAttribute("title", "Ask to retry");
  // The button shares the call's line: the failed row is one line, not two.
  const [retryBox, sentenceBox] = [await retry.boundingBox(), await page.locator('[data-tool="bash"] .tool-sentence').last().boundingBox()];
  expect(retryBox!.y).toBeLessThan(sentenceBox!.y + sentenceBox!.height);
  // It lies over its unseen twin in the row, which keeps the status mark and chevron in the rows' column.
  const room = await page.locator('[data-tool="bash"] .tool-retry-room').last().boundingBox();
  expect(Math.abs(retryBox!.x - room!.x)).toBeLessThan(1);
  expect(Math.abs(retryBox!.width - room!.width)).toBeLessThan(1);
  await retry.click();
  await expect(page.getByTestId("user-prompt").last()).toHaveText("Retry the failed tool call (running npm run e2e). It failed with: Error: port 4791 is already in use");
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 20_000 });
  // The older turn's failed call no longer offers it.
  await expect(retry).toHaveCount(0);
});

test("an earlier turn's failed call has no retry while a new turn runs", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "toolfail");
  await send(page, "slow please");
  await expect(page.getByRole("button", { name: /^Ask the agent to retry/ })).toHaveCount(0);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("the facts sit under the sentence and the retry stays on the call's line", async ({ page }) => {
    await signInAndOpen(page);
    await page.keyboard.press("Escape");
    await newChat(page);
    await sendAndWait(page, "testrun toolfail");
    // Settled cards are shut (their bodies unmount after the shut): open the card before measuring its rows.
    const toggle = page.getByTestId("process-toggle").last();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    // Settled with a tally, the header gives the check's room back to its label, which then fits whole.
    await expect(toggle.getByTestId("process-status")).toBeHidden();
    expect(await toggle.locator(".process-label").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const row = page.locator('[data-tool="bash"]').first();
    const [sentence, facts] = [await row.locator(".tool-sentence").boundingBox(), await row.locator(".tool-facts").boundingBox()];
    expect(facts!.y).toBeGreaterThan(sentence!.y + sentence!.height - 4);
    const failed = page.locator('[data-status="error"]');
    const [button, card] = [await failed.getByRole("button", { name: /^Ask the agent to retry/ }).boundingBox(), await failed.boundingBox()];
    // One line: the button sits inside the call's row, finger-sized, not under it.
    expect(button!.y).toBeGreaterThanOrEqual(card!.y - 1);
    expect(button!.y + button!.height).toBeLessThanOrEqual(card!.y + card!.height + 1);
    expect(button!.width).toBeLessThan(card!.width * 0.7);
    expect(button!.height).toBeGreaterThanOrEqual(32);
    // The retry holds its own room in the row: the failed call's mark stays in the passing call's column.
    const [failedMark, passedMark] = [await failed.locator(".tool-status").boundingBox(), await row.locator(".tool-status").boundingBox()];
    expect(Math.abs(failedMark!.x - passedMark!.x)).toBeLessThan(1);
  });
});

test("the working label names what the agent is doing, then settles on Worked for", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  // Two calls: a settled card of one call drops its header, and this checks the header's last word.
  await send(page, "tool ticking");
  const toggle = page.getByTestId("process-toggle").last();
  const phase = toggle.getByRole("status");
  await expect(phase).toHaveText("Running npm test");
  await expect(toggle).toHaveText(/Worked for \d+s · Used 2 tools/, { timeout: 20_000 });
  await expect(toggle.getByRole("status")).toHaveCount(0);
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("a settled mark and the card's chevron do not animate", async ({ page }) => {
    await signInAndOpen(page);
    await newChat(page);
    await sendAndWait(page, "tool ticking");
    await page.getByTestId("process-toggle").last().click();
    const animated = await page.locator(".tool-row .tool-status > svg, .process-chevron").evaluateAll((els) => els.map((el) => getComputedStyle(el).animationName + getComputedStyle(el).transitionDuration));
    for (const a of animated) expect(a).toMatch(/^none0s/);
  });
});

test("a running test command shows how far it has got, and the bar goes when it settles", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "e2eprogress");
  const meter = page.getByTestId("test-meter");
  const bar = meter.getByRole("progressbar", { name: "Tests" });
  // Playwright announced 8 tests; the bar counts them as they go, the failure in red.
  await expect(bar).toHaveAttribute("aria-valuemax", "8");
  await expect.poll(async () => Number(await bar.getAttribute("aria-valuenow")), { timeout: 10_000 }).toBeGreaterThanOrEqual(4);
  await expect(meter.getByText("1 failed")).toBeVisible();
  await expect(meter.locator(".test-meter-now")).toContainText("tests/e2e/tabs.spec.ts");
  // Settled, the row's facts take over and the live bar leaves.
  await expect(page.locator(".answer-actions").last()).toBeVisible({ timeout: 20_000 });
  await expect(meter).toHaveCount(0);
});
