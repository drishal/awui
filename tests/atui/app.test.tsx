// atui end to end: the built server with fake harnesses, atui in OpenTUI's
// test renderer, driven by keys and clicks as a person would.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { RGBA, TextAttributes } from "@opentui/core";
import path from "node:path";
import { contextTone } from "../../src/atui/theme.js";
import { mount, startServer, wait, type Mounted } from "./helpers.js";

let server: Awaited<ReturnType<typeof startServer>>;
let ui: Mounted | null = null;

beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server.stop();
});
afterEach(() => {
  ui?.unmount();
  ui = null;
});

const idle = (m: Mounted) => m.until(() => m.app.chat()?.status === "idle", 15_000);

describe("atui", () => {
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
    expect(f).toContain("┌─ ● Read README.md");
    expect(f).toMatch(/├─ ● Edit src\/app\.ts +Added 1 line, removed 1 line/);
    expect(f).toMatch(/└─ ● /);
    expect(f).toContain("● Echo: showcase tool edit please");
    expect(f).toMatch(/Σ \d+ calls · /);
    expect(f).not.toContain("Worked for");
    expect(f).toContain("Fake Echo ▾  Low ▾");
    // Clicked, a call is framed on the tree's trunk, its outcome in the bottom edge.
    await ui.click("Edit src/app.ts");
    const framed = await ui.until("╰─ Added 1 line, removed 1 line");
    expect(framed).toContain("╭");
    // C-x e folds every turn to its line, and brings the work back.
    ui.keys.pressKey("x", { ctrl: true });
    ui.keys.pressKey("e");
    const folded = await ui.until("▸ Worked for");
    expect(folded).toMatch(/▸ Worked for \d+s · 2 reads, 1 search, 2 edits/);
    expect(folded).not.toContain("┌─ ● Read");
  }, 30_000);

  it("shows a reply written between tool calls as a reply, before the command that followed it", async () => {
    ui = await mount(path.join(server.root, "beta"), { height: 40 });
    await ui.type("interleaved please");
    ui.keys.pressEnter();
    await idle(ui);
    const f = await ui.until("Echo: interleaved please");
    const reply = f.indexOf("this is reply block 1");
    const command = f.indexOf("● Bash");
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
    const mark = async () => (await ui?.spans())?.flat().find((s) => s.text.startsWith("▲"))?.fg.toInts().join();
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
    expect(live).toMatch(/[●○] Bash · running…/);
    await idle(ui);
    expect(await ui.frame()).not.toContain("step-6.test.ts");
  }, 30_000);

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
    expect(f).toContain("Fake Echo ▾  Low ▾");
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

  it("moves around in vim mode: Esc for NORMAL, j/k and gg/G, : for commands, i to type again", async () => {
    // Wide enough for NORMAL's whole hint beside the context and its sparkline (a narrower footer cuts the hint).
    ui = await mount(path.join(server.root, "beta"), { vim: true, height: 30, width: 170 });
    expect(await ui.frame()).toContain("-- INSERT --");
    await ui.type("slow stream for scrolling");
    ui.keys.pressEnter();
    await ui.until("Echo: slow stream for scrolling");
    await idle(ui);
    await ui.escape();
    expect(await ui.until("-- NORMAL --")).toContain("gg/G top/bottom");
    // In NORMAL, letters move instead of typing: nothing reaches the composer.
    const before = await ui.frame();
    ui.keys.pressKey("g");
    ui.keys.pressKey("g");
    await wait(60);
    expect(await ui.frame()).not.toBe(before);
    ui.keys.pressKey("g", { shift: true });
    await wait(60);
    ui.keys.pressKey("k");
    ui.keys.pressKey("x");
    await wait(60);
    expect(ui.app.chat()?.items.filter((i) => i.kind === "user")).toHaveLength(1);
    // ":" is the palette; Esc closes it and stays in NORMAL.
    ui.keys.pressKey(":");
    await ui.until("Search commands, sessions, thinking…");
    await ui.escape();
    expect(await ui.frame()).toContain("-- NORMAL --");
    // i: back to typing.
    ui.keys.pressKey("i");
    await ui.until("-- INSERT --");
    await ui.type("typed again");
    expect(await ui.until("typed again")).toContain("-- INSERT --");
  }, 40_000);

  it("answers an approval with a number and a question with the arrows", async () => {
    ui = await mount(path.join(server.root, "beta"));
    await ui.type("please ask first");
    ui.keys.pressEnter();
    expect(await ui.until("Waiting for approval")).toContain("› 1. Approve");
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
    expect(menu).toContain("Tab completes");
    ui.keys.pressTab();
    await wait(50);
    ui.keys.pressEnter();
    await ui.until("fake status: all good");

    // C-x: the which-key panel lists every key until one is pressed.
    ui.keys.pressKey("x", { ctrl: true });
    const panel = await ui.until("C-x-");
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
    // Where the answer is being written, a cursor blinks.
    await ui.until("▍");
    await ui.escape();
    await ui.until("Esc again to stop");
    await ui.escape();
    await ui.until("■ Stopped", 15_000);
    await idle(ui);
    expect(await ui.frame()).not.toContain("▍");
    ui.keys.pressKey("c", { ctrl: true });
    await ui.until("C-c again to quit");
    ui.keys.pressKey("c", { ctrl: true });
    await ui.until(() => ui?.exited() === true);
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
    await ui.until("Tab or Enter inserts");
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
    expect(await ui.frame()).toContain("Sessions │ Info");
    // C-x i: the Info tab, where the right panel's context and usage now live.
    ui.keys.pressKey("x", { ctrl: true });
    await ui.type("i");
    const info = await ui.until("Tool definitions");
    expect(info).toContain("Context");
    // Each changed file with its stat bar.
    expect(info).toMatch(/\+\d+ −\d+ ■{5}/);
    await ui.click("Sessions");
    await ui.until("C-x s to browse");
    // « folds it to a rail; » unfolds it.
    await ui.click("«");
    const folded = await ui.until("»");
    expect(folded).not.toContain("Sessions │ Info");
    await ui.click("»");
    await ui.until("Sessions │ Info");
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

  it("offers a prompt's actions on a click: Edit replaces it in place, Esc drops an edit", async () => {
    ui = await mount(path.join(server.root, "alpha"), { height: 40 });
    await ui.type("first try");
    ui.keys.pressEnter();
    await idle(ui);
    await ui.click("❯ first try");
    await ui.until("↻ Retry");
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

  it("reviews the chat's changes: a thread on a line, resolved, and its open ones sent as one prompt", async () => {
    ui = await mount(path.join(server.root, "beta"), { height: 40 });
    await ui.type("edit please");
    ui.keys.pressEnter();
    await idle(ui);
    ui.keys.pressKey("x", { ctrl: true });
    await ui.type("d");
    const view = await ui.until("Review changes  1 file · 0 open");
    expect(view).toContain("src/app.ts");
    expect(view).toMatch(/▌\s+\d*\s*- a/);
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
    const y = rows.findIndex((r) => r.includes("Echo: please run this"));
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
    await idle(ui);
    ui.keys.pressKey("x", { ctrl: true });
    await ui.type("n");
    await ui.until("What should Fake do in beta?");
    await ui.type("second session here");
    ui.keys.pressEnter();
    await idle(ui);
    await ui.until(() => (ui?.app.overview().sessions.filter((s) => s.title.endsWith("session here")).length ?? 0) >= 2);
    ui.keys.pressKey("x", { ctrl: true });
    await ui.type("s");
    await ui.until("↑↓ Enter · t tab · Esc back");
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
});
