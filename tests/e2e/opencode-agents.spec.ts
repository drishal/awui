// The primary-agent selector in a real OpenCodeAdapter chat: its choices, API
// effects and the phone sheet. Model inference is still the scripted fixture.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { signInAndOpen, openCodeChat, newChat } from "./helpers.js";


function assertPhase<T>(value: T | null, phase: string): T {
  if (value === null) throw new Error(`Expected actual ${phase} motion evidence`);
  return value;
}

interface FixtureState {
  createdAgents?: Array<string | null>;
  agentSwitches?: Array<{ sessionID: string; agent: string }>;
  modelSet?: number;
  sessions: Record<string, { agent?: string; model?: { variant?: string; id?: string; providerID?: string }; messages?: Array<{ text?: string }> }>;
}
const fixture = () => JSON.parse(readFileSync(process.env.AWUI_OPENCODE_STATE as string, "utf8")) as FixtureState;


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
  await expect(menu.getByRole("option")).toHaveCount(4);
  await expect(menu.getByRole("option", { name: "Harness default", exact: true })).toHaveAttribute("aria-selected", "true");
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
  // Let the composer's landing motion finish before taking the evidence still.
  await page.waitForTimeout(700);
  await page.screenshot({ path: "test-results/opencode-new-chat-agents-desktop.png" });
});

