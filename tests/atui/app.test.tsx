// atui end to end: the built server with fake harnesses, atui in OpenTUI's
// test renderer, driven by keys and clicks as a person would.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { MarkdownRenderable, RGBA, TextAttributes } from "@opentui/core";
import path from "node:path";
/** The blinking stream cursor atui used to draw; it is gone, like in opencode, pi and Claude Code. */
const OLD_CARET = "▍";
import { contextTone } from "../../src/atui/theme.js";
import { setIconSet } from "../../src/atui/icons.js";
import { mount, startServer, wait, type Mounted } from "./helpers.js";

let server: Awaited<ReturnType<typeof startServer>>;
let ui: Mounted | null = null;
/** The fake gh's record (tests write it, the server's gh reads it) and its call log. */
let ghRecord = "";
let ghCalls = "";

beforeAll(async () => {
  // The GitHub panel's tests point the server's gh at the fixture; the other tests never call it.
  const ghBin = mkdtempSync(path.join(tmpdir(), "atui-gh-"));
  const gh = path.join(ghBin, "gh");
  writeFileSync(gh, readFileSync(path.resolve(import.meta.dirname, "../fixtures/fake-gh.mjs"), "utf8"));
  execFileSync("chmod", ["755", gh]);
  ghRecord = path.join(ghBin, "pr.json");
  ghCalls = path.join(ghBin, "calls.jsonl");
  server = await startServer({ env: { PATH: `${ghBin}:${process.env.PATH ?? ""}`, AWUI_GH_FIXTURE: ghRecord, AWUI_GH_CALLS: ghCalls } });
});
afterAll(async () => {
  await server.stop();
});
afterEach(async () => {
  await ui?.unmount();
  ui = null;
});

const idle = (m: Mounted) => m.until(() => m.app.chat()?.status === "idle", 15_000);

const markdownContents = (root: { getChildren?: () => unknown[] }): string[] => {
  const out: string[] = [];
  const walk = (node: { getChildren?: () => unknown[] }) => {
    if (node instanceof MarkdownRenderable) out.push(node.content);
    for (const child of node.getChildren?.() ?? []) walk(child as { getChildren?: () => unknown[] });
  };
  walk(root);
  return out;
};

const markdownHeights = (root: { getChildren?: () => unknown[] }): number[] => {
  const out: number[] = [];
  const walk = (node: { getChildren?: () => unknown[] }) => {
    if (node instanceof MarkdownRenderable) out.push(node.height);
    for (const child of node.getChildren?.() ?? []) walk(child as { getChildren?: () => unknown[] });
  };
  walk(root);
  return out;
};

const assistant = (m: Mounted) => m.app.chat()?.items.find((item) => item.kind === "assistant");

/** A full-pane view starts inside the conversation column, not under the sidebar: its title sits right of the sidebar's edge, with no frame of its own (Review's grammar). */
const sheetFits = (frame: string, title: string) => {
  const rows = frame.split("\n");
  const edge = rows.find((row) => !row.includes("Sessions") && !row.includes("Info") && row.trimStart().startsWith("│"))?.indexOf("│") ?? -1;
  const at = rows.find((row, i) => i > 1 && row.includes(title));
  expect(at).toBeDefined();
  expect(at?.indexOf(title) ?? 0).toBeGreaterThan(edge);
  // No frame of its own: the title is not the row under a rounded top edge.
  expect(rows[rows.indexOf(at as string) - 1] ?? "").not.toContain("╭");
};

