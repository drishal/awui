import { expect, test } from "@playwright/test";
// Assert navigations and workflow, not a screenshot/product claim. Real native cards and native scope only.
import { signInAndOpen, newChat, sendAndWait, send } from "./helpers.js";

test("work happens along with its chart: context count follows the original tool", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "subagents");
  const panel = page.getByRole("complementary", { name: "Chat context" });
  // One group has rows, so it is the only one with a count: an empty group is left out, not shown as "0".
  await expect(panel.getByRole("heading", { name: "Agents and lineage" })).toBeVisible();
  await expect(panel.locator(".context-count")).toHaveCount(1);
  await expect(panel.locator(".context-count").first()).toHaveText("2");
  await expect(panel.getByRole("heading", { name: "Background jobs" })).toHaveCount(0);
  // Where the project stands is one row above the groups (the header already names the chat and project),
  // and each run reads one status word.
  const gitRow = panel.locator(".context-git");
  const chatId = /chat=([^&]+)/.exec(new URL(page.url()).hash)?.[1];
  // The row is painted only after /api/chats/:id/git returns a status. Wait for that
  // answer; if this folder has no readable repo, skip the row and keep asserting the rail.
  let gitStatus: unknown = null;
  if (chatId) {
    await expect.poll(async () => {
      const res = await page.request.get(`/api/chats/${encodeURIComponent(chatId)}/git`);
      gitStatus = ((await res.json()) as { status: unknown | null }).status;
      return gitStatus !== undefined;
    }, { timeout: 10_000 }).toBeTruthy();
  }
  if (gitStatus) {
    await page.getByRole("button", { name: "GitHub", exact: true }).click();
    await expect(gitRow).toBeVisible();
    await expect(gitRow.locator(".context-git-branch")).not.toBeEmpty();
    await expect(gitRow.getByRole("button", { name: "Review changes" })).toBeVisible();
    await page.getByRole("button", { name: "GitHub", exact: true }).click();
    // The dock shows the same facts: the rail no longer repeats them.
    await expect(gitRow).toHaveCount(0);
    await expect(page.locator("main .composer-git")).toBeVisible();
  }
  // The context figure lives in its card (the ring and the token line), and on the composer's ring: the
  // group's heading does not repeat it.
  await expect(panel.locator(".context-usage-row .context-pie")).toBeVisible();
  await expect(panel.locator(".context-usage-row .context-row-meta")).toContainText(/tokens/);
  await expect(panel.locator(".context-usage-bar")).toHaveCount(0);
  // The quiet groups start folded: open the agents and lineage group to reach the run rows.
  const agentsFold = panel.getByRole("button", { name: /Agents and lineage/ });
  if ((await agentsFold.getAttribute("aria-expanded")) !== "true") await agentsFold.click();
  await expect(panel.locator(".context-status").first()).toHaveText("Done");
  const briefButton = panel.getByRole("button", { name: "Open scout run", exact: true }).first();
  await briefButton.click();
  const toolRow = page.getByTestId("tool-row").filter({ hasText: "Ran 2 agents: scout, worker" });
  await expect(toolRow).toBeVisible();
  const agentRow = toolRow.locator(".run-head").first();
  if ((await agentRow.getAttribute("aria-expanded")) !== "true") await agentRow.click();
  await expect(toolRow.getByRole("button", { name: "Open transcript", exact: true })).toBeVisible();
  await toolRow.getByRole("button", { name: "Open transcript", exact: true }).click();
  await expect(page.getByRole("dialog", { name: /Transcript of/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: /Transcript of/ })).toHaveCount(0);

  const usageFold = panel.getByRole("button", { name: /Context and usage/ });
  if ((await usageFold.getAttribute("aria-expanded")) !== "true") await usageFold.click();
  await expect(panel.getByRole("button", { name: "Open context and timings" })).toBeVisible({ timeout: 10_000 });
  // The row opens the full view, not the composer ring's small popover.
  await panel.getByRole("button", { name: "Open context and timings" }).click();
  await expect(page.getByRole("dialog", { name: "Context, usage, and timing" })).toBeVisible();
  await expect(page.getByTestId("usage-panel")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Context, usage, and timing" })).toHaveCount(0);
  await usageFold.click();
  await expect(panel.locator(".context-section-memory .context-section-body")).toHaveCount(0);
  await page.getByRole("button", { name: "Collapse context panel", exact: true }).click();
  await expect(panel).toHaveClass(/is-collapsed/);
  await expect(panel.getByRole("heading", { name: "Active work" })).toHaveCount(0);
  const railToggle = panel.getByRole("button", { name: "Expand context panel", exact: true });
  await expect(railToggle).toHaveCSS("width", "34px");
  await expect(railToggle).toHaveCSS("height", "34px");
  const railUsage = panel.getByRole("button", { name: /^Context used: \d+% of / });
  await expect(railUsage).toBeVisible();
  await expect(railUsage.locator(".context-rail-figure")).toHaveCount(0);
  await expect(railUsage.locator("svg").first()).toHaveAttribute("width", "28");
  await expect(panel.locator(".context-live-grow")).toHaveCount(0);
  await expect.poll(async () => (await panel.evaluate((el) => getComputedStyle(el).flexBasis)), { timeout: 3000 }).toBe("40px");
  const box = await panel.boundingBox();
  expect(box?.width).toBeCloseTo(40, 1);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("awui.context.folds") ?? "{}").memory)).toBe(false);
  await page.getByRole("button", { name: "Expand context panel", exact: true }).click();
  await expect(panel.locator(".context-section-memory .context-section-body")).toHaveCount(0);
});