test("the start screen clears a pending primary role through Harness default", async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await signInAndOpen(page);
  await page.getByRole("button", { name: "Agent for this chat" }).click();
  await page.getByRole("listbox", { name: "Agent" }).getByRole("option", { name: "OpenCode", exact: true }).click();
  const picker = page.locator(".start-screen").getByTestId("agent-picker");
  await picker.click();
  await page.getByRole("listbox", { name: "Primary agent" }).getByRole("option", { name: "orchestrator", exact: true }).click();
  await expect(picker).toHaveAccessibleName("Agent: orchestrator");
  await picker.click();
  await page.getByRole("listbox", { name: "Primary agent" }).getByRole("option", { name: "Harness default", exact: true }).click();
  // The inverse is null, not an empty role id: the chip names the default and the row is selected.
  await expect(picker).toHaveAccessibleName("Agent: Harness default");
  await picker.click();
  await expect(page.getByRole("listbox", { name: "Primary agent" }).getByRole("option", { name: "Harness default", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: "Message" }).fill("pre-send inverted");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("Idle");
  const snapshot = await (await page.request.get(`/api/chats/${/chat=([^/]+)$/.exec(page.url())?.[1]}`)).json();
  // The create carried no role; OpenCode's own default then resolves on the first step.
  expect(fixture().createdAgents?.at(-1)).toBeNull();
  expect(snapshot.config.agent).toBe("build");
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
  await expect(menu).toBeFocused();
  await expect(page.locator(".model-backdrop")).toBeVisible();
  // Tab leaves the visible sheet by returning to the chip that opened it, not by moving focus behind it.
  await page.keyboard.press("Tab");
  await expect(menu).toHaveCount(0);
  await expect(picker).toBeFocused();
  await picker.click();
  await expect(menu).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(picker).toBeFocused();
  await picker.click();
  await expect(menu).toBeFocused();
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
  await expect(pane.locator(".config-pane-note")).toContainText("model and permissions stay separate");
  await expect(pane.locator(".config-pane-note")).toContainText("OpenCode");
  await expect(pane.locator(".config-pane-note")).toContainText("Harness default");
  await expect(pane.getByRole("option", { selected: true, name: "Harness default" })).toHaveCount(1);
  await expect(pane.getByRole("option", { selected: true })).toHaveCount(1);
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
  expect(await menu.getByRole("option").evaluateAll(rows => rows.every(row => row.getBoundingClientRect().bottom <= row.closest("dialog")!.getBoundingClientRect().bottom))).toBe(true);
  expect(paneMotion.roleCount).toBe(4);
  // This is an animated native dialog, so measure steady hit geometry once it has actually settled.
  await menu.evaluate(async (el) => { await Promise.all((el.closest("dialog")?.getAnimations({ subtree: true }) ?? []).map((a) => a.finished.catch(() => undefined))); });
  await expect(menu).not.toHaveClass(/harness-menu/);
  expect(await menu.evaluate(el => getComputedStyle(el).animationName)).toBe("none");
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


test("choosing Harness default after a role opens a new chat on the default", async ({ page }) => {
  await openCodeChat(page);
  await page.getByRole("textbox", { name: "Message" }).fill("before the default");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("Idle");
  const before = page.url();
  // The chat's config picker, not the start screen's creation chip.
  const picker = page.locator(".composer-card").getByTestId("agent-picker");
  // Deliberately select Plan so the default state has a real inverse to exercise.
  await picker.click();
  const list = page.getByRole("listbox", { name: "Primary agent" });
  await list.getByRole("option", { name: "Plan", exact: true }).click();
  await expect(page.getByTestId("config-chip")).toContainText("Plan");
  // Carry a real effort too, so the new default chat proves it kept effort while the old role stays.
  const oldId = /chat=([^/]+)$/.exec(page.url())?.[1] as string;
  await page.getByTestId("thinking-picker").click();
  await page.getByRole("slider", { name: "Thinking" }).press("End");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await (await page.request.get(`/api/chats/${oldId}`)).json()).config.thinkingLevel).toBe("high");
  const oldSnapshot = await (await page.request.get(`/api/chats/${oldId}`)).json();
  expect(oldSnapshot.config.agent).toBe("plan");
  // Wait for the leave furl to unmount before reopening, or its outside-dismiss eats the new menu.
  await page.locator(".agent-menu").waitFor({ state: "detached" });
  // Choosing the truthful Harness default row starts a fresh chat; the old one stays.
  await picker.click();
  await page.locator(".agent-menu").evaluate(async el => { await Promise.all(el.getAnimations().map(a => a.finished.catch(() => undefined))); });
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "the settled menu holds focus").toBe("Primary agent");
  // Keyboard activation of the truthful Harness default row (the one-way door's inverse).
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.getByTestId("config-chip").innerText(), "the fresh default chat voices Harness default once its catalog arrives").toContain("Harness default");
  expect(page.url()).not.toBe(before);
  const newSnapshot = await (await page.request.get(`/api/chats/${/chat=([^/]+)$/.exec(page.url())?.[1]}`)).json();
  expect(newSnapshot.config.agent ?? null).toBeNull();
  expect(newSnapshot.config.model).toBe(oldSnapshot.config.model);
  expect(newSnapshot.config.thinkingLevel).toBe("high");
  // The old menu owner is gone with the chat; the fresh composer takes the next keystroke.
  await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused();
  // The fresh native session selects no explicit role.
  await page.locator(".composer-card").getByTestId("agent-picker").click();
  await expect(page.getByRole("listbox", { name: "Primary agent" }).getByRole("option", { name: "Harness default", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  // The old native session keeps the explicit role the inverse left behind.
  await page.goto(before);
  await expect(page.getByTestId("config-chip")).toContainText("Plan");
  await expect(page.getByTestId("model-picker")).toHaveAccessibleName("Model: Fast Free");
  await page.locator(".composer-card").getByTestId("agent-picker").click();
  await expect(page.getByRole("listbox", { name: "Primary agent" }).getByRole("option", { name: "Plan", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
});

test("a rejected Harness-default creation keeps the role pane and its error", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCodeChat(page);
  // Give the chat an explicit role first, so Harness default is an action rather than the current state.
  await page.getByTestId("config-chip").click();
  await page.getByRole("dialog", { name: "Chat settings" }).getByTestId("agent-picker").click();
  const pane = page.getByRole("dialog", { name: "Primary agent", exact: true });
  await pane.getByRole("option", { name: "Plan", exact: true }).click();
  await expect(page.getByTestId("config-chip")).toContainText("Plan");
  await page.locator("dialog[open]").waitFor({ state: "detached" });
  await page.route("**/api/chats", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "no session" }) });
  });
  await page.getByTestId("config-chip").click();
  await page.getByRole("dialog", { name: "Chat settings" }).getByTestId("agent-picker").click();
  await pane.getByRole("option", { name: "Harness default", exact: true }).click();
  // Creation failed, so the current chat remains authoritative and the pane stays for Back/retry.
  await expect(pane.getByRole("option", { name: "Plan", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(pane.locator(".config-pane-note")).toContainText("Could not start a new chat");
  await expect(page.getByTestId("config-chip")).toContainText("Plan");
  // The settings pane owns the single notice; the app banner must not repeat it.
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("choosing Harness default in Chat settings focuses the fresh composer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCodeChat(page);
  // Put the chat on an explicit role first, so the settings pane's default is an action.
  await page.getByTestId("config-chip").click();
  await page.getByRole("dialog", { name: "Chat settings" }).getByTestId("agent-picker").click();
  const pane = page.getByRole("dialog", { name: "Primary agent", exact: true });
  await pane.getByRole("option", { name: "Build", exact: true }).click();
  await expect(page.getByTestId("config-chip")).toContainText("Build");
  await page.locator("dialog[open]").waitFor({ state: "detached" });
  await page.getByTestId("config-chip").click();
  await page.getByRole("dialog", { name: "Chat settings" }).getByTestId("agent-picker").click();
  await pane.getByRole("option", { name: "Harness default", exact: true }).click();
  await expect(page.getByTestId("config-chip")).toContainText("Harness default");
  // The settings invoker belonged to the old chat; focus lands in the new composer, not on body.
  await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused();
});

test("a popover create failure reports one banner and keeps the chat", async ({ page }) => {
  await openCodeChat(page);
  const picker = page.locator(".composer-card").getByTestId("agent-picker");
  await picker.click();
  await page.getByRole("listbox", { name: "Primary agent" }).getByRole("option", { name: "Plan", exact: true }).click();
  await expect(page.getByTestId("config-chip")).toContainText("Plan");
  await page.locator(".agent-menu").waitFor({ state: "detached" });
  const tabs = await page.getByRole("tab").count();
  await page.route("**/api/chats", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "no session" }) });
  });
  await picker.click();
  await page.getByRole("listbox", { name: "Primary agent" }).getByRole("option", { name: "Harness default", exact: true }).click();
  // The composer owns the only notice; the current chat and its role are untouched.
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByTestId("config-chip")).toContainText("Plan");
  await expect(page.getByRole("tab")).toHaveCount(tabs);
});

