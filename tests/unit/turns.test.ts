import { describe, expect, it } from "vitest";
import type { ChatItem } from "../../src/shared/protocol.js";
import { buildTurns, changeStatLabel, turnOfTool, countParts, countSummary, formatDuration, isEmojiOnly, modelName, modelSwitches, relativePath, saysSomething, latestThought, readsAsReply, segmentStartsOpen, workAfterSegment, workSegments, toolLabel, type WorkSegment } from "../../src/web/turns.js";

const tool = (id: string, category: "read" | "edit" | "command", extra: Record<string, unknown> = {}): ChatItem => ({
  kind: "tool",
  id,
  name: category,
  args: "",
  status: "done",
  output: "",
  truncated: false,
  category,
  summary: "",
  paths: [],
  ...extra,
});

describe("a turn's change stat", () => {
  const diffOf = (added: number, removed: number, lines = 3) => ({
    lines: [...Array.from({ length: lines }, (_, i) => ({ kind: "add" as const, text: `l${i}` })), { kind: "gap" as const, text: "more lines" }],
    added,
    removed,
  });
  const statOf = (...items: ChatItem[]) => buildTurns([{ kind: "user", id: "u", text: "go" }, ...items], "idle")[0]?.changeStat;

  it("sums the lines of every edit and write, and counts the files", () => {
    const stat = statOf(
      tool("t1", "edit", { paths: ["/w/a.ts"], diffStat: { added: 3, removed: 1 } }),
      tool("t2", "edit", { paths: ["/w/b.ts"], diffStat: { added: 2, removed: 0 } }),
      tool("t3", "edit", { paths: ["/w/a.ts"], diffStat: { added: 1, removed: 4 } }),
      tool("t4", "read"),
    );
    expect(stat).toEqual({ added: 6, removed: 5, files: 2, partial: false });
  });

  it("falls back on the diff's own counts, and a cut diff still counts in full", () => {
    // Three lines kept on the wire, 900 added: the diff's counts are taken before it is cut.
    const stat = statOf(tool("t1", "edit", { paths: ["/w/a.ts"], diff: diffOf(900, 20) }));
    expect(stat).toEqual({ added: 900, removed: 20, files: 1, partial: false });
  });

  it("marks the sums a lower bound when a finished edit reported no counts", () => {
    const stat = statOf(tool("t1", "edit", { paths: ["/w/a.ts"], diffStat: { added: 2, removed: 1 } }), tool("t2", "edit", { paths: ["/w/b.ts"] }));
    expect(stat).toEqual({ added: 2, removed: 1, files: 2, partial: true });
    expect(changeStatLabel(stat!)).toBe("at least 2 additions, 1 deletion, 2 files");
  });

  it("leaves a failed edit out, and a running one adds its file but no lines yet", () => {
    const stat = statOf(
      tool("t1", "edit", { paths: ["/w/a.ts"], diffStat: { added: 5, removed: 5 }, status: "error" }),
      tool("t2", "edit", { paths: ["/w/b.ts"], status: "running" }),
      tool("t3", "edit", { paths: ["/w/c.ts"], diff: diffOf(1, 0, 1) }),
    );
    expect(stat).toEqual({ added: 1, removed: 0, files: 2, partial: false });
  });

  it("is null for a turn with no edits, or whose edits counted nothing", () => {
    expect(statOf(tool("t1", "read"), tool("t2", "command"))).toBeNull();
    expect(statOf(tool("t1", "edit", { paths: ["/w/a.ts"] }))).toBeNull();
  });

  it("follows a live turn as edits land", () => {
    const items: ChatItem[] = [{ kind: "user", id: "u", text: "go" }, tool("t1", "edit", { paths: ["/w/a.ts"], diffStat: { added: 1, removed: 1 } })];
    expect(buildTurns(items, "running")[0]?.changeStat?.added).toBe(1);
    items.push(tool("t2", "edit", { paths: ["/w/b.ts"], diffStat: { added: 4, removed: 0 } }));
    expect(buildTurns(items, "running")[0]?.changeStat).toEqual({ added: 5, removed: 1, files: 2, partial: false });
  });
});

