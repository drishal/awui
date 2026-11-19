// atui's look-and-feel logic, apart from the drawing: the shimmer, paced
// streaming, meters, eased scrolling, the minimap, word-level diffs, task
// boxes, mentions, ghost text, picker highlights, and toasts.
import { describe, expect, it } from "vitest";
import type { ProjectSession } from "../../src/shared/protocol.js";
import { asHarnessId } from "../../src/shared/protocol.js";
import { applyMention, codeBlocks, ghostCompletion, matchSpans, mentionAt, newsBetween, notifySequence, quoteText, runForMessage, runStatus, tipAt, TIPS } from "../../src/atui/assist.js";
import { breathe, flashAt, meter, mix, ramp, revealCut, revealStep, scrollPath, shimmer, sparkline, spinnerFor, statBar, streamRate, unrollCounts } from "../../src/atui/fx.js";
import { contextTone, DARK } from "../../src/atui/theme.js";
import { CARET, filetypeOf, taskBoxes, withCaret } from "../../src/atui/markdown.js";
import { minimapCells, pinnedTurn, rowToScroll } from "../../src/atui/minimap.js";
import { LEADER_HELP, LEADER_KEYS, WHICH_KEY_CELL, whichKeyColumns, whichKeyGrid } from "../../src/atui/keys.js";
import { clip, tabTitleChars } from "../../src/atui/format.js";
import { highlightPreview, wordDiff } from "../../src/atui/words.js";
import { attachmentFrom, byteSize, clipboardTool, imageModeFrom, imagePathsFromPaste, imageProtocol, pickImageType } from "../../src/atui/images.js";
import { progressSequence, speaksProgress, terminalState } from "../../src/atui/terminal.js";

// A 2×2 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64");

describe("fx", () => {
  it("mixes colours and sweeps a shimmer band across a label", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mix("#102030", "#102030", 0.7)).toBe("#102030");
    const frame = shimmer(10, 6, "#000000", "#ffffff");
    expect(frame).toHaveLength(10);
    // The band's head (frame 6 - band 4 = char 2) is the brightest; far away is the base.
    expect(frame[2]).toBe("#ffffff");
    expect(frame[9]).toBe("#000000");
  });

  it("reveals streamed text at a steady pace, catching up when far behind", () => {
    expect(revealStep(0, 10, 33)).toBeLessThan(10);
    expect(revealStep(10, 10, 33)).toBe(10);
    // 3000 characters behind: a few frames, not seconds.
    let shown = 0;
    let frames = 0;
    while (shown < 3000 && frames < 100) {
      shown = revealStep(shown, 3000, 33);
      frames++;
    }
    expect(frames).toBeLessThan(40);
    expect(revealCut("hello wonderful world", 13)).toBe("hello");
    expect(revealCut("abc", 10)).toBe("abc");
  });

  it("measures how fast text streams, in tokens a second, once there is enough to tell", () => {
    expect(streamRate([])).toBeNull();
    expect(streamRate([[0, 0], [300, 400]])).toBeNull();
    // 800 characters in two seconds: 200 tokens, 100 a second.
    expect(streamRate([[0, 100], [1000, 500], [2000, 900]])).toBe(100);
    expect(streamRate([[0, 900], [1000, 900]])).toBe(0);
  });

  it("draws sparklines and meters with block characters", () => {
    expect(sparkline([0, 50, 100])).toBe("▁▅█");
    expect(sparkline([])).toBe("");
    expect(meter(0.5, 4)).toBe("██  ");
    expect(meter(1, 3)).toBe("███");
    expect(meter(0.1, 4)).toHaveLength(4);
  });

  it("ramps a colour between stops, holding the ends", () => {
    const stops: Array<[number, string]> = [
      [0, "#000000"],
      [10, "#ffffff"],
      [20, "#ff0000"],
    ];
    expect(ramp(-5, stops)).toBe("#000000");
    expect(ramp(5, stops)).toBe("#808080");
    expect(ramp(15, stops)).toBe("#ff8080");
    expect(ramp(99, stops)).toBe("#ff0000");
    // The context: green with room, amber where compacting is offered, red as it runs out.
    expect(contextTone(DARK, 10)).toBe(DARK.ok);
    expect(contextTone(DARK, 65)).toBe(DARK.warn);
    expect(contextTone(DARK, 95)).toBe(DARK.danger);
  });

  it("draws a diff stat bar scaled to the largest change, each side that changed in it", () => {
    expect(statBar(40, 10, 50, 5)).toEqual({ add: 4, del: 1, rest: 0 });
    expect(statBar(5, 0, 50, 5)).toEqual({ add: 1, del: 0, rest: 4 });
    expect(statBar(1, 99, 100, 5)).toEqual({ add: 1, del: 4, rest: 0 });
    expect(statBar(99, 1, 100, 5)).toEqual({ add: 4, del: 1, rest: 0 });
    expect(statBar(0, 0, 50, 5)).toEqual({ add: 0, del: 0, rest: 5 });
    // A single file is the largest: it fills the bar.
    expect(statBar(3, 0, 3, 5)).toEqual({ add: 5, del: 0, rest: 0 });
  });

  it("eases a scroll and lands exactly on the target", () => {
    const path = scrollPath(0, 100, 6);
    expect(path).toHaveLength(6);
    expect(path[path.length - 1]).toBe(100);
    // Ease-out: the first step is the biggest.
    expect((path[0] as number) > (path[1] as number) - (path[0] as number)).toBe(true);
  });

  it("unrolls a fold: most rows on the first frame, all by the last", () => {
    expect(unrollCounts(10, 3)).toEqual([8, 10, 10]);
    expect(unrollCounts(30, 3)).toEqual([22, 29, 30]);
    expect(unrollCounts(1, 3)).toEqual([1, 1, 1]);
    expect(unrollCounts(0, 3)).toEqual([0, 0, 0]);
  });

  it("flashes once: up quickly, down slowly, and out", () => {
    expect(flashAt(0)).toBe(0);
    expect(flashAt(0.15)).toBe(1);
    expect(flashAt(0.5)).toBeGreaterThan(0.1);
    expect(flashAt(0.5)).toBeLessThan(flashAt(0.3));
    expect(flashAt(1)).toBe(0);
  });

  it("breathes from nothing to full and back over its period", () => {
    expect(breathe(0, 20)).toBe(0);
    expect(breathe(10, 20)).toBeCloseTo(1);
    expect(breathe(5, 20)).toBeCloseTo(0.5);
    expect(breathe(20, 20)).toBeCloseTo(0);
  });

  it("gives each harness its own spinner", () => {
    expect(spinnerFor("claude")).not.toEqual(spinnerFor("pi"));
    expect(spinnerFor("unknown")).toEqual(spinnerFor("pi"));
    for (const id of ["pi", "omp", "claude", "hermes"]) for (const frame of spinnerFor(id)) expect([...frame]).toHaveLength(1);
  });
});