test("a carry failure is reported on the fresh default chat", async ({ page }) => {
  await openCodeChat(page);
  const picker = page.locator(".composer-card").getByTestId("agent-picker");
  await picker.click();
  await page.getByRole("listbox", { name: "Primary agent" }).getByRole("option", { name: "Plan", exact: true }).click();
  await expect(page.getByTestId("config-chip")).toContainText("Plan");
  await page.locator(".agent-menu").waitFor({ state: "detached" });
  await page.getByTestId("thinking-picker").click();
  await page.getByRole("slider", { name: "Thinking" }).press("End");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await (await page.request.get(`/api/chats/${/chat=([^/]+)$/.exec(page.url())?.[1]}`)).json()).config.thinkingLevel).toBe("high");
  await page.route("**/api/chats/*/config", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "carry refused" }) });
  });
  await picker.click();
  await page.getByRole("listbox", { name: "Primary agent" }).getByRole("option", { name: "Harness default", exact: true }).click();
  // The native chat is created; only its model/effort carry failed, and that failure is visible.
  await expect(page.getByTestId("config-chip")).toContainText("Harness default");
  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("carry refused");
});

test("double activation of Harness default starts exactly one native chat", async ({ page }) => {
  await openCodeChat(page);
  const picker = page.locator(".composer-card").getByTestId("agent-picker");
  await picker.click();
  await page.getByRole("listbox", { name: "Primary agent" }).getByRole("option", { name: "Plan", exact: true }).click();
  await expect(page.getByTestId("config-chip")).toContainText("Plan");
  await page.locator(".agent-menu").waitFor({ state: "detached" });
  await expect(page.getByRole("tab")).toHaveCount(1);
  await picker.click();
  const option = page.getByRole("listbox", { name: "Primary agent" }).getByRole("option", { name: "Harness default", exact: true });
  // Two synchronous activations, as a double-click or a held Enter delivers them.
  await option.evaluate((el) => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await expect(page.getByTestId("config-chip")).toContainText("Harness default");
  await expect(page.getByRole("tab")).toHaveCount(2);
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
  // The fixture counts model writes for the whole server; measure this test's own writes.
  const modelSetBefore = fixture().modelSet;
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
  expect((fixture().modelSet ?? 0) - (modelSetBefore ?? 0)).toBe(4);
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
  await expect(menu.getByRole("option", { name: "Plan", exact: true })).toHaveAttribute("aria-describedby", /-desc$/);
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
    expect(result.labels).toHaveLength(4);
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
    await expect(pane.getByRole("button", { name: "Back to chat settings" })).toBeDisabled();
    await expect(pane.getByRole("button", { name: "Close", exact: true })).toBeDisabled();
    await expect(pane.locator("[role=option][aria-disabled=true]")).toHaveCount(4);
    expect(await pane.getByRole("button", { name: "Close", exact: true }).evaluate(el => Number(getComputedStyle(el).opacity))).toBeLessThan(1);
    await expect(pane.getByRole("button", { name: "Back to chat settings" })).toHaveAttribute("title", "Close when saving finishes");
    // Pointer-selected focus need not be a visible keyboard ring; exercise real locked keyboard navigation.
    await pane.getByRole("listbox", { name: "Primary agent" }).press("ArrowUp");
    await pane.getByRole("listbox", { name: "Primary agent" }).press("ArrowDown");
    expect(await pane.getByRole("listbox", { name: "Primary agent" }).evaluate(el => el.matches(":focus-visible"))).toBe(true);
    const attemptedActive = await pane.getByRole("option", { name: "Plan", exact: true }).evaluate(el => ({ selected: el.getAttribute("aria-selected"), activeClass: el.classList.contains("is-active"),
      bg: getComputedStyle(el).backgroundColor }));
    expect(attemptedActive).toMatchObject({ selected: "false", activeClass: true });
    expect(attemptedActive.bg).not.toBe("rgba(0, 0, 0, 0)");
    await pane.getByRole("listbox", { name: "Primary agent" }).press("Escape");
    // Escape routes through the role's Back handler too; it may not merely hide behind a 120 ms leave timer.
    await expect(pane.locator(".config-agent-pane.is-returning")).toHaveCount(0);
    await expect(pane).toBeVisible();
    await expect(pane.getByRole("button", { name: "Close", exact: true })).toHaveAttribute("title", "Close when saving finishes");
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
    expect(await pane.locator(".agent-menu[aria-disabled=true] > .is-active").evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    await expect(pane.getByRole("option", { name: "Plan", exact: true }).locator(".harness-option-check")).toHaveCount(0);
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
    await expect(pane).toBeVisible();
    const snapshot = page.locator(".config-agent-pane.is-returning");
    await expect.poll(() => snapshot.evaluate(root => root.getAnimations().some(run => run.id === "morph:pane")), { intervals: [16] }).toBe(true);
    await expect.poll(() => snapshot.evaluate(root => root.closest("dialog")!.querySelector(".dialog-body")!.getAnimations().some(run => run.id === "morph:pane-size")), { intervals: [16] }).toBe(true);
    const reverse = await snapshot.evaluate(root => {
      const dialog = root.closest("dialog")!;
      const body = dialog.querySelector<HTMLElement>(".dialog-body")!;
      const leave = root.getAnimations().find(a => a.id === "morph:pane");
      const size = body.getAnimations().find(a => a.id === "morph:pane-size");
      if (!leave || !size) throw new Error("Expected the actual outgoing pane and subsequent sizing movement");
      // Make the paused timeline deterministic before reading its start height.
      // Unpaused native motion is separately sampled throughout the full sequence.
      size.pause(); size.currentTime = 0;
      const before = body.getBoundingClientRect().height;
      size.currentTime = 40;
      const keyframes = (size.effect as KeyframeEffect | null)?.getKeyframes() ?? [];
      const from = Number.parseFloat(String(keyframes[0]?.height));
      const target = Number.parseFloat(String(keyframes[1]?.height));
      const panel = dialog.getBoundingClientRect();
      const rows = root.querySelectorAll<HTMLElement>("[role=option]");
      return {
        at: size.currentTime, outgoingState: leave.playState,
        fill: leave.effect?.getComputedTiming().fill, opacity: Number(getComputedStyle(root).opacity), clip: getComputedStyle(root).clipPath,
        labels: root.querySelectorAll(".permission-option-name").length,
        selected: root.querySelector("[aria-selected=true] .permission-option-name")?.textContent,
        owner: dialog.getAttribute("aria-label"), disabled: root.querySelector("[role=listbox]")?.getAttribute("aria-disabled"),
        from, target, before, current: body.getBoundingClientRect().height, sizeFill: size.effect?.getComputedTiming().fill,
        roleInside: [...rows].every(row => { const r = row.getBoundingClientRect(); return r.top >= panel.top - 0.01 && r.bottom <= panel.bottom + 0.01; }),
        textInside: [...root.querySelectorAll<HTMLElement>(".permission-option-name,.permission-option-desc")].every(part => { const r = part.getBoundingClientRect(); return r.top >= panel.top - 0.01 && r.bottom <= panel.bottom + 0.01; }),
        futureButtons: root.querySelectorAll("[data-testid=model-picker]").length,
      };
    });
    expect(reverse.labels).toBe(4);
    expect(reverse.selected).toBe("Plan");
    expect(reverse.at).toBe(40);
    expect(reverse.clip).toBe("none");
    expect(reverse.fill).toBe("forwards");
    // The outgoing pane has finished fading: substitution never shows a ghost.
    expect(reverse.opacity).toBe(0);
    expect(reverse.outgoingState).toBe("finished");
    expect(reverse.owner).toBe("Primary agent");
    expect(reverse.disabled).toBe("true");
    expect(reverse.roleInside).toBe(true);
    expect(reverse.textInside).toBe(true);
    expect(reverse.futureButtons).toBe(0);
    expect(Number.isFinite(reverse.from) && Number.isFinite(reverse.target)).toBe(true);
    const low = Math.min(reverse.from, reverse.target);
    expect(Math.abs(reverse.before - reverse.from)).toBeLessThan(0.02);
    const high = Math.max(reverse.from, reverse.target);
    expect(reverse.sizeFill).toBe("forwards");
    expect(reverse.current).toBeGreaterThan(low);
    expect(reverse.current).toBeLessThan(high);
    await snapshot.evaluate(async root => {
      const dialog = root.closest("dialog")!;
      const runs = [...root.getAnimations(), ...dialog.querySelector(".dialog-body")!.getAnimations()].filter(a => a.id === "morph:pane" || a.id === "morph:pane-size");
      for (const run of runs) run.play();
      await Promise.all(runs.map(a => a.finished.catch(() => undefined)));
    });
    await expect(snapshot).toHaveCount(0);
    const settings = page.getByRole("dialog", { name: "Chat settings" });
    const released = await settings.locator(".dialog-body").evaluate(async body => {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      return {
        outgoing: body.querySelector(".config-agent-pane"),
        sizing: body.getAnimations().filter(run => run.id === "morph:pane-size").length,
        heightOverride: body.style.height,
      };
    });
    expect(released).toEqual({ outgoing: null, sizing: 0, heightOverride: "" });
    await expect(settings.getByTestId("agent-picker")).toBeFocused();
    await expect(page.getByText("Fixture role save failed", { exact: true })).toHaveCount(0);
    await page.getByRole("dialog", { name: "Chat settings" }).getByTestId("agent-picker").click();
    await expect(page.getByRole("dialog", { name: "Primary agent", exact: true })).toBeVisible();
    await expect(page.locator(".config-error")).toHaveCount(0);
  } finally { await context.close(); }
});


test("model popovers keep their choices, contrast and native lifecycle while opening and closing", async ({ page }) => {
  await openCodeChat(page);
  const trigger = page.getByTestId("model-picker");
  const pop = page.locator(".model-pop");
  const phase = async (t: number, leaving: boolean) => {
    const facts = await page.waitForFunction(({ phase, at }) => {
      const panel = document.querySelector<HTMLElement>(".model-pop");
      if (!panel || panel.classList.contains("is-leaving") !== phase || (phase && panel.dataset.morph !== "leaving")) return null;
      const run = panel.getAnimations().find(animation => animation.id === "morph:popup");
      if (!run) return null;
      run.pause(); run.currentTime = at;
      const box = panel.getBoundingClientRect();
      const result = {
        clip: getComputedStyle(panel).clipPath, opacity: Number(getComputedStyle(panel).opacity), width: box.width, height: box.height,
        parts: [...panel.querySelectorAll<HTMLElement>(".model-name,.model-tag,.model-check")].map(part => {
          const r = part.getBoundingClientRect();
          return { text: part.textContent, inside: r.left >= box.left && r.right <= box.right && r.top >= box.top && r.bottom <= box.bottom };
        }),
      };
      run.play();
      return result;
    }, { phase: leaving, at: t }, { polling: "raf", timeout: 5_000 });
    try { return await assertPhase(await facts.jsonValue(), leaving ? "model closing" : "model opening"); } finally { await facts.dispose(); }
  };
  await trigger.click();
  const opening = await phase(40, false);
  expect(opening.clip).toBe("none");
  // The enter ramp is below 1 mid-flight but the settled frame is fully opaque over the hero.
  expect(opening.opacity, "the entering panel is already legible over large text behind it").toBeGreaterThanOrEqual(0.8);
  expect(opening.opacity).toBeLessThan(1);
  expect(opening.parts.every(part => part.inside)).toBe(true);
  expect(opening.parts.length).toBeGreaterThan(1);
  await pop.evaluate(async el => { await Promise.all(el.getAnimations().map(a => a.finished.catch(() => undefined))); });
  expect(await pop.evaluate(el => Number(getComputedStyle(el).opacity)), "the settled menu is fully opaque over the hero").toBe(1);
  // However tall the catalogue is, the settled panel stays inside the viewport.
  const box = await pop.evaluate(el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, viewport: innerHeight }; });
  expect(box.top).toBeGreaterThanOrEqual(8);
  expect(box.bottom).toBeLessThanOrEqual(box.viewport - 8);
  await pop.screenshot({ path: "test-results/model-motion-rest.png" });
  expect(await pop.evaluate(el => getComputedStyle(el).willChange)).toBe("auto");
  await page.keyboard.press("Escape");
  // Early in the leave, while the fast-start ramp is still legible.
  const closing = await phase(20, true);
  expect(closing.clip).toBe("none");
  expect(closing.opacity, "the outgoing model menu is still legible early in its leave").toBeGreaterThanOrEqual(0.4);
  expect(closing.width).toBe(opening.width);
  expect(closing.height).toBe(opening.height);
  expect(closing.parts.every(part => part.inside)).toBe(true);
  // The finished leave holds opacity 0 through the unmount window; clearing it would flash the panel.
  expect(await pop.evaluate(async (el) => {
    const run = el.getAnimations().find(animation => animation.id === "morph:popup");
    if (!run) return null;
    run.finish();
    await Promise.resolve();
    return Number(getComputedStyle(el).opacity);
  })).toBe(0);
  await pop.waitFor({ state: "detached" });
  await expect(pop).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await trigger.click();
  await expect(pop).toBeVisible();
  expect(await pop.getAttribute("data-morph")).toBeNull();
  expect(await pop.evaluate(el => el.getAnimations().length)).toBe(0);
  expect(await pop.evaluate(el => getComputedStyle(el).clipPath)).toBe("none");
});


