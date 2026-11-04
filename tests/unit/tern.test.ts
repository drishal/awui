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
import { conversation, foldHead, toolNode, type ConversationCx } from "../../src/tern/view.js";
import { parseTernArgs } from "../../src/tern/args.js";
import { ternEntry } from "../../src/server/tern-client.js";
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
    expect(node.props).toMatchObject({ name: "bash", title: "Bash", target: "npm test", targetKind: "command", status: "done", took: 2500, collapsible: true, collapsed: true, frame: "inline" });
    expect(node.children[0]?.kind).toBe("ansi");
    // The web UI's row carries no "1 line" count.
    expect(node.props.meta).toBeUndefined();
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
    expect(node.props).toMatchObject({ title: "Edit", target: "src/a.ts", targetKind: "path", meta: ["+1", "−1"], collapsed: true });
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
    const cx: ConversationCx = { chat, harness: null, webUrl: "http://x", age: () => undefined, shown: 30, folds: new Map(), picked: null, blob: () => null, on: { fold: noop, pick: noop, showEarlier: noop, retry: noop, edit: noop, fork: noop, undo: noop, copy: noop } };
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
    const cx: ConversationCx = { chat, harness: null, webUrl: "http://x", age: () => undefined, shown: 30, folds: new Map([["u1#0", true]]), picked: null, blob: () => null, on: { fold: noop, pick: noop, showEarlier: noop, retry: noop, edit: noop, fork: noop, undo: noop, copy: noop } };
    const all = (n: Node): Node[] => [n, ...n.children.flatMap(all)];
    const thought = conversation(cx).flatMap((n) => all(n as Node)).find((n) => n.kind === "tool" && n.props.name === "thinking");
    expect(thought?.props).toMatchObject({ title: "Thought", target: "Considering the config first", frame: "inline", collapsed: true });
  });

  it("words a fold the web UI's way", () => {
    const turn = { live: false, startedAt: 0, endedAt: 27_000 } as Turn;
    const seg = { counts: { command: 3 } } as unknown as WorkSegment;
    expect(foldHead(turn, seg, "only")).toBe("Worked for 27s · 3 commands");
    expect(foldHead(turn, seg, "last")).toBe("3 commands");
    expect(foldHead({ ...turn, live: true }, seg, "only")).toBe("Working · 3 commands");
  });
});

describe("awui tern's command line", () => {
  it("takes atui's options", () => {
    expect(parseTernArgs(["--url", "http://h:1/", "--harness", "pi", "--resume"], {})).toMatchObject({ url: "http://h:1", harness: "pi", resume: true });
    expect(parseTernArgs(["--vim"], {})).toEqual({ error: "Unknown option --vim" });
    expect(parseTernArgs(["-h"], {})).toEqual({ help: true });
  });

  it("finds the client in the checkout, else where `awui install tui` put it", () => {
    expect(ternEntry("/nowhere", false)).toMatch(/src\/tern\/main\.ts$/);
    const state = mkdtempSync(path.join(tmpdir(), "awui-tern-"));
    // A binary somewhere with no checkout above it, before and after install tui.
    expect(ternEntry(state, true, "/usr/bin/env")).toBeNull();
    mkdirSync(path.join(state, "atui", "src", "tern"), { recursive: true });
    writeFileSync(path.join(state, "atui", "src", "tern", "main.ts"), "");
    expect(ternEntry(state, true, "/usr/bin/env")).toBe(path.join(state, "atui", "src", "tern", "main.ts"));
    // A binary built into a checkout's dist/bin (install service --link) runs the checkout's client:
    // a checkout of its own, since this one has a built binary only after `npm run build:binary`.
    const repo = mkdtempSync(path.join(tmpdir(), "awui-checkout-"));
    mkdirSync(path.join(repo, "src", "tern"), { recursive: true });
    mkdirSync(path.join(repo, "dist", "bin", "linux-x64"), { recursive: true });
    writeFileSync(path.join(repo, "package.json"), "{}");
    writeFileSync(path.join(repo, "src", "tern", "main.ts"), "");
    writeFileSync(path.join(repo, "dist", "bin", "linux-x64", "awui"), "");
    expect(ternEntry(state, true, path.join(repo, "dist", "bin", "linux-x64", "awui"))).toBe(path.join(repo, "src", "tern", "main.ts"));
  });
});
