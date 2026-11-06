import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Key } from "@stencil-hq/tern";
import type { ChatItem, InteractionRequest, ProjectSession, SessionsOverview, ToolItem } from "../../src/shared/protocol.js";
import type { ChatState } from "../../src/web/chat-state.js";
import type { Node } from "@stencil-hq/tern";
import { applyEdit, draftState, editKey, lineStep, redo, setText, undo, wordStep, type DraftState } from "../../src/tern/draft.js";
import { filterItems, matchRanges, moveSelection, sessionRows } from "../../src/tern/overlays.js";
import { askShape, decorations, dock, placeholder, type DockCx } from "../../src/tern/dock.js";
import { themeSheet } from "../../src/tern/look.js";
import { conversation, foldHead, foldHeadSpans, toolNode, type ConversationCx } from "../../src/tern/view.js";
import { parseTernArgs } from "../../src/tern/args.js";
import { clientCommand, sourceRun } from "../../src/server/clients.js";
import { DARK } from "../../src/atui/theme.js";
import type { Turn, WorkSegment } from "../../src/web/turns.js";

const key = (name: string, over: Partial<Key> = {}): Key => ({ name, ctrl: false, alt: false, shift: false, meta: false, ...(name.length === 1 ? { text: name } : {}), ...over });

/** The draft after typing each key in turn. */
function typed(state: DraftState, ...keys: Key[]): DraftState {
  for (const k of keys) state = editKey(state, k) ?? state;
  return state;
}

describe("the Tern composer's draft", () => {
  it("types, moves, and deletes as the shell does", () => {
    let s = typed(draftState(), key("h"), key("i"), key("space"), key("t"), key("h"), key("e"), key("r"), key("e"));
    expect(s.draft).toEqual({ text: "hi there", cursor: 8, anchor: null });
    s = typed(s, key("w", { ctrl: true }));
    expect(s.draft.text).toBe("hi ");
    s = typed(s, key("a", { ctrl: true }), key("right"), key("delete"));
    expect(s.draft).toMatchObject({ text: "h ", cursor: 1 });
    s = typed(s, key("u", { ctrl: true }));
    expect(s.draft).toMatchObject({ text: " ", cursor: 0 });
  });

  it("undoes a typed word as one step, and redoes it", () => {
    let s = typed(draftState(), key("o"), key("n"), key("e"), key("space"), key("t"), key("w"), key("o"));
    s = undo(s);
    expect(s.draft.text).toBe("one ");
    s = undo(s);
    expect(s.draft.text).toBe("");
    expect(redo(redo(s)).draft.text).toBe("one two");
  });

  it("selects with Shift, and typing replaces the selection", () => {
    let s = setText(draftState(), "hello world");
    s = typed(s, key("left", { shift: true }), key("left", { shift: true }));
    expect(s.draft).toMatchObject({ cursor: 9, anchor: 11 });
    s = typed(s, key("!"));
    expect(s.draft.text).toBe("hello wor!");
  });

  it("takes a paste whole, its line ends as new lines", () => {
    const s = typed(draftState(), { name: "paste", text: "a\r\nb", ctrl: false, alt: false, shift: false, meta: false });
    expect(s.draft.text).toBe("a\nb");
  });

  it("leaves Enter, Esc, Tab, and the app's chords to the app", () => {
    for (const k of [key("enter"), key("escape"), key("tab"), key("k", { ctrl: true }), key("x", { ctrl: true })]) expect(editKey(draftState(), k)).toBeNull();
    // C-d deletes forward in text, and is the app's (quit) in an empty draft.
    expect(editKey(draftState(), key("d", { ctrl: true }))).toBeNull();
  });

  it("moves by line within the text, and says where the first or last line is", () => {
    const s = setText(draftState(), "ab\ncdef", 5);
    expect(lineStep(s.draft, -1)).toBe(2);
    expect(lineStep(s.draft, 1)).toBeNull();
    expect(lineStep({ text: "ab\ncd", cursor: 1, anchor: null }, -1)).toBeNull();
    expect(wordStep("foo  bar baz", 12, -1)).toBe(9);
    expect(wordStep("foo  bar baz", 0, 1)).toBe(3);
  });

  it("applies Tern's edit events, and ignores one made against an older text", () => {
    let s = setText(draftState(), "hello");
    s = applyEdit(s, { from: 0, to: 5, text: "bye", cursor: 3, len: 5 });
    expect(s.draft).toMatchObject({ text: "bye", cursor: 3 });
    expect(applyEdit(s, { from: 0, to: 1, text: "x", cursor: 1, len: 99 })).toBe(s);
    // A caret move alone is no undo step.
    const moved = applyEdit(s, { from: 1, to: 1, text: "", cursor: 1, len: 3 });
    expect(moved.draft.cursor).toBe(1);
    expect(moved.undo).toEqual(s.undo);
  });
});

