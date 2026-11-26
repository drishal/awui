import { expect, test } from "@playwright/test";
import { newChat, send, sendAndWait, showSidebar, signInAndOpen } from "./helpers.js";

// Visual check only: AWUI_SCREENSHOTS=<dir> npx playwright test screenshots
const dir = process.env.AWUI_SCREENSHOTS;
test.skip(!dir, "set AWUI_SCREENSHOTS to a directory to capture screenshots");

const idle = (page: import("@playwright/test").Page) => expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 20_000 });

for (const [name, viewport] of [
  ["desktop", { width: 1360, height: 860 }],
  ["phone", { width: 390, height: 844 }],
  ["narrow", { width: 320, height: 640 }],
] as const) {
  test(`capture ${name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await signInAndOpen(page);
    if (name !== "desktop") await page.keyboard.press("Escape");
    await newChat(page);
    await page.screenshot({ path: `${dir}/${name}-0-hero.png` });
    await sendAndWait(page, "hello tool, render **markdown** and a `code` span");
    await sendAndWait(page, "make a todo list and edit things");
    await sendAndWait(page, "one more question");
    await page.screenshot({ path: `${dir}/${name}-1-chat.png` });
    await page.getByTestId("process-toggle").first().click();
    await page.getByTestId("tool-row").first().locator("button").first().click();
    await page.screenshot({ path: `${dir}/${name}-2-expanded.png` });
    await send(page, "ask please");
    await expect(page.getByTestId("approval-card")).toBeVisible();
    await page.screenshot({ path: `${dir}/${name}-3-approval.png` });
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByTestId("approval-card")).toHaveCount(0);
    await idle(page);
    await send(page, "slow stream");
    const jump = page.getByRole("button", { name: /Jump to latest/ });
    if (await jump.isVisible()) await jump.click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${dir}/${name}-4-live.png` });
    await idle(page);
    if (name !== "desktop") {
      await showSidebar(page);
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${dir}/${name}-5-drawer.png` });
    }
  });
}

test("capture ripple", async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 860 });
  await signInAndOpen(page);
  await newChat(page);
  await page.getByRole("textbox", { name: "Message" }).fill("ripple demo");
  for (const [name, locator] of [
    ["send", page.getByRole("button", { name: "Send", exact: true })],
    ["newchat", page.getByRole("button", { name: "New chat", exact: true })],
  ] as const) {
    const box = (await locator.boundingBox()) as { x: number; y: number; width: number; height: number };
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
    await page.mouse.down();
    await page.waitForTimeout(260);
    await page.screenshot({ path: `${dir}/ripple-${name}.png`, clip: { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: box.height + 24 } });
    await page.mouse.move(box.x - 40, box.y - 40);
    await page.mouse.up();
  }
});

for (const [name, viewport] of [
  ["desktop", { width: 1360, height: 860 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test(`capture model picker ${name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await signInAndOpen(page);
    if (name !== "desktop") await page.keyboard.press("Escape");
    await newChat(page);
    await sendAndWait(page, "hello");
    await page.getByTestId("model-picker").click();
    await page.screenshot({ path: `${dir}/picker-${name}-open.png` });
    await page.getByRole("combobox", { name: "Search models" }).fill("gpt");
    await page.screenshot({ path: `${dir}/picker-${name}-search.png` });
  });
}

test("capture tool cards", async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 2400 });
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "showcase");
  await page.getByTestId("process-toggle").first().click();
  for (const row of await page.getByTestId("tool-row").all()) await row.locator("button").first().click();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${dir}/tools-${scheme}.png`, fullPage: true });
  }
});