describe("minimap", () => {
  it("puts one tick per turn and marks the visible stretch", () => {
    const cells = minimapCells(
      [
        { top: 0, tone: "plain" },
        { top: 50, tone: "edited" },
        { top: 90, tone: "failed" },
      ],
      100,
      40,
      20,
      10,
    );
    expect(cells.map((c) => c.tone)).toEqual(["plain", null, null, null, null, "edited", null, null, null, "failed"]);
    expect(cells.map((c) => c.inView)).toEqual([false, false, false, false, true, true, false, false, false, false]);
  });

  it("maps a click back to a scroll position, clamped", () => {
    expect(rowToScroll(0, 10, 100, 20)).toBe(0);
    expect(rowToScroll(9, 10, 100, 20)).toBe(80);
    expect(rowToScroll(5, 10, 100, 20)).toBe(45);
  });

  it("pins the turn whose prompt scrolled away while its answer is on screen", () => {
    expect(pinnedTurn([0, 40, 90], 0)).toBeNull();
    expect(pinnedTurn([0, 40, 90], 10)).toBe(0);
    expect(pinnedTurn([0, 40, 90], 50)).toBe(1);
    // The next prompt is right at the top: nothing to pin.
    expect(pinnedTurn([0, 40, 90], 40)).toBeNull();
  });
});

