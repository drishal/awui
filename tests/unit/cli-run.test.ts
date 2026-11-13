// The headless CLI (src/server/cli-run.ts): how it reads a command line, how
// it reads a chat, and the real thing against a server that is running — found
// through the state folder's server.json, the way the desktop shell finds it.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WAIT_SECONDS,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_TIMEOUT,
  EXIT_USAGE,
  isHealth,
  liveChats,
  outcomeOf,
  parseCommand,
  runHeadlessCli,
  type CliIo,
} from "../../src/server/cli-run.js";
import { asHarnessId, type AssistantItem, type ChatItem, type SessionsOverview, type UserItem } from "../../src/shared/protocol.js";
import { makeTestApp, tempDir } from "../helpers/app.js";

const user = (text: string): UserItem => ({ kind: "user", id: `u-${text}`, text, at: 1 });
const assistant = (text: string): AssistantItem => ({ kind: "assistant", id: `a-${text}`, text, thinking: "", streaming: false });
const notice = (text: string, level: "info" | "error"): ChatItem => ({ kind: "notice", id: `n-${text}`, level, text });

/** Where the CLI reads and writes, as the process's streams would be, minus the process's. */
function collector(env: NodeJS.ProcessEnv) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { AWUI_CONFIG_DIR: "", ...env }, out: (line) => out.push(line), err: (line) => err.push(line) };
  return { io, out, err };
}

describe("the headless CLI's command line", () => {
  it("reads run's options and its prompt", () => {
    expect(parseCommand(["run", "--harness", "omp", "--project", "/p", "--model", "pi/gpt-5", "--wait", "--json", "fix the bug"])).toEqual({
      kind: "run",
      prompt: "fix the bug",
      harness: "omp",
      project: "/p",
      model: "pi/gpt-5",
      wait: true,
      json: true,
    });
    // An unquoted prompt is one prompt, and the defaults are honest about what was not given.
    expect(parseCommand(["run", "add", "a", "test"])).toEqual({ kind: "run", prompt: "add a test", harness: null, project: null, model: null, wait: false, json: false });
  });

  it("reads send, wait, chats, and help", () => {
    expect(parseCommand(["send", "abc", "carry", "on"])).toEqual({ kind: "send", chatId: "abc", prompt: "carry on" });
    expect(parseCommand(["wait", "abc"])).toEqual({ kind: "wait", chatId: "abc", timeoutSeconds: DEFAULT_WAIT_SECONDS });
    expect(parseCommand(["wait", "--timeout", "5", "abc"])).toEqual({ kind: "wait", chatId: "abc", timeoutSeconds: 5 });
    expect(parseCommand(["chats"])).toEqual({ kind: "chats", json: false });
    expect(parseCommand(["chats", "--json"])).toEqual({ kind: "chats", json: true });
    expect(parseCommand(["run", "--help"])).toEqual({ kind: "help" });
  });

  it("refuses a command line it cannot use", () => {
    for (const args of [[], ["run"], ["run", "--harness"], ["run", "--nope", "hi"], ["send", "abc"], ["send", "--json", "abc", "hi"], ["wait"], ["wait", "--timeout", "soon", "abc"], ["wait", "abc", "def"], ["chats", "--wait"], ["hello"]]) {
      expect(parseCommand(args), JSON.stringify(args)).toHaveProperty("error");
    }
  });
});

