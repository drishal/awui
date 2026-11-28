// The primary-agent selector in a real OpenCodeAdapter chat: its choices, API
// effects and the phone sheet. Model inference is still the scripted fixture.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { signInAndOpen } from "./helpers.js";

interface FixtureState {
  createdAgents?: Array<string | null>;
  agentSwitches?: Array<{ sessionID: string; agent: string }>;
  modelSet?: number;
  sessions: Record<string, { agent?: string; model?: { variant?: string; id?: string; providerID?: string } }>;
}
const fixture = () => JSON.parse(readFileSync(process.env.AWUI_OPENCODE_STATE as string, "utf8")) as FixtureState;

export async function openCodeChat(page: Page) {
  const root = process.env.AWUI_E2E_ROOT as string;
  const ws = await (await page.request.post("/api/workspaces/open", { data: { path: `${root}/alpha` } })).json() as { id: string };
  const chat = await (await page.request.post("/api/chats", { data: { harnessId: "opencode", workspaceId: ws.id } })).json() as { chatId: string };
  await page.goto(`/#chat=${chat.chatId}`);
  await expect(page.getByTestId("chat-status")).toHaveText("Idle");
  return chat.chatId;
}

test("OpenCode primary agents are catalogued, chosen through the API, and kept on resume", async ({ page }) => {
  const chatId = await openCodeChat(page);
  await expect(page.getByTestId("connection")).toHaveText("Connected");
  const trigger = page.getByTestId("agent-picker");
  await expect(trigger).toHaveAccessibleName("Agent: Harness default");
  await trigger.click();
  const list = page.getByRole("listbox", { name: "Primary agent" });
  await expect(list).toBeVisible();
  await expect(list).toHaveCSS("z-index", "40");
  expect((await list.boundingBox())?.width ?? 0).toBeGreaterThan(240);
  await expect(list.getByRole("option", { name: "orchestrator", exact: true })).toBeVisible();
  await expect(list.getByRole("option", { name: "Build", exact: true })).toBeVisible();
  await expect(list.getByRole("option", { name: "Plan", exact: true })).toBeVisible();
  await expect(list.getByRole("option", { name: "explorer", exact: true })).toHaveCount(0);
  await expect(list.getByRole("option", { name: "Title", exact: true })).toHaveCount(0);
  await list.getByRole("option", { name: "orchestrator", exact: true }).click();
  await expect(trigger).toHaveAccessibleName("Agent: orchestrator");
  expect((await (await page.request.get(`/api/chats/${chatId}`)).json()).config.agent).toBe("orchestrator");

  await page.getByRole("textbox", { name: "Message" }).fill("on the plugin primary");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("answer")).toContainText("Echo: on the plugin primary", { timeout: 15_000 });
  await expect(page.getByTestId("chat-status")).toHaveText("Idle");
  expect(fixture().createdAgents).toEqual(["orchestrator"]);
  expect(fixture().modelSet).toBeUndefined(); // No session model was silently overridden by this role pick.

  const modelsBefore = fixture().modelSet ?? 0;
  await trigger.click();
  await page.getByRole("listbox", { name: "Primary agent" }).getByRole("option", { name: "Plan", exact: true }).click();
  await expect(trigger).toHaveAccessibleName("Agent: Plan");
  await expect.poll(() => fixture().agentSwitches?.at(-1)?.agent).toBe("plan");
  expect(fixture().modelSet ?? 0).toBe(modelsBefore);

  await page.reload();
  await expect(page.getByTestId("chat-status")).toHaveText("Idle");
  await expect(page.getByTestId("agent-picker")).toHaveAccessibleName("Agent: Plan");
  await expect(page.getByRole("listbox", { name: "Primary agent" })).toHaveCount(0);
  await page.getByTestId("agent-picker").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("listbox", { name: "Primary agent" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("agent-picker")).toBeFocused();
  await expect(page.getByRole("listbox", { name: "Primary agent" })).toHaveCount(0);
});


