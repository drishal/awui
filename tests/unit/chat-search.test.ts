// Search every chat: the words found in prompts, answers, and tool targets,
// with snippets and their marks, from live chats and from the harness's own
// files after a chat closed; and the bounds that keep it quick.
import { afterEach, describe, expect, it } from "vitest";
import type { ChatItem, ChatSearch, ChatSnapshot, ProjectSession } from "../../src/shared/protocol.js";
import { asHarnessId } from "../../src/shared/protocol.js";
import { ChatSearcher, matchText, plainMarkdown, queryWords, searchEntries, sessionHits } from "../../src/server/chat-search.js";
import { makeTestApp, openSse, signedIn, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const items: ChatItem[] = [
  { kind: "user", id: "u1", text: "Fix the  flaky\nmigration test" },
  { kind: "assistant", id: "a1", text: "The migration runs twice; I made the test wait for it.", thinking: "", streaming: false },
  { kind: "tool", id: "t1", name: "bash", category: "command", summary: "npm test -- migrate.test.ts", paths: [], args: "", status: "done", output: "", truncated: false },
  { kind: "user", id: "u2", text: "/compact", command: true },
  { kind: "user", id: "u3", text: "now the docs" },
] as ChatItem[];

describe("chat search, the matching", () => {
  it("reads prompts, answers, and tool targets, numbering each by its prompt and skipping commands", () => {
    expect(searchEntries(items)).toEqual([
      { kind: "prompt", turn: 1, text: "Fix the flaky migration test" },
      { kind: "answer", turn: 1, text: "The migration runs twice; I made the test wait for it." },
      { kind: "tool", turn: 1, text: "npm test -- migrate.test.ts" },
      { kind: "prompt", turn: 2, text: "now the docs" },
    ]);
  });

  it("searches an answer as it reads, without its Markdown", () => {
    expect(plainMarkdown("## Plan\n> **Run** the `migrate` step, see [the docs](https://x.example) and ~~old~~ notes\n```ts\ncode()\n```")).toBe(
      "Plan\nRun the migrate step, see the docs and old notes\n\ncode()\n",
    );
  });

  it("needs every word in one place, and marks each in the snippet", () => {
    const words = queryWords("Migration TEST migration");
    expect(words).toEqual(["migration", "test"]);
    const m = matchText("Fix the flaky migration test", words);
    expect(m?.snippet).toBe("Fix the flaky migration test");
    expect(m?.ranges).toEqual([
      [14, 23],
      [24, 28],
    ]);
    expect(matchText("migration only", words)).toBeNull();
  });

  it("cuts a long text around the match at spaces, with ellipses", () => {
    const long = `${"lorem ipsum ".repeat(20)}needle here ${"dolor sit ".repeat(30)}`.trim();
    const m = matchText(long, ["needle"]);
    expect(m?.snippet.startsWith("…")).toBe(true);
    expect(m?.snippet.endsWith("…")).toBe(true);
    expect(m?.snippet).toContain("needle here");
    expect(m?.snippet.length).toBeLessThan(230);
    const [from, to] = m?.ranges[0] ?? [0, 0];
    expect(m?.snippet.slice(from, to)).toBe("needle");
  });

  it("puts a title hit first, and keeps the chat's order after it", () => {
    const hits = sessionHits("Migration fixes", searchEntries(items), ["migrat"]);
    expect(hits.map((h) => [h.kind, h.turn])).toEqual([
      ["title", null],
      ["prompt", 1],
      ["answer", 1],
      ["tool", 1],
    ]);
  });

  it("reads a session once per version, and stops at its time budget", async () => {
    const searcher = new ChatSearcher();
    let reads = 0;
    const session = (id: string, updatedAt: string): ProjectSession => ({ id, harnessId: asHarnessId("fake"), title: "t", updatedAt, workspaceId: "w" });
    const target = (s: ProjectSession) => ({ session: s, read: async () => (reads++, items) });
    await searcher.search("docs", [target(session("fake:1", "a"))], []);
    await searcher.search("docs", [target(session("fake:1", "a"))], []);
    expect(reads).toBe(1);
    await searcher.search("docs", [target(session("fake:1", "b"))], []);
    expect(reads).toBe(2);
    const slow = Array.from({ length: 20 }, (_, i) => ({ session: session(`fake:s${i}`, "a"), read: () => new Promise<ChatItem[]>((r) => setTimeout(() => r(items), 30)) }));
    const result = await searcher.search("docs", slow, [], 50);
    expect(result.truncated).toBe(true);
    expect(result.scanned).toBeLessThan(20);
    expect(result.total).toBe(20);
  });

  it("keeps every session of a long history between searches, and finishes a cut-short search in the background", async () => {
    const searcher = new ChatSearcher();
    let reads = 0;
    const session = (id: string): ProjectSession => ({ id, harnessId: asHarnessId("fake"), title: "t", updatedAt: "a", workspaceId: "w" });
    const many = Array.from({ length: 450 }, (_, i) => ({ session: session(`fake:m${i}`), read: async () => (reads++, items) }));
    await searcher.search("nomatch", many, []);
    await searcher.search("nomatch", many, []);
    // More sessions than the old cap of 400: still all read once.
    expect(reads).toBe(450);

    const slow = Array.from({ length: 12 }, (_, i) => ({ session: session(`fake:w${i}`), read: () => new Promise<ChatItem[]>((r) => setTimeout(() => r(items), 25)) }));
    const first = await searcher.search("nomatch", slow, [], 20);
    expect(first.truncated).toBe(true);
    await new Promise((r) => setTimeout(r, 600));
    const second = await searcher.search("nomatch", slow, [], 20);
    expect(second.truncated).toBe(false);
    expect(second.scanned).toBe(12);
  });
});

describe("chat search, the route", () => {
  it("finds words in live and closed chats, grouped by chat, with the project", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string; name: string };
    const run = async (text: string) => {
      const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
      const sse = openSse(t as TestApp, chat.chatId, agent.cookie);
      await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "snapshot"));
      await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text });
      await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "status" && e.status === "idle"));
      sse.close();
      return chat.chatId;
    };
    const first = await run("the pelican migration");
    await run("something else entirely");
    await agent.post(`/api/chats/${first}/dispose`);
    const found = (await agent.get("/api/sessions/search?q=pelican")).body as ChatSearch;
    expect(found.results).toHaveLength(1);
    const [hit] = found.results;
    expect(hit?.session.title).toContain("pelican");
    expect(hit?.hits.map((h) => h.kind)).toEqual(["title", "prompt", "answer"]);
    expect(found.workspaces.map((w) => w.name)).toEqual([ws.name]);
    expect(found.truncated).toBe(false);
    expect(((await agent.get("/api/sessions/search?q=pelican&harnessId=fake-b")).body as ChatSearch).results).toEqual([]);
    expect((await agent.get("/api/sessions/search?q=p")).status).toBe(400);
  });
});