describe("buildTurns", () => {
  it("numbers stored user turns for forks, skipping preambles and harness-answered commands", () => {
    const answer = (id: string): ChatItem => ({ kind: "assistant", id, text: "ok", thinking: "", streaming: false });
    const turns = buildTurns(
      [
        { kind: "notice", id: "n", level: "info", text: "started" },
        { kind: "user", id: "u1", text: "first" },
        answer("a1"),
        { kind: "user", id: "u2", text: "/context", command: true },
        answer("a2"),
        { kind: "user", id: "u3", text: "second" },
        answer("a3"),
      ],
      "idle",
    );
    expect(turns.map((t) => t.through)).toEqual([0, 1, 0, 2]);
  });

  it("splits on prompts and folds the work before the answer", () => {
    const items: ChatItem[] = [
      { kind: "notice", id: "n0", level: "info", text: "startup" },
      { kind: "user", id: "u1", text: "fix it", at: 1000 },
      { kind: "assistant", id: "a1", text: "", thinking: "plan", streaming: false, at: 1100 },
      tool("t1", "read", { at: 1200, endedAt: 1300 }),
      tool("t2", "edit", { paths: ["/w/src/a.ts"], at: 1400, endedAt: 1500 }),
      { kind: "assistant", id: "a2", text: "done", thinking: "", streaming: false, at: 1600, endedAt: 13600 },
      { kind: "notice", id: "n1", level: "error", text: "boom" },
      { kind: "user", id: "u2", text: "again" },
    ];
    const turns = buildTurns(items, "idle");
    expect(turns.map((t) => t.id)).toEqual(["pre-n0", "u1", "u2"]);
    const t = turns[1]!;
    expect(t.answer?.id).toBe("a2");
    expect(t.process.map((i) => i.id)).toEqual(["a1", "t1", "t2"]);
    expect(t.errors.map((i) => i.id)).toEqual(["n1"]);
    expect(t.counts).toEqual({ read: 1, edit: 1 });
    expect(t.changedFiles).toEqual(["/w/src/a.ts"]);
    expect(formatDuration((t.endedAt ?? 0) - (t.startedAt ?? 0))).toBe("13s");
    expect(t.live).toBe(false);
  });

  it("has no answer while work follows the last text, and marks the last turn live", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "u1", text: "go" },
      { kind: "assistant", id: "a1", text: "Let me look", thinking: "", streaming: false },
      tool("t1", "command"),
    ];
    const [turn] = buildTurns(items, "running");
    expect(turn?.answer).toBeNull();
    expect(turn?.process.map((i) => i.id)).toEqual(["a1", "t1"]);
    expect(turn?.live).toBe(true);
  });

  it("keeps a reply as the answer when the model calls a tool after writing it", () => {
    const reply = "Here is what I found.\n\nThe config loads twice because both extensions register it.";
    const items: ChatItem[] = [
      { kind: "user", id: "u1", text: "go" },
      { kind: "assistant", id: "a1", text: "Let me look", thinking: "", streaming: false },
      tool("t1", "command"),
      { kind: "assistant", id: "a2", text: reply, thinking: "", streaming: false },
      tool("t2", "command"),
    ];
    for (const status of ["running", "idle"] as const) {
      const [turn] = buildTurns(items, status);
      expect(turn?.answer?.id).toBe("a2");
      // The fold above the reply holds the work before it; the call after it keeps its place below.
      expect(turn?.process.map((i) => i.id)).toEqual(["a1", "t1"]);
      expect(turn?.workAfter.map((i) => i.id)).toEqual(["t2"]);
      expect(turn?.answerAt).toBe(2);
      const after = turn ? workAfterSegment(turn) : null;
      expect(after?.items.map((i) => i.id)).toEqual(["t2"]);
      expect(after?.counts).toEqual({ command: 1 });
    }
  });

  it("reads the live thought in order when work follows the answer", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "u1", text: "go" },
      { kind: "assistant", id: "a1", text: "Done.\n\nAll set.", thinking: "Wrote the reply.", streaming: false },
      tool("t1", "command"),
      { kind: "assistant", id: "a2", text: "", thinking: "Now tidying up.", streaming: true },
    ];
    const [turn] = buildTurns(items, "running");
    expect(turn?.answer?.id).toBe("a1");
    expect(turn?.workAfter.map((i) => i.id)).toEqual(["t1", "a2"]);
    expect(turn && latestThought(turn)).toBe("Now tidying up.");
  });

  it("tells a reply from a remark before more work", () => {
    expect(readsAsReply("Let me check the config.")).toBe(false);
    expect(readsAsReply("Now I'll run the tests to confirm.")).toBe(false);
    expect(readsAsReply("Done.\n\nThe fix is in app.ts.")).toBe(true);
    expect(readsAsReply("Findings:\n- one\n- two")).toBe(true);
    expect(readsAsReply("## Summary\nAll good")).toBe(true);
    expect(readsAsReply("x".repeat(300))).toBe(true);
  });

  it("formats counts, durations, and workspace-relative paths", () => {
    expect(countSummary({ read: 3, edit: 1, command: 2 })).toBe("3 reads, 1 edit, 2 commands");
    // Split for Rolling: the category is the key, so only the number inside a part can move.
    expect(countParts({ read: 3, command: 2 })).toEqual([
      { category: "read", n: 3, word: "reads" },
      { category: "command", n: 2, word: "commands" },
    ]);
    // More than three reads as one line: the open fold lists the rest.
    expect(countSummary({ read: 1, search: 1, edit: 2, write: 1, command: 1, web: 1, other: 2 })).toBe("1 read, 1 search, 2 edits, …");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(3_720_000)).toBe("1h 2m");
    expect(formatDuration(400)).toBe("<1s");
    expect(formatDuration(0)).toBe("<1s");
    expect(relativePath("/w/src/a.ts", "/w")).toBe("src/a.ts");
    expect(relativePath("/other/a.ts", "/w")).toBe("/other/a.ts");
  });
});

