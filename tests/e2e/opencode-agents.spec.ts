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

async function openCodeChat(page: Page) {
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
  const plain = options.getByRole("option", { name: /Plain/ });
  const active = await plain.getAttribute("id");
  await expect(page.getByRole("combobox", { name: "Search models" })).toHaveAttribute("aria-activedescendant", active!);
  await expect(options.getByRole("option", { name: /Fast Free/ })).toHaveAttribute("aria-selected", "true");
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
