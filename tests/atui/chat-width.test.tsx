// The chat width (config.yml's chat_width) in atui: the conversation's column in
// characters, the composer on the same column, and the C-x key and the palette
// saving it through the server's settings route, as the web UI's Settings does.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mount, PORT, startServer, wait, type Mounted } from "./helpers.js";

let server: Awaited<ReturnType<typeof startServer>>;
let ui: Mounted | null = null;

beforeAll(async () => {
  // The suite's own port plus one, so this server and app.test.tsx's never meet.
  server = await startServer({ port: PORT + 1 });
});
afterAll(async () => {
  await server.stop();
});
afterEach(async () => {
  await ui?.unmount();
  ui = null;
});

/** config.yml as the server reads it on every bootstrap: the setting needs no restart. */
const setWidth = (width: string) => writeFileSync(path.join(server.configDir, "config.yml"), `chat_width: ${width}\n`);
const savedWidth = () => readFileSync(path.join(server.configDir, "config.yml"), "utf8");

/**
 * How many columns a box paints on the row that shows `text`: the prompt's fill strip, or the
 * composer card's surface. Each box draws to the conversation's column, so this is what the
 * setting set (a turn's box is capped at the column, the composer's card is the column wide).
 */
async function paintedWidth(ui: Mounted, text: string): Promise<number> {
  const rows = await ui.spans();
  const row = rows.find((line) => line.map((span) => span.text).join("").includes(text));
  if (!row) throw new Error(`the frame shows no ${JSON.stringify(text)}`);
  const paint = row.find((span) => span.text.includes(text))?.bg.toInts().join();
  const start = row.findIndex((span) => span.bg.toInts().join() === paint);
  let width = 0;
  for (let i = start; i >= 0 && i < row.length && row[i]?.bg.toInts().join() === paint; i++) width += row[i]?.width ?? 0;
  return width;
}

/** The conversation's column: what the prompt's fill strip covers. */
const column = (ui: Mounted) => paintedWidth(ui, "❯");

/** Wait until the drawn column is `width` (a save and a resize reach the next frame). */
const columnBecomes = async (width: number) => {
  const shown = ui as Mounted;
  const start = Date.now();
  for (;;) {
    const got = await column(shown);
    if (got === width) return;
    if (Date.now() - start > 8000) throw new Error(`the column stayed ${got}, not ${width}:\n${await shown.frame()}`);
    await wait(50);
  }
};

describe("the chat width", () => {
  it("draws comfortable, wide, and full, follows a resize, and saves a change from C-x l", async () => {
    setWidth("comfortable");
    ui = await mount(path.join(server.root, "alpha"), { width: 240, height: 50, base: server.base });
    await ui.type("hello");
    ui.keys.pressEnter();
    await ui.until("Echo: hello");
    await ui.until(() => ui?.app.chat()?.status === "idle");
    // Comfortable is the reading column atui has always drawn.
    await columnBecomes(104);
    // The composer card sits on the same column, as the web composer sits on the thread's.
    expect(await paintedWidth(ui, "Message the agent")).toBe(104);

    // A narrower window keeps its own room rather than a width it has not got: 120 - 28 (the panel) - 4 (the transcript's padding).
    ui.resize(120, 40);
    await columnBecomes(88);
    ui.resize(240, 50);
    await columnBecomes(104);

    // C-x l cycles to wide, and the save goes through the settings route the web dialog uses.
    ui.keys.pressKey("x", { ctrl: true });
    const panel = await ui.until("C-x-");
    expect(panel).toContain("l → chat width");
    ui.keys.pressKey("l");
    await ui.until("Chat width: Wide");
    await columnBecomes(160);
    expect(savedWidth()).toContain("chat_width: wide");

    // Again: full is the whole content width (240 - 36 for the panel - 4 for the padding).
    ui.keys.pressKey("x", { ctrl: true });
    ui.keys.pressKey("l");
    await ui.until("Chat width: Full");
    await columnBecomes(200);

    // And round to comfortable, which is what the cycle's third press is for.
    ui.keys.pressKey("x", { ctrl: true });
    ui.keys.pressKey("l");
    await ui.until("Chat width: Comfortable");
    await columnBecomes(104);
    expect(savedWidth()).toContain("chat_width: comfortable");
    expect(ui.app.boot()?.ui.chatWidth).toBe("comfortable");
  }, 60_000);

  it("sets the width from the palette, which lists all three", async () => {
    setWidth("comfortable");
    ui = await mount(path.join(server.root, "beta"), { width: 240, height: 50, base: server.base });
    await ui.type("hello");
    ui.keys.pressEnter();
    await ui.until("Echo: hello");
    await ui.until(() => ui?.app.chat()?.status === "idle");
    ui.keys.pressKey("k", { ctrl: true });
    await ui.until("Search commands");
    await ui.type("chat width");
    const listed = await ui.until("Chat width: Wide");
    expect(listed).toContain("Chat width: Comfortable");
    expect(listed).toContain("Chat width: Full");
    // The rows keep the setting's order: down to Full, and take it.
    ui.keys.pressArrow("down");
    ui.keys.pressArrow("down");
    ui.keys.pressEnter();
    await ui.until("Chat width: Full");
    await columnBecomes(200);
    expect(savedWidth()).toContain("chat_width: full");
  }, 60_000);
});