describe("replies between tool calls", () => {
  const items: ChatItem[] = [
    { kind: "user", id: "u1", text: "reply, run something, then say done" },
    { kind: "assistant", id: "a1", text: "this is reply block 1", thinking: "They want a reply first.", streaming: false },
    tool("t1", "command"),
    { kind: "assistant", id: "a2", text: "done with tool call", thinking: "The command ran.", streaming: false },
  ];

  it("show in order as replies, with only the work between them folded", () => {
    const [turn] = buildTurns(items, "idle");
    expect(turn?.answer?.id).toBe("a2");
    const segments = turn ? workSegments(turn) : [];
    // The first reply's thought, the reply; then the command and the answer's thought.
    expect(segments.map((s) => [s.items.map((i) => i.id), s.reply?.id ?? null, s.answerAt])).toEqual([
      [["a1"], "a1", -1],
      [["t1"], null, 1],
    ]);
    expect(segments[1]?.counts).toEqual({ command: 1 });
  });

  it("are the same while the run is live, and a turn with no reply between work keeps one fold", () => {
    const [live] = buildTurns(items.slice(0, 3), "running");
    expect(live?.answer).toBeNull();
    expect(live ? workSegments(live).map((s) => s.reply?.id ?? null) : []).toEqual(["a1", null]);
    const [plain] = buildTurns([items[0] as ChatItem, tool("t1", "read"), { kind: "assistant", id: "a9", text: "Done.", thinking: "", streaming: false }], "idle");
    expect(plain ? workSegments(plain).map((s) => [s.items.map((i) => i.id), s.reply]) : []).toEqual([[["t1"], null]]);
  });
});