describe("how the CLI reads a chat", () => {
  it("takes the last reply as the answer, once the run settles", () => {
    const settled = outcomeOf({ status: "idle", items: [user("hi"), assistant("Let me look at the file"), assistant("Added the test.")] });
    expect(settled).toEqual({ settled: true, ok: true, answer: "Added the test.", error: null });
    // A run still going has no answer to print yet.
    expect(outcomeOf({ status: "running", items: [user("hi"), assistant("Working")] }).settled).toBe(false);
    expect(outcomeOf({ status: "starting", items: [] })).toEqual({ settled: false, ok: false, answer: "", error: null });
    // Text with no word in it (a stray dot between tool calls) is not a reply.
    expect(outcomeOf({ status: "idle", items: [user("hi"), assistant("…"), assistant("  ")] }).answer).toBe("");
  });

  it("reports only this turn's error, and a failed status", () => {
    const failed = outcomeOf({ status: "error", items: [user("hi"), assistant(""), notice("Prompt rejected: nope", "error")] });
    expect(failed).toEqual({ settled: true, ok: false, answer: "", error: "Prompt rejected: nope" });
    // An error from a turn before this prompt belongs to that turn, not this run.
    // A model-side failure: the harness's error turn settles, so the chat is idle and the error rides on the reply.
    const errored: AssistantItem = { ...assistant(""), error: "Fake failure" };
    expect(outcomeOf({ status: "idle", items: [user("hi"), errored] })).toEqual({ settled: true, ok: false, answer: "", error: "Fake failure" });
    const again = outcomeOf({ status: "idle", items: [user("first"), notice("Fake failure", "error"), user("second"), assistant("Done.")] });
    expect(again).toEqual({ settled: true, ok: true, answer: "Done.", error: null });
    expect(outcomeOf({ status: "disposed", items: [] }).ok).toBe(false);
  });

  it("accepts only awui's own health answer", () => {
    expect(isHealth('{"ok":true,"build":"2c0210d6a6"}')).toBe(true);
    // A server without a built UI has a null build; it is still awui.
    expect(isHealth('{"ok":true,"build":null}')).toBe(true);
    expect(isHealth('{"ok":true}')).toBe(false);
    expect(isHealth('{"status":"ok"}')).toBe(false);
    expect(isHealth("null")).toBe(false);
    expect(isHealth("<html>hello</html>")).toBe(false);
  });

  it("lists only the sessions a server holds a live chat for", () => {
    const overview: SessionsOverview = {
      workspaces: [{ id: "w1", path: "/proj/one", name: "one" }],
      sessions: [
        { id: "fake:1", harnessId: asHarnessId("fake"), title: "open", updatedAt: null, workspaceId: "w1", liveChatId: "chat-1", status: "running" },
        { id: "fake:2", harnessId: asHarnessId("fake"), title: "listed only", updatedAt: null, workspaceId: "w1" },
        { id: "fake:3", harnessId: asHarnessId("fake"), title: "open elsewhere", updatedAt: null, workspaceId: "gone", liveChatId: "chat-3", status: "idle" },
      ],
      errors: [],
    };
    expect(liveChats(overview)).toEqual([
      { chatId: "chat-1", status: "running", harnessId: "fake", title: "open", project: "/proj/one" },
      { chatId: "chat-3", status: "idle", harnessId: "fake", title: "open elsewhere", project: "" },
    ]);
  });
});

