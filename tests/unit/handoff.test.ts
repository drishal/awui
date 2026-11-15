// toSeed: portable handoff seeds from normalized chat items.
import { describe, expect, it } from "vitest";
import type { ChatItem, ImageAttachment, ImageRef } from "../../src/shared/protocol.js";
import { BRIEF_MAX_CHARS, answerOf, briefPrompt, isEmptySeed, seedTranscript, toSeed, toolRecordText, toolsOf } from "../../src/server/harness/handoff.js";
import { historyToItems } from "../../src/server/harness/agent-events.js";
import { seedSessionText } from "../../src/server/harness/session-files.js";

const user = (text: string): ChatItem => ({ kind: "user", id: `u-${text}`, text });
const assistant = (text: string): ChatItem => ({ kind: "assistant", id: `a-${text}`, text, thinking: "", streaming: false });
const tool = (name: string): ChatItem => ({
  kind: "tool",
  id: `t-${name}`,
  name,
  args: "{}",
  status: "done",
  output: "out",
  truncated: false,
  category: "command",
  summary: name,
  paths: [],
});
const png = (id: string): ImageRef => ({ id, mimeType: "image/png" });
/** A stand-in image store: every id it is asked for resolves, except the ones listed as gone. */
const store =
  (gone: string[] = []) =>
  (ref: ImageRef): ImageAttachment | null =>
    gone.includes(ref.id) ? null : { mimeType: "image/png", data: Buffer.from(ref.id).toString("base64") };