describe("the Tern menus", () => {
  const items = [
    { id: "a", label: "Browse sessions" },
    { id: "b", label: "New chat", keywords: "start" },
    { id: "c", label: "Change the model…", detail: "session" },
  ];

  it("keep the rows with every word, label hits first", () => {
    expect(filterItems(items, "").map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(filterItems(items, "ses").map((i) => i.id)).toEqual(["a", "c"]);
    expect(filterItems(items, "start").map((i) => i.id)).toEqual(["b"]);
    expect(filterItems(items, "chat zzz")).toEqual([]);
  });

  it("mark where the words are, and wrap the selection", () => {
    expect(matchRanges("Change the model", "mod ch")).toEqual([
      [0, 2],
      [11, 14],
    ]);
    expect(matchRanges("x", "y")).toBeNull();
    expect(moveSelection({ kind: "palette", query: "", selected: 0 }, 3, -1).selected).toBe(2);
    expect(moveSelection({ kind: "palette", query: "", selected: 2 }, 3, 1).selected).toBe(0);
  });
});

describe("the Tern sessions picker", () => {
  const at = Date.parse("2026-10-27T12:00:00Z");
  const session = (id: string, over: Partial<ProjectSession>): ProjectSession =>
    ({ id, harnessId: "fake", workspaceId: "here", title: id, updatedAt: new Date(at - 60_000).toISOString(), status: null, ...over }) as ProjectSession;
  const overview = {
    workspaces: [
      { id: "here", name: "alpha", path: "/p/alpha" },
      { id: "far", name: "beta", path: "/p/beta" },
      { id: "old", name: "gamma", path: "/p/gamma" },
    ],
    sessions: [
      session("old-one", { workspaceId: "old", updatedAt: new Date(at - 86_400_000).toISOString() }),
      session("far-one", { workspaceId: "far" }),
      session("mine", {}),
      session("pinned", { pinned: true, workspaceId: "far" }),
      session("asks", { asking: true }),
      session("gone", { archived: true }),
    ],
    errors: [],
  } as unknown as SessionsOverview;

  it("orders them as the web sidebar does: what needs you, pins, this project, the others, the put-away last", () => {
    const rows = sessionRows(overview, { here: "here", current: null, harnessName: () => "Fake" }, at);
    expect(rows.map((r) => [r.group, r.id])).toEqual([
      ["Needs you", "asks"],
      ["Pinned", "pinned"],
      ["alpha", "mine"],
      ["beta", "far-one"],
      ["gamma", "old-one"],
      ["Snoozed, settled, and archived", "gone"],
    ]);
    // Outside its project's group a row names the project.
    expect(rows.find((r) => r.id === "pinned")?.detail).toBe("Fake · beta");
    expect(rows.find((r) => r.id === "mine")?.detail).toBe("Fake");
  });
});

describe("the Tern dock", () => {
  it("colours @mentions and {{blanks}} in the draft", () => {
    expect(decorations("see @src/a.ts and {{why}}")).toEqual([
      { from: 4, to: 13, s: "accent" },
      { from: 18, to: 25, s: "warning mark" },
    ]);
  });

  const noop = () => undefined;
  const dockCx = (chat: Partial<ChatState>, over: Partial<DockCx> = {}): DockCx =>
    ({
      chat: { chatId: "c", status: "idle", items: [], pending: [], queue: { steering: [], followUp: [] }, chain: [], todos: [], capabilities: {}, config: { models: [] }, ...chat } as unknown as ChatState,
      harness: null, git: null, limits: null, connected: true, version: "t", project: null,
      draft: { text: "", cursor: 0, anchor: null }, ghost: "", editing: null, answer: { text: "", cursor: 0, anchor: null }, leader: false, todosOpen: true,
      on: new Proxy({}, { get: () => noop }) as DockCx["on"],
      ...over,
    }) as DockCx;
  const all = (n: Node): Node[] => [n, ...n.children.flatMap(all)];

  it("shows the todos as the web UI's card over the composer, grouped by phase", () => {
    const todos = [
      { phase: "Plan", text: "Read the code", status: "completed" },
      { phase: "Plan", text: "Write the fix", status: "in_progress" },
      { phase: "Verify", text: "Run the tests", status: "pending" },
    ];
    const card = all(dock(dockCx({ todos }))).find((n) => n.props.role === "awui.todos");
    expect(JSON.stringify(card?.props.head)).toContain("1/3");
    const list = card?.children.find((n) => n.kind === "checklist");
    expect(list?.props.phases).toEqual([
      { id: "p0", title: "Plan", items: [{ id: "0", text: "Read the code", status: "done" }, { id: "1", text: "Write the fix", status: "active" }] },
      { id: "p1", title: "Verify", items: [{ id: "2", text: "Run the tests", status: "pending" }] },
    ]);
    // Folded, it keeps its heading and drops the list.
    const folded = all(dock(dockCx({ todos }, { todosOpen: false }))).find((n) => n.props.role === "awui.todos");
    expect(folded?.props.collapsed).toBe(true);
    expect(folded?.children.filter(Boolean)).toEqual([]);
  });


  const request = (over: Partial<InteractionRequest>): InteractionRequest => ({ id: "r1", kind: "select", title: "Run command?", message: "npm test", options: ["Approve", "Deny"], createdAt: 1, ...over });

  it("draws an approval as a tool row waiting for its yes, its buttons answering by option", () => {
    const answered: Array<[string, number]> = [];
    const r = request({ options: ["Allow once", "Always allow (npm test)", "Deny"] });
    const row = all(dock(dockCx({ pending: [r] }, { on: { answer: (q: InteractionRequest, i: number) => answered.push([q.id, i]) } as unknown as DockCx["on"] }))).find((n) => n.kind === "tool");
    expect(row?.props).toMatchObject({ name: "bash", title: "Run command", target: "npm test", targetKind: "command", status: "ask", confirm: "card" });
    expect(row?.props.ask).toEqual({ allow: "Allow once · 1", deny: "Deny · 3", always: "Always allow · 2" });
    const on = row?.handlers?.onAction;
    void on?.["allow"]?.({ act: "allow" } as never);
    void on?.["always"]?.({ act: "always" } as never);
    void on?.["deny"]?.({ act: "deny" } as never);
    expect(answered).toEqual([["r1", 0], ["r1", 1], ["r1", 2]]);
  });

  it("keeps a question, or a choice of more than an allowance, as a card", () => {
    expect(askShape(request({ options: ["Approve", "Deny"] }))).toEqual({ allow: 0, deny: 1, always: null });
    expect(askShape(request({ kind: "confirm", options: undefined }))).toEqual({ allow: 0, deny: 1, always: null });
    expect(askShape(request({ options: ["Allow once", "Allow for this session", "Deny"] }))).toEqual({ allow: 0, deny: 2, always: 1 });
    expect(askShape(request({ options: ["Red", "Green", "Blue"] }))).toBeNull();
    expect(askShape(request({ options: ["Allow once", "Maybe", "Deny"] }))).toBeNull();
    expect(askShape(request({ kind: "input", options: undefined }))).toBeNull();
  });

  it("offers the permission mode as a chip where the harness has modes, marking one that asks nothing", () => {
    const modes = [
      { id: "default", label: "Ask first", description: "Asks before edits and commands" },
      { id: "yolo", label: "Don't ask", description: "Asks nothing", caution: true },
    ];
    const chip = (permissionMode: string) =>
      all(dock(dockCx({ capabilities: { supportsPermissionMode: true } as ChatState["capabilities"], config: { models: [], permissionModes: modes, permissionMode } as unknown as ChatState["config"] }))).find((n) => n.props.key === "p");
    expect(JSON.stringify(chip("default"))).toContain("Ask first ⌄");
    expect(chip("default")?.props.class).toBe("chip think");
    expect(chip("yolo")?.props.class).toBe("chip think caution");
    expect(all(dock(dockCx({}))).some((n) => n.props.key === "p")).toBe(false);
  });

  it("asks for what fits the chat's state", () => {
    expect(placeholder(null, null, null)).toBe("Message the agent…");
    expect(placeholder(null, null, 3)).toMatch(/^Edit message 3/);
  });
});

describe("the Tern theme sheet", () => {
  it("uses a theme file's colours only in its own appearance", () => {
    expect(themeSheet(DARK, "#ff0000", "dark", true)).toContain(`--t1: ${DARK.text}`);
    expect(themeSheet(DARK, "#ff0000", "dark", false)).not.toContain("--t1");
    expect(themeSheet(DARK, "#ff0000", "dark", false)).toContain("--awui-harness: #ff0000");
    expect(themeSheet(DARK, "#ff0000", null, true)).not.toContain("--t1");
  });
});

const tool = (over: Partial<ToolItem>): ToolItem => ({ kind: "tool", id: "t1", name: "bash", args: "{}", status: "done", output: "", truncated: false, category: "command", summary: "", paths: [], ...over });

describe("the Tern conversation", () => {
  it("draws a command as Tern's tool row, its output folded under it", () => {
    const node = toolNode(tool({ args: JSON.stringify({ command: "npm test" }), output: "ok\n", at: 1000, endedAt: 3500 }), "/w", () => undefined);
    expect(node.kind).toBe("tool");
    expect(node.props).toMatchObject({ name: "bash", title: "Ran", target: "npm test", targetKind: "command", status: "done", took: 2500, collapsible: true, collapsed: true, frame: "inline" });
    expect(node.children[0]?.kind).toBe("ansi");
    // The facts are the web UI's: what the output holds.
    expect(node.props.meta).toEqual(["1 line"]);
  });

  it("shows a running test run's progress as a meter over its output, the failures as a red stretch", () => {
    const run = toolNode(tool({ status: "running", at: 1000, args: JSON.stringify({ command: "pytest" }), output: "collected 10 items\n\ntests/test_a.py ..F.   [ 40%]" }), "/w", () => 0);
    const [meter, out] = run.children;
    expect(meter?.kind).toBe("col");
    const bar = meter?.children[0];
    expect(bar?.kind).toBe("meter");
    expect(bar?.props.parts).toEqual([{ value: 0.3, token: "success", label: "passed" }, { value: 0.1, token: "error", label: "failed" }]);
    expect(JSON.stringify(bar?.props.label)).toContain("4/10 tests");
    expect(JSON.stringify(bar?.props.total)).toContain("1 failed");
    expect(out?.kind).toBe("ansi");
    // Settled, the bar goes: the row's facts say how it ended.
    expect(toolNode(tool({ status: "done", args: JSON.stringify({ command: "pytest" }), output: "collected 10 items\n\ntests/test_a.py ..F." }), "/w", () => 0).children[0]?.kind).toBe("ansi");
  });

  it("draws every job widget block natively, or as plain text when the terminal lacks its kind", () => {
    const item = tool({
      name: "wait",
      category: "other",
      status: "running",
      at: 1000,
      jobs: [{
        id: "j1",
        kind: "shell",
        status: "running",
        label: "npm test",
        title: "Tests",
        startedAt: 1000,
        widget: {
          headline: { text: "8", label: "passed" },
          stage: "test nine",
          blocks: [
            { kind: "meter", label: "done", value: 0.5, text: "5/10", tone: "success" },
            { kind: "stat", items: [{ label: "failed", text: "1", tone: "error" }] },
            { kind: "text", text: "still running" },
            { kind: "bars", label: "workers", items: [{ label: "a", value: 3, text: "three", tone: "accent" }], max: 5 },
            { kind: "spark", label: "rate", values: [1, 3, 2], last: "2/s", min: 0, max: 4 },
            { kind: "grid", label: "cases", items: [{ label: "one", text: "✓", tone: "success" }] },
          ],
        },
      }],
    });
    const rich = toolNode(item, "/w", () => 4200, () => true);
    const all = (n: Node): Node[] => [n, ...n.children.flatMap(all)];
    const nodes = all(rich);
    const job = nodes.find((n) => n.props.role === "awui.job");
    expect(job?.props).toMatchObject({ name: "job", title: "Tests", target: "npm test", status: "running", age: 4200 });
    expect(nodes.filter((n) => n.kind === "chart").map((n) => n.props.kind)).toEqual(["bars", "spark"]);
    expect(nodes.find((n) => n.kind === "chart" && n.props.kind === "bars")?.props.series).toEqual([{ value: 3, label: "a", title: "three", tone: "accent" }]);
    expect(nodes.some((n) => n.kind === "meter" && n.props.value === 0.5)).toBe(true);
    expect(nodes.some((n) => n.kind === "stats")).toBe(true);
    expect(nodes.some((n) => n.kind === "kv")).toBe(true);

    const plain = all(toolNode(item, "/w", () => 4200, () => false));
    expect(plain.some((n) => ["meter", "stats", "kv", "chart"].includes(n.kind))).toBe(false);
    expect(JSON.stringify(plain.map((n) => n.props))).toContain("5/10");
    expect(JSON.stringify(plain.map((n) => n.props))).toContain("three");
    expect(JSON.stringify(plain.map((n) => n.props))).toContain("2/s");
  });

  it("words a call as the web UI does: a command without its cd, a failure with its reason", () => {
    const ran = toolNode(tool({ args: JSON.stringify({ command: "cd /w && npm run build --silent" }), output: "ok\n" }), "/w", () => undefined);
    expect(ran.props).toMatchObject({ title: "Ran", target: "npm run build --silent" });
    const mcp = toolNode(tool({ name: "mcp__tracker__triage_ticket", category: "other", args: "{}" }), "/w", () => undefined);
    expect(mcp.props).toMatchObject({ title: "Asked", target: "tracker: triage ticket" });
    const failed = toolNode(tool({ status: "error", args: JSON.stringify({ file_path: "/w/src/gone.ts" }), category: "read", paths: ["/w/src/gone.ts"], output: "Error: ENOENT: no such file or directory" }), "/w", () => undefined);
    expect(failed.props).toMatchObject({ title: "Couldn't read", target: "src/gone.ts", status: "error" });
    expect(JSON.stringify(failed.props.note)).toContain("ENOENT");
  });

  it("times a finished call only past a second and a half, as the web UI's rows do", () => {
    expect(toolNode(tool({ output: "ok\n", at: 1000, endedAt: 1300 }), "/w", () => undefined).props.took).toBeUndefined();
    expect(toolNode(tool({ output: "ok\n", at: 1000, endedAt: 2600 }), "/w", () => undefined).props.took).toBe(1600);
  });

  it("keeps a running command open, following its output, timed from its age", () => {
    const node = toolNode(tool({ status: "running", args: JSON.stringify({ command: "sleep 9" }), output: "1\n2\n", at: 1000 }), "/w", () => 4200);
    expect(node.props).toMatchObject({ status: "running", age: 4200, collapsed: false, preview: { tail: 4 } });
    expect(node.children[0]?.props.follow).toBe(true);
  });

  it("draws an edit as a diff with its +/− counts", () => {
    const node = toolNode(
      tool({ name: "edit", category: "edit", paths: ["/w/src/a.ts"], diffStat: { added: 1, removed: 1 }, diff: { added: 1, removed: 1, lines: [{ kind: "del", text: "a", line: 3 }, { kind: "add", text: "b", line: 3 }] } }),
      "/w",
      () => undefined,
    );
    // Folded like every row, its +/− count saying how big it is.
    expect(node.props).toMatchObject({ title: "Edited", target: "src/a.ts", targetKind: "path", meta: ["+1", "−1"], collapsed: true });
    expect(node.props.preview).toBeUndefined();
    expect(node.children[0]?.kind).toBe("diff");
    expect(String(node.children[0]?.props.text)).toContain("-a\n+b");
  });

  it("draws what a compaction kept as plain rows with its reply, not a fold", () => {
    const items: ChatItem[] = [
      { kind: "notice", id: "n1", level: "info", text: "Earlier conversation was compacted" },
      { kind: "assistant", id: "a1", text: "The build passes now.\n\n- one\n- two", thinking: "", streaming: false },
    ];
    const chat = { chatId: "c", workspace: { id: "w", path: "/w", name: "w" }, status: "idle", items, capabilities: {}, checkpoints: [] } as unknown as ChatState;
    const noop = () => undefined;
    const cx: ConversationCx = { chat, harness: null, webUrl: "http://x", now: 0, age: () => undefined, supports: () => true, shown: 30, folds: new Map(), picked: null, blob: () => null, on: { fold: noop, pick: noop, showEarlier: noop, retry: noop, edit: noop, fork: noop, undo: noop, copy: noop } };
    const [turn] = conversation(cx);
    const kinds = (n: Node): string[] => [n.kind, ...n.children.flatMap(kinds)];
    expect(kinds(turn as Node)).not.toContain("section");
    expect(JSON.stringify(turn)).toContain("Earlier conversation was compacted");
    expect(JSON.stringify(turn)).toContain("The build passes now.");
  });

  it("draws a thought as a row among the calls, its reasoning folded under it", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "u1", text: "why", images: [] } as unknown as ChatItem,
      { kind: "assistant", id: "a1", text: "", thinking: "Considering the config first", streaming: false },
      tool({ id: "t2", output: "ok\n" }),
      { kind: "assistant", id: "a2", text: "Because.", thinking: "", streaming: false },
    ];
    const chat = { chatId: "c", workspace: { id: "w", path: "/w", name: "w" }, status: "idle", items, capabilities: {}, checkpoints: [] } as unknown as ChatState;
    const noop = () => undefined;
    const cx: ConversationCx = { chat, harness: null, webUrl: "http://x", now: 0, age: () => undefined, supports: () => true, shown: 30, folds: new Map([["u1#0", true]]), picked: null, blob: () => null, on: { fold: noop, pick: noop, showEarlier: noop, retry: noop, edit: noop, fork: noop, undo: noop, copy: noop } };
    const all = (n: Node): Node[] => [n, ...n.children.flatMap(all)];
    const thought = conversation(cx).flatMap((n) => all(n as Node)).find((n) => n.kind === "tool" && n.props.name === "thinking");
    expect(thought?.props).toMatchObject({ title: "Thought", target: "Considering the config first", frame: "inline", collapsed: true });
  });

  it("works a job's elapsed time from the view's clock, not the wall clock", () => {
    const wait = (job: Record<string, unknown>) =>
      tool({ name: "wait", category: "other", status: "running", jobs: [{ id: "j1", kind: "shell", label: "npm test", ...job }] as unknown as ToolItem["jobs"] });
    const jobOf = (item: ToolItem, now: number) => {
      const all = (n: Node): Node[] => [n, ...n.children.flatMap(all)];
      const job = all(toolNode(item, "/w", (_key, at) => at, () => true, now)).find((n) => n.props.role === "awui.job");
      if (!job) throw new Error("no job row");
      return job.props;
    };
    // A running job with no start but a duration began that long before the view's time.
    expect(jobOf(wait({ status: "running", durationMs: 3000 }), 10_000).age).toBe(7000);
    expect(jobOf(wait({ status: "running", durationMs: 3000 }), 20_000).age).toBe(17_000);
    // A finished one with a start and no end ran until the view's time.
    expect(jobOf(wait({ status: "done", startedAt: 1000 }), 6000).took).toBe(5000);
    expect(jobOf(wait({ status: "done", startedAt: 1000 }), 9000).took).toBe(8000);
  });

  it("words a fold the web UI's way", () => {
    const turn = { live: false, startedAt: 0, endedAt: 27_000 } as Turn;
    const seg = { counts: { command: 3 } } as unknown as WorkSegment;
    expect(foldHead(turn, seg, "only")).toBe("Worked for 27s · 3 commands");
    expect(foldHead(turn, seg, "last")).toBe("3 commands");
    expect(foldHead({ ...turn, live: true }, seg, "only")).toBe("Working · 3 commands");
  });

  it("adds the turn's +/− to the first stretch and a tally of failed calls", () => {
    const turn = { live: false, startedAt: 0, endedAt: 27_000, changeStat: { added: 12, removed: 3, files: 2, partial: false } } as Turn;
    const items = [tool({ status: "error" }), tool({ id: "t2" }), tool({ id: "t3", status: "error" })];
    const seg = { counts: { command: 3 }, items } as unknown as WorkSegment;
    const text = (place: "first" | "last") => foldHeadSpans(turn, seg, place).map((s) => s.t).join("");
    expect(text("first")).toBe("Worked for 27s · 3 commands  +12 −3  2 failed");
    expect(text("last")).toBe("3 commands  2 failed");
    expect(foldHeadSpans(turn, { counts: { command: 1 }, items: [tool({})] } as unknown as WorkSegment, "only").map((s) => s.t).join("")).toBe("Worked for 27s · 1 command  +12 −3");
  });
});