describe("atui", () => {
  it("keeps the sidebar's New chat row and project card when the list is far taller than the screen", async () => {
    ui = await mount(path.join(server.root, "alpha"), { width: 140, height: 36 });
    await ui.until("Fake Echo ▾");
    await ui.type("hello");
    ui.keys.pressEnter();
    await idle(ui);
    const workspaceId = ui.app.workspace()?.id;
    expect(workspaceId).toBeTruthy();
    for (let i = 0; i < 60; i++) await ui.app.server.call("/api/chats", { body: { workspaceId, harnessId: "fake" } });
    const frame = await ui.until("● 61");
    // Squeezed to nothing by the list, these rows once left a blank band under the tabs.
    expect(frame).toContain("+ New chat");
    expect(frame).toMatch(/A\s+…\/\S*alpha/);
  }, 60_000);

  it("keeps the original controls neat and clickable without a second toolbar", async () => {
    ui = await mount(path.join(server.root, "alpha"), { width: 140, height: 36 });
    const start = await ui.until("Fake Echo ▾");
    expect(start).not.toContain("Send ↑");
    expect(start).not.toContain("▤ alpha ▾");
    await ui.type("sent from the arrow");
    await ui.click("↑");
    await idle(ui);
    expect(await ui.frame()).toContain("Echo: sent from the arrow");
    // ↑ in the empty box recalls the sent prompt, ↓ past the newest empties it again.
    ui.keys.pressArrow("up");
    await ui.until(() => (ui?.app.chat() ? true : false));
    await wait(60);
    expect((await ui.frame()).split("\n").some((line) => line.includes("│ sent from the arrow"))).toBe(true);
    ui.keys.pressArrow("down");
    await wait(60);
    expect((await ui.frame()).split("\n").some((line) => line.includes("│ sent from the arrow"))).toBe(false);
    await ui.click("Fake ▾");
    await ui.until("Search harnesses…");
    await ui.escape();
    await ui.click("Fake Echo ▾");
    await ui.until("Search models…");
    await ui.escape();
    await ui.click("Sessions");
    await ui.until("»");
    await ui.click("»");
    await ui.until(">_");
    await ui.click(">_");
    await ui.until("Project terminal", 15_000);
    await ui.type("printf neat-terminal-ok\\n\n");
    await ui.until("neat-terminal-ok", 15_000);
    await ui.escape();
    await ui.until("Fake Echo ▾");
  }, 30_000);

  it("opens Git from the branch button, including before a first message", async () => {
    const repo = path.join(server.root, "buttonrepo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(path.join(repo, "README.md"), "initial\n");
    execFileSync("git", ["init", "-qb", "master"], { cwd: repo });
    ui = await mount(repo, { height: 44 });
    await ui.app.ensureChat();
    await ui.until("master");
    await ui.click("master");
    await ui.until(() => ui?.app.git() !== null, 15_000);
    const panel = await ui.until("master");
    expect(panel).toContain("Upstream");
    expect(panel).toContain("README.md");
    expect(ui.app.chat()).not.toBeNull();
    await ui.escape();
    await ui.until("Fake Echo ▾");
  }, 30_000);

  it("keeps the board, active work and delegated views inside the conversation column", async () => {
    for (const width of [100, 140]) {
      ui = await mount(path.join(server.root, "alpha"), { width, height: 44 });
      await ui.type("delegate please");
      ui.keys.pressEnter();
      await idle(ui);
      for (const [key, expected] of [["k", "Agents"], ["p", "Active work"], ["j", "Delegated work"]] as const) {
        ui.keys.pressKey("x", { ctrl: true });
        ui.keys.pressKey(key);
        const frame = await ui.until(expected);
        sheetFits(frame, expected);
        if (key === "k") {
          expect(frame).toMatch(/Enter open · .*Esc close/);
          // The worker's row gives its title the room, so its model is said whole under the board (read once its preview arrives).
          if (width === 140) expect(await ui.until("Workers fake/echo · test")).toMatch(/└ .*test · /);
        }
        ui.keys.pressEscape();
        await wait(60);
      }
      await ui.unmount();
      ui = null;
    }
  }, 45_000);

  it("sends a message, streams the answer, and shows the work, files, and context", async () => {
    // Tall enough for the whole opened turn: neat-render's rows take two lines and more.
    ui = await mount(path.join(server.root, "alpha"), { height: 80 });
    expect(await ui.frame()).toContain("What should Fake do in alpha?");
    await ui.type("showcase tool edit please");
    ui.keys.pressEnter();
    await ui.until("Echo: showcase tool edit please");
    await idle(ui);
    await ui.until("Changed 3 files");
    // The answer itself (its ● gutter), not the thought line that also quotes it: the reveal may still be finishing.
    const f = await ui.until("● Echo: showcase tool edit please");
    expect(f).toContain("Changed 3 files");
    // neat-render's turn: the prompt behind a ❯, the calls fired together on one tree, each
    // outcome at the end of its line, the answer marked, and a Σ line of what the turn did.
    expect(f).toContain("❯ showcase tool edit please");
    expect(f).toContain("┌─ ▤ Read README.md");
    expect(f).toMatch(/├─ ✎ Edited src\/app\.ts +\+1 −1/);
    expect(f).toMatch(/└─ [▤✎⊞›⌕↗◈◇≡●✗] /);
    expect(f).toContain("● Echo: showcase tool edit please");
    expect(f).toMatch(/Σ \d+ calls · /);
    expect(f).not.toContain("Worked for");
    expect(f).toContain("Fake Echo ▾");
    expect(f).toContain("Low ▾");
    // Clicked, a call is framed on the tree's trunk, its outcome in the bottom edge.
    await ui.click("Edited src/app.ts");
    const framed = await ui.until("╰─ +1 −1");
    expect(framed).toContain("╭");
    // C-x e folds every turn to its line, and brings the work back.
    ui.keys.pressKey("x", { ctrl: true });
    ui.keys.pressKey("e");
    const folded = await ui.until("▸ Worked for");
    expect(folded).toMatch(/▸ Worked for \d+s · 2 reads, 1 search, 2 edits/);
    expect(folded).not.toContain("┌─ ● Read");
  }, 30_000);
  it("switches the marks to Nerd Font glyphs from the palette and back", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 40 });
    await ui.type("showcase tool edit please");
    ui.keys.pressEnter();
    await ui.until("┌─ ▤ Read README.md");
    await idle(ui);
    ui.keys.pressKey("k", { ctrl: true });
    await ui.until("Search commands");
    await ui.type("icons");
    ui.keys.pressEnter();
    const nerd = await ui.until("\uf15c Read README.md");
    expect(nerd).toMatch(/├─ \uf040 Edited src\/app\.ts/);
    expect(nerd).not.toContain("▤ Read README.md");
    ui.keys.pressKey("k", { ctrl: true });
    await ui.until("Search commands");
    await ui.type("icons");
    ui.keys.pressEnter();
    await ui.until("┌─ ▤ Read README.md");
    setIconSet("unicode");
  }, 30_000);
  it("paints a find's words inside an open turn's tool rows, so the count of matches in the work points at something lit", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 40 });
    await ui.type("showcase tool edit please");
    ui.keys.pressEnter();
    await ui.until("┌─ ▤ Read README.md");
    await idle(ui);
    ui.keys.pressKey("s", { ctrl: true });
    await ui.until("Type to find text in this chat…");
    await ui.type("lines");
    await wait(500);
    ui.keys.pressEnter();
    await wait(300);
    const rows = (await ui.spans()) ?? [];
    const read = rows.find((l) => l.map((x) => x.text).join("").includes("Read README.md"));
    const hit = read?.find((x) => x.text === "lines");
    // The words sit on a ground of their own (the warn tint), not the page's.
    expect(hit).toBeDefined();
    const page = read?.find((x) => x.text.includes("Read"))?.bg.toInts().join();
    expect(hit?.bg.toInts().join()).not.toBe(page);
  }, 30_000);
  it("paints a find's words inside an open edit's diff, which OpenTUI's diff view cannot", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 60, width: 140 });
    await ui.type("showcase tool listen");
    ui.keys.pressEnter();
    await ui.until("┌─ ▤ Read README.md");
    await idle(ui);
    await ui.click("Edited src/server.ts");
    await ui.until("process.env");
    ui.keys.pressKey("s", { ctrl: true });
    await ui.until("Type to find text in this chat…");
    await ui.type("listen");
    await wait(500);
    ui.keys.pressEnter();
    await wait(300);
    const rows = (await ui.spans()) ?? [];
    const line = rows.find((l) => l.map((x) => x.text).join("").includes("listen(port, host)"));
    const hit = line?.find((x) => x.text === "listen");
    expect(hit).toBeDefined();
    const code = line?.find((x) => x.text.includes("log("));
    expect(hit?.bg.toInts().join()).not.toBe(code?.bg.toInts().join());
  }, 30_000);
  it("starts a rename from the palette by putting /rename in the composer", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 40 });
    await ui.type("hello rename");
    ui.keys.pressEnter();
    await ui.until("Echo: hello rename");
    await idle(ui);
    ui.keys.pressKey("k", { ctrl: true });
    await ui.until("Search commands");
    await ui.type("rename this");
    ui.keys.pressEnter();
    expect(await ui.until("/rename")).not.toContain("Search commands");
  }, 30_000);
  it("says what will fill Active work when a chat has only its context", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 40 });
    await ui.type("hello quiet rail");
    ui.keys.pressEnter();
    await ui.until("Echo: hello quiet rail");
    await idle(ui);
    ui.keys.pressKey("x", { ctrl: true });
    ui.keys.pressKey("p");
    const rail = await ui.until("Active work");
    expect(rail).toContain("Nothing is running.");
    expect(rail).toContain("Workers this chat delegates, background jobs");
    // The sentence explains the empty list, so it sits above the context card, not under it.
    expect(rail.indexOf("Workers this chat delegates")).toBeLessThan(rail.indexOf("Context and usage"));
  }, 30_000);
  it("masks a password prompt, shows bullets for what is typed, and sends it once", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 40 });
    await ui.type("sudo please");
    ui.keys.pressEnter();
    const card = await ui.until("Sudo password");
    expect(card).toContain("Masked in this terminal");
    // One line only: a newline would join the secret unseen, so the hint offers none.
    expect(card).toContain("Enter send · Esc cancel");
    expect(card).not.toContain("Shift+Enter new line");
    await ui.type("hunter2");
    const typed = await ui.until("> •••••••");
    // The characters are never drawn; only their count is.
    expect(typed).not.toContain("hunter2");
    ui.keys.pressEnter();
    const done = await ui.until("Password accepted");
    expect(done).not.toContain("hunter2");
  }, 30_000);
  it("carries the chat's tokens, cache and price on a second footer row where there is room, and keeps one row where there is not", async () => {
    ui = await mount(path.join(server.root, "alpha"), { width: 140, height: 40 });
    await ui.type("showcase timing");
    ui.keys.pressEnter();
    await idle(ui);
    const roomy = await ui.until(/* the usage arrives with the run's end */ "cache ");
    expect(roomy).toMatch(/in [\d.]+k? · out [\d.]+k?/);
    // The first row keeps what steers; the figures are the row under it.
    const rows = roomy.split("\n");
    const first = rows.findIndex((r) => /Think \w+ ▾/.test(r));
    expect(rows[first]).not.toContain("cache ");
    expect(rows[first + 1]).toMatch(/in [\d.]+k? · out/);
    await ui.unmount();
    ui = await mount(path.join(server.root, "alpha"), { width: 70, height: 28 });
    await ui.type("showcase timing");
    ui.keys.pressEnter();
    await idle(ui);
    const tight = await ui.frame();
    // A short, narrow pane keeps one row, and the level chip keeps its noun.
    expect(tight).not.toMatch(/in [\d.]+k? · out/);
    expect(tight).toContain("Think ");
  }, 40_000);
  it("opens the file sheet on a file from an opened call's View line", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 80 });
    await ui.type("showcase tool edit please");
    ui.keys.pressEnter();
    await ui.until("Changed 3 files");
    await idle(ui);
    await ui.click("Edited src/app.ts");
    await ui.until("╰─ +1 −1");
    await ui.click("▤ View src/app.ts");
    const sheet = await ui.until("Open a file");
    expect(sheet).toContain("src/app.ts");
    await ui.escape();
    await wait(150);
    expect(await ui.frame()).not.toContain("Open a file");
  }, 30_000);
  it("shows reasoning by default, folds one block or all, and finishes streaming", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 60 });
    await ui.type("showcase");
    ui.keys.pressEnter();
    await idle(ui);
    await ui.until("Considering: Echo: showcase");
    // Under a loaded machine the first frame after the status flips can still be the working one: wait for the settled frame.
    let shown = await ui.frame();
    for (let i = 0; i < 40 && shown.includes("Working ·"); i++) { await new Promise((r) => setTimeout(r, 50)); shown = await ui.frame(); }
    expect(shown).not.toContain("░ nop placeholder");
    expect(shown).not.toContain("Working ·");
    expect(shown).not.toContain("Running");
    // C-t: all reasoning folds; a local click reopens only that block.
    ui.keys.pressKey("t", { ctrl: true });
    const folded = await ui.until("Reasoning folded");
    expect(ui.app.showThoughts()).toBe(false);
    expect(folded).not.toContain("Considering: Echo: showcase");
    expect(folded).toContain("C-t to show");
    const assistantId = ui.app.chat()!.items.find((i) => i.kind === "assistant" && i.thinking.trim())!.id;
    // A local click inverts this block without changing the global preference.
    await ui.click("Thinking");
    await ui.until(() => ui?.app.thoughtOpen(assistantId) === true);
    expect(ui.app.showThoughts()).toBe(false);
    expect(await ui.frame()).toContain("Considering: Echo: showcase");
    // A fresh global choice clears local exceptions, then reverses normally.
    ui.keys.pressKey("t", { ctrl: true });
    await ui.until(() => ui?.app.showThoughts() === true);
    expect(ui.app.thoughtOpen(assistantId)).toBe(true);
    ui.keys.pressKey("x", { ctrl: true });
    await ui.keys.pressKey("o");
    await ui.until(() => ui?.app.showThoughts() === false);
    expect((await ui.frame()).includes("Considering: Echo: showcase")).toBe(false);
    ui.keys.pressKey("x", { ctrl: true });
    await ui.keys.pressKey("o");
    await ui.until(() => ui?.app.showThoughts() === true);
    expect(ui.app.thoughtOpen(assistantId)).toBe(true);
    expect(await ui.frame()).toContain("Considering: Echo: showcase");
  }, 30_000);

  it("shows a reply written between tool calls as a reply, before the command that followed it", async () => {
    ui = await mount(path.join(server.root, "beta"), { height: 40 });
    await ui.type("interleaved please");
    ui.keys.pressEnter();
    await idle(ui);
    const f = await ui.until("Echo: interleaved please");
    const reply = f.indexOf("this is reply block 1");
    const command = f.indexOf("› Ran");
    expect(reply).toBeGreaterThan(0);
    expect(command).toBeGreaterThan(reply);
    expect(f.indexOf("Echo: interleaved please")).toBeGreaterThan(command);
    // The reply is drawn once, not again among the work. (The fake's thought would quote it, after "Considering:".)
    expect(f.match(/(?<!Considering: )this is reply block 1/g)).toHaveLength(1);
  }, 30_000);

  it("flashes the prompt's ❯ once when a run ends", async () => {
    ui = await mount(path.join(server.root, "alpha"));
    await ui.type("tool please");
    ui.keys.pressEnter();
    await idle(ui);
    const ok = RGBA.fromHex(ui.app.theme().muted).toInts().join();
    const edge = async () => {
      const row = (await ui?.spans())?.find((l) => l.map((s) => s.text).join("").includes("❯ tool please"));
      return row?.find((s) => s.text.includes("❯"))?.fg.toInts().join();
    };
    // A tenth of a second in, the flash is near its height.
    await wait(100);
    const lit = await edge();
    expect(lit).toBeDefined();
    expect(lit).not.toBe(ok);
    await wait(1100);
    expect(await edge()).toBe(ok);
  }, 30_000);

  it("breathes a session that asks for you in the side panel", async () => {
    ui = await mount(path.join(server.root, "beta"), { width: 150 });
    await ui.type("please ask first");
    ui.keys.pressEnter();
    await ui.until("Waiting for approval");
    await ui.until(() => ui?.app.overview().sessions.some((s) => s.asking) ?? false);
    // The asking row's own prefix (the project card's ▲N count is a different span, warn and steady).
    const mark = async () => (await ui?.spans())?.flat().find((s) => s.text === "▲ ")?.fg.toInts().join();
    // Three looks a little apart: a breath cannot show the same colour at all of them.
    const seen = [await ui.until("▲ please ask first").then(mark)];
    for (const _ of [1, 2]) {
      await wait(400);
      seen.push(await mark());
    }
    expect(seen.every(Boolean)).toBe(true);
    expect(new Set(seen).size).toBeGreaterThan(1);
    ui.keys.pressKey("1");
    await idle(ui);
  }, 30_000);

  it("shows a running command's last lines under it, until its outcome takes their place", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 40 });
    await ui.type("ticking please");
    ui.keys.pressEnter();
    const live = await ui.until("step-4.test.ts");
    // Three lines at a time, the newest last.
    expect(live).toContain("│  ✓ tests/unit/step-2.test.ts");
    expect(live).not.toContain("step-1.test.ts");
    // The bullet blinks between filled and hollow while the call runs.
    // The marker ticks: "running…" until the call has gone on long enough to show its time.
    expect(live).toMatch(/[●○] Running · (?:running…|\d)/);
    await idle(ui);
    expect(await ui.frame()).not.toContain("step-6.test.ts");
  }, 30_000);

  it("draws a call's background job under it, and the live ones above the composer", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 44 });
    await ui.type("bgjob please");
    ui.keys.pressEnter();
    // While the wait streams its widget, the job's own row carries the meter and its progress.
    const live = await ui.until("tests done");
    expect(live).toContain("bg_1");
    expect(live).toMatch(/tests done ━+/);
    await idle(ui);
    // Settled: the counts it left, the projects' grid, and where the run ended.
    const done = await ui.until("11 passed · 1 failed");
    expect(done).toContain("tests done");
    expect(done).toContain("11 passed, 1 failed");
    expect(done).toContain("bg_1");
  }, 45_000);

  it("colours the context from green toward red as it fills", async () => {
    ui = await mount(path.join(server.root, "beta"));
    // The sparkline before the figure shares its colour, so the two can come as one run: "▁▂ ctx 8%".
    const label = async () => (await ui?.spans())?.flat().find((s) => /(^|\s)ctx \d+%$/.test(s.text));
    const toneAt = (percent: number) => RGBA.fromHex(contextTone(ui?.app.theme() as never, percent)).toInts().join();
    await ui.type("hello there");
    ui.keys.pressEnter();
    await idle(ui);
    const low = await ui.until("ctx ").then(label);
    expect(low?.fg.toInts().join()).toBe(toneAt(ui.app.chat()?.context?.percent ?? 0));
    await ui.type("bloat it");
    ui.keys.pressEnter();
    await idle(ui);
    await ui.until(() => (ui?.app.chat()?.context?.percent ?? 0) > 50);
    const high = await label();
    expect(high?.fg.toInts().join()).toBe(toneAt(ui.app.chat()?.context?.percent ?? 0));
    expect(high?.fg.toInts().join()).not.toBe(low?.fg.toInts().join());
  }, 30_000);

  it("says how fast the agent writes while it streams, and nothing once it is done", async () => {
    ui = await mount(path.join(server.root, "alpha"));
    await ui.type("slow stream for the rate");
    ui.keys.pressEnter();
    expect(await ui.until(" tok/s", 10_000)).toMatch(/~\d+ tok\/s/);
    await idle(ui);
    expect(await ui.frame()).not.toContain("tok/s");
  }, 30_000);

  it("marks a parsed test failure in red and underlines it", async () => {
    ui = await mount(path.join(server.root, "alpha"));
    await ui.type("testrun");
    ui.keys.pressEnter();
    await idle(ui);
    await ui.until("1 failed");
    const spans = (await ui.spans()).flat();
    const failed = spans.find(s => s.text.includes("1 failed"));
    expect(failed?.fg.toInts().join()).toBe(RGBA.fromHex(ui.app.theme().danger).toInts().join());
    expect(failed && failed.attributes & TextAttributes.UNDERLINE).toBeTruthy();
    expect(spans.find(s => s.text.includes("1 passed"))?.fg.toInts().join()).toBe(RGBA.fromHex(ui.app.theme().muted).toInts().join());
    ui.keys.pressKey("x", { ctrl: true });
    ui.keys.pressKey("e");
    const folded = await ui.until("Worked for");
    expect(folded).not.toContain("Σ ");
  }, 30_000);

  it("underlines a failure as well as colouring it", async () => {
    ui = await mount(path.join(server.root, "alpha"));
    await ui.type("fail please");
    ui.keys.pressEnter();
    await ui.until("✗ Fake failure");
    const failure = (await ui.spans()).flat().find((s) => s.text.includes("Fake failure"));
    expect(failure && failure.attributes & TextAttributes.UNDERLINE).toBeTruthy();
    expect(failure?.text).not.toContain("✗");
  }, 30_000);

  it("names the harness's default model and level on the start screen, and starts the first chat on a pick there", async () => {
    ui = await mount(path.join(server.root, "alpha"));
    // Before any chat: the catalog's answer, not a bare "Model" and "Thinking".
    const f = await ui.until("Fake Echo ▾");
    expect(ui.app.chat()).toBeNull();
    expect(f).toContain("Fake Echo ▾");
    expect(f).toContain("Low ▾");
    // Alt+M offers the catalog's models; the pick is kept for the chat the first message makes.
    ui.keys.pressKey("m", { meta: true });
    await ui.until("Search models…");
    await ui.type("slow");
    ui.keys.pressEnter();
    await ui.until(() => ui?.app.chips().name === "Fake Slow");
    expect(ui.app.chat()).toBeNull();
    await ui.type("hello there");
    ui.keys.pressEnter();
    await ui.until(() => ui?.app.chat()?.status === "idle" && ui?.app.chat()?.config.model === "fake/slow", 15_000);
  }, 30_000);

  it("finds text in the chat with C-s: the turns that mention it, a line around the match, Enter goes to the turn", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 40 });
    await ui.type("first needle prompt");
    ui.keys.pressEnter();
    await ui.until("Echo: first needle prompt");
    await idle(ui);
    await ui.type("second haystack prompt");
    ui.keys.pressEnter();
    await ui.until("Echo: second haystack prompt");
    await idle(ui);
    ui.keys.pressKey("s", { ctrl: true });
    await ui.until("Type to find text in this chat…");
    await ui.type("needle");
    const found = await ui.until("turn 1");
    expect(found).toMatch(/turn 1 · \d+×/);
    expect(found).toContain("1 turn");
    expect(found).not.toContain("turn 2");
    ui.keys.pressEnter();
    await ui.until(() => ui?.app.chat() !== null);
    await wait(80);
    expect(await ui.frame()).not.toContain("Find in chat");
    // M-n and M-p step through the turns the find matched, wrapping, without reopening the sheet.
    ui.keys.pressKey("s", { ctrl: true });
    await ui.until("Type to find text in this chat…");
    await ui.type("prompt");
    await ui.until("2 turns");
    ui.keys.pressEnter();
    await ui.until("match 1 of 2 · M-n next · M-p previous");
    await wait(120);
    ui.keys.pressKey("n", { meta: true });
    await ui.until("match 2 of 2 · M-n next · M-p previous");
    ui.keys.pressKey("n", { meta: true });
    await ui.until("match 1 of 2 · M-n next · M-p previous");
    ui.keys.pressKey("p", { meta: true });
    await ui.until("match 2 of 2 · M-n next · M-p previous");
    // The turn the find landed on carries a strip with its words (and says Esc clears it); the palette clears it too.
    expect(await ui.frame()).toMatch(/⌕ .*prompt.* in the turn/);
    expect(await ui.frame()).toContain("match 2/2");
    expect(await ui.frame()).toContain("Esc clears");
    ui.keys.pressEscape();
    await ui.until("Find marks cleared");
    expect(await ui.frame()).not.toMatch(/⌕ .* in the turn/);
    // Search every chat: the palette's entry lists chats whose words match, the first hit as the row.
    ui.keys.pressKey("k", { ctrl: true });
    await ui.until("Search commands, sessions, thinking…");
    await ui.type("search every");
    await ui.until("Search every chat…");
    ui.keys.pressEnter();
    await ui.until("Type to search every chat's words…");
    await ui.type("haystack");
    expect(await ui.until("1 chat")).toMatch(/haystack/);
    ui.keys.pressEnter();
    await ui.until("⌕");
    // Nothing matches: the picker says so instead of listing the whole chat.
    ui.keys.pressKey("s", { ctrl: true });
    await ui.until("Type to find text in this chat…");
    await ui.type("zzzz");
    expect(await ui.until("Nothing matches “zzzz”")).toContain("Find in chat");
  }, 30_000);

  it("edits the draft in $EDITOR from M-e and takes the file back", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 30 });
    const was = process.env.VISUAL;
    // A stand-in editor: it writes one line into the file it is given ($0 inside the quoted script).
    process.env.VISUAL = "sh -c 'printf from-editor > \"$0\"'";
    try {
      await ui.type("short draft");
      ui.keys.pressKey("e", { meta: true });
      await ui.until("from-editor");
      expect(await ui.frame()).not.toContain("short draft");
    } finally {
      if (was === undefined) delete process.env.VISUAL;
      else process.env.VISUAL = was;
    }
  }, 30_000);

  it("shows the permission mode where the harness has one, and changes it from its chip", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 40 });
    await ui.type("hello permission");
    ui.keys.pressEnter();
    await ui.until("Echo: hello permission");
    await idle(ui);
    expect(await ui.frame()).toContain("Ask first ▾");
    await ui.click("Ask first ▾");
    await ui.until("Search modes…");
    await ui.type("accept");
    ui.keys.pressEnter();
    await ui.until(() => ui?.app.chat()?.config.permissionMode === "acceptEdits");
    expect(await ui.until("Accept edits ▾")).not.toContain("Ask first ▾");
  }, 30_000);

  it("jumps to the last failed call from the palette", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 40 });
    await ui.type("tool toolfail");
    ui.keys.pressEnter();
    await ui.until("Echo: tool toolfail");
    await idle(ui);
    ui.keys.pressKey("k", { ctrl: true });
    await ui.until("Search commands, sessions, thinking…");
    await ui.type("failed call");
    await ui.until("Show the last failed call");
    ui.keys.pressEnter();
    // The work opens to the call that failed: its row is on screen.
    await ui.until("npm run e2e");
    expect(await ui.frame()).not.toContain("Search commands, sessions, thinking…");
  }, 30_000);

  it("pins the plan above the composer while a run works through it, and unpins it when the run settles", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 40 });
    await ui.type("todolist slow");
    ui.keys.pressEnter();
    const pinned = await ui.until("1/3");
    expect(pinned).toContain("Draw the reason inline");
    expect(pinned).toMatch(/1\/3  ◐ .*Draw the reason inline.*·/);
    await idle(ui);
    expect(await ui.until("Message the agent")).not.toContain("1/3  ◐");
  }, 40_000);

  it("opens the pinned plan into its steps with a click and folds it again", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 40 });
    await ui.type("todolist slow");
    ui.keys.pressEnter();
    await ui.until("1/3");
    expect(await ui.frame()).not.toContain("○ Run the suite");
    await ui.click("1/3  ◐");
    const open = await ui.until("○ Run the suite");
    expect(open).toContain("✓ Read the tool card");
    await ui.click("1/3  ◐");
    await wait(150);
    expect(await ui.frame()).not.toContain("○ Run the suite");
    await idle(ui);
  }, 40_000);

  it("unrolls a framed call's whole output with a click and folds it again", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 80 });
    await ui.type("tool longlog");
    ui.keys.pressEnter();
    await ui.until("Echo: tool longlog");
    await idle(ui);
    // A call row opens into its framed output on a click.
    await ui.click("Ran $ npm run build");
    const folded = await ui.until("lines above · click to show all");
    expect(folded).not.toContain("build step 1 done");
    await ui.click("lines above · click to show all");
    const open = await ui.until("click to fold");
    expect(open).toContain("build step 1 done");
    await ui.click("click to fold");
    await ui.until("lines above · click to show all");
  }, 30_000);

  it("cycles the permission mode with Shift+Tab from the composer", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 40 });
    await ui.type("hello cycling");
    ui.keys.pressEnter();
    await ui.until("Echo: hello cycling");
    await idle(ui);
    expect(await ui.frame()).toContain("Ask first ▾");
    ui.keys.pressTab({ shift: true });
    await ui.until(() => ui?.app.chat()?.config.permissionMode !== "default" && ui?.app.chat()?.config.permissionMode !== undefined);
    expect(await ui.frame()).not.toContain("Ask first ▾");
  }, 30_000);

  it("lists the queued messages from the +N queued chip and pulls one back into the composer", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 40 });
    await ui.type("slow stream for the queue");
    ui.keys.pressEnter();
    await ui.until(() => ui?.app.chat()?.status === "running");
    await ui.type("then the first follow-up");
    ui.keys.pressEnter();
    await ui.until(() => (ui?.app.chat()?.queue.steering.length ?? 0) + (ui?.app.chat()?.queue.followUp.length ?? 0) === 1);
    expect(await ui.until("+1 queued")).toContain("+1 queued");
    await ui.click("+1 queued");
    const picker = await ui.until("Search queued messages…");
    expect(picker).toContain("then the first follow-up");
    ui.keys.pressEnter();
    // The message left the queue and is the draft again, to edit and send as it was.
    await ui.until(() => (ui?.app.chat()?.queue.steering.length ?? 0) + (ui?.app.chat()?.queue.followUp.length ?? 0) === 0);
    expect(await ui.until("then the first follow-up")).not.toContain("+1 queued");
  }, 40_000);

  it("removes a queued message with x in the queue picker", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 40 });
    await ui.type("slow stream for the queue removal");
    ui.keys.pressEnter();
    await ui.until(() => ui?.app.chat()?.status === "running");
    await ui.type("remove this follow-up");
    ui.keys.pressEnter();
    await ui.until(() => (ui?.app.chat()?.queue.steering.length ?? 0) + (ui?.app.chat()?.queue.followUp.length ?? 0) === 1);
    await ui.click("+1 queued");
    await ui.until("Queued messages");
    ui.keys.pressKey("x");
    await ui.until(() => (ui?.app.chat()?.queue.steering.length ?? 0) + (ui?.app.chat()?.queue.followUp.length ?? 0) === 0);
    expect(await ui.until("Message the agent")).not.toContain("remove this follow-up");
  }, 40_000);

  it("changes thinking, model, and harness directly, hands the chat off, and opens history", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 50 });
    await ui.type("remember the harness");
    ui.keys.pressEnter();
    await ui.until("Echo: remember the harness");
    await idle(ui);
    // Alt+T: the thinking levels, picked by typing.
    ui.keys.pressKey("t", { meta: true });
    await ui.until("Search levels…");
    await ui.type("high");
    ui.keys.pressEnter();
    await ui.until(() => ui?.app.chat()?.config.thinkingLevel === "high");
    expect(await ui.until("High ▾")).toContain("Fake Echo ▾");
    // Alt+M: the models.
    ui.keys.pressKey("m", { meta: true });
    await ui.until("Search models…");
    await ui.type("slow");
    ui.keys.pressEnter();
    await ui.until("Fake Slow ▾");
    // A click on the footer's harness: with a conversation open, it can move to another harness.
    await ui.click("Fake ▾");
    const picker = await ui.until("Hand off this chat to");
    expect(picker).toContain("Harness for new chats");
    await ui.type("fake b");
    ui.keys.pressEnter();
    await ui.until(() => ui?.app.chat()?.harnessId === "fake-b", 15_000);
    expect(await ui.until("Fake B ▾")).toContain("remember the harness");
    // Ctrl+R: every session, under its project.
    ui.keys.pressKey("r", { ctrl: true });
    const history = await ui.until("Search sessions, projects, harnesses…");
    expect(history).toContain("remember the harness");
    expect(history).toContain("alpha");
  }, 40_000);

  it("lives in the vim keybind style: NORMAL at start, i to type, motions, : and the jumplist", async () => {
    // Wide enough for NORMAL's whole hint beside the context and its sparkline (a narrower footer cuts the hint).
    ui = await mount(path.join(server.root, "beta"), { keybinds: "vim", height: 30, width: 190 });
    // The vim style starts in NORMAL: the footer says so, and the Emacs chords are off.
    expect(await ui.until("NORMAL")).toContain("NORMAL");
    ui.keys.pressKey("k", { ctrl: true });
    expect(await ui.frame()).not.toContain("Search commands, sessions, thinking…");
    // i goes to INSERT; Esc comes back to NORMAL, where letters move instead of typing.
    ui.keys.pressKey("i");
    await ui.until("INSERT");
    await ui.type("slow stream for scrolling");
    ui.keys.pressEnter();
    await ui.until("Echo: slow stream for scrolling");
    await idle(ui);
    await ui.escape();
    expect(await ui.until("NORMAL")).toContain("gg/G top/bottom");
    // The pinned prompt, once the view has really settled, is the jump test's clock:
    // it shows exactly when the top has scrolled away.
    const pinned = async (want: boolean, ms = 5000) => {
      for (const start = Date.now(); Date.now() - start < ms; ) {
        if ((await ui!.frame()).includes("⇡ slow stream for scrolling") === want) return;
        await wait(50);
      }
      throw new Error(`the pinned prompt did not ${want ? "appear" : "vanish"}`);
    };
    const before = await ui.frame();
    ui.keys.pressKey("g");
    ui.keys.pressKey("g");
    await wait(80);
    expect(await ui.frame()).not.toBe(before);
    await pinned(false);
    // gg left the bottom behind; G leaves the settled top. The jumplist is bottom → top,
    // so Ctrl+O steps back to the bottom (the pin stays) and Ctrl+I forward to the top.
    // (The typing path delivers the real G byte; the mock's shift-modified key does not.)
    await ui.type("G");
    await pinned(true);
    ui.keys.pressKey("o", { ctrl: true });
    await pinned(true);
    ui.keys.pressKey("i", { ctrl: true });
    await pinned(false);
    // In NORMAL nothing reaches the composer: stray letters are not typed.
    ui.keys.pressKey("k");
    ui.keys.pressKey("x");
    await wait(60);
    expect(ui.app.chat()?.items.filter((i) => i.kind === "user")).toHaveLength(1);
    // ":" is the palette; Esc closes it and stays in NORMAL.
    ui.keys.pressKey(":");
    await ui.until("Search commands, sessions, thinking…");
    await ui.escape();
    expect(await ui.frame()).toContain("NORMAL");
    // ":" then "quit" would leave; typing again is i.
    ui.keys.pressKey("i");
    await ui.until("INSERT");
    await ui.type("typed again");
    expect(await ui.until("typed again")).toContain("INSERT");
  }, 40_000);

  it("answers an approval with a number and a question with the arrows", async () => {
    ui = await mount(path.join(server.root, "beta"));
    await ui.type("please ask first");
    ui.keys.pressEnter();
    const asked = await ui.until("Waiting for approval");
    expect(asked).toContain("▌ 1. Approve");
    // Two answers, so the hint names 1–2 rather than a fixed 1–9.
    expect(asked).toContain("1–2 choose");
    ui.keys.pressKey("1");
    await ui.until("Echo: please ask first");
    await idle(ui);
    await ui.type("quiz described");
    ui.keys.pressEnter();
    const q = await ui.until("Waiting for your answer");
    expect(q).toContain("Should the theme and the text size both move into config.yml?");
    expect(q).toContain("Every device gets the same look.");
    ui.keys.pressArrow("down");
    await wait(30);
    ui.keys.pressEnter();
    await ui.until("Chose: Only text size");
  }, 30_000);

  it("offers an optional explanation when denying an approval", async () => {
    ui = await mount(path.join(server.root, "beta"));
    await ui.type("please ask first");
    ui.keys.pressEnter();
    await ui.until("Waiting for approval");
    ui.keys.pressKey("2");
    await ui.until("Reason for denial (optional)");
    await ui.type("Keep the file unchanged.");
    ui.keys.pressEnter();
    await idle(ui);
    expect(ui.app.chat()?.items.find((item) => item.kind === "request" && item.outcome === "Denied")).toMatchObject({ denialReason: "Keep the file unchanged." });
  }, 30_000);

  it("lists commands on /, completes with Tab, and runs the palette and the model picker", async () => {
    ui = await mount(path.join(server.root, "alpha"));
    await ui.type("hello");
    ui.keys.pressEnter();
    await ui.until("Echo: hello");
    await idle(ui);
    await ui.type("/fake");
    const menu = await ui.until("/fake-status");
    expect(menu).toContain("Tab complete");
    ui.keys.pressTab();
    await wait(50);
    ui.keys.pressEnter();
    await ui.until("fake status: all good");

    // C-x: the which-key panel lists every key until one is pressed.
    ui.keys.pressKey("x", { ctrl: true });
    const panel = await ui.until("C-x …");
    expect(panel).toContain("n → new chat");
    expect(panel).toContain("m → +model");
    await ui.type("m");
    await ui.until("Search models");
    await ui.type("slow");
    await ui.until("Fake Slow");
    ui.keys.pressEnter();
    await ui.until(() => ui?.app.chat()?.config.model === "fake/slow");
    await ui.type("one more");
    ui.keys.pressEnter();
    await ui.until("Switched to Fake Slow", 15_000);
    await idle(ui);

    ui.keys.pressKey("k", { ctrl: true });
    await ui.until("Search commands");
    await ui.type("new chat");
    ui.keys.pressEnter();
    await ui.until("What should Fake do in alpha?");
  }, 40_000);

  it("stops a run on Esc Esc and quits on Ctrl+C twice", async () => {
    ui = await mount(path.join(server.root, "alpha"));
    await ui.type("slow stream please");
    ui.keys.pressEnter();
    await ui.until(() => ui?.app.chat()?.status === "running");
    await ui.until("Steer the agent");
    // A live turn shows in the Working status, not a cursor in the text.
    await ui.until("Working");
    await ui.escape();
    await ui.until("Esc again to stop");
    await ui.escape();
    await ui.until("■ Stopped", 15_000);
    await idle(ui);
    expect(await ui.frame()).not.toContain(OLD_CARET);
    ui.keys.pressKey("c", { ctrl: true });
    await ui.until("C-c again to quit");
    ui.keys.pressKey("c", { ctrl: true });
    await ui.until(() => ui?.exited() === true);
  }, 30_000);

  it("draws no cursor while streaming or after, and does not reflow between identical frames", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 60 });
    await ui.type("slow stream please");
    ui.keys.pressEnter();
    await ui.until(() => Boolean(assistant(ui!)?.thinking.trim()), 15_000);
    let sawWorking = false;
    let sawText = false;
    let pairs = 0;
    const until = Date.now() + 8_000;
    while (Date.now() < until) {
      const contents = markdownContents(ui.renderer.root);
      const frame = await ui.frame();
      expect(contents.join("\n")).not.toContain(OLD_CARET);
      expect(frame).not.toContain(OLD_CARET);
      if (frame.includes("Working")) sawWorking = true;
      const item = assistant(ui);
      if (item?.text) sawText = true;
      // Two frames 250 ms apart (more than a blink's half-period) with the
      // same text must lay out the same: nothing toggles on a timer.
      const before = markdownContents(ui.renderer.root).join("\u0000");
      const heights = markdownHeights(ui.renderer.root);
      await wait(250);
      await ui.frame();
      if (markdownContents(ui.renderer.root).join("\u0000") === before) {
        expect(markdownHeights(ui.renderer.root)).toEqual(heights);
        pairs += 1;
      }
      if (item && !item.streaming && item.text) break;
    }
    expect(sawWorking).toBe(true);
    expect(sawText).toBe(true);
    expect(pairs).toBeGreaterThan(0);
    await idle(ui);
    expect(markdownContents(ui.renderer.root).join("\n")).not.toContain(OLD_CARET);
    expect(await ui.frame()).not.toContain(OLD_CARET);
  }, 30_000);

  it("tips on the empty screen, ghosts a command, mentions a file, previews history, and toasts a background run", async () => {
    mkdirSync(path.join(server.root, "beta", "src"), { recursive: true });
    writeFileSync(path.join(server.root, "beta", "src", "server.ts"), "x");
    ui = await mount(path.join(server.root, "beta"), { width: 150, height: 44 });
    expect(await ui.frame()).toContain("Tip ");
    // "/comp": the menu lists /compact, and the rest of it shows after what was typed.
    await ui.type("/comp");
    const ghost = await ui.until("Summarize the conversation");
    expect(ghost.split("/compact").length - 1).toBeGreaterThanOrEqual(2);
    await ui.escape();
    for (let i = 0; i < 5; i++) ui.keys.pressBackspace();
    // "@": the project's files; Tab puts the path in.
    await ui.type("look at @serv");
    await ui.until("Tab or Enter insert");
    ui.keys.pressTab();
    await ui.until("look at @src/server.ts");
    ui.keys.pressEnter();
    await ui.until("Echo: look at @src/server.ts");
    await idle(ui);
    // Ctrl+R on a wide screen: the highlighted session's last exchange beside the list.
    ui.keys.pressKey("r", { ctrl: true });
    await ui.until("1 turn");
    expect(await ui.frame()).toContain("› look at @src/server.ts");
    await ui.escape();
    // A run that finishes while another chat is shown: a toast in the corner.
    ui.keys.pressKey("x", { ctrl: true });
    await ui.type("n");
    await ui.type("slow stream in the background");
    ui.keys.pressEnter();
    await ui.until(() => ui?.app.chat()?.status === "running");
    ui.keys.pressKey("x", { ctrl: true });
    await ui.type("n");
    expect(await ui.until("✓ Done", 30_000)).toContain("slow stream in the");
  }, 60_000);

  it("attaches an image file dropped on the terminal and sends it under the prompt", async () => {
    const shot = path.join(server.root, "alpha", "shot.png");
    writeFileSync(shot, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64"));
    ui = await mount(path.join(server.root, "alpha"), { height: 44 });
    // A drop pastes the file's path: it becomes a thumbnail, not text.
    await ui.keys.pasteBracketedText(shot);
    await ui.until("▣ #1  png 1 KB");
    expect(await ui.frame()).not.toContain("shot.png");
    await ui.type("what is in this picture");
    ui.keys.pressEnter();
    await ui.until("Echo: what is in this picture");
    await idle(ui);
    const prompt = ui.app.chat()?.items.find((i) => i.kind === "user");
    expect(prompt && prompt.kind === "user" ? prompt.imageCount : 0).toBe(1);
    expect(await ui.frame()).toContain("▣ #1");
  }, 30_000);

  it("keeps sessions and info in one side panel, switched by tab, folding to a rail", async () => {
    ui = await mount(path.join(server.root, "alpha"), { width: 150, height: 40 });
    await ui.type("tool edit please");
    ui.keys.pressEnter();
    await ui.until("Echo: tool edit please");
    await idle(ui);
    expect(await ui.frame()).toContain("Sessions  Info");
    // C-x i: the Info tab, where the right panel's context and usage now live.
    ui.keys.pressKey("x", { ctrl: true });
    await ui.type("i");
    const info = await ui.until("Tool definitions");
    expect(info).toContain("Context");
    // Each changed file with its stat bar.
    expect(info).toMatch(/\+\d+ −\d+ ■{5}/);
    await ui.click("Sessions");
    await ui.until("C-x s browse");
    // The tab strip's « (nf angle-double-left) folds it to a rail; the rail's » unfolds it.
    await ui.click("«");
    const folded = await ui.until("»");
    expect(folded).not.toContain("Sessions  Info");
    await ui.click("»");
    await ui.until("Sessions  Info");
  }, 30_000);

  it("shows a ghost of the thread, named, while a session takes its time to open", async () => {
    ui = await mount(path.join(server.root, "beta"), { width: 150 });
    await ui.type("ghost session here");
    ui.keys.pressEnter();
    await idle(ui);
    ui.keys.pressKey("x", { ctrl: true });
    await ui.type("n");
    await ui.until(() => ui?.app.overview().sessions.some((s) => s.title === "ghost session here") ?? false);
    const target = ui.app.overview().sessions.find((s) => s.title === "ghost session here");
    // A slow server: the chat arrives a second after it is asked for.
    const api = ui.app.server;
    const call = api.call.bind(api);
    api.call = (async (url: string, init?: unknown) => {
      if (url.startsWith("/api/chats/")) await wait(1000);
      return call(url, init as never);
    }) as typeof api.call;
    const opened = ui.app.openSession(target as NonNullable<typeof target>);
    const ghost = await ui.until("Opening ghost session here");
    expect(ghost).toContain("━━━━");
    expect(ghost).toContain("Fake");
    await opened;
    const thread = await ui.until("❯ ghost session here");
    expect(thread).not.toContain("Opening");
  }, 30_000);

  it("keeps chats in tabs: a new one beside, M-number and C-x ] to switch, a dot for news, C-x w to close", async () => {
    ui = await mount(path.join(server.root, "alpha"), { width: 150 });
    await ui.type("first tab chat");
    ui.keys.pressEnter();
    await idle(ui);
    ui.keys.pressKey("x", { ctrl: true });
    await ui.type("a");
    await ui.until("What should Fake do in alpha?");
    await ui.type("slow second tab chat");
    ui.keys.pressEnter();
    const bar = await ui.until("2 F slow second tab chat");
    expect(bar).toContain("1 F first tab chat");
    // M-1 brings the first back; the second's run finishes out of sight and marks its tab.
    ui.keys.pressKey("1", { meta: true });
    await ui.until(() => ui?.app.chat()?.title === "first tab chat");
    await ui.until("slow second tab chat ●", 20_000);
    ui.keys.pressKey("x", { ctrl: true });
    await ui.type("]");
    await ui.until(() => ui?.app.chat()?.title === "slow second tab chat");
    expect(await ui.frame()).not.toContain("slow second tab chat ●");
    ui.keys.pressKey("x", { ctrl: true });
    await ui.type("w");
    await ui.until(() => ui?.app.chat()?.title === "first tab chat");
    // One tab left: the bar goes.
    expect(await ui.frame()).not.toContain("1 F first tab chat");
  }, 40_000);

  it("shows a turn's timing from the chip under its prompt: each step with where it started and how long it took", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 40 });
    await ui.type("showcase timing");
    ui.keys.pressEnter();
    await idle(ui);
    await ui.click("❯ showcase timing");
    await ui.until("◷ Timing");
    await ui.click("◷ Timing");
    const shown = await ui.until("Search steps…");
    expect(shown).toContain("This turn took");
    expect(shown).toContain("Edited src/server.ts");
    // Esc closes it and the screen is the chat again.
    await ui.escape();
    expect(await ui.until("Message the agent")).not.toContain("Search steps…");
  }, 40_000);

  it("opens usage across chats from the palette and switches its range", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 40 });
    ui.keys.pressKey("k", { ctrl: true });
    await ui.until("Search commands");
    await ui.type("usage across");
    ui.keys.pressEnter();
    const shown = await ui.until("Last 7 days");
    expect(shown).toContain("Usage across chats");
    expect(shown).toContain("Tab 30 days");
    expect(shown).toMatch(/[·▁▂▃▄▅▆▇█]{7}\s+\d+(\.\d)?[kM]? tokens/);
    // Tab cycles the range, as the web dialog's 7/30/90 switch does.
    ui.keys.pressTab();
    expect(await ui.until("Last 30 days")).toContain("Tab 90 days");
    await ui.escape();
    expect(await ui.until("Ask Fake to")).not.toContain("Usage across chats");
  }, 40_000);

  it("offers a prompt's actions on a click: Edit replaces it in place, Esc drops an edit", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 40 });
    await ui.type("first try");
    ui.keys.pressEnter();
    await idle(ui);
    await ui.click("❯ first try");
    const offered = await ui.until("↻ Retry");
    // The reply and the whole turn (prompt, work, answer) copy beside the prompt's own text.
    expect(offered).toContain("⧉ Copy answer");
    expect(offered).toContain("⧉ Copy turn as Markdown");
    await ui.click("✎ Edit");
    await ui.until("editing message 1");
    // Esc drops it.
    await ui.escape();
    await ui.until("Edit cancelled");
    expect(await ui.frame()).not.toContain("editing message 1");
    await ui.click("❯ first try");
    await ui.click("✎ Edit");
    await ui.until("editing message 1");
    // (Not C-c: the test renderer quits on it.)
    for (const _ of "first try") ui.keys.pressBackspace();
    await ui.type("second try");
    ui.keys.pressEnter();
    await ui.until("Echo: second try", 15_000);
    await idle(ui);
    expect(ui.app.chat()?.items.filter((i) => i.kind === "user").map((i) => (i as { text: string }).text)).toEqual(["second try"]);
  }, 40_000);

  it("undoes a prompt's file changes from the chosen files, and C-x z puts them back", async () => {
    const repo = path.join(server.root, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(path.join(repo, "app.ts"), "const a = 1;\n");
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "init");
    ui = await mount(repo, { height: 40 });
    await ui.type("change the app");
    ui.keys.pressEnter();
    await idle(ui);
    await ui.until(() => (ui?.app.chat()?.checkpoints ?? []).includes(1));
    writeFileSync(path.join(repo, "app.ts"), "const a = 2;\n");
    await ui.click("❯ change the app");
    await ui.click("↶ Undo files");
    await ui.until("Undo file changes from message 1 on");
    // The dialog opens on "Comparing the files…" and lists them once the preview arrives.
    const dialog = await ui.until("[x] app.ts");
    expect(dialog).toContain("put back");
    ui.keys.pressEnter();
    await ui.until("C-x z puts them back");
    expect(readFileSync(path.join(repo, "app.ts"), "utf8")).toBe("const a = 1;\n");
    ui.keys.pressKey("x", { ctrl: true });
    await ui.type("z");
    await ui.until("Put 1 file back as they were");
    expect(readFileSync(path.join(repo, "app.ts"), "utf8")).toBe("const a = 2;\n");
  }, 40_000);

  it("makes a worktree from the palette and opens a chat in it", async () => {
    const repo = path.join(server.root, "repo-worktree");
    mkdirSync(repo, { recursive: true });
    writeFileSync(path.join(repo, "app.ts"), "const a = 1;\n");
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "init");
    ui = await mount(repo, { height: 40, width: 150 });
    ui.keys.pressKey("k", { ctrl: true });
    await ui.until("Search commands, sessions, thinking…");
    await ui.type("worktrees");
    await ui.until("Worktrees…");
    ui.keys.pressEnter();
    await ui.type("tryout");
    await ui.until("Create worktree “tryout” from HEAD");
    ui.keys.pressEnter();
    await ui.until(() => (ui?.app.workspace()?.path ?? "").includes("tryout"));
    // The header names the checkout the chat now runs in.
    await ui.until("tryout-");
  }, 40_000);

  it("opens a project file read-only and mentions it in the message", async () => {
    const dir = path.join(server.root, "repo-files");
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "hello-viewer.ts"), "export const greeting = \"hi\";\nexport const two = 2;\n");
    ui = await mount(dir, { height: 40, width: 150 });
    ui.keys.pressKey("k", { ctrl: true });
    await ui.until("Search commands, sessions, thinking…");
    await ui.type("open a file");
    await ui.until("Open a file…");
    ui.keys.pressEnter();
    await ui.type("hello-viewer");
    // The file's head sits beside the row, numbered.
    const sheet = await ui.until("export const two = 2;");
    expect(sheet).toContain("src/hello-viewer.ts");
    expect(sheet).toContain("2 lines");
    ui.keys.pressEnter();
    await ui.until("@src/hello-viewer.ts");
  }, 40_000);

  it("lists a chat's file checkpoints in a timeline and opens the undo from one", async () => {
    const repo = path.join(server.root, "repo-timeline");
    mkdirSync(repo, { recursive: true });
    writeFileSync(path.join(repo, "app.ts"), "const a = 1;\n");
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "init");
    ui = await mount(repo, { height: 40, width: 150 });
    await ui.type("change the app");
    ui.keys.pressEnter();
    await idle(ui);
    await ui.until(() => (ui?.app.chat()?.checkpoints ?? []).includes(1));
    writeFileSync(path.join(repo, "app.ts"), "const a = 2;\n");
    ui.keys.pressKey("k", { ctrl: true });
    await ui.until("Search commands, sessions, thinking…");
    await ui.type("file timeline");
    await ui.until("File timeline…");
    ui.keys.pressEnter();
    // One row per prompt, with the files changed since it in the preview.
    const sheet = await ui.until("Since message 1: 1 file changed");
    expect(sheet).toContain("change the app");
    expect(sheet).toContain("Message 1");
    expect(sheet).toContain("~ app.ts");
    ui.keys.pressEnter();
    await ui.until("Undo file changes from message 1 on");
  }, 40_000);

  it("reviews the chat's changes: a thread on a line, resolved, and its open ones sent as one prompt", async () => {
    ui = await mount(path.join(server.root, "beta"), { height: 40 });
    await ui.type("edit please");
    ui.keys.pressEnter();
    await idle(ui);
    ui.keys.pressKey("x", { ctrl: true });
    await ui.type("d");
    const view = await ui.until("Review changes   1 file");
    expect(view).toContain("src/app.ts");
    // The attribution marks: the file head says which lines this chat wrote (the fake edit's own).
    await ui.until("from this chat");
    expect(view).toMatch(/▌\s+\d*\s*[-−] a/);
    // e opens hidden lines; this edit folds none, and the review says so rather than doing nothing.
    ui.keys.pressKey("e");
    await ui.until("No hidden lines to show here");
    ui.keys.pressEnter();
    await ui.until("What should change here?");
    await ui.type("keep a");
    ui.keys.pressEnter();
    await ui.until("✎ keep a");
    expect(await ui.frame()).toContain("1 open");

    // The thread resolves on the server and stays, struck through with a tick.
    ui.keys.pressKey("r");
    await ui.until("✓ keep a");
    expect(await ui.frame()).toContain("1 resolved");
    ui.keys.pressKey("r");
    await ui.until("✎ keep a");

    // One prompt, composed by the server; nothing is cleared and the panel stays.
    ui.keys.pressKey("s", { shift: true });
    await ui.until(() => ui?.app.chat()?.items.some((i) => i.kind === "user" && i.text.startsWith("Review comments on your changes")) ?? false, 15_000);
    const sent = ui.app.chat()?.items.filter((i) => i.kind === "user").pop() as { text: string };
    expect(sent.text).toContain("1. src/app.ts");
    expect(sent.text).toContain("keep a");
    // The panel stays open with the thread still there; its notice is behind it, so Esc shows it.
    // The prompt reaches the chat before the send call itself answers, so wait out "Sending…".
    await ui.until("Esc close");
    expect(await ui.frame()).toContain("✎ keep a");
    expect(await ui.frame()).toContain("1 open");
    ui.keys.pressEscape();
    await ui.until("Sent 1 comment to this chat");
  }, 40_000);

  it("shows the GitHub panel: the branch, the PR's checks, the tour, and a new pull request", async () => {
    const dir = path.join(server.root, "ghrepo");
    mkdirSync(path.join(dir, "src"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    writeFileSync(ghRecord, JSON.stringify({
      current: { url: "https://github.com/acme/repo/pull/7", title: "Ordered auth work", state: "OPEN", isDraft: false },
      prs: { 7: { url: "https://github.com/acme/repo/pull/7", title: "Ordered auth work", state: "OPEN", isDraft: false, baseRefName: "main", headRefName: "tour", headRefOid: "a01cdef" } },
      checks: [{ name: "build", state: "pass", link: null }, { name: "e2e", state: "fail", link: null }],
      nextPr: 10,
      diff: [
        "diff --git a/package-lock.json b/package-lock.json",
        "--- a/package-lock.json",
        "+++ b/package-lock.json",
        "@@ -0,0 +1 @@",
        "+{}",
        "diff --git a/tests/core.spec.ts b/tests/core.spec.ts",
        "--- a/tests/core.spec.ts",
        "+++ b/tests/core.spec.ts",
        "@@ -0,0 +1 @@",
        "+expect(check()).toBe(true);",
        "diff --git a/src/core.ts b/src/core.ts",
        "--- a/src/core.ts",
        "+++ b/src/core.ts",
        "@@ -0,0 +1 @@",
        "+export function check() { return verify(); }",
        "",
      ].join("\n"),
    }));
    ui = await mount(dir, { height: 44 });
    // GitHub stands on the palette (no leader letter is free in both clients).
    ui.keys.pressKey("k", { ctrl: true });
    await ui.type("github");
    ui.keys.pressEnter();
    const panel = await ui.until("Pull request  https://github.com/acme/repo/pull/7");
    expect(panel).toContain("main");
    expect(panel).toContain("1/2 checks passing · failing: e2e");
    expect(panel).toContain("Failing: e2e");
    // t opens the guided tour: source first, then tests; ] steps, Esc goes back.
    ui.keys.pressKey("t");
    const tour = await ui.until("src/core.ts");
    expect(tour).toMatch(/1 of 3 · source/);
    await ui.type("]");
    await ui.until("2 of 3 · tests");
    ui.keys.pressEscape();
    await ui.until("Pull request  https://github.com/acme/repo/pull/7");
    // n opens the form: the title, then the target branch, then the description, then creates.
    ui.keys.pressKey("n");
    await ui.until("New pull request");
    await ui.type("A change");
    ui.keys.pressEnter();
    await ui.until("Target branch");
    ui.keys.pressEnter();
    await ui.until("Description");
    await ui.type("Why it matters");
    ui.keys.pressEnter();
    await ui.until("Created the pull request: https://github.com/acme/repo/pull/10", 15_000);
    const calls = readFileSync(ghCalls, "utf8");
    expect(calls).toContain('"--title","A change"');
    expect(calls).toContain('"--base","main"');
  }, 40_000);

  it("works git from the panel: the diff, staging, unstaging, stage all, and a commit", async () => {
    const repo = path.join(server.root, "gitrepo");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src/app.ts"), "const a = 1;\n");
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "init");
    ui = await mount(repo, { height: 44 });
    await ui.type("edit please");
    ui.keys.pressEnter();
    await idle(ui);
    // C-x u opens the panel on the chat's project, the file under Changed with its word.
    ui.keys.pressKey("x", { ctrl: true });
    await ui.type("u");
    const panel = await ui.until("M src/app.ts");
    expect(panel).toContain("Stage");
    expect(panel).not.toContain("Unstage");
    // d opens the file's diff against HEAD; Esc goes back to the files.
    ui.keys.pressKey("d");
    await ui.until("Managed by the fake harness's edit command", 30_000);
    ui.keys.pressEscape();
    await ui.until("M src/app.ts");
    // Enter stages it: the row moves under Staged and offers Unstage.
    ui.keys.pressEnter();
    const staged = await ui.until("Unstage");
    expect(staged).toContain("Staged");
    expect(staged).toContain("1 staged");
    // A fresh change and a new file: `a` stages everything the index does not have.
    writeFileSync(path.join(repo, "src/app.ts"), "const a = 2;\n");
    writeFileSync(path.join(repo, "notes.md"), "# notes\n");
    ui.keys.pressKey("r");
    await ui.until("(new)", 20_000);
    ui.keys.pressKey("a");
    await ui.until(() => (ui?.app.git()?.counts.staged ?? 0) >= 2);
    for (const width of [100, 140]) {
      ui.resize(width, 44);
      const frame = await ui.frame();
      const head = frame.split("\n").find(row => /\bGit\b/.test(row));
      expect(head).toContain("not pushed");
      expect(frame.split("\n").filter(row => row.includes("Esc close"))).toHaveLength(1);
      expect(frame).not.toContain("\n· Esc close");
    }
    ui.resize(140, 44);
    // `u` takes it all back out of the index.
    ui.keys.pressKey("u");
    await ui.until(() => (ui?.app.git()?.counts.staged ?? 1) === 0);
    // Stage the one file again (the cursor sits on it) and commit it from the message box; the untracked file stays.
    ui.keys.pressEnter();
    await ui.until(() => (ui?.app.git()?.counts.staged ?? 0) === 1);
    ui.keys.pressKey("c");
    await ui.until("Commit message: Enter commit · Esc cancel");
    await ui.type("commit from atui");
    ui.keys.pressEnter();
    await ui.until(() => (ui?.app.git()?.counts.staged ?? 1) === 0 && (ui?.app.git()?.counts.changed ?? 1) === 0);
    expect(git("log", "--format=%s", "-1").trim()).toBe("commit from atui");
    expect(await ui.frame()).toContain("notes.md");
    // Esc closes the panel and the conversation is back.
    ui.keys.pressEscape();
  }, 40_000);

  it("runs a command from an answer and puts its output in the message; quotes a selection", async () => {
    ui = await mount(path.join(server.root, "alpha"), { width: 150, height: 44 });
    await ui.app.send("please run this\n```bash\necho run-from-atui\n```");
    await ui.until("Echo: please run this");
    await idle(ui);
    ui.keys.pressKey("x", { ctrl: true });
    await ui.type("x");
    await ui.until("$ echo run-from-atui");
    ui.keys.pressEnter();
    const out = await ui.until("exit 0");
    expect(out).toContain("run-from-atui");
    ui.keys.pressEnter();
    const draft = await ui.until("$ echo run-from-atui");
    expect(draft).toContain("(exit 0)");
    // A selection, dragged with the mouse over a line of the answer, goes in as a quote.
    const rows = (await ui.frame()).split("\n");
    const y = rows.findIndex((r) => r.includes("● Echo: please run this"));
    const x = (rows[y] as string).indexOf("Echo: please");
    await ui.mouse.drag(x, y, x + "Echo: please run this".length, y);
    await wait(80);
    ui.keys.pressKey("q", { meta: true });
    await ui.until("Quoted into your message");
    expect(await ui.frame()).toContain("> Echo: please run this");
  }, 40_000);

  it("lists skills under $ and saved prompts under #, and fills a prompt's blanks with Tab", async () => {
    ui = await mount(path.join(server.root, "beta"), { width: 150, height: 40 });
    await ui.app.server.call("/api/prompts", { body: { name: "risky", text: "Review {{file}} for {{risk}}" } });
    await ui.type("hello there");
    ui.keys.pressEnter();
    await idle(ui);
    await ui.type("/");
    await ui.until("1 skills under $");
    ui.keys.pressBackspace();
    await ui.type("$rev");
    await ui.until("$review");
    ui.keys.pressTab();
    expect(await ui.until("/skill:review")).toContain("/skill:review");
    for (const _ of "/skill:review ") ui.keys.pressBackspace();
    await ui.type("#ris");
    await ui.until("Saved prompts");
    ui.keys.pressEnter();
    await ui.until("Review {{file}} for {{risk}}");
    await ui.type("app.ts");
    ui.keys.pressTab();
    await ui.type("races");
    await ui.until("Review app.ts for races");
  }, 40_000);

  it("browses sessions from the sidebar and opens one", async () => {
    ui = await mount(path.join(server.root, "beta"));
    await ui.type("first session here");
    ui.keys.pressEnter();
    // A fresh chat reads idle before its run starts: wait for the answer itself.
    await ui.until("Echo: first session here");
    await idle(ui);
    ui.keys.pressKey("x", { ctrl: true });
    await ui.type("n");
    await ui.until("What should Fake do in beta?");
    await ui.type("second session here");
    ui.keys.pressEnter();
    await ui.until("Echo: second session here");
    await idle(ui);
    await ui.until(() => (ui?.app.overview().sessions.filter((s) => s.title.endsWith("session here")).length ?? 0) >= 2);
    // The sidebar sorts newest first once the second run's time lands: ↓ from the second session
    // must reach the first, not whatever sat under it before the list re-sorted.
    for (const start = Date.now(); ; await wait(30)) {
      const rows = (await ui.frame()).split("\n");
      const second = rows.findIndex((r) => r.includes("● second session here"));
      if (second >= 0 && rows[second + 1]?.includes("● first session here")) break;
      if (Date.now() - start > 8000) throw new Error(`the sidebar never put the second session above the first:\n${rows.join("\n")}`);
    }
    ui.keys.pressKey("x", { ctrl: true });
    await ui.type("s");
    await ui.until("↑↓ move · t tab · Esc back");
    ui.keys.pressArrow("down");
    await wait(30);
    ui.keys.pressEnter();
    await ui.until(() => ui?.app.chat()?.title === "first session here");
    expect(await ui.frame()).toContain("❯ first session here");
  }, 30_000);

  it("keeps the context's history across a chat's runs, and the harness's commands while one streams", async () => {
    ui = await mount(path.join(server.root, "alpha"));
    await ui.type("first run");
    ui.keys.pressEnter();
    await idle(ui);
    await ui.type("second run");
    ui.keys.pressEnter();
    await idle(ui);
    // Each run's context share is kept for the sparkline, not emptied by the next streamed event.
    await ui.until(() => (ui?.app.contextHistory().length ?? 0) >= 2);
    // While a run streams, the / menu keeps what the harness offers (the fake's /fake-status), not only awui's own.
    await ui.type("slow please");
    ui.keys.pressEnter();
    await ui.until(() => ui?.app.chat()?.status === "running");
    await ui.type("/");
    await ui.until("/new");
    await ui.until("/fake-status");
    await wait(400);
    expect(await ui.frame()).toContain("/fake-status");
  }, 30_000);

  it("reviews a delegated worker's patch: its files, Apply with a confirmation, and Undo apply", async () => {
    // A project of its own, a real git checkout: a worktree worker's patch is applied into it.
    const root = path.join(server.root, "delegate-review");
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "app.ts"), "const a = 1;\nconst b = 1;\n");
    writeFileSync(path.join(root, "README.md"), "# delegate-review\n");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    ui = await mount(root, { height: 40 });
    await ui.type("delegate worktree please");
    ui.keys.pressEnter();
    await ui.until(() => ui?.app.chat()?.status === "idle", 40_000);
    await ui.until(() => (ui?.app.chat()?.delegated?.length ?? 0) === 1);
    // C-x j: one row a worker, with the word for how it stands.
    ui.keys.pressKey("x", { ctrl: true });
    ui.keys.pressKey("j");
    const list = await ui.until("Fake delegated task");
    expect(list).toContain("1 worker");
    expect(list).toContain("Delegated work");
    // The selected worker's detail sits under the list: what it ended with, said in full.
    expect(list).toMatch(/Result {2}Fake · .*test/);
    // In plain words: the result's Markdown markers are not drawn.
    expect(list).not.toContain("**");
    // Opened: the worker's changed file and its diff, and the review that decides what happens to it.
    ui.keys.pressEnter();
    const detail = await ui.until("Apply patch into lead");
    expect(detail).toContain("src/app.ts");
    expect(detail).toContain("− a");
    expect(detail).toContain("+ b");
    expect(detail).toContain("Choose whether to apply its patch");
    // Apply writes the lead checkout, so it asks first.
    ui.keys.pressKey("a");
    await ui.until("Apply patch into lead? y confirms");
    ui.keys.pressKey("y");
    await ui.until("Approved and applied into the lead checkout", 20_000);
    expect(readFileSync(path.join(root, "src", "app.ts"), "utf8")).toContain("const changed = true;");
    // Undo apply reverses that patch while the checkout still holds exactly it.
    ui.keys.pressKey("u");
    await ui.until("Choose whether to apply its patch", 20_000);
    expect(readFileSync(path.join(root, "src", "app.ts"), "utf8")).toContain("const b = 1;");
  }, 90_000);

  it("opens a worker from the active-work panel, and cancels a running one only after a confirmation", async () => {
    ui = await mount(path.join(server.root, "beta"), { height: 40 });
    // A file changed first, so the Info tab the rail's context row opens has something to show.
    await ui.type("edit please");
    ui.keys.pressEnter();
    await idle(ui);
    // The child waits on a question, so its row is live until it is cancelled.
    await ui.type("delegate askchild please");
    ui.keys.pressEnter();
    await ui.until(() => ui?.app.chat()?.delegated?.[0]?.state === "waiting_for_user", 20_000);
    // C-x p: the rail, one card a group, the worker's row carrying its own status word.
    ui.keys.pressKey("x", { ctrl: true });
    ui.keys.pressKey("p");
    const rail = await ui.until("Delegated work");
    expect(rail).toContain("Agent · fake");
    expect(rail).toContain("Context and usage");
    // Enter on the worker opens its own screen (its review lives there).
    ui.keys.pressEnter();
    await ui.until("Esc back");
    // Esc back to the list, and x asks before stopping the worker.
    await ui.escape();
    await ui.until("Enter open");
    ui.keys.pressKey("x");
    const asked = await ui.until("y confirms");
    expect(asked).toContain("Cancel Fake delegated task?");
    ui.keys.pressKey("y");
    await ui.until(() => ui?.app.chat()?.delegated?.[0]?.outcome === "cancelled", 20_000);
    // The rail's context row opens the Info tab, where the context and the session are drawn.
    await ui.escape();
    ui.keys.pressKey("x", { ctrl: true });
    ui.keys.pressKey("p");
    await ui.until("Context used");
    ui.keys.pressKey("END");
    ui.keys.pressEnter();
    await ui.until("Changed in this chat");
    await idle(ui);
  }, 90_000);

  it("draws the agents board by column and opens the chat a card names", async () => {
    ui = await mount(path.join(server.root, "alpha"), { width: 150 });
    await ui.type("board please");
    ui.keys.pressEnter();
    await idle(ui);
    // C-x k: three columns with their counts, and the shown session among them.
    ui.keys.pressKey("x", { ctrl: true });
    ui.keys.pressKey("k");
    await ui.until(() => (ui?.app.overview().sessions.length ?? 0) > 0);
    const board = await ui.until("Needs you");
    expect(board).toContain("Working");
    expect(board).toContain("Done");
    expect(board).toContain("Every project");
    expect(board).toContain("board please");
    // The card under the cursor is told in full under the columns: its prompt and what it answered.
    const told = await ui.until("Said");
    expect(told).toContain("You");
    // f narrows to one project, and Enter opens the card under the cursor.
    ui.keys.pressKey("f");
    const filtered = await ui.until("Any pull request");
    expect(filtered).toContain("f alpha · r Any pull request");
    // Other chats may share the project, so the test names its card instead of trusting where the cursor starts.
    await ui.click("board please");
    ui.keys.pressEnter();
    await ui.until("❯ board please");
  }, 60_000);
});