test("the desktop handoff names its action and opens the real native choices", async ({ page }) => {
  await openCodeChat(page);
  const trigger = page.getByRole("button", { name: "Hand off from OpenCode to another harness", exact: true });
  await expect(trigger).toContainText("OpenCode");
  await expect(trigger.locator(".harness-label > svg.icon")).toBeVisible();
  const geometry = await trigger.locator(".harness-label > svg.icon").evaluate(icon => {
    const r = icon.getBoundingClientRect();
    const button = icon.closest("button")!.getBoundingClientRect();
    const text = icon.parentElement!.querySelector(".harness-row-name")!.getBoundingClientRect();
    return { inside: r.left >= button.left && r.right <= button.right && r.top >= button.top && r.bottom <= button.bottom,
      rightOfLabel: r.x >= text.right, position: getComputedStyle(icon).position, strokeColor: getComputedStyle(icon).color };
  });
  expect(geometry).toEqual({ inside: true, rightOfLabel: true, position: "static", strokeColor: "rgb(172, 164, 153)" });
  await expect(trigger.locator(".harness-label > svg.icon path")).toHaveAttribute("d", "M4 6l4 4 4-4");
  await page.setViewportSize({ width: 720, height: 900 });
  expect(await trigger.locator(".harness-label > svg.icon").evaluate(icon => {
    const box = icon.getBoundingClientRect();
    const button = icon.closest("button")!.getBoundingClientRect();
    const group = document.querySelector<HTMLElement>(".composer-pill-settings")!.getBoundingClientRect();
    return { withinChip: box.right <= button.right && box.top >= button.top && box.bottom <= button.bottom,
      precedesSettings: box.right <= group.left };
  })).toEqual({ withinChip: true, precedesSettings: true });
  await expect(trigger).toHaveAttribute("title", /fresh native session/);
  const label = trigger.locator(".harness-row-name");
  expect(await label.evaluate(el => ({ position: getComputedStyle(el).position, width: el.getBoundingClientRect().width }))).toEqual({ position: "static", width: expect.closeTo(65.59375, 1) });
  await expect(trigger).toContainText(/^OpenCode$/);
  await trigger.click();
  const menu = page.getByRole("listbox", { name: "Hand off to" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("option", { name: "Fake", exact: true })).toBeVisible();
  await expect(menu.getByRole("option", { name: "Fake B", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});


test("the primary role reads as a quieter separate trigger from model and harness", async ({ page }) => {
  await openCodeChat(page);
  const role = page.getByTestId("agent-picker");
  const pill = page.locator(".composer-pill");
  await expect(role).toBeVisible();
  const layout = await page.evaluate(() => {
    const agent = document.querySelector<HTMLElement>("[data-testid=agent-picker]")!;
    const group = document.querySelector<HTMLElement>(".composer-pill")!;
    const ar = agent.getBoundingClientRect(); const pr = group.getBoundingClientRect();
    return { gap: pr.left - ar.right, roleFill: getComputedStyle(agent).backgroundColor, pillFill: getComputedStyle(group.querySelector(".composer-pill-settings")!).backgroundColor,
      name: group.querySelector("button.harness-chip")?.getAttribute("aria-label") };
  });
  expect(layout.gap).toBeGreaterThanOrEqual(12);
  expect(layout.roleFill).not.toBe(layout.pillFill);
  expect(layout.roleFill).toBe("rgba(0, 0, 0, 0)");
  expect(layout.name).toContain("OpenCode");
});

test("a real coarse pointer gives the primary-role dialog a 44px Close", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await openCodeChat(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await page.getByTestId("config-chip").click();
    await page.getByRole("dialog", { name: "Chat settings" }).getByTestId("agent-picker").click();
    const pane = page.getByRole("dialog", { name: "Primary agent" });
    await expect(pane).toBeVisible();
    const close = await pane.getByRole("button", { name: "Close", exact: true }).boundingBox();
    expect(close?.width).toBe(44);
    expect(close?.height).toBe(44);
    await pane.getByRole("option", { name: "Build", exact: true }).click();
    await expect(page.getByTestId("config-chip")).toContainText("Build");
  } finally { await context.close(); }
});
test("phone handoffs stay disabled while a model configuration applies", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await openCodeChat(page);
    await page.getByTestId("config-chip").click();
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    let seen = false;
    await page.route("**/api/chats/*/config", async route => { seen = true; await hold; await route.continue(); });
    await page.getByRole("dialog", { name: "Chat settings" }).getByTestId("model-picker").click();
    await page.getByRole("option", { name: "Plain", exact: true }).click();
    await expect.poll(() => seen).toBe(true);
    const sheet = page.getByRole("dialog", { name: "Chat settings" });
    await expect(sheet.locator(".config-pane-note")).toHaveText("Saving…");
    await expect(sheet.locator(".config-choices button")).toHaveCount(3);
    await expect(sheet.locator(".config-choices button:not([disabled])")).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "Close", exact: true })).toBeDisabled();
    release();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByTestId("config-chip")).toContainText("Plain");
  } finally { await context.close(); }
});