test("a slow context chunk reserves the panel instead of clipping its label", async ({ page }) => {
  await page.route(/ContextPanel-.*\.js$/, async route => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await route.continue();
  });
  await signInAndOpen(page);
    await newChat(page);
  await send(page, "hello");
  const loading = page.getByRole("status", { name: "Opening…", exact: true });
  await expect(loading).toBeVisible();
  const label = await loading.locator(".loader-label").boundingBox();
  const viewport = await page.evaluate(() => innerWidth);
  expect(label!.x + label!.width).toBeLessThan(viewport - 8);
  await expect(loading).toHaveCount(0);
});

test("background jobs and their native tool references remain reachable without duplicating job data", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "bgjob");
  const panel = page.getByRole("complementary", { name: "Chat context" });
  await expect(panel.getByRole("heading", { name: "Background jobs" })).toBeVisible({ timeout: 15_000 });
  const reported = panel.getByRole("button", { name: "Open reported output", exact: true }).last();
  await expect(reported).toBeVisible();
  await reported.click();
  const messageTool = page.getByTestId("tool-row").filter({ hasText: /Waiting on bg_1|Waited on bg_1/ });
  await expect(messageTool.first()).toBeVisible();
  await expect(page.getByTestId("approval-card")).toHaveCount(0);
});

test("returning to an ask card does not approve or deny it, and the narrow layout draws the same context sheet", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 860 });
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "ask");
  await expect(page.getByTestId("approval-card")).toContainText("Waiting for approval");
  await page.getByRole("button", { name: "Expand chat context", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Active chat context" });
  await expect(sheet).toContainText("This chat needs a human answer");
  // Selected by section, not by position: empty groups are omitted, so the counts shift.
  await expect(sheet.locator(".context-section-questions .context-count")).toHaveText("1");
  await expect(sheet.getByRole("heading", { name: "Delegated work" })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Jump to the request", exact: true }).click();
  await expect(page.getByTestId("approval-card")).toContainText("Waiting for approval");
  await expect(page.getByRole("dialog", { name: "Active chat context" })).toHaveCount(0);
});

test("a short chat's composer sits on the bottom of the main column", async ({ page }) => {
  // Tall enough that a one-prompt chat is shorter than the window: the case where the wrapper's own height shows.
  await page.setViewportSize({ width: 1600, height: 1100 });
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "hello");
  const main = await page.locator("main.main").boundingBox();
  const work = await page.locator(".context-work").boundingBox();
  const composer = await page.getByRole("textbox", { name: /message/i }).first().boundingBox();
  expect(main && work && composer).toBeTruthy();
  // The wrapper fills the column, and the composer is within a card's height of its bottom edge.
  expect(Math.abs((work!.y + work!.height) - (main!.y + main!.height))).toBeLessThan(2);
  expect((main!.y + main!.height) - (composer!.y + composer!.height)).toBeLessThan(160);
});

test("the rail's width snaps on a session switch and animates only for a person's own fold", async ({ page }) => {
  await signInAndOpen(page);
  // One chat with rows in the rail (it takes the width by itself), one bare chat (a 40 px rail).
  await newChat(page);
  await sendAndWait(page, "subagents");
  const panel = page.getByRole("complementary", { name: "Chat context" });
  const wide = (await panel.boundingBox())!.width;
  expect(wide).toBeGreaterThan(100);
  await newChat(page);
  await sendAndWait(page, "a plain rail switch answer");
  await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBeLessThan(wide);

  /** Every width the panel takes over the next 200 ms, after one click on `click`. */
  const widths = (click: string) => page.evaluate(async (selector) => {
    const target = document.querySelector<HTMLElement>(selector);
    target?.click();
    const panelEl = document.querySelector<HTMLElement>(".context-panel");
    const seen: number[] = [];
    if (!panelEl) return seen;
    await new Promise<void>((resolve) => {
      const start = performance.now();
      const tick = () => {
        seen.push(Math.round(panelEl.getBoundingClientRect().width));
        if (performance.now() - start < 200) requestAnimationFrame(tick);
        else resolve();
      };
      tick();
    });
    return [...new Set(seen)];
  }, click);

  // A switch: the transcript and the rail take their final size in the same frame, so one width is read
  // (two if the click's own frame is sampled first) instead of a 160 ms slide of every label in the rail.
  const switched = await widths('[role="tab"]:not([aria-selected="true"])');
  expect(switched.length).toBeLessThanOrEqual(2);

  // A person's own fold still animates: the rail grows across several frames.
  const toggled = await widths('.context-panel .context-top button');
  expect(toggled.length).toBeGreaterThan(3);
});