describe("word-level diff", () => {
  it("finds the words that changed in a replaced line", () => {
    const d = wordDiff("const total = price * qty;", "const total = price * quantity;");
    expect(d.before.filter((s) => s.changed).map((s) => s.text)).toEqual(["qty"]);
    expect(d.after.filter((s) => s.changed).map((s) => s.text)).toEqual(["quantity"]);
  });

  it("marks a rewritten line changed throughout", () => {
    const d = wordDiff("alpha beta", "gamma delta");
    expect(d.before).toEqual([{ text: "alpha beta", changed: true }]);
  });

  it("pairs removed and added runs line for line in a preview", () => {
    const lines = highlightPreview([
      { marker: " ", text: "x" },
      { marker: "-", text: "let a = 1;" },
      { marker: "+", text: "let a = 2;" },
      { marker: "+", text: "let b = 3;" },
    ]);
    expect(lines[1]?.segments.find((s) => s.changed)?.text).toBe("1");
    expect(lines[2]?.segments.find((s) => s.changed)?.text).toBe("2");
    expect(lines[3]?.segments).toEqual([{ text: "let b = 3;", changed: true }]);
    expect(lines[0]?.segments).toEqual([{ text: "x", changed: false }]);
  });
});

describe("markdown", () => {
  it("draws task lists as boxes, but not inside code", () => {
    expect(taskBoxes("- [ ] write\n- [x] test\n* [X] ship")).toBe("- ☐ write\n- ☑ test\n* ☑ ship");
    expect(taskBoxes("```\n- [ ] code\n```")).toBe("```\n- [ ] code\n```");
    expect(taskBoxes("a [link](x)")).toBe("a [link](x)");
  });

  it("names a file's language from its extension", () => {
    expect(filetypeOf("src/app.tsx")).toBe("tsx");
    expect(filetypeOf("flake.nix")).toBe("nix");
    expect(filetypeOf("Makefile")).toBeUndefined();
  });
});

describe("composer and picker helpers", () => {
  it("finds an @mention being typed and replaces it with the file", () => {
    expect(mentionAt("look at @src/ap")).toEqual({ query: "src/ap", start: 8 });
    expect(mentionAt("@")).toEqual({ query: "", start: 0 });
    expect(mentionAt("mail me@x.com")).toBeNull();
    expect(mentionAt("done @a ")).toBeNull();
    expect(applyMention("look at @src/ap", "src/app.ts")).toBe("look at @src/app.ts ");
  });

  it("ghosts the rest of the best slash command", () => {
    const cmd = { name: "compact", source: "app" } as const;
    expect(ghostCompletion("/com", cmd)).toBe("pact");
    expect(ghostCompletion("/compact", cmd)).toBe("");
    expect(ghostCompletion("/compact now", cmd)).toBe("");
    expect(ghostCompletion("/x", cmd)).toBe("");
  });

  it("highlights the letters a search matched", () => {
    expect(matchSpans("Choose model", "mod")).toEqual([
      { text: "Choose ", hit: false },
      { text: "mod", hit: true },
      { text: "el", hit: false },
    ]);
    expect(matchSpans("abc", "")).toEqual([{ text: "abc", hit: false }]);
  });

  it("toasts a background session that finished, failed, or asks", () => {
    const s = (id: string, extra: Partial<ProjectSession>): ProjectSession => ({ id, harnessId: asHarnessId("pi"), title: id, updatedAt: null, workspaceId: "w", ...extra });
    const before = [s("a", { status: "running" }), s("b", { status: "running" }), s("c", { status: "idle" }), s("shown", { status: "running" })];
    const after = [s("a", { status: "idle" }), s("b", { status: "error" }), s("c", { status: "idle", asking: true }), s("shown", { status: "idle" })];
    expect(newsBetween(before, after, "shown").map((n) => `${n.sessionId}:${n.kind}`)).toEqual(["a:done", "b:failed", "c:asking"]);
    expect(newsBetween(null, after, null)).toEqual([]);
  });

  it("asks the terminal for a notification, without letting a title inject escapes", () => {
    expect(notifySequence({ TERM: "foot" }, "Done", "fix it")).toBe("\x1b]777;notify;Done;fix it\x1b\\");
    expect(notifySequence({ TERM: "xterm-kitty" }, "Done", "x")).toBe("\x1b]9;Done: x\x1b\\");
    const evil = notifySequence({ TERM: "foot" }, "Done", "a\x1b]52;c;ZXZpbA==\x07b");
    expect(evil).not.toContain("\x1b]52");
    expect(evil.match(/\x1b/g)).toHaveLength(2);
  });

  it("rotates the tips", () => {
    expect(tipAt(0)).toBe(TIPS[0]);
    expect(tipAt(8000)).toBe(TIPS[1]);
  });
});