describe("toSeed", () => {
  it("groups prompts, answers, and tools into turns", () => {
    const seed = toSeed([user("q"), tool("bash"), assistant("a")], { title: "t" });
    expect(seed.title).toBe("t");
    expect(seed.turns).toHaveLength(1);
    expect(seed.turns[0]?.prompt.text).toBe("q");
    expect(answerOf(seed.turns[0]!)).toMatchObject({ text: "a" });
    expect(toolsOf(seed.turns[0]!)).toHaveLength(1);
    expect(seed.summary).toBeNull();
  });

  it("keeps every message of a turn in order, not only the last", () => {
    const seed = toSeed([user("q"), assistant("looking first"), tool("bash"), assistant("now the fix"), tool("edit"), assistant("done")]);
    expect(seedTranscript(seed).map((e) => (e.role === "tool" ? `tool:${e.name}` : e.text))).toEqual(["q", "looking first", "tool:bash", "now the fix", "tool:edit", "done"]);
  });

  it("keeps a mid-run note in its turn and leaves out commands the harness answered itself", () => {
    const steer: ChatItem = { kind: "user", id: "s", text: "also check the logs", interjected: true };
    const command: ChatItem = { kind: "user", id: "c", text: "/compact", command: true };
    const seed = toSeed([user("q"), tool("bash"), steer, assistant("a"), command, assistant("Compacted."), user("q2"), assistant("a2")]);
    expect(seed.turns.map((t) => t.prompt.text)).toEqual(["q", "q2"]);
    expect(seedTranscript(seed).map((e) => `${e.role}:${e.role === "tool" ? e.name : e.text}`)).toEqual(["user:q", "tool:bash", "user:also check the logs", "assistant:a", "user:q2", "assistant:a2"]);
  });

  it("drops notices and requests, keeps preamble-free turns", () => {
    const seed = toSeed([
      { kind: "notice", id: "n", level: "info", text: "hi" },
      user("q"),
      assistant("a"),
    ]);
    expect(seed.turns).toHaveLength(1);
  });

  it("caps at first + recent turns with a summary of the middle", () => {
    const items: ChatItem[] = [];
    for (let i = 0; i < 15; i += 1) {
      items.push(user(`q${i}`), assistant(`a${i}`));
    }
    const seed = toSeed(items);
    expect(seed.turns).toHaveLength(11);
    expect(seed.turns[0]?.prompt.text).toBe("q0");
    expect(seed.turns[10]?.prompt.text).toBe("q14");
    expect(seed.summary).toContain("q1");
    expect(seed.summary).not.toContain("q14");
    // The summary of the dropped middle reads after the first turn, not before it.
    const order = seedTranscript(seed).map((e) => (e.role === "tool" ? "tool" : e.text));
    expect(order.slice(0, 4)).toEqual(["q0", "a0", seed.summary, "q5"]);
  });

  it("lays turns out as prompt, tool records, answer", () => {
    const seed = toSeed([user("q"), tool("bash"), assistant("a")]);
    expect(seedTranscript(seed).map((e) => e.role)).toEqual(["user", "tool", "assistant"]);
  });

  it("honors throughTurns; an empty seed is empty", () => {
    const seed = toSeed([user("q1"), assistant("a1"), user("q2"), assistant("a2")], { throughTurns: 1 });
    expect(seed.turns).toHaveLength(1);
    expect(isEmptySeed(seed)).toBe(false);
    expect(isEmptySeed(toSeed([]))).toBe(true);
  });

  it("carries a prompt's pictures, and notes only the ones the store no longer has", () => {
    const seed = toSeed([{ kind: "user", id: "u", text: "look", imageCount: 2, images: [png("a"), png("b")] }, assistant("seen")], { images: store(["b"]) });
    expect(seed.turns[0]?.prompt.images).toHaveLength(1);
    expect(seed.turns[0]?.prompt.text).toBe("look\n[1 image sent with this message could not be carried over]");
    const first = seedTranscript(seed)[0];
    expect(first?.role === "user" && first.images?.length).toBe(1);
    // A harness that never kept the bytes: the note says so, in words that cannot be read as the next message's.
    expect(toSeed([{ kind: "user", id: "u", text: "look", imageCount: 2 }]).turns[0]?.prompt.text).toBe("look\n[2 images sent with this message could not be carried over]");
  });

  it("carries the newest pictures first, at most one prompt's worth", () => {
    const items: ChatItem[] = [];
    for (let i = 0; i < 5; i += 1) items.push({ kind: "user", id: `u${i}`, text: `shot ${i}`, imageCount: 2, images: [png(`${i}a`), png(`${i}b`)] }, assistant(`a${i}`));
    const seed = toSeed(items, { images: store() });
    expect(seed.turns.map((t) => t.prompt.images.length)).toEqual([0, 2, 2, 2, 2]);
    expect(seed.turns[0]?.prompt.text).toBe("shot 0\n[2 images sent with this message could not be carried over]");
  });

  it("writes an edit's diff into its record", () => {
    const edit: ChatItem = {
      ...(tool("edit") as Extract<ChatItem, { kind: "tool" }>),
      output: "Updated src/a.ts",
      diff: { added: 1, removed: 1, lines: [{ kind: "hunk", text: "@@ -1 +1 @@" }, { kind: "del", text: "old()" }, { kind: "add", text: "new()" }] },
    };
    const record = toolsOf(toSeed([user("q"), edit, assistant("a")]).turns[0]!)[0]!;
    expect(record.diff).toBe("@@ -1 +1 @@\n-old()\n+new()");
    expect(toolRecordText(record)).toBe("[Handed off from another harness] edit: edit\nUpdated src/a.ts\n@@ -1 +1 @@\n-old()\n+new()");
  });

  it("writes the todo list at the end of the seed", () => {
    const seed = toSeed([user("q"), assistant("a")], { todos: [{ text: "write the test", status: "completed" }, { text: "ship", status: "pending" }] });
    const last = seedTranscript(seed).at(-1);
    expect(last).toMatchObject({ role: "assistant" });
    expect(last?.role === "assistant" && last.text).toContain("- [x] write the test\n- [ ] ship");
  });

  it("briefs as context, not requests, and ends on the draft or a short status", () => {
    const seed = toSeed([user("fix the build"), tool("bash"), assistant("fixed it")], { title: "t" });
    const waiting = briefPrompt(seed, { from: "Pi", project: "webui", draft: null }).text;
    expect(waiting.split("\n")[0]).toBe("This conversation is continuing here from Pi (project: webui).");
    expect(waiting).toContain("none of it should be run again");
    expect(waiting).toContain("<transcript>\nUser: fix the build\n  · bash bash\n    out\nPi: fixed it\n</transcript>");
    expect(waiting.endsWith("without running anything, reply in two or three lines with where things stand, and wait for the next request.")).toBe(true);
    expect(briefPrompt(seed, { from: "Pi", project: "webui", draft: "now ship it" }).text.endsWith("continue with this request:\n\nnow ship it")).toBe(true);
  });

  it("briefs every message of a turn, the todo list, and attaches the pictures it names", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "u1", text: "why is it stuck", imageCount: 1, images: [png("x")] },
      assistant("checking processes"),
      tool("bash"),
      assistant("it is waiting on a lock"),
    ];
    const brief = briefPrompt(toSeed(items, { images: store(), todos: [{ text: "free the lock", status: "in_progress" }] }), { from: "Claude Code", project: "dotfiles", draft: null });
    expect(brief.images).toHaveLength(1);
    expect(brief.text).toContain("User: why is it stuck\n[1 image sent with this message: attached to this briefing as image 1]\nClaude Code: checking processes\n  · bash bash\n    out\nClaude Code: it is waiting on a lock");
    expect(brief.text).toContain("- [~] free the lock");
  });

  it("cuts tool output, then folds the oldest turns, to stay inside the budget", () => {
    const big = (id: string): ChatItem => ({ ...(tool("bash") as Extract<ChatItem, { kind: "tool" }>), id, output: "x".repeat(5000) });
    const small = briefPrompt(toSeed([user("q"), big("t1"), assistant("a")]), { from: "omp", project: "p", draft: null }).text;
    expect(small).toContain("[… 3000 more characters]");
    const items: ChatItem[] = [];
    for (let i = 0; i < 12; i += 1) items.push(user(`question ${i} ${"q".repeat(3000)}`), big(`t${i}`), assistant(`answer ${i} ${"a".repeat(3000)}`));
    const brief = briefPrompt(toSeed(items), { from: "omp", project: "p", draft: "go on" }).text;
    expect(brief.length).toBeLessThanOrEqual(BRIEF_MAX_CHARS);
    // The first turn stays verbatim, the newest too; tool output went first; older turns became one-liners.
    expect(brief).toContain(`User: question 0 ${"q".repeat(3000)}`);
    expect(brief).toContain(`User: question 11 ${"q".repeat(3000)}`);
    expect(brief).not.toContain("xxxxxxxxxx");
    expect(brief).toContain("[Earlier turns, one line each]");
    expect(brief.endsWith("continue with this request:\n\ngo on")).toBe(true);
  });
});