test("coarse secondary model controls are thumb-sized", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await openCodeChat(page);
    await page.getByTestId("config-chip").click();
    const sheet = page.getByRole("dialog", { name: "Chat settings" });
    await expect(sheet).toBeVisible();
    await sheet.getByTestId("model-picker").click();
    const pop = page.getByRole("dialog", { name: "Choose a model" });
    await expect(pop).toBeVisible();
    await pop.evaluate(async root => { await Promise.all(root.getAnimations({ subtree: true }).map(a => a.finished.catch(() => undefined))); });
    for (const item of await pop.locator(".model-refresh,.model-option").evaluateAll(rows => rows.map(row => {
      const r = row.getBoundingClientRect();
      return { width: r.width, height: r.height, owned: row.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
    }))) {
      expect(item.width).toBeGreaterThanOrEqual(44);
      expect(item.height).toBeGreaterThanOrEqual(44);
      expect(item.owned).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    expect(await sheet.evaluate(el => ({ bodyInert: el.hasAttribute("inert"), containsFocus: el.contains(document.activeElement) }))).toEqual({ bodyInert: false, containsFocus: true });
  } finally { await context.close(); }
});


test("a Back during role-pane entry waits its owner instead of starting a competing reverse", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await openCodeChat(page);
    await page.getByTestId("config-chip").click();
    const sheet = page.getByRole("dialog", { name: "Chat settings" });
    await sheet.getByTestId("agent-picker").click();
    const root = page.locator(".config-agent-pane");
    await expect(page.getByRole("dialog", { name: "Primary agent", exact: true })).toBeVisible();
    await expect.poll(() => root.evaluate(el => el.getAnimations().some(a => a.id === "morph:pane"))).toBe(true);
    await root.evaluate(el => {
      const entry = el.getAnimations().find(a => a.id === "morph:pane");
      if (!entry) throw new Error("no real live entry");
      entry.pause();
    });
    // Repeated Escape before React commits returning cannot create a second same-owner leave.
    await root.getByRole("listbox", { name: "Primary agent" }).press("Escape");
    await root.getByRole("listbox", { name: "Primary agent" }).press("Escape");
    await expect(root).toHaveClass(/is-returning/);
    const ownedEntries = await root.evaluate(el => el.getAnimations().filter(animation => animation.id === "morph:pane").length);
    expect(ownedEntries).toBe(1);
    await root.evaluate(async el => {
      const entry = el.getAnimations().find(a => a.id === "morph:pane");
      if (!entry) throw new Error("lost the original entrance");
      entry.play(); await entry.finished;
    });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("agent-picker")).toBeFocused();
    await expect(root).toHaveCount(0);
  } finally { await context.close(); }
});