describe("images", () => {
  it("picks kitty's protocol in kitty and Ghostty, half blocks in tmux, and honours an explicit mode", () => {
    expect(imageProtocol(null, { TERM: "xterm-kitty" })).toBe("kitty");
    expect(imageProtocol(null, { TERM_PROGRAM: "ghostty" })).toBe("kitty");
    expect(imageProtocol(null, { GHOSTTY_RESOURCES_DIR: "/x" })).toBe("kitty");
    expect(imageProtocol(null, { TERM: "xterm-256color" })).toBe("auto");
    expect(imageProtocol(null, { TERM: "xterm-kitty", TMUX: "/tmp/tmux" })).toBe("blocks");
    expect(imageProtocol("sixel", { TERM: "xterm-kitty" })).toBe("sixel");
    expect(imageProtocol("off", {})).toBeNull();
    expect(imageModeFrom(undefined, { ATUI_IMAGES: "Kitty" })).toBe("kitty");
    expect(imageModeFrom("nope", {})).toBeNull();
  });

  it("reads a paste of dropped image files as paths, and anything else as text", () => {
    expect(imagePathsFromPaste("/tmp/a.png", "/w")).toEqual(["/tmp/a.png"]);
    expect(imagePathsFromPaste("'/tmp/my shot.png' shots/b.JPG", "/w")).toEqual(["/tmp/my shot.png", "/w/shots/b.JPG"]);
    expect(imagePathsFromPaste("/tmp/my\\ shot.webp", "/w")).toEqual(["/tmp/my shot.webp"]);
    expect(imagePathsFromPaste("file:///tmp/a%20b.gif", "/w")).toEqual(["/tmp/a b.gif"]);
    expect(imagePathsFromPaste("~/x.png", "/w", "/home/u")).toEqual(["/home/u/x.png"]);
    expect(imagePathsFromPaste("look at /tmp/a.png", "/w")).toBeNull();
    expect(imagePathsFromPaste("notes.txt", "/w")).toBeNull();
  });

  it("reads the clipboard with wl-paste or xclip, asking for an image type the server takes", () => {
    expect(pickImageType(["text/plain", "image/jpeg", "image/png"])).toBe("image/png");
    expect(pickImageType(["image/bmp", "text/plain"])).toBeNull();
    expect(clipboardTool({ WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":0" })?.read("image/png")).toEqual(["wl-paste", ["--no-newline", "--type", "image/png"]]);
    expect(clipboardTool({ DISPLAY: ":0" })?.list[0]).toBe("xclip");
    expect(clipboardTool({})).toBeNull();
  });

  it("checks an attachment by its bytes", () => {
    const ok = attachmentFrom(new Uint8Array(PNG));
    expect(typeof ok === "string" ? ok : ok.mimeType).toBe("image/png");
    expect(attachmentFrom(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toMatch(/not a PNG/);
    expect(byteSize(900)).toBe("1 KB");
    expect(byteSize(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });
});

describe("keys", () => {
  it("writes keys the Emacs way and lays C-x out column by column like which-key", () => {
    expect(LEADER_HELP).not.toMatch(/\^|Ctrl\+/);
    expect(new Set(LEADER_KEYS.map((k) => k.key)).size).toBe(LEADER_KEYS.length);
    expect(whichKeyGrid(14, 100, 34)).toEqual({ columns: 2, rows: 7 });
    expect(whichKeyColumns([1, 2, 3, 4, 5], 100, 34)).toEqual([[1, 2, 3], [4, 5]]);
    expect(whichKeyColumns([1, 2], 10, 34)).toEqual([[1, 2]]);
  });

  it("fits every which-key entry, state word included, in its column's cell", () => {
    // The longest words the panel ever shows beside a key (app.tsx passes these).
    const states: Partial<Record<string, string>> = { o: "folded", b: "off", i: "on", e: "off", v: "on", g: "off" };
    for (const k of LEADER_KEYS) {
      const line = `${k.key} → ${k.label}${states[k.key] ? ` (${states[k.key]})` : ""}`;
      expect(line.length).toBeLessThanOrEqual(WHICH_KEY_CELL);
    }
    // Three columns on an 80-column pane (its padding off), so the panel is nine rows, not fourteen.
    expect(whichKeyColumns(LEADER_KEYS, 78, WHICH_KEY_CELL)).toHaveLength(3);
    expect(whichKeyGrid(LEADER_KEYS.length, 78, WHICH_KEY_CELL).rows).toBeLessThanOrEqual(9);
  });
});

describe("the terminal's title and progress", () => {
  it("names the chat, marks a run, and counts the sessions that ask", () => {
    expect(terminalState({ title: "Fix the build", busy: false, asking: 0 })).toEqual({ title: "Fix the build · atui", progress: null });
    expect(terminalState({ title: "Fix the build", busy: true, asking: 0 })).toEqual({ title: "● Fix the build · atui", progress: "busy" });
    expect(terminalState({ title: "Fix", busy: true, asking: 2 })).toEqual({ title: "(2) ● Fix · atui", progress: "asking" });
    // An agent's title cannot end the sequence and start another.
    expect(terminalState({ title: "a\x07\x1b]0;evil", busy: false, asking: 0 }).title).toBe("a  ]0;evil · atui");
  });

  it("speaks OSC 9;4 only where the terminal draws it", () => {
    expect(speaksProgress({ TERM_PROGRAM: "ghostty" })).toBe(true);
    expect(speaksProgress({ WT_SESSION: "x" })).toBe(true);
    expect(speaksProgress({ TERM_PROGRAM: "ghostty", TMUX: "/tmp/tmux" })).toBe(false);
    expect(speaksProgress({ TERM: "xterm-kitty" })).toBe(false);
    expect(speaksProgress({ TERM: "xterm-kitty", ATUI_PROGRESS: "1" })).toBe(true);
    expect(speaksProgress({ TERM_PROGRAM: "ghostty", ATUI_PROGRESS: "0" })).toBe(false);
    expect(progressSequence("busy")).toBe("\x1b]9;4;3\x1b\\");
    expect(progressSequence("asking")).toBe("\x1b]9;4;4;100\x1b\\");
    expect(progressSequence(null)).toBe("\x1b]9;4;0\x1b\\");
  });
});

describe("the stream's cursor", () => {
  it("follows the text, except where a character would change what a line means", () => {
    expect(withCaret("Hello wor")).toBe(`Hello wor${CARET}`);
    expect(withCaret("a list:\n- one\n")).toBe(`a list:\n- one\n${CARET}`);
    // A fence would take it as the language; a table row and a rule would stop being one.
    expect(withCaret("see:\n```ts")).toBe("see:\n```ts");
    expect(withCaret("| a | b |")).toBe("| a | b |");
    expect(withCaret("above\n---")).toBe("above\n---");
  });
});

describe("quote and run in atui", () => {
  it("quotes a selection line by line", () => {
    expect(quoteText("  first line\n\nthird  \n")).toBe("> first line\n>\n> third");
  });

  it("finds an answer's fenced code blocks with their language", () => {
    const md = "Run this:\n```bash\nnpm test\n```\nand\n~~~\nplain\n~~~\n````md\n```js\nnested\n```\n````";
    expect(codeBlocks(md)).toEqual([
      { lang: "bash", code: "npm test" },
      { lang: null, code: "plain" },
      { lang: "md", code: "```js\nnested\n```" },
    ]);
    expect(codeBlocks("no code")).toEqual([]);
  });

  it("words a run's end and puts it into a message as the browser does", () => {
    expect(runStatus({ exitCode: 0, timedOut: false })).toBe("exit 0");
    expect(runStatus({ exitCode: null, timedOut: true })).toBe("timed out");
    expect(runStatus({ exitCode: null, timedOut: false })).toBe("stopped");
    expect(runForMessage("ls", "a\nb\n", "exit 0")).toBe("```\n$ ls\na\nb\n```\n(exit 0)");
  });
});

describe("layout budgets", () => {
  it("gives each tab a title budget that shrinks as tabs grow, never below a readable few", () => {
    expect(tabTitleChars(80, 2)).toBe(26);
    expect(tabTitleChars(80, 3)).toBe(14);
    expect(tabTitleChars(80, 5)).toBe(6);
    // Never negative, however many tabs or narrow the pane.
    expect(tabTitleChars(80, 9)).toBe(6);
    expect(tabTitleChars(140, 4)).toBe(23);
  });
  it("clips at a character, never leaving a space hanging before the ellipsis", () => {
    expect(clip("another long chat title", 14)).toBe("another long…");
    expect(clip("a fairly long chat title", 14)).toBe("a fairly long…");
    expect(clip("short", 20)).toBe("short");
    expect(clip("abcdef", 4)).toBe("abc…");
  });
});
