import { describe, expect, it } from "vitest";
import type { ChatItem, InteractionRequest, LimitAccount, ToolItem } from "../../src/shared/protocol.js";
import { parseArgs } from "../../src/atui/args.js";
import { accountName, ago, clip, clipPath, fileUrl, foldLabel, outputTail, streamedChars, tokens, toolTarget, unifiedDiff, windowLabel } from "../../src/atui/format.js";
import { isApproval, optionsOf } from "../../src/atui/requests.js";
import { DARK, themeFrom } from "../../src/atui/theme.js";
import { buildTurns } from "../../src/web/turns.js";

const tool = (extra: Partial<ToolItem> = {}): ToolItem => ({
  kind: "tool",
  id: "t1",
  name: "edit",
  args: "",
  status: "done",
  output: "",
  truncated: false,
  category: "edit",
  summary: "/p/src/app.ts",
  paths: ["/p/src/app.ts"],
  ...extra,
});

describe("atui formatting", () => {
  it("names a tool's target relative to the project, and a delegation by its agents", () => {
    expect(toolTarget(tool(), "/p")).toBe("src/app.ts");
    expect(toolTarget(tool({ summary: "npm test", paths: [] }), "/p")).toBe("npm test");
    expect(toolTarget(tool({ subagents: { runs: [{ id: "0", agent: "scout", task: "x", status: "done" }] } }), "/p")).toBe("1 agent");
  });

  it("turns a tool diff into a unified diff, a hunk per run between folds", () => {
    const diff = unifiedDiff("src/app.ts", {
      added: 2,
      removed: 1,
      lines: [
        { kind: "ctx", text: "a", line: 3 },
        { kind: "del", text: "b", line: 4 },
        { kind: "add", text: "B", line: 4 },
        { kind: "gap", text: "" },
        { kind: "add", text: "z", line: 20 },
      ],
    });
    expect(diff).toBe("--- a/src/app.ts\n+++ b/src/app.ts\n@@ -4,2 +3,2 @@\n a\n-b\n+B\n@@ -20,0 +20,1 @@\n+z\n");
  });

  it("words the fold line as the web UI does, live or done", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "u", text: "go", at: 1000 },
      { ...tool(), at: 2000, endedAt: 13_000 },
      { kind: "assistant", id: "a", text: "done", thinking: "", streaming: false, at: 13_000, endedAt: 13_500 },
    ];
    const [done] = buildTurns(items, "idle");
    expect(done && foldLabel(done)).toBe("Worked for 13s · 1 edit");
    const [live] = buildTurns(items.slice(0, 2), "running");
    expect(live && foldLabel(live, 4000)).toBe("Working · 3s · 1 edit");
    // A fold per stretch of work: the first has the time, one between replies only what it did.
    expect(done && foldLabel(done, 0, { counts: { read: 2 }, place: "first" })).toBe("Worked for 13s · 2 reads");
    expect(done && foldLabel(done, 0, { counts: { read: 2, edit: 1 }, place: "middle" })).toBe("2 reads, 1 edit");
    expect(done && foldLabel(done, 0, { counts: {}, place: "middle" })).toBe("Worked");
    expect(live && foldLabel(live, 4000, { counts: {}, place: "last" })).toBe("Working · 3s");
  });

  it("links a file by a file:// URL, relative paths from the project, names encoded", () => {
    expect(fileUrl("src/app.ts", "/home/me/proj/")).toBe("file:///home/me/proj/src/app.ts");
    expect(fileUrl("/etc/hosts", "/home/me/proj")).toBe("file:///etc/hosts");
    expect(fileUrl("notes #1?.md", "/p")).toBe("file:///p/notes%20%231%3F.md");
  });

  it("keeps a running command's last lines, plain, as they read now", () => {
    expect(outputTail("one\ntwo\n\nthree\nfour\n", 3)).toEqual(["two", "three", "four"]);
    // Colour codes out; a progress bar redrawn with \r reads as its last state; Windows line ends kept whole.
    expect(outputTail("\x1b[32m✓ ok\x1b[0m\r\n 10%\r 55%\r 90%", 3)).toEqual(["✓ ok", " 90%"]);
    expect(outputTail("\x1b]8;;file:///x\x07link\x1b]8;;\x07 \x07bell", 1)).toEqual(["link bell"]);
    expect(outputTail("", 3)).toEqual([]);
  });

  it("counts what the agent has written since the last prompt", () => {
    const say = (id: string, text: string, thinking = ""): ChatItem => ({ kind: "assistant", id, text, thinking, streaming: false }) as ChatItem;
    const items: ChatItem[] = [{ kind: "user", id: "u1", text: "hi" } as ChatItem, say("a1", "old answer"), { kind: "user", id: "u2", text: "again" } as ChatItem, say("a2", "four", "ab"), tool(), say("a3", "six!!!")];
    expect(streamedChars(items)).toBe(12);
    expect(streamedChars([])).toBe(0);
  });

  it("says how long ago a session was active", () => {
    const now = Date.parse("2026-10-08T12:00:00Z");
    expect(ago("2026-10-08T11:59:40Z", now)).toBe("now");
    expect(ago("2026-10-08T11:48:00Z", now)).toBe("12m");
    expect(ago("2026-10-08T09:00:00Z", now)).toBe("3h");
    expect(ago("2026-10-03T12:00:00Z", now)).toBe("5d");
    expect(ago(null, now)).toBe("");
  });

  it("shortens counts, limits, and long lines", () => {
    expect([tokens(950), tokens(12_400), tokens(1_250_000)]).toEqual(["950", "12k", "1.3M"]);
    const claude: LimitAccount = { id: "claude", source: "Claude Code", provider: "Anthropic", windows: [{ label: "5 hours", used: 0.15, resetsAt: null }, { label: "7 days", used: 0.55, resetsAt: null }], limited: false, at: 0 };
    expect(accountName(claude)).toBe("Claude");
    expect(claude.windows.map((w) => windowLabel(w.label))).toEqual(["5h", "7d"]);
    expect(clip("a  long\n line", 8)).toBe("a long …");
    // A path keeps its end, cut at a folder: the project's own name is the part that tells two apart.
    expect(clipPath("/tmp/atui-scratch/workspaces/alpha", 24)).toBe("…/workspaces/alpha");
    expect(clipPath("/tmp/atui-scratch/workspaces/alpha", 14)).toBe("…/alpha");
    expect(clipPath("alpha", 14)).toBe("alpha");
  });
});