test("reduced motion returns role settings directly with no live pane or size morph", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    await openCodeChat(page);
    await page.getByTestId("config-chip").click();
    const sheet = page.getByRole("dialog", { name: "Chat settings" });
    await sheet.getByTestId("agent-picker").click();
    const root = page.locator(".config-agent-pane");
    expect(await root.evaluate(el => el.getAnimations().length)).toBe(0);
    await page.getByRole("button", { name: "Back to chat settings" }).click();
    await expect(sheet.getByTestId("agent-picker")).toBeFocused();
    expect(await page.locator("dialog").evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0);
    expect(await page.locator(".config-agent-pane").count()).toBe(0);
    expect(await sheet.locator(".dialog-body").evaluate(el => el.style.height)).toBe("");
  } finally { await context.close(); }
});


test("closing during an outgoing role transition returns to the actual settings invoker", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await openCodeChat(page);
    await page.getByTestId("config-chip").click();
    await page.getByRole("dialog", { name: "Chat settings" }).getByTestId("agent-picker").click();
    const pane = page.getByRole("dialog", { name: "Primary agent", exact: true });
    await expect(pane).toBeVisible();
    await pane.evaluate(async root => { await Promise.all(root.getAnimations({ subtree: true }).map(a => a.finished.catch(() => undefined))); });
    await pane.getByRole("button", { name: "Back to chat settings" }).click();
    const outgoing = page.locator(".config-agent-pane.is-returning");
    await expect.poll(() => outgoing.evaluate(el => el.getAnimations().some(a => a.id === "morph:pane"))).toBe(true);
    await outgoing.evaluate(el => { for (const a of el.getAnimations()) a.pause(); });
    // The outgoing motion remains unsatisfied. Native close must cancel, not await a fake complete Back.
    await pane.getByRole("button", { name: "Close", exact: true }).click();
    await expect(pane).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Chat settings" })).toHaveCount(0);
    await expect(outgoing).toHaveCount(0);
    await expect(page.getByTestId("config-chip")).toBeFocused();
  } finally { await context.close(); }
});