describe("atui's density at 80 columns", () => {
  it("draws the which-key panel in columns that never cut into one another", async () => {
    ui = await mount(path.join(server.root, "alpha"), { width: 80, height: 24 });
    await ui.until("What should Fake do in alpha?");
    ui.keys.pressKey("x", { ctrl: true });
    const frame = await ui.until("C-x …");
    // Every entry whole, state words included, and the last key still on screen: three columns, nine rows.
    expect(frame).toContain("o → reasoning (shown)");
    expect(frame).toContain("q → quit atui");
    expect(frame).toContain("f → compact or full");
    // The old panel truncated mid-label into the next column ("reas...sibility (shown)g → glass mode").
    expect(frame).not.toMatch(/\.\.\./);
    expect(frame).not.toContain("sibility");
    for (const line of frame.split("\n")) if (line.includes(" → ")) expect(line.length).toBeLessThanOrEqual(80);
    await ui.escape();
  }, 30_000);

  it("words a plan row the browser's way, and leaves a target that fits whole", async () => {
    ui = await mount(path.join(server.root, "alpha"), { width: 80, height: 44 });
    await ui.type("showcase tool edit please");
    ui.keys.pressEnter();
    await idle(ui);
    const frame = await ui.until("Changed 3 files");
    // A todo call is a plan row, worded as the web row words it (shared/tool-row.ts).
    // Adjacent plans fold onto one row (turns.ts), worded as the web row words it (shared/tool-row.ts).
    const row = frame.split("\n").find((line) => line.includes("Updated the plan"));
    expect(row).toBeDefined();
    expect(row).not.toContain("TodoWrite");
    expect((row ?? "").length).toBeLessThanOrEqual(80);
    // A target that fits is left whole.
    expect(frame).toContain("Read src/net.ts:1-20");
  }, 45_000);

  it("budgets tab titles so three long ones fit the strip", async () => {
    ui = await mount(path.join(server.root, "alpha"), { width: 80, height: 30 });
    await ui.type("a fairly long chat title to test the tab strip's budget");
    ui.keys.pressEnter();
    await idle(ui);
    for (const text of ["another long chat title for the second tab", "the third long chat title in the strip"]) {
      ui.keys.pressKey("x", { ctrl: true });
      ui.keys.pressKey("a");
      await ui.until("What should Fake do in alpha?");
      await ui.type(text);
      ui.keys.pressEnter();
      await idle(ui);
    }
    await ui.until(() => (ui?.app.tabs().tabs.length ?? 0) === 3);
    const bar = await ui.frame();
    const strip = bar.split("\n")[0] ?? "";
    // Each title at its budget (14 columns for three tabs on 80), ending in an ellipsis, never a hard cut.
    expect(strip).toContain("1 F a fairly long…");
    expect(strip).toContain("2 F another long…");
    expect(strip).toContain("3 F the third…");
    expect(strip).not.toMatch(/\.\.\./);
    expect(strip.length).toBeLessThanOrEqual(80);
  }, 60_000);

  it("marks a session that needs you on the folded rail, and keeps one column of air beside its title", async () => {
    ui = await mount(path.join(server.root, "alpha"), { width: 80, height: 30 });
    await ui.type("please ask");
    ui.keys.pressEnter();
    await ui.until("Waiting for approval");
    // The card arrives on the chat's own stream; the asking flag rides the overview, a beat behind.
    await ui.until(() => (ui?.app.overview().sessions.filter((s) => s.asking).length ?? 0) > 0, 20_000);
    const card = await ui.frame();
    // The card's own semantics: Approve in the ok tone, Deny in danger — as the web card's buttons.
    const spans = (await ui.spans()).flatMap((line) => line);
    expect(spans.find((s) => s.text.includes("Approve"))?.fg.toInts().slice(0, 3)).toEqual([78, 209, 126]);
    expect(spans.find((s) => s.text.includes("Deny"))?.fg.toInts().slice(0, 3)).toEqual([248, 113, 113]);
    // The rail (the panel is folded at this width) carries the asking mark under its `»`.
    expect(card.split("\n").slice(0, 3).map((line) => line.slice(0, 3)).join("")).toContain("▲");
    // Open the panel (it opens unfocused): the asking row is there, its meta the age alone — the old
    // row put a second "!" beside the `▲` the prefix already shows.
    ui.keys.pressKey("x", { ctrl: true });
    ui.keys.pressKey("b");
    const open = await ui.until("C-x s browse");
    expect(open).toMatch(/▲ please ask\s+now/);
    expect(open).not.toContain("! now");
    // Folded again, the mark is still the only thing that asks for you.
    ui.keys.pressKey("x", { ctrl: true });
    ui.keys.pressKey("b");
    const folded = await ui.until("Waiting for approval");
    expect(folded.split("\n").slice(0, 3).map((line) => line.slice(0, 3)).join("")).toContain("▲");
    expect(folded.split("\n")[0]).not.toContain("Sessions");
  }, 45_000);

  it("draws the empty screen inside the chat column, never over the pane's edges", async () => {
    ui = await mount(path.join(server.root, "alpha"), { width: 80, height: 24 });
    await ui.until("What should Fake do in alpha?");
    // Open the panel at this width: the column is half the pane, where the splash once wrapped
    // its tip out to the very edges. Inside the column, every line keeps its left margin.
    ui.keys.pressKey("x", { ctrl: true });
    ui.keys.pressKey("b");
    const open = await ui.until("C-x s browse");
    expect(open.split("\n").every((line) => line === "" || line.startsWith(" "))).toBe(true);
    // A line without the panel's border is conversation: it keeps the panel's width of margin —
    // the old splash wrapped its tip to the pane's very left edge.
    for (const line of open.split("\n")) {
      if (line.includes("│") || line.trim() === "") continue;
      expect(line.length - line.trimStart().length).toBeGreaterThanOrEqual(26);
    }
  }, 30_000);

  it("never answers an approval while the focus is elsewhere", async () => {
    ui = await mount(path.join(server.root, "alpha"), { width: 120, height: 30 });
    await ui.type("please ask first");
    ui.keys.pressEnter();
    await ui.until("Waiting for approval");
    // The chord that hands the keys to the sessions must disarm the card: Enter there opens the
    // selected session, and the approval stays pending — answered only when the composer owns the keys.
    ui.keys.pressKey("x", { ctrl: true });
    await ui.type("s");
    await ui.until("↑↓ move · t tab · Esc");
    ui.keys.pressEnter();
    await wait(200);
    const pending = ui.app.chat()?.pending ?? [];
    expect(pending.length).toBe(1);
    expect(ui.app.chat()?.items.some((i) => i.kind === "request" && i.outcome !== undefined)).toBe(false);
    // Back in the composer the card answers as before.
    await ui.escape();
    await ui.until("Waiting for approval");
    ui.keys.pressKey("1");
    await ui.until(() => (ui?.app.chat()?.pending.length ?? 1) === 0, 20_000);
  }, 45_000);
});