describe("atui theme", () => {
  it("takes the server's hex tokens over the dark defaults, and ignores anything else", () => {
    const theme = themeFrom({ vars: { "--accent": "#7daea3", "--bg": "rgb(0 0 0)", "--text": "#d4be98" } });
    expect(theme.accent).toBe("#7daea3");
    expect(theme.text).toBe("#d4be98");
    expect(theme.bg).toBe(DARK.bg);
    expect(themeFrom(null)).toEqual(DARK);
  });
});

describe("atui command line", () => {
  it("reads the server, harness, and what to open", () => {
    expect(parseArgs(["--harness", "omp", "--resume"], { AWUI_URL: "http://box:4783/" })).toMatchObject({ url: "http://box:4783", harness: "omp", resume: true });
    expect(parseArgs(["--vim"], {})).toMatchObject({ vim: true });
    expect(parseArgs(["--no-vim"], {})).toMatchObject({ vim: false });
    expect(parseArgs([], {})).not.toHaveProperty("vim");
    expect(parseArgs(["--resume", "pi:abc"], {})).toMatchObject({ url: "http://127.0.0.1:4783", resume: "pi:abc" });
    expect(parseArgs(["--chat", "c1", "--url", "http://x:1"], {})).toMatchObject({ chatId: "c1", url: "http://x:1" });
    expect(parseArgs(["-h"], {})).toEqual({ help: true });
    expect(parseArgs(["--url"], {})).toEqual({ error: "--url needs a value" });
    expect(parseArgs(["--nope"], {})).toEqual({ error: "Unknown option --nope" });
  });
});

describe("atui requests", () => {
  const ask = (extra: Partial<InteractionRequest>): InteractionRequest => ({ id: "r", kind: "confirm", title: "Allow?", createdAt: 0, ...extra });
  it("offers Approve and Deny for an approval, and a question's choices otherwise", () => {
    expect(isApproval(ask({}))).toBe(true);
    expect(optionsOf(ask({})).map((o) => [o.label, o.answer])).toEqual([
      ["Approve", { kind: "confirm", confirmed: true }],
      ["Deny", { kind: "confirm", confirmed: false }],
    ]);
    const q = ask({ kind: "select", options: ["Both (Recommended)", "Neither"], optionDetails: ["Shared", ""] });
    expect(isApproval(q)).toBe(false);
    expect(optionsOf(q)).toEqual([
      { label: "Both", detail: "Shared", recommended: true, answer: { kind: "select", value: "Both (Recommended)" } },
      { label: "Neither", recommended: false, answer: { kind: "select", value: "Neither" } },
    ]);
    expect(optionsOf(ask({ kind: "input" }))).toEqual([]);
  });
});