describe("a seeded session read back", () => {
  const seededItems = (items: ChatItem[]) => {
    const text = seedSessionText({ id: "s", cwd: "/p", now: new Date(0), entries: seedTranscript(toSeed(items, { images: store() })) });
    const messages = text
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => JSON.parse(l).message);
    return { messages, items: historyToItems(messages) };
  };

  it("draws tool records as tool rows and keeps the prompt's picture", () => {
    const { messages, items } = seededItems([{ kind: "user", id: "u", text: "look", imageCount: 1, images: [png("p")] }, tool("bash"), assistant("a")]);
    expect(messages[0].content.map((c: { type: string }) => c.type)).toEqual(["image", "text"]);
    expect(items.map((i) => i.kind)).toEqual(["user", "tool", "assistant"]);
    expect(items[0]).toMatchObject({ imageCount: 1 });
    expect(items[1]).toMatchObject({ kind: "tool", name: "bash", summary: "bash", output: "out", status: "done", category: "command" });
  });

  it("hands off again without losing the earlier calls", () => {
    const first = seededItems([user("q"), tool("read"), tool("bash"), assistant("a")]).items;
    const again = toSeed(first);
    expect(toolsOf(again.turns[0]!).map((t) => t.name)).toEqual(["read", "bash"]);
    expect(answerOf(again.turns[0]!)?.text).toBe("a");
  });
});