describe("a stretch's fold", () => {
  // Work, then a reply, then more work (still running): the first stretch ends in a reply, the second is live.
  const [turn] = buildTurns([{ kind: "user", id: "u1", text: "go" }, { kind: "assistant", id: "r1", text: "a reply", thinking: "", streaming: false }, tool("t1", "command")], "running");
  const [replied, running] = turn ? workSegments(turn) : [];
  expect(replied?.reply?.id).toBe("r1");
  expect(running?.reply).toBeNull();

  it("is open while its work still runs, and folds away once a reply lands after it", () => {
    expect(segmentStartsOpen(true, running as WorkSegment, 0)).toBe(true);
    expect(segmentStartsOpen(true, replied as WorkSegment, 0)).toBe(false);
  });
  it("is shut on a settled turn, even around a failure, and stays open around a live one", () => {
    expect(segmentStartsOpen(false, running as WorkSegment, 0)).toBe(false);
    expect(segmentStartsOpen(false, replied as WorkSegment, 1)).toBe(false);
    expect(segmentStartsOpen(true, replied as WorkSegment, 1)).toBe(true);
  });
});
describe("a message streaming after a reply", () => {
  it("leaves the reply where it is, from the first token to the settled turn", () => {
    const reply: ChatItem = { kind: "assistant", id: "a1", text: "Done — 2/3 complete.\n\n- [x] a\n- [x] b\n- [ ] c", thinking: "", streaming: false };
    const next = (text: string, streaming: boolean): ChatItem => ({ kind: "assistant", id: "a2", text, thinking: "The reminder nags about c.", streaming });
    const order = (items: ChatItem[], status: "running" | "idle") => {
      const [turn] = buildTurns([{ kind: "user", id: "u1", text: "todos" }, tool("t1", "command"), reply, ...items], status);
      return { answer: turn?.answer?.id ?? null, replies: turn ? workSegments(turn).map((s) => s.reply?.id ?? null) : [] };
    };
    // Thinking only: the reply is already an interim one, and the thought follows it.
    expect(order([next("", true)], "running")).toEqual({ answer: null, replies: ["a1", null] });
    expect(order([next("C stays open", true)], "running")).toEqual({ answer: "a2", replies: ["a1", null] });
    expect(order([next("C stays open", false)], "idle")).toEqual({ answer: "a2", replies: ["a1", null] });
  });
});

describe("notices that arrive while idle", () => {
  it("sit after the turn and never stretch its duration", () => {
    const day = 86_400_000;
    const items: ChatItem[] = [
      { kind: "user", id: "u1", text: "old question", at: 1_000 },
      { kind: "assistant", id: "a1", text: "", thinking: "hm", streaming: false, at: 2_000 },
      { kind: "tool", id: "t1", name: "bash", args: "", status: "done", output: "", truncated: false, category: "command", summary: "", paths: [], at: 3_000, endedAt: 9_000 },
      { kind: "assistant", id: "a2", text: "answer", thinking: "", streaming: false, at: 10_000 },
      // Re-opened four days later: extension notices arrive while idle.
      { kind: "notice", id: "n1", level: "info", text: "compaction-control: capped", at: 4 * day, ambient: true },
      { kind: "notice", id: "n2", level: "warning", text: "trust skipped", at: 4 * day, ambient: true },
    ];
    const [turn] = buildTurns(items, "idle");
    expect(turn?.after.map((n) => n.id)).toEqual(["n1", "n2"]);
    expect(turn?.process.map((i) => i.id)).toEqual(["a1", "t1"]);
    expect(formatDuration((turn?.endedAt ?? 0) - (turn?.startedAt ?? 0))).toBe("9s");
  });
});

describe("model switches", () => {
  const turn = (n: number, model?: string): ChatItem[] => [
    { kind: "user", id: `u${n}`, text: `q${n}` },
    { kind: "assistant", id: `a${n}`, text: `a${n}`, thinking: "", streaming: false, ...(model ? { model } : {}) },
  ];
  it("marks the turns whose model differs from the last turn that named one", () => {
    const turns = buildTurns([...turn(1, "opus"), ...turn(2, "opus"), ...turn(3), ...turn(4, "haiku"), ...turn(5, "opus")], "idle");
    expect(turns.map((t) => t.model)).toEqual(["opus", "opus", undefined, "haiku", "opus"]);
    expect([...modelSwitches(turns)]).toEqual([
      ["u4", "haiku"],
      ["u5", "opus"],
    ]);
  });
  it("names a model by key or id, else as the harness wrote it", () => {
    const models = [{ key: "anthropic/claude-opus-5-5", id: "claude-opus-5-5", name: "Opus 5.5" }];
    expect(modelName("claude-opus-5-5", models)).toBe("Opus 5.5");
    expect(modelName("anthropic/claude-opus-5-5", models)).toBe("Opus 5.5");
    expect(modelName("gpt-x", models)).toBe("gpt-x");
  });
});