describe("atui's keybind styles", () => {
  it("lists the empty screen's keys in the active style, and updates them when the style changes", async () => {
    ui = await mount(path.join(server.root, "alpha"), { width: 150, height: 36 });
    const emacs = await ui.until("C-k commands");
    expect(emacs).toContain("C-r history");
    expect(emacs).toContain("C-x s sessions");
    expect(emacs).toContain("@ files");
    expect(emacs).not.toContain(": commands");
    expect(emacs).not.toContain("SPC s sessions");
    expect(emacs).toContain("C-x s browse");
    // C-x v: the vim style, and the same row now names those keys.
    ui.keys.pressKey("x", { ctrl: true });
    ui.keys.pressKey("v");
    const vim = await ui.until(": commands");
    expect(vim).toContain("/ history");
    expect(vim).toContain("SPC s sessions");
    expect(vim).toContain("@ files");
    expect(vim).not.toContain("C-k commands");
    expect(vim).not.toContain("C-x s sessions");
    expect(vim).toContain("SPC s browse");
    // Space v back to Emacs restores the chords.
    await ui.type(" ");
    ui.keys.pressKey("v");
    const back = await ui.until("C-k commands");
    expect(back).toContain("C-x s sessions");
    expect(back).toContain("C-r history");
    expect(back).toContain("C-x s browse");
    expect(back).not.toContain(": commands");
    await ui.unmount();
    // Starting already in vim names the same keys, with no Emacs chords left on the row.
    ui = await mount(path.join(server.root, "alpha"), { keybinds: "vim", width: 150, height: 36 });
    const started = await ui.until(": commands");
    expect(started).toContain("/ history");
    expect(started).toContain("SPC s sessions");
    expect(started).toContain("@ files");
    expect(started).not.toContain("C-k commands");
  }, 40_000);

  it("switches styles with the leader's v, and each style's keys are its own", async () => {
    // Emacs first: C-x opens the leader panel; the vim keys are not bound.
    ui = await mount(path.join(server.root, "beta"), { width: 150, height: 36 });
    await ui.type("hello there");
    ui.keys.pressEnter();
    await ui.until("Echo: hello there");
    await idle(ui);
    ui.keys.pressKey("x", { ctrl: true });
    const panel = await ui.until("C-x …");
    expect(panel).toContain("v → keybinds (vim)");
    ui.keys.pressKey("v");
    // The vim style: NORMAL at once, the footer says it, and the Emacs chords are off.
    const normal = await ui.until("NORMAL");
    expect(normal).toContain("Vim keybinds");
    ui.keys.pressKey("k", { ctrl: true });
    expect(await ui.frame()).not.toContain("Search commands, sessions, thinking…");
    // Space is the leader: its panel lists the same actions, and v switches back.
    await ui.type(" ");
    const spc = await ui.until("SPC …");
    expect(spc).toContain("v → keybinds (emacs)");
    ui.keys.pressKey("v");
    // Emacs again: its chords work and the panel says vim is the other way (no mode marker to wait for).
    ui.keys.pressKey("x", { ctrl: true });
    expect(await ui.until("C-x …")).toContain("v → keybinds (vim)");
    await ui.escape();
  }, 40_000);

  it("gives vim its tabs, its new chat, its close, and its quit", async () => {
    ui = await mount(path.join(server.root, "beta"), { keybinds: "vim", width: 150, height: 36 });
    await ui.until("NORMAL");
    // o: a new chat, straight into INSERT.
    ui.keys.pressKey("o");
    await ui.until("What should Fake do in");
    await ui.type("first tab in vim");
    ui.keys.pressEnter();
    await ui.until("Echo: first tab in vim");
    await idle(ui);
    // A second chat in a tab of its own (Space then a, vim's leader), then gt steps between them.
    await ui.escape();
    await ui.until("NORMAL");
    await ui.type(" ");
    ui.keys.pressKey("a");
    await ui.until("What should Fake do in");
    await ui.type("second tab in vim");
    ui.keys.pressEnter();
    await ui.until("Echo: second tab in vim");
    await idle(ui);
    await ui.escape();
    await ui.until("NORMAL");
    expect(await ui.frame()).toContain("2 F second tab in vim");
    ui.keys.pressKey("g");
    ui.keys.pressKey("t");
    await ui.until("❯ first tab in vim");
    ui.keys.pressKey("2");
    ui.keys.pressKey("g");
    ui.keys.pressKey("t");
    await ui.until("❯ second tab in vim");
    // q closes the shown tab, as :bd; the other one stays.
    ui.keys.pressKey("q");
    await ui.until(() => ui?.app.tabs().tabs.length === 1, 5000);
    expect(await ui.frame()).toContain("❯ first tab in vim");
    expect(await ui.frame()).not.toContain("2 F second tab in vim");
    // ZZ quits, the chat keeping running on the server.
    ui.keys.pressKey("Z");
    ui.keys.pressKey("Z");
    expect(ui.exited()).toBe(true);
  }, 60_000);
  it("compares the draft across two agents, each in a worktree of its own", async () => {
    // A comparison makes worktrees, so the project has to be a Git checkout with a commit.
    const alpha = path.join(server.root, "compare-project");
    mkdirSync(alpha, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: alpha, stdio: "ignore" });
    git("init", "-q");
    writeFileSync(path.join(alpha, "README.md"), "hello\n");
    git("add", "README.md");
    git("commit", "-q", "-m", "init");
    ui = await mount(alpha, { height: 40 });
    ui.keys.pressKey("k", { ctrl: true });
    await ui.until("Search commands");
    await ui.type("compare agents");
    ui.keys.pressEnter();

    // The draft is the prompt: with none the sheet does not open and says why.
    expect(await ui.until("Write the prompt first")).not.toContain("Run it with");
    await ui.type("tidy the readme");
    ui.keys.pressKey("k", { ctrl: true });
    await ui.until("Search commands");
    await ui.type("compare agents");
    ui.keys.pressEnter();
    const sheet = await ui.until("Run it with");
    expect(sheet).toContain("Start with 2 agents");
    expect(sheet).toMatch(/◉ Fake/);
    ui.keys.pressEnter();
    // The comparison's sheet opens on the two agents, with a winner still to pick.
    const race = await ui.until("Pick a winner");
    expect(race).toContain("Comparison");
    expect(race).toMatch(/Keep Fake's as the winner/);
    // Two agents, then the first one's Keep row.
    ui.keys.pressArrow("down");
    ui.keys.pressArrow("down");
    ui.keys.pressEnter();
    // A winner is not final: the sheet stays open, offers the other agent "instead", and the clean-up of the losers.
    const picked = await ui.until("Clean up 1 loser");
    expect(picked).toMatch(/Make .* the winner instead/);
    expect(picked).toContain("Tidy up");
    // The sheet refreshes every two seconds; the cursor stays on the row it was moved to (walking down to "instead", then waiting out a refresh).
    ui.keys.pressArrow("down");
    ui.keys.pressArrow("down");
    await wait(2600);
    ui.keys.pressEnter();
    await ui.until("marked as the winner");
    ui.keys.pressEscape();
    await wait(300);
    // A second comparison in the same project starts too: the worktree names do not collide.
    await ui.type("tidy the docs");
    ui.keys.pressKey("k", { ctrl: true });
    await ui.until("Search commands");
    await ui.type("compare agents");
    ui.keys.pressEnter();
    await ui.until("Run it with");
    ui.keys.pressEnter();
    const second = await ui.until("Pick a winner");
    expect(second).toContain("tidy the docs");
  }, 60_000);
  it("saves a setup as a named preset, starts a chat from it, and forgets it", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 40 });
    ui.keys.pressKey("k", { ctrl: true });
    await ui.until("Search commands");
    await ui.type("presets");
    ui.keys.pressEnter();
    // No preset yet: the sheet offers to save this screen's setup.
    expect(await ui.until("Save this setup as a preset")).toContain("Presets");
    ui.keys.pressEnter();
    await ui.until("Name it");
    await ui.type("Explore");
    expect(await ui.until("Save as “Explore”")).toContain("Fake");
    ui.keys.pressEnter();
    await ui.until("Preset “Explore” saved");
    expect(ui.app.presets()).toEqual([expect.objectContaining({ name: "Explore", harnessId: "fake" })]);
    // The same name replaces it rather than adding a second.
    ui.keys.pressKey("k", { ctrl: true });
    await ui.until("Search commands");
    await ui.type("presets");
    ui.keys.pressEnter();
    const sheet = await ui.until("Start a chat with");
    expect(sheet).toMatch(/Explore\s+Fake/);
    // A preset for the other harness starts a chat there.
    ui.app.savePreset("Other");
    ui.app.startPreset({ name: "Other", harnessId: "fake-b" });
    await wait(300);
    expect(ui.app.harnessId()).toBe("fake-b");
    // x forgets the highlighted one.
    ui.keys.pressEscape();
    await wait(200);
    ui.keys.pressKey("k", { ctrl: true });
    await ui.until("Search commands");
    await ui.type("presets");
    ui.keys.pressEnter();
    await ui.until("Start a chat with");
    ui.keys.pressKey("x");
    await wait(200);
    expect(ui.app.presets().map((x) => x.name)).toEqual(["Other"]);
    // u in the sheet puts it back where it was.
    ui.keys.pressKey("u");
    await wait(200);
    expect(ui.app.presets().map((x) => x.name)).toEqual(["Explore", "Other"]);
  }, 40_000);
  it("lists the paths an edit left behind and continues one in a new tab", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 40 });
    await ui.type("first branch question");
    ui.keys.pressEnter();
    await ui.until("Echo: first branch question");
    await idle(ui);
    await ui.type("second branch question");
    ui.keys.pressEnter();
    await ui.until("Echo: second branch question");
    await idle(ui);
    const original = ui.app.chat()?.chatId;
    // Replacing the second prompt leaves the first path behind.
    const last = ui.app.chat()?.items.filter((i) => i.kind === "user").at(-1);
    if (last?.kind !== "user") throw new Error("no prompt");
    await ui.app.rerun(2, last, "a replaced second question");
    await ui.until("Echo: a replaced second question");
    await idle(ui);
    ui.keys.pressKey("k", { ctrl: true });
    await ui.until("Search commands");
    await ui.type("branches");
    await ui.until("Branches: continue a path");
    ui.keys.pressEnter();
    const sheet = await ui.until("Left behind");
    expect(sheet).toContain("This chat");
    expect(sheet).toContain("a replaced second question");
    expect(sheet).toMatch(/second branch question\s+splits after prompt 1 of 2/);
    // The cursor starts on the left-behind path (the chat's own has nothing to continue): Enter continues it in a tab of its own.
    ui.keys.pressEnter();
    await ui.until(() => ui?.app.chat()?.chatId !== original);
    const prompts = ui.app.chat()?.items.filter((i) => i.kind === "user").map((i) => (i.kind === "user" ? i.text : ""));
    expect(prompts).toEqual(["first branch question", "second branch question"]);
  }, 40_000);
  it("starts a chat from a preset in that preset's permission mode", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 40 });
    ui.app.startPreset({ name: "Careful", harnessId: "fake", permissionMode: "acceptEdits" });
    await wait(300);
    await ui.type("hello preset mode");
    ui.keys.pressEnter();
    await ui.until("Echo: hello preset mode");
    await ui.until(() => ui?.app.chat()?.config.permissionMode === "acceptEdits");
    expect(await ui.until("Accept edits ▾")).toContain("Accept edits");
    // Saving the open chat keeps that mode with the preset.
    expect(ui.app.savePreset("Mode")?.permissionMode).toBe("acceptEdits");
  }, 30_000);
  it("ends a finished turn's Σ line with what that turn cost when the harness prices the model", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 40 });
    await ui.type("priced tool please");
    ui.keys.pressEnter();
    await ui.until("priced tool please");
    await idle(ui);
    await ui.until(() => Object.keys(ui?.app.turnSpend() ?? {}).length === 1);
    await ui.type("priced again");
    ui.keys.pressEnter();
    await ui.until("priced again");
    await idle(ui);
    await wait(500);
    const spends = Object.values(ui.app.turnSpend());
    // Two turns, each its own share: the second is one call's price, not the session's running total.
    expect(spends).toHaveLength(2);
    // Kept per chat, so a tab switched away from and back keeps its figures.
    const chatId = ui.app.chat()?.chatId ?? "";
    expect(Object.keys(ui.app.turnSpend()).every((k) => k.startsWith(`${chatId}:`))).toBe(true);
    expect(spends[1]).toBeCloseTo(0.014, 3);
    expect(spends[0]).toBeGreaterThanOrEqual(0.014);
    const frame = await ui.frame();
    expect(frame).toMatch(/Σ .*\$0\.014/);
  }, 40_000);
});