describe("the headless CLI against a running server", () => {
  it("finds the server through the state folder and lists its chats", async () => {
    const t = await makeTestApp();
    try {
      // No AWUI_URL: the port comes from the state folder's server.json, as the desktop shell reads it.
      const stateDir = tempDir();
      writeFileSync(path.join(stateDir, "server.json"), JSON.stringify({ port: t.port, host: "127.0.0.1", pid: process.pid }));
      const quiet = collector({ AWUI_STATE_DIR: stateDir });
      expect(await runHeadlessCli(["chats", "--json"], quiet.io)).toBe(EXIT_OK);
      expect(quiet.out).toEqual(["[]"]);
      // With no chat open, the text form says how to start one instead of printing nothing.
      expect(await runHeadlessCli(["chats"], quiet.io)).toBe(EXIT_OK);
      expect(quiet.err).toEqual(["awui: no chats are open on that server (`awui run` starts one)"]);
    } finally {
      await t.close();
    }
  });

  it("runs a prompt, prints the answer, and takes another through send and wait", async () => {
    const t = await makeTestApp();
    try {
      const c = collector({ AWUI_URL: `http://127.0.0.1:${t.port}` });
      const code = await runHeadlessCli(["run", "--project", t.project, "--harness", "fake", "--wait", "hello there"], c.io);
      expect(code).toBe(EXIT_OK);
      // The fake answers in Markdown, so the answer is the whole reply, blank line and list included.
      expect(c.out).toHaveLength(1);
      expect(c.out[0]?.startsWith("Echo: hello there\n")).toBe(true);
      // The chat's id goes to stderr, so stdout is the answer alone.
      const chatId = /^awui: chat (\S+)$/.exec(c.err[0] ?? "")?.[1];
      expect(chatId).toBeTypeOf("string");

      const list = collector({ AWUI_URL: `http://127.0.0.1:${t.port}` });
      expect(await runHeadlessCli(["chats"], list.io)).toBe(EXIT_OK);
      expect(list.out[0]?.split("\t")).toEqual([chatId, "idle", "fake", list.out[0]?.split("\t")[3]]);

      const next = collector({ AWUI_URL: `http://127.0.0.1:${t.port}` });
      expect(await runHeadlessCli(["send", chatId as string, "again"], next.io)).toBe(EXIT_OK);
      expect(next.out).toEqual([]);
      expect(await runHeadlessCli(["wait", chatId as string], next.io)).toBe(EXIT_OK);
      expect(next.out[0]?.startsWith("Echo: again\n")).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("prints one JSON object, and fails the exit code when the run does", async () => {
    const t = await makeTestApp();
    try {
      const c = collector({ AWUI_URL: `http://127.0.0.1:${t.port}` });
      expect(await runHeadlessCli(["run", "--project", t.project, "--harness", "fake", "--wait", "--json", "fail please"], c.io)).toBe(EXIT_FAILED);
      const object = JSON.parse(c.out[0] ?? "null") as { chatId?: unknown; status?: unknown; answer?: unknown; error?: unknown };
      expect(object.chatId).toBeTypeOf("string");
      // A model-side failure settles the chat idle; the error is the reply's own, and the exit code says so.
      expect(object.status).toBe("idle");
      expect(object.answer).toBe("");
      expect(object.error).toBe("Fake failure");
    } finally {
      await t.close();
    }
  });

  it("times out without stopping the run, and reports usage errors as usage errors", async () => {
    const t = await makeTestApp({ chunkDelayMs: 25 });
    try {
      const c = collector({ AWUI_URL: `http://127.0.0.1:${t.port}` });
      expect(await runHeadlessCli(["run", "--project", t.project, "--harness", "fake", "slow one"], c.io)).toBe(EXIT_OK);
      const chatId = c.out[0] as string;
      expect(await runHeadlessCli(["wait", chatId, "--timeout", "0.2"], c.io)).toBe(EXIT_TIMEOUT);
      expect(c.err.at(-1)).toContain("is still running there");

      const bad = collector({ AWUI_URL: `http://127.0.0.1:${t.port}` });
      expect(await runHeadlessCli(["run", "--nope"], bad.io)).toBe(EXIT_USAGE);
      expect(bad.out).toEqual([]);
      expect(bad.err[0]).toContain("unknown option --nope");
    } finally {
      await t.close();
    }
  });

  it("inspects a chat's state and prints its transcript through logs", async () => {
    const t = await makeTestApp();
    try {
      const c = collector({ AWUI_URL: `http://127.0.0.1:${t.port}` });
      expect(await runHeadlessCli(["run", "--project", t.project, "--harness", "fake", "--wait", "hello logs"], c.io)).toBe(EXIT_OK);
      const chatId = /^awui: chat (\S+)$/.exec(c.err[0] ?? "")?.[1] as string;

      const seen = collector({ AWUI_URL: `http://127.0.0.1:${t.port}` });
      expect(await runHeadlessCli(["inspect", chatId, "--json"], seen.io)).toBe(EXIT_OK);
      const object = JSON.parse(seen.out[0] ?? "null") as { chatId?: unknown; status?: unknown; items?: unknown; answer?: unknown };
      expect(object.chatId).toBe(chatId);
      expect(object.status).toBe("idle");
      expect(object.items).toBeGreaterThanOrEqual(2);
      expect(String(object.answer)).toContain("Echo: hello logs");

      // The text form: one tab row, then a counts row, then the answer.
      const text = collector({ AWUI_URL: `http://127.0.0.1:${t.port}` });
      expect(await runHeadlessCli(["inspect", chatId], text.io)).toBe(EXIT_OK);
      expect(text.out[0]?.split("\t").slice(0, 2)).toEqual([chatId, "idle"]);

      const logs = collector({ AWUI_URL: `http://127.0.0.1:${t.port}` });
      expect(await runHeadlessCli(["logs", chatId], logs.io)).toBe(EXIT_OK);
      expect(logs.out[0]).toContain("user\thello logs");
      expect(logs.out.at(-1)).toContain("Echo: hello logs");
      // --tail cuts from the head, so one line means the last item (the answer).
      const tail = collector({ AWUI_URL: `http://127.0.0.1:${t.port}` });
      expect(await runHeadlessCli(["logs", chatId, "--tail", "1"], tail.io)).toBe(EXIT_OK);
      expect(tail.out).toHaveLength(1);
      expect(tail.out[0]).toContain("assistant\tEcho: hello logs");
    } finally {
      await t.close();
    }
  });

  it("attaches a listed session as a live chat and refuses an unknown one", async () => {
    const t = await makeTestApp();
    try {
      // A closed chat leaves its native session in the sidebar's list: attach resumes it.
      const c = collector({ AWUI_URL: `http://127.0.0.1:${t.port}` });
      expect(await runHeadlessCli(["run", "--project", t.project, "--harness", "fake", "--wait", "for attach"], c.io)).toBe(EXIT_OK);
      const chatId = /^awui: chat (\S+)$/.exec(c.err[0] ?? "")?.[1] as string;
      // Closing it parks the session; the snapshot route still names the session id.
      const snapshot = JSON.parse((await (await fetch(`http://127.0.0.1:${t.port}/api/chats/${chatId}`)).text())) as { sessionId?: string };
      const sessionId = snapshot.sessionId as string;
      expect(sessionId.startsWith("fake:")).toBe(true);

      const unknown = collector({ AWUI_URL: `http://127.0.0.1:${t.port}` });
      expect(await runHeadlessCli(["attach", "fake:no-such-session", "--harness", "fake"], unknown.io)).toBe(EXIT_FAILED);
      expect(unknown.err[0]).toContain("no session fake:no-such-session");

      const back = collector({ AWUI_URL: `http://127.0.0.1:${t.port}` });
      expect(await runHeadlessCli(["attach", sessionId, "--harness", "fake", "--json"], back.io)).toBe(EXIT_OK);
      const attached = JSON.parse(back.out[0] ?? "null") as { chatId?: unknown; status?: unknown };
      expect(attached.chatId).toBeTypeOf("string");
      expect(attached.status).toBe("idle");
    } finally {
      await t.close();
    }
  });
});