describe("awui tern's command line", () => {
  it("takes atui's options", () => {
    expect(parseTernArgs(["--url", "http://h:1/", "--harness", "pi", "--resume"], {})).toMatchObject({ url: "http://h:1", harness: "pi", resume: true });
    expect(parseTernArgs(["--vim"], {})).toEqual({ error: "Unknown option --vim" });
    expect(parseTernArgs(["-h"], {})).toEqual({ help: true });
  });

  it("picks the client by command, flag, or the binary's atui name", () => {
    expect(clientCommand(["tui", "--help"], "awui")).toEqual({ client: "atui", args: ["--help"] });
    expect(clientCommand(["tern", "--url", "http://h:1/"], "awui")).toEqual({ client: "tern", args: ["--url", "http://h:1/"] });
    expect(clientCommand(["--tern"], "awui")).toEqual({ client: "tern", args: [] });
    // The binary linked as `atui` takes every argument, server subcommands included.
    expect(clientCommand(["--version"], "atui")).toEqual({ client: "atui", args: ["--version"] });
    expect(clientCommand(["--version"], "/home/me/.local/bin/atui")).toEqual({ client: "atui", args: ["--version"] });
    expect(clientCommand(["--version"], "atui.exe")).toEqual({ client: "atui", args: ["--version"] });
    // A symlink's path is argv0 only when it is the basename's end; `awui` runs the server.
    expect(clientCommand(["--version"], "awui")).toBeNull();
    expect(clientCommand(["doctor"], "awui")).toBeNull();
  });

  it("runs the clients from source under Bun with their settings", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "awui-checkout-"));
    mkdirSync(path.join(repo, "src", "tern"), { recursive: true });
    writeFileSync(path.join(repo, "package.json"), "{}");
    // atui rides OpenTUI's Solid transform; Tern rides Solid's reactive build (--conditions=browser).
    const atui = sourceRun("atui", repo);
    expect(atui.entry).toBe(path.join(repo, "src", "atui", "main.tsx"));
    expect(atui.bunArgs.join(" ")).toContain("preload");
    expect(atui.needs).toBe(path.join("@opentui", "solid"));
    const tern = sourceRun("tern", repo);
    expect(tern.entry).toBe(path.join(repo, "src", "tern", "main.ts"));
    expect(tern.bunArgs).toContain("--conditions=browser");
    expect(tern.needs).toBe(path.join("@stencil-hq", "tern"));
  });
});
