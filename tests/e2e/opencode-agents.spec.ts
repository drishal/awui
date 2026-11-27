// The primary-agent selector in a real OpenCodeAdapter chat: its choices, API
// effects and the phone sheet. Model inference is still the scripted fixture.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { signInAndOpen } from "./helpers.js";

interface FixtureState {
  createdAgents?: Array<string | null>;
  agentSwitches?: Array<{ sessionID: string; agent: string }>;
  modelSet?: number;
  sessions: Record<string, { agent?: string }>;
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
  await expect(trigger).toHaveAccessibleName("Agent: Default agent");
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

test("a phone puts the real primary agent in Chat settings without narrowing the layout", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCodeChat(page);
  await expect(page.locator(".composer-pickers")).toBeHidden();
  await page.getByTestId("config-chip").click();
  const sheet = page.getByRole("dialog", { name: "Chat settings" });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".config-row-label", { hasText: /^Agent$/ })).toBeVisible();
  await expect(sheet.getByTestId("agent-picker")).toHaveAccessibleName("Agent: Default agent");
  await expect(sheet.getByTestId("model-picker")).toBeVisible();
  await sheet.getByTestId("agent-picker").click();
  const menu = page.getByRole("listbox", { name: "Primary agent" });
  await expect(menu).toBeVisible();
  const rect = await menu.boundingBox();
  expect(rect).not.toBeNull();
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(390);
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  expect(await sheet.evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(await sheet.evaluate((el) => el.clientWidth));
  await menu.getByRole("option", { name: "orchestrator", exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId("config-chip")).toContainText("orchestrator");
  await page.getByTestId("config-chip").click();
  await expect(page.getByRole("dialog", { name: "Chat settings" }).getByTestId("agent-picker")).toHaveAccessibleName("Agent: orchestrator");
});

test("a harness with no primary-agent catalogue gains no fake Default agent control", async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await signInAndOpen(page);
  await page.getByRole("textbox", { name: "Message" }).fill("hello on another harness");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("Idle");
  await expect(page.getByTestId("agent-picker")).toHaveCount(0);
});