test("the pre-send new-chat screen lists primary roles and uses one on OpenCode session create", async ({ page }) => {
  await signInAndOpen(page);
  // StartScreen has its own harness chip; OpenCode is not selected just because the API adapter is installed.
  await page.getByRole("button", { name: "Agent for this chat" }).click();
  await page.getByRole("listbox", { name: "Agent" }).getByRole("option", { name: "OpenCode", exact: true }).click();
  await expect(page.getByRole("heading", { name: /What should OpenCode do in alpha\?/ })).toBeVisible();
  const picker = page.locator(".start-screen").getByTestId("agent-picker");
  await expect(picker).toHaveAccessibleName("Agent: Harness default");
  await picker.click();
  const menu = page.getByRole("listbox", { name: "Primary agent" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("option")).toHaveCount(3);
  await expect(menu.getByRole("option", { name: "orchestrator", exact: true })).toBeVisible();
  await expect(menu.getByRole("option", { name: "Build", exact: true })).toBeVisible();
  await expect(menu.getByRole("option", { name: "Plan", exact: true })).toBeVisible();
  await menu.getByRole("option", { name: "orchestrator", exact: true }).click();
  await expect(picker).toHaveAccessibleName("Agent: orchestrator");
  await page.getByRole("textbox", { name: "Message" }).fill("pre-send primary agent choice");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("Idle");
  const response = await page.request.get(`/api/chats/${/chat=([^/]+)$/.exec(page.url())?.[1]}`);
  const snapshot = await response.json();
  expect(snapshot.config.agent).toBe("orchestrator");
  expect(snapshot.sessionId).toMatch(/^opencode:ses_/);
  expect(fixture().sessions[(snapshot.sessionId as string).replace(/^.*?:/, "")]?.agent).toBe("orchestrator");
  expect(fixture().createdAgents).toContain("orchestrator");
  await expect(page.getByTestId("agent-picker")).toHaveAccessibleName("Agent: orchestrator");
  await page.screenshot({ path: "test-results/opencode-new-chat-agents-desktop.png" });
});

test("the pre-send role picker works on a phone inside its viewport", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAndOpen(page);
  await page.getByRole("button", { name: "Agent for this chat" }).click();
  await page.getByRole("listbox", { name: "Agent" }).getByRole("option", { name: "OpenCode", exact: true }).click();
  const picker = page.locator(".start-screen").getByTestId("agent-picker");
  await expect(picker).toHaveAccessibleName("Agent: Harness default");
  await picker.click();
  const menu = page.getByRole("listbox", { name: "Primary agent" });
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
    const bounds = await menu.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  await expect(page.locator(".start-screen")).toBeVisible();
  await page.screenshot({ path: "test-results/opencode-pre-send-phone.png" });
  await menu.getByRole("option", { name: "orchestrator", exact: true }).click();
  await expect(picker).toHaveAccessibleName("Agent: orchestrator");
  await page.getByRole("textbox", { name: "Message" }).fill("first from phone");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("Idle");
  expect(fixture().createdAgents).toContain("orchestrator");
});
test("a phone puts the real primary agent in Chat settings without narrowing the layout", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCodeChat(page);
  await expect(page.locator(".composer-pickers")).toBeHidden();
  await page.getByTestId("config-chip").click();
  const sheet = page.getByRole("dialog", { name: "Chat settings" });
  await expect(sheet).toBeVisible();
  // Common choices lead, ahead of every rare handoff option.
  await expect(sheet.locator(".config-row-label", { hasText: /^Primary agent$/ })).toBeVisible();
  await expect(sheet.getByTestId("agent-picker")).toHaveAccessibleName("Agent: Harness default");
  await expect(sheet.getByTestId("model-picker")).toBeVisible();
  await expect(sheet.getByTestId("thinking-picker")).toBeVisible();
  await sheet.getByTestId("agent-picker").click();
  const pane = page.getByRole("dialog", { name: "Primary agent", exact: true });
  await expect(pane).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Chat settings" })).toHaveCount(0);
  const menu = page.getByRole("listbox", { name: "Primary agent" });
  const paneMotion = await pane.evaluate(el => {
    const run = el.querySelector<HTMLDivElement>(".config-agent-pane")?.getAnimations().find(a => a.id === "morph:pane");
    if (!run) return { present: false, clip: null, opacity: null, roleCount: null };
    run.pause(); run.currentTime = 40;
    const root = el.querySelector<HTMLElement>(".config-agent-pane")!;
    const frame = { clip: getComputedStyle(root).clipPath, opacity: Number(getComputedStyle(root).opacity), roleCount: root.querySelectorAll("[role=option]").length, time: run.currentTime };
    if (run.playState === "paused") run.play();
    return { present: true, ...frame };
  });
  expect(paneMotion.present, "the role pane uses its own composed transition").toBe(true);
  expect(paneMotion.clip).toBe("none");
  expect(paneMotion.opacity).toBeGreaterThanOrEqual(0.72);
  expect(paneMotion.roleCount).toBe(3);
  // This is an animated native dialog, so measure steady hit geometry once it has actually settled.
  await menu.evaluate(async (el) => { await Promise.all((el.closest("dialog")?.getAnimations({ subtree: true }) ?? []).map((a) => a.finished.catch(() => undefined))); });
  await expect(menu).toBeFocused();
  const contained = await menu.evaluate((el) => {
    const sheet = el.closest("dialog");
    if (!sheet) return false;
    const body = sheet.querySelector(".dialog-body")!.getBoundingClientRect();
    const list = el.getBoundingClientRect();
    return list.left >= body.left && list.right <= body.right && list.top >= body.top && list.bottom <= body.bottom;
  });
  expect(contained).toBe(true);
  const owned = await menu.getByRole("option").evaluateAll((elements) => elements.every((el) => {
    const r = el.getBoundingClientRect();
    return r.height >= 44 && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  }));
  expect(owned).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Chat settings" })).toBeVisible();
  await expect(sheet.getByTestId("agent-picker")).toBeFocused();
  await page.getByRole("listbox", { name: "Primary agent" }).waitFor({ state: "detached" });
  await sheet.getByTestId("agent-picker").click();
  await expect(page.getByRole("listbox", { name: "Primary agent" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Chat settings" })).toBeHidden();
  await expect(page.getByTestId("config-chip")).toContainText("Build");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.getByTestId("config-chip").click();
  await expect(page.getByRole("dialog", { name: "Chat settings" }).getByTestId("agent-picker")).toHaveAccessibleName("Agent: Build");
});

test("a harness with no primary-agent catalogue gains no fabricated default-role control", async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await signInAndOpen(page);
  await page.getByRole("textbox", { name: "Message" }).fill("hello on another harness");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("Idle");
  await expect(page.getByTestId("agent-picker")).toHaveCount(0);
});

// Selection state and effort preferences use native values, not visual highlights or aliases.
test("the model listbox keeps keyboard focus separate from the actually selected model", async ({ page }) => {
  await openCodeChat(page);
  await page.getByTestId("model-picker").click();
  const options = page.getByRole("listbox", { name: "Models" });
  await expect(options.getByRole("option", { name: /Fast Free/ })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("combobox", { name: "Search models" }).focus();
  await page.keyboard.press("ArrowDown");
  await page.locator(".model-pop").evaluate(async el => { await Promise.all(el.getAnimations().map(a => a.finished.catch(() => undefined))); });
  const plain = options.getByRole("option", { name: /Plain/ });
  const active = await plain.getAttribute("id");
  await expect(page.getByRole("combobox", { name: "Search models" })).toHaveAttribute("aria-activedescendant", active!);
  const search = page.getByRole("combobox", { name: "Search models" });
  const focusHint = await search.evaluate((el) => {
    const owner = el.parentElement!;
    const probe = document.createElement("span");
    probe.append("x"); probe.style.color = "var(--accent)"; owner.append(probe);
    const expected = getComputedStyle(probe).color; probe.remove();
    return { visible: el.matches(":focus-visible"), before: el.clientWidth, after: owner.getBoundingClientRect().width, border: getComputedStyle(owner).borderBottomColor, expected };
  });
  expect(focusHint.visible).toBe(true);
  expect(focusHint.border).toBe(focusHint.expected);
  expect(Math.abs(focusHint.before - ((await search.boundingBox())?.width ?? 0))).toBeLessThanOrEqual(1);
  // Focus and selection differ in more shape than a near-background hover tint.
  // The keyboard indicator is a shape cue, while Fast Free's own current flag is untouched.
  expect(await plain.evaluate((el) => getComputedStyle(el, "::before").backgroundColor)).toBe(await plain.evaluate((el) => {
    const swatch = document.createElement("span");
    swatch.style.color = "var(--muted-text)";
    el.append(swatch);
    const colour = getComputedStyle(swatch).color;
    swatch.remove();
    return colour;
  }));
  await expect(options.getByRole("option", { name: /Fast Free/ })).toHaveAttribute("aria-selected", "true");
  expect(await options.getByRole("option", { name: /Fast Free/ }).evaluate((el) => getComputedStyle(el, "::before").display)).toBe("none");
  await expect(plain).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("model-picker")).toHaveAccessibleName("Model: Plain");
});

test("OpenCode's thinking default is a named stop with a real way back", async ({ page }) => {
  const chatId = await openCodeChat(page);
  const think = page.getByTestId("thinking-picker");
  await page.getByRole("textbox", { name: "Message" }).fill("ticking");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("Idle");
  const session = await (await page.request.get(`/api/chats/${chatId}`)).json();
  expect(session.sessionId).toMatch(/^opencode:ses_/);
  const nativeId = session.sessionId.replace(/^opencode:/, "");
  const variant = () => fixture().sessions[nativeId]?.model?.variant;
  await expect.poll(variant).toBe("default");
  await think.click();
  const slider = page.getByRole("slider", { name: "Thinking" });
  await expect(slider).toBeFocused();
  await expect(slider).toHaveAttribute("aria-valuetext", "Default");
  expect(await page.locator(".effort-stop").evaluateAll((stops) => stops.map((stop) => stop.getAttribute("title")))).toEqual(["Default", "Low", "High"]);
  const config = async () => (await (await page.request.get(`/api/chats/${chatId}`)).json()).config.thinkingLevel as string | null;
  await slider.press("End");
  await expect(slider).toHaveAttribute("aria-valuetext", "High");
  await expect.poll(config).toBe("high");
  await expect.poll(variant).toBe("high");
  await page.keyboard.press("Escape");
  await think.click();
  await page.getByRole("slider", { name: "Thinking" }).press("Home");
  await expect.poll(config).toBe(null);
  await expect.poll(variant).toBe("default");
  await expect(page.getByRole("slider", { name: "Thinking" })).toHaveAttribute("aria-valuetext", "Default");
  await page.getByRole("slider", { name: "Thinking" }).press("ArrowRight");
  await expect(page.getByRole("slider", { name: "Thinking" })).toHaveAttribute("aria-valuetext", "Low");
  await expect.poll(config).toBe("low");
  await expect.poll(variant).toBe("low");
  await page.getByRole("slider", { name: "Thinking" }).press("Home");
  await expect.poll(config).toBe(null);
  await expect.poll(variant).toBe("default");
  expect(fixture().modelSet).toBe(4);
});

test("Escape returns a thinking control's focus without inventing a state change", async ({ page }) => {
  await openCodeChat(page);
  await page.getByTestId("thinking-picker").click();
  await expect(page.getByRole("slider", { name: "Thinking" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("thinking-picker")).toBeFocused();
  await page.getByTestId("model-picker").click();
  await expect(page.getByRole("combobox", { name: "Search models" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("model-picker")).toBeFocused();
});


test("the role surface keeps its labels and selection intact throughout its morph", async ({ page }) => {
  await openCodeChat(page);
  await page.getByRole("textbox", { name: "Message" }).fill("ticking");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("answer").last()).toContainText("Echo: ticking", { timeout: 15_000 });
  await page.getByTestId("agent-picker").click();
  const menu = page.getByRole("listbox", { name: "Primary agent" });
  await expect(menu).toBeFocused();
  await expect(menu.getByRole("option", { name: "Build", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(menu.getByRole("option", { name: "Build", exact: true }).locator(".harness-option-check")).toBeVisible();
  await expect(menu.getByRole("option", { name: "Plan", exact: true })).toHaveAttribute("aria-describedby", /-2-desc$/);
  await expect(menu.getByRole("option", { name: "Plan", exact: true })).toHaveAccessibleDescription("Read-only planning");
  const sample = async (at: number) => {
    await menu.evaluate((el, t) => {
      const run = el.getAnimations().find((a) => a.id === "morph:popup");
      if (!run) throw new Error("missing measured popup motion");
      run.pause();
      run.currentTime = t;
    }, at);
    const result = await menu.evaluate((el) => {
      const edge = el.getBoundingClientRect();
      const range = document.createRange();
      const options = [...el.querySelectorAll<HTMLElement>("[role=option]")];
      return {
        clip: getComputedStyle(el).clipPath,
        transform: getComputedStyle(el).transform,
        labels: options.map((option) => {
          const line = option.querySelector<HTMLElement>(".permission-option-name")!;
          range.selectNodeContents(line);
          const r = range.getBoundingClientRect();
          const check = line.nextElementSibling ? null : option.querySelector<HTMLElement>(".harness-option-check");
          const box = check?.getBoundingClientRect();
          return {
            text: line.textContent, selected: option.getAttribute("aria-selected"),
            inside: r.left >= edge.left && r.right <= edge.right && r.top >= edge.top && r.bottom <= edge.bottom,
            checkInside: !box || (box.left >= edge.left && box.right <= edge.right && box.top >= edge.top && box.bottom <= edge.bottom),
          };
        }),
      };
    });
    expect(result.clip).toBe("none");
    expect(result.transform).toMatch(/^matrix\(1, 0, 0, 1, 0(?:\.0+)?, /);
    expect(result.labels).toHaveLength(3);
    expect(result.labels.every((line) => line.inside && line.checkInside)).toBe(true);
    expect(result.labels.filter((line) => line.selected === "true").map((line) => line.text)).toEqual(["Build"]);
  };
  for (const at of [40, 90, 140]) await sample(at);
  await menu.getByRole("option", { name: "Plan", exact: true }).click();
  await expect(page.getByTestId("agent-picker")).toHaveAccessibleName("Agent: Plan");
  await menu.waitFor({ state: "detached" });
});

async function settleComposer(page: Page) {
  await page.locator(".composer").evaluate(async el => {
    await Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished.catch(() => undefined)));
  });
}
async function phoneRows(page: Page) {
  return page.locator(".composer").evaluate((composer) => {
    const at = (selector: string) => {
      const el = composer.querySelector<HTMLElement>(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, width: r.width, ownsPoint: el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
    };
    return { attach: at(".composer-attach"), actions: at(".composer-actions"), chip: at(".composer-config-chip") };
  });
}
function promptActionsAboveSettings(rows: Awaited<ReturnType<typeof phoneRows>>) {
  expect(rows.attach, "attachment is present").not.toBeNull();
  expect(rows.actions, "sending actions are present").not.toBeNull();
  expect(rows.chip, "settings trigger is present").not.toBeNull();
  const centreOf = (row: NonNullable<(typeof rows)["attach"]>) => row.top + (row.bottom - row.top) / 2;
  expect(Math.abs(centreOf(rows.attach!) - centreOf(rows.actions!)), "actions and attachment share a visual row").toBeLessThanOrEqual(1);
  expect(rows.chip!.top, "settings is below both actions, not between attachment and Send").toBeGreaterThanOrEqual(rows.actions!.bottom + 2);
  for (const row of [rows.attach, rows.chip]) expect(row!.ownsPoint).toBe(true);
}

test("the phone shows the full summary with non-overlapping 44px core controls", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await openCodeChat(page);
    await page.getByRole("textbox", { name: "Message" }).fill("ticking");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("answer").last()).toContainText("Echo: ticking", { timeout: 15_000 });
    await expect(page.getByTestId("config-chip")).toContainText("Fast Free · Build · Default");
    const boxes = await page.locator(".composer-card").evaluate((card) => [...card.querySelectorAll<HTMLElement>(".composer-attach,.composer-input,.composer-config-chip,.context-ring,.round-btn")].map((el) => {
      const r = el.getBoundingClientRect();
      return { name: el.className, width: r.width, height: r.height, left: r.left, right: r.right, owned: el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
    }));
    expect(boxes.length).toBeGreaterThanOrEqual(5);
    expect(boxes.every((box) => box.width >= 44 && box.height >= 44 && box.left >= 0 && box.right <= 390 && box.owned)).toBe(true);
    expect(await page.getByTestId("config-chip").locator(".config-summary").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await settleComposer(page);
    promptActionsAboveSettings(await phoneRows(page));
    await page.getByTestId("config-chip").click();
    await page.getByRole("dialog", { name: "Chat settings" }).getByTestId("agent-picker").click();
    await page.getByRole("option", { name: "Plan", exact: true }).click();
    await page.getByRole("dialog", { name: "Primary agent", exact: true }).waitFor({ state: "detached" });
    await expect(page.getByTestId("config-chip")).toContainText("Fast Free · Plan · Default");
    await expect(page.getByTestId("config-chip")).toHaveAccessibleName("Fast Free · Plan · Default");
    expect(await page.getByTestId("config-chip").locator(".config-summary").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.getByRole("textbox", { name: "Message" }).click();
    await expect(page.locator(".composer-card")).not.toHaveClass(/is-folded/);
    await expect(page.getByTestId("config-chip")).toContainText("Fast Free · Plan · Default");
    expect(await page.getByTestId("config-chip").locator(".config-summary").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect((await page.getByTestId("config-chip").boundingBox())?.width).toBeGreaterThan(300);
    await page.locator(".composer").evaluate(async el => { await Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished.catch(() => undefined))); });
    promptActionsAboveSettings(await phoneRows(page));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByTestId("config-chip").click();
    const sheet = page.getByRole("dialog", { name: "Chat settings" });
    await expect(sheet).toBeVisible();
    expect(await sheet.evaluate((el) => getComputedStyle(el, "::backdrop").animationName)).toBe("none");
    expect(await sheet.evaluate((el) => el.getAnimations().length)).toBe(0);
  } finally {
    await context.close();
  }
});


test("phone role selection applies before closing and keeps errors in the owning pane", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await openCodeChat(page);
    await page.getByRole("textbox", { name: "Message" }).fill("ticking");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("answer").last()).toContainText("Echo: ticking", { timeout: 15_000 });
    await page.getByTestId("config-chip").click();
    const agentsBeforeApply = fixture().createdAgents?.length ?? 0;
    const chatBeforeApply = page.url();
    await page.getByRole("dialog", { name: "Chat settings" }).getByTestId("agent-picker").click();
    const pane = page.getByRole("dialog", { name: "Primary agent", exact: true });
    await expect(pane).toBeVisible();

    let requestSeen = false;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    // Route the browser's config PATCH. OpenCode's own child call is server-side, invisible to page.route.
    await page.route("**/api/chats/*/config", async (route) => { requestSeen = true; await hold; await route.continue(); });
    await pane.getByRole("option", { name: "Plan", exact: true }).click();
    await expect.poll(() => requestSeen).toBe(true);
    await expect(pane).toBeVisible();
    await expect(pane.locator(".config-pane-note")).toHaveText("Saving…");
    expect(fixture().createdAgents?.length ?? 0).toBe(agentsBeforeApply);
    expect(page.url()).toBe(chatBeforeApply);
    await expect(page.locator(".config-choices button:not([disabled])")).toHaveCount(0);
    const emphasis = async (name: "Build" | "Plan" | "orchestrator") => pane.getByRole("option", { name, exact: true }).evaluate(el => ({
      selected: el.getAttribute("aria-selected"), disabled: el.getAttribute("aria-disabled"),
      opacity: getComputedStyle(el).opacity, background: getComputedStyle(el).backgroundColor,
    }));
    const current = await emphasis("Build");
    const attempted = await emphasis("Plan");
    expect(current.selected).toBe("true");
    expect(attempted.selected).toBe("false");
    expect(current.opacity).toBe("1");
    expect(Number(attempted.opacity)).toBeLessThan(1);
    expect(attempted.disabled).toBe("true");
    expect(current.background).not.toBe(attempted.background);
    expect(attempted.background).toBe("rgba(0, 0, 0, 0)");
    release();
    await expect(pane).toHaveCount(0);
    await expect(page.getByTestId("config-chip")).toContainText("Fast Free · Plan · Default");
    await page.unroute("**/api/chats/*/config");

    await page.getByTestId("config-chip").click();
    await page.getByRole("dialog", { name: "Chat settings" }).getByTestId("agent-picker").click();
    await expect(page.getByRole("dialog", { name: "Primary agent", exact: true })).toBeVisible();
    await page.route("**/api/chats/*/config", (route) => route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Fixture role save failed" }) }));
    await page.getByRole("option", { name: "orchestrator", exact: true }).click();
    await expect(pane).toBeVisible();
    await expect(pane.locator(".config-pane-note.config-error")).toHaveText("Fixture role save failed");
    await expect(pane.getByRole("option", { name: "Plan", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(pane.getByRole("option", { name: "orchestrator", exact: true })).toHaveAttribute("aria-selected", "false");
    await expect(page.getByText("Fixture role save failed", { exact: true })).toHaveCount(1);
    await pane.getByRole("button", { name: "Back to chat settings" }).click();
    await expect(page.getByRole("dialog", { name: "Chat settings" })).toBeVisible();
  } finally { await context.close(); }
});


test("model popovers keep their choices, contrast and native lifecycle while opening and closing", async ({ page }) => {
  await openCodeChat(page);
  const trigger = page.getByTestId("model-picker");
  const pop = page.locator(".model-pop");
  const phase = async (t: number) => {
    await expect.poll(() => pop.evaluate(el => el.getAnimations().some(a => a.id === "morph:popup")), { timeout: 5_000 }).toBe(true);
    return pop.evaluate((el, at) => {
      const run = el.getAnimations().find(a => a.id === "morph:popup");
      if (!run) throw new Error("Expected the actual model morph animation");
      run!.pause(); run!.currentTime = at;
      const box = el.getBoundingClientRect();
      const parts = [...el.querySelectorAll<HTMLElement>(".model-name,.model-tag,.model-check")].map(part => {
        const r = part.getBoundingClientRect();
        return { text: part.textContent, inside: r.left >= box.left && r.right <= box.right && r.top >= box.top && r.bottom <= box.bottom };
      });
      if (run.playState === "paused") run.play();
      return { clip: getComputedStyle(el).clipPath, opacity: Number(getComputedStyle(el).opacity), width: box.width, height: box.height, parts };
    }, t);
  };
  await trigger.click();
  const opening = await phase(40);
  expect(opening.clip).toBe("none");
  expect(opening.opacity).toBeGreaterThanOrEqual(0.72);
  expect(opening.parts.every(part => part.inside)).toBe(true);
  expect(opening.parts.length).toBeGreaterThan(1);
  await pop.evaluate(async el => { await Promise.all(el.getAnimations().map(a => a.finished.catch(() => undefined))); });
  await pop.screenshot({ path: "test-results/model-motion-rest.png" });
  await page.keyboard.press("Escape");
  const closing = await phase(40);
  expect(closing.clip).toBe("none");
  expect(closing.opacity).toBeGreaterThanOrEqual(0.72);
  expect(closing.width).toBe(opening.width);
  expect(closing.height).toBe(opening.height);
  expect(closing.parts.every(part => part.inside)).toBe(true);
  await pop.waitFor({ state: "detached" });
  await expect(pop).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await trigger.click();
  await expect(pop).toBeVisible();
  expect(await pop.getAttribute("data-morph")).toBeNull();
  expect(await pop.evaluate(el => el.getAnimations().length)).toBe(0);
  expect(await pop.evaluate(el => getComputedStyle(el).clipPath)).toBe("none");
});