describe("stray text between tool calls", () => {
  it("counts only text with a letter or digit as something said", () => {
    expect([".", "\n\n\n", "", " - ", "…", "ok", "4", "Готово"].map(saysSomething)).toEqual([false, false, false, false, false, true, true, true]);  });
  it("never picks blank text as the answer", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "u", text: "q" },
      { kind: "assistant", id: "a1", text: "The fix is in.", thinking: "", streaming: false },
      { kind: "assistant", id: "a2", text: "\n\n\n", thinking: "", streaming: false },
    ];
    expect(buildTurns(items, "idle")[0]?.answer?.id).toBe("a1");
  });
});

describe("the live turn's latest thought", () => {
  const think = (id: string, thinking: string): ChatItem => ({ kind: "assistant", id, text: "", thinking, streaming: true });
  it("is the first sentence of the newest thinking, on one line", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "u", text: "fix it" },
      think("a1", "Old idea. Not this."),
      { kind: "tool", id: "t", name: "read", args: "", status: "done", output: "", truncated: false, category: "read", summary: "a.ts", paths: [] },
      think("a2", "Found the cause:\nthe retry   path never resets. Then I will patch it."),
      think("a3", "   "),
    ];
    const [turn] = buildTurns(items, "running");
    expect(turn && latestThought(turn)).toBe("Found the cause: the retry path never resets.");
  });
  it("is nothing before any thinking", () => {
    const [turn] = buildTurns([{ kind: "user", id: "u", text: "q" }], "running");
    expect(turn && latestThought(turn)).toBeNull();
  });
});


describe("tool labels", () => {
  it("writes an MCP tool as its name and server, and leaves any other alone", () => {
    expect(toolLabel("mcp__awui__render_html")).toBe("render_html · awui");
    expect(toolLabel("mcp__github__create_issue")).toBe("create_issue · github");
    expect(toolLabel("Bash")).toBe("Bash");
  });
});

describe("emoji-only prompts", () => {
  it("reads a short emoji-only message as a reaction", () => {
    expect(isEmojiOnly("👍")).toBe(true);
    expect(isEmojiOnly("  🎉🎉  ")).toBe(true);
    expect(isEmojiOnly("👍🏽")).toBe(true); // a modifier joins it
    expect(isEmojiOnly("❤️")).toBe(true); // a variation selector joins it
    expect(isEmojiOnly("🇮🇳")).toBe(true); // a flag is two regional indicators
  });
  it("never reads words, digits, or long emoji art as one", () => {
    expect(isEmojiOnly("ok 👍")).toBe(false);
    expect(isEmojiOnly("2")).toBe(false);
    expect(isEmojiOnly("👍".repeat(7))).toBe(false);
    expect(isEmojiOnly("")).toBe(false);
  });
});

describe("finding the call a rail row came from", () => {
  it("names the turn whose work holds the call, before or after its answer, and null when it is gone", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "u1", text: "one", at: 1 } as ChatItem,
      tool("t1", "read"),
      { kind: "user", id: "u2", text: "two", at: 2 } as ChatItem,
      tool("t2", "read"),
      { kind: "assistant", id: "a2", text: "done", thinking: "", streaming: false } as ChatItem,
      tool("t3", "read"),
    ];
    const turns = buildTurns(items, "idle");
    expect(turnOfTool(turns, "t1")).toBe(0);
    expect(turnOfTool(turns, "t2")).toBe(1);
    // Work the agent did after writing its answer is still that turn's.
    expect(turnOfTool(turns, "t3")).toBe(1);
    expect(turnOfTool(turns, "gone")).toBeNull();
  });
});
