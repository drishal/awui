import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Chat } from "../../src/server/chats/chat.js";
import { HermesAdapter, hermesModelKey, liveHermesLinks, splitReasoningBlock } from "../../src/server/harness/hermes.js";
import type { HarnessEvent, LiveChat } from "../../src/server/harness/types.js";
import type { WorkspaceInfo } from "../../src/shared/protocol.js";
import { tempDir } from "../helpers/app.js";

const script = path.join(import.meta.dirname, "..", "fixtures", "fake-hermes.mjs");
chmodSync(script, 0o755);

let home: string;
let project: string;
let state: string;
let adapter: HermesAdapter;
const open: LiveChat[] = [];

beforeEach(() => {
  home = tempDir("awui-hermes-home-");
  project = path.join(home, "proj");
  mkdirSync(project);
  state = path.join(home, "state.json");
  writeFileSync(
    state,
    JSON.stringify({
      spawns: [],
      rows: [{ id: "20261002_120000_fake1", title: "Fake Hermes session", cwd: project, last_active: 1790921090, message_count: 3 }],
    }),
  );
  process.env.FAKE_HERMES_STATE = state;
  adapter = new HermesAdapter({ command: process.execPath, args: [script] });
});

afterEach(async () => {
  for (const chat of open.splice(0)) await chat.dispose();
  await adapter.shutdown();
  expect(liveHermesLinks()).toBe(0);
});

async function openChat(resumeNativeId?: string) {
  const live = await adapter.openChat({ cwd: project, ...(resumeNativeId ? { resumeNativeId } : {}) });
  open.push(live);
  const ws: WorkspaceInfo = { id: "w", path: project, name: "proj" };
  return { live, chat: await Chat.open("c1", adapter, ws, live) };
}

async function until(predicate: () => boolean, ms = 8000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("hermes adapter (scripted gateway)", () => {
  it("creates a session and streams a turn with thinking and usage", async () => {
    const { chat, live } = await openChat();
    expect(live.nativeId).toBe("20261002_120000_fake1");
    await chat.send("hello there", "normal");
    await until(() => chat.status === "idle");
    const snap = chat.snapshot();
    const assistant = snap.items.find((i) => i.kind === "assistant");
    expect(assistant).toMatchObject({ text: "hermes says hello there", thinking: "hmm ", streaming: false });
    expect(snap.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    const usage = await live.getUsage();
    expect(usage).toMatchObject({ turns: 1, input: 900, output: 12, cachedInput: 300 });
    expect(chat.snapshot().config).toMatchObject({ model: "fake/fake-model", thinkingLevel: "medium" });
  });

  it("replaces a past prompt in place, cutting the session at that message's row", async () => {
    const { chat, live } = await openChat();
    for (const text of ["one", "two", "three"]) {
      await chat.send(text, "normal");
      await until(() => chat.status === "idle");
    }
    await chat.rewind(2, "two, reworded");
    await until(() => chat.status === "idle");
    const users = (items: Awaited<ReturnType<typeof live.history>>) => items.flatMap((i) => (i.kind === "user" ? [i.text] : []));
    expect(users(chat.snapshot().items)).toEqual(["one", "two, reworded"]);
    // The gateway's own transcript was cut the same way.
    expect(users(await live.history())).toEqual(["one", "two, reworded"]);
    // The first message needs the extra consent the gateway asks for; the adapter gives it.
    await chat.rewind(1, "from the top");
    await until(() => chat.status === "idle");
    expect(users(await live.history())).toEqual(["from the top"]);
  });

  it("sums per-turn usage into lifetime totals across turns", async () => {
    const { chat, live } = await openChat();
    await chat.send("first", "normal");
    await until(() => chat.status === "idle");
    await chat.send("second", "normal");
    await until(() => chat.status === "idle" && chat.snapshot().items.filter((i) => i.kind === "user").length === 2);
    // Two turns at input 900 / cache_read 300 each: lifetime totals, not last snapshot.
    expect(await live.getUsage()).toMatchObject({ turns: 2, input: 1800, output: 24, cachedInput: 600 });
  });

  it("streams tool rows from tool.start and tool.complete", async () => {
    const { chat } = await openChat();
    await chat.send("run tool please", "normal");
    await until(() => chat.status === "idle");
    const tool = chat.snapshot().items.find((i) => i.kind === "tool");
    expect(tool).toMatchObject({ name: "read", status: "done", category: "read", summary: "README.md" });
    expect(tool && tool.kind === "tool" && tool.output).toContain("file.txt");
  });

  it("reads stored tool rows back as tool output, not the row's JSON", async () => {
    const { chat, live } = await openChat();
    await chat.send("run tool please", "normal");
    await until(() => chat.status === "idle");
    const stored = (await live.history()).find((i) => i.kind === "tool");
    expect(stored).toMatchObject({ name: "read", output: "file.txt", summary: "README.md", status: "done" });
  });

  it("raises approvals from server requests and answers them", async () => {
    const { chat } = await openChat();
    await chat.send("ask to delete", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    const request = chat.snapshot().pending[0];
    expect(request).toMatchObject({ kind: "select", options: ["once", "session", "always", "deny"] });
    expect(request?.message).toContain("rm -rf /tmp/x");
    expect(chat.answer(request?.id as string, { kind: "select", value: "once" })).toContain("once");
    await until(() => chat.status === "idle");
    expect(chat.snapshot().pending).toEqual([]);
  });

  it("interrupts a running turn", async () => {
    const { chat } = await openChat();
    await chat.send("slow please", "normal");
    await until(() => chat.status === "running");
    await chat.abort();
    expect(chat.status).toBe("idle");
    const assistant = chat.snapshot().items.find((i) => i.kind === "assistant");
    expect(assistant && assistant.kind === "assistant" && assistant.text.length).toBeLessThan("hermes says slow please".length);
  });

  it("asks a chat's own gateway for its models instead of starting a probe", async () => {
    const { chat } = await openChat();
    const before = JSON.parse(readFileSync(state, "utf8")).spawns.length;
    expect(chat.snapshot().config.models.map((m) => m.key)).toEqual(["fake/fake-model", "fake/fake-mini"]);
    await chat.refreshModels();
    expect(JSON.parse(readFileSync(state, "utf8")).spawns.length).toBe(before);
    expect(before).toBe(1);
  });

  it("lists models with model.options", async () => {
    const models = await adapter.listModels(project);
    expect(models.map((m) => m.key)).toEqual(["fake/fake-model", "fake/fake-mini"]);
    expect(models[0]).toMatchObject({ reasoning: true });
  });

  it("names Hermes's virtual MoA provider and the presets it offers", async () => {
    const stored = JSON.parse(readFileSync(state, "utf8"));
    stored.moa = true;
    writeFileSync(state, JSON.stringify(stored));
    const models = await adapter.listModels(project, true);
    expect(models.find((m) => m.key === "moa/default")).toMatchObject({
      provider: "moa",
      providerName: "Mixture of Agents",
      id: "default",
      name: "default",
      reasoning: true,
    });
  });

  it("handles a multi-provider gateway: qualified model key matches the catalog without double prefixing", async () => {
    const { chat } = await openChat();
    await chat.send("multimodel check", "normal");
    await until(() => chat.status === "idle");
    const config = chat.snapshot().config;
    // model arrived as local/opencode-go-v4-flash with provider=custom; no custom/… doubling
    expect(config.model).toBe("local/opencode-go-v4-flash");
    await chat.refreshModels();
    const refreshed = chat.snapshot().config;
    const keys = refreshed.models.map((m) => m.key);
    expect(keys).toContain("local/opencode-go-v4-flash");
    expect(keys).toEqual([...new Set(keys)]); // same model id listed under two slugs stays separate; no duplicate keys
    expect(refreshed.models.find((m) => m.key === refreshed.model)).toBeDefined();
  });

  it("serves expired session rows at once and refreshes them behind the list", async () => {
    expect((await adapter.listSessions(project)).map((s) => s.title)).toEqual(["Fake Hermes session"]);
    const stored = JSON.parse(readFileSync(state, "utf8"));
    stored.rows.push({ id: "20261002_130000_fake2", title: "Newer session", cwd: project, last_active: 1790924690, message_count: 1 });
    writeFileSync(state, JSON.stringify(stored));
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      const t0 = realNow();
      // Expired: the old rows come back without waiting for a probe gateway…
      expect((await adapter.listSessions(project)).map((s) => s.title)).toEqual(["Fake Hermes session"]);
      expect(realNow() - t0).toBeLessThan(50);
      // …and the refresh it started lands for the next listing.
      await until(() => JSON.parse(readFileSync(state, "utf8")).spawns.length >= 2);
      await new Promise((r) => setTimeout(r, 300));
      expect((await adapter.listSessions(project)).map((s) => s.title)).toEqual(["Newer session", "Fake Hermes session"]);
    } finally {
      Date.now = realNow;
    }
  });

  it("lists stored sessions for the workspace and recent ones across projects", async () => {
    const sessions = await adapter.listSessions(project);
    expect(sessions.map((s) => s.nativeId)).toEqual(["20261002_120000_fake1"]);
    expect(sessions[0]).toMatchObject({ title: "Fake Hermes session", messageCount: 3 });
    const recent = await adapter.listRecentSessions(10);
    expect(recent.map((s) => s.cwd)).toEqual([project]);
  });

  it("resumes a stored session and changes model and reasoning", async () => {
    const { chat, live } = await openChat("20261002_120000_fake1");
    expect(live.nativeId).toBe("20261002_120000_fake1");
    await chat.setConfig({ model: "fake/fake-mini", thinkingLevel: "high" });
    const config = await live.getConfig();
    expect(config).toMatchObject({ model: "fake/fake-mini", thinkingLevel: "high" });
  });

  it("offers ultra, and says when the route sends a lower level for it", async () => {
    const { chat, live } = await openChat("20261002_120000_fake1");
    expect((await live.getConfig()).thinkingLevels.at(-1)).toBe("ultra");
    await chat.setConfig({ thinkingLevel: "ultra" });
    await until(() => chat.snapshot().config.thinkingLevel === "ultra");
    expect(chat.snapshot().config.thinkingSent).toBe("max");
    expect(await live.getConfig()).toMatchObject({ thinkingLevel: "ultra", thinkingSent: "max" });
    await chat.setConfig({ thinkingLevel: "high" });
    await until(() => chat.snapshot().config.thinkingLevel === "high");
    expect(chat.snapshot().config.thinkingSent).toBeNull();
  });

  it("switches to a model on another provider with --provider, as Hermes's picker does", async () => {
    const { chat } = await openChat();
    await chat.send("multimodel check", "normal");
    await until(() => chat.status === "idle");
    // Both providers list this id; the pick names the remote one.
    await chat.setConfig({ model: "remote/opencode-go-v4-flash" });
    await until(() => chat.snapshot().config.model === "remote/opencode-go-v4-flash");
    // The key alone reads the same either way (a qualified name passes through); the request is what moved.
    await chat.send("whoami", "normal");
    await until(() => chat.status === "idle");
    const answer = chat.snapshot().items.findLast((i) => i.kind === "assistant");
    expect(answer && "text" in answer ? answer.text : "").toBe("on remote as opencode-go-v4-flash");
  });

  it("keeps naming the picked model when a proxied provider reports back its proxy", async () => {
    const { chat } = await openChat();
    await chat.send("proxied setup", "normal");
    await until(() => chat.status === "idle");
    // The catalog holds opencode-go/deepseek-v4.1-flash; after the pick the gateway's session info
    // says "litellm/deepseek-v4.1-flash". The chip and the picker keep naming what was picked.
    await chat.setConfig({ model: "opencode-go/deepseek-v4.1-flash" });
    await until(() => chat.snapshot().config.model === "opencode-go/deepseek-v4.1-flash");
    await chat.send("whoami", "normal");
    await until(() => chat.status === "idle");
    expect(chat.snapshot().config.model).toBe("opencode-go/deepseek-v4.1-flash");
  });

  it("names the picked model by the provider Hermes reports, never a catalog entry the requests do not reach", () => {
    const models = [
      { key: "opencode-go/deepseek-v4.1-flash", provider: "opencode-go", id: "deepseek-v4.1-flash", name: "deepseek-v4.1-flash" },
      { key: "custom:local//models/bonsai.gguf", provider: "custom:local", id: "/models/bonsai.gguf", name: "bonsai" },
      { key: "local/glm-local", provider: "local", id: "glm-local", name: "glm-local" },
    ];
    const mine = new Set(["custom:local", "local"]);
    expect(hermesModelKey("deepseek-v4.1-flash", "opencode-go", models, mine)).toBe("opencode-go/deepseek-v4.1-flash");
    // A local endpoint reports provider "custom"; its row is one of the user's own.
    expect(hermesModelKey("/models/bonsai.gguf", "custom", models, mine)).toBe("custom:local//models/bonsai.gguf");
    expect(hermesModelKey("local/glm-local", "custom", models, mine)).toBe("local/glm-local");
    // A bare switch's leftover: DeepSeek's name, sent to the local endpoint. Not DeepSeek.
    expect(hermesModelKey("opencode-go/deepseek-v4.1-flash", "custom", models, mine)).toBe("custom/opencode-go/deepseek-v4.1-flash");
    // No catalog yet: the name as reported.
    expect(hermesModelKey("deepseek-v4.1-flash", "opencode-go", [], new Set())).toBe("opencode-go/deepseek-v4.1-flash");
  });

  it("reports a turn failure as an error on the assistant item", async () => {
    const { chat } = await openChat();
    await chat.send("fail now", "normal");
    await until(() => chat.status === "idle");
    const assistant = chat.snapshot().items.find((i) => i.kind === "assistant");
    expect(assistant).toMatchObject({ error: "fake failure" });
  });

  it("keeps the status line out of thinking: spinner frames dropped, waits as a chip until the turn ends", async () => {
    const { chat } = await openChat();
    await chat.send("wait for it", "normal");
    await until(() => chat.snapshot().extensionStatus["hermes:status"] !== undefined);
    expect(chat.snapshot().extensionStatus["hermes:status"]).toBe("Waiting for the provider (5s)...");
    // Mid-turn, while it streams, the thinking holds no status-line text.
    const streaming = chat.snapshot().items.filter((i) => i.kind === "assistant");
    expect(streaming.map((i) => (i.kind === "assistant" ? i.thinking : "")).join("")).not.toMatch(/musing|Waiting/);
    await until(() => chat.status === "idle");
    expect(chat.snapshot().extensionStatus["hermes:status"]).toBeUndefined();
    const assistant = chat.snapshot().items.find((i) => i.kind === "assistant");
    expect(assistant && assistant.kind === "assistant" && assistant.thinking).toBe("hmm ");
  });

  it("stays running through a mid-turn session.info that names no running state", async () => {
    const { chat } = await openChat();
    await chat.send("retitled run", "normal");
    // Before the call starts: the title has landed, the model is writing the call, and the turn is still live.
    await until(() => chat.snapshot().extensionStatus["hermes:status"] === "Writing a terminal call");
    expect(chat.status).toBe("running");
    expect(chat.snapshot().title).toBe("Retitled by Hermes");
    await until(() => chat.snapshot().items.some((i) => i.kind === "tool" && i.status === "running"));
    expect(chat.status).toBe("running");
    expect(chat.snapshot().extensionStatus["hermes:status"]).toBeUndefined();
    await until(() => chat.status === "idle");
    expect(chat.snapshot().items.find((i) => i.kind === "tool")).toMatchObject({ name: "terminal", status: "done" });
  });

  it("settles a turn and follows the model from session.info alone", async () => {
    const { chat } = await openChat();
    await chat.send("vanish now", "normal");
    await until(() => chat.status === "idle");
    expect(chat.snapshot().config).toMatchObject({ model: "fake/fake-fallback" });
  });

  it("refuses handoffs, since recording a turn would run it", async () => {
    expect(adapter.capabilities.supportsHandoff).toBe(false);
    await expect(adapter.seedChat()).rejects.toThrow(/cannot take a handoff/);
    expect(JSON.parse(readFileSync(state, "utf8")).spawns).toEqual([]);
  });

  it("lists Hermes's commands and runs them the way its TUI does", async () => {
    const { chat, live } = await openChat();
    expect((await live.listCommands()).map((c) => [c.name, c.source])).toEqual([
      ["status", "command"],
      ["review", "skill"],
      ["moa", "command"],
    ]);
    // A built-in answers with output and no model turn.
    await chat.send("/status", "normal");
    await until(() => chat.status === "idle");
    const ran = chat.snapshot().items;
    expect(ran.find((i) => i.kind === "user")).toMatchObject({ text: "/status" });
    expect(ran.find((i) => i.kind === "assistant")).toMatchObject({ text: expect.stringContaining("hermes status: fine") });
    // A skill goes on to command.dispatch, and its message runs as a normal turn.
    await chat.send("/review the tests", "normal");
    await until(() => chat.snapshot().items.some((i) => i.kind === "assistant" && i.text.includes("Review: the tests")));
    await until(() => chat.status === "idle");
  });

  it("runs /moa as the prompt it becomes, with each reference's advice folded under its model", async () => {
    const { chat, live } = await openChat();
    const events: HarnessEvent[] = [];
    live.subscribe((e) => events.push(e));
    await chat.send("/moa explain the cache", "normal");
    await until(() => chat.status === "idle");
    const items = chat.snapshot().items;
    // The user row is the submitted prompt, which is the row Hermes stores; the slash is how it was sent.
    expect(items.find((i) => i.kind === "user")).toMatchObject({ text: "explain the cache" });
    // The one-shot's notice belongs to the turn, not to an idle moment after it.
    const oneShot = items.find((i) => i.kind === "notice" && /MoA one-shot queued/.test(i.text));
    expect(oneShot).toMatchObject({ level: "info" });
    expect((oneShot as { ambient?: boolean }).ambient).toBeUndefined();
    // Each reference opens as Markdown advice under the model that wrote it.
    const refs = items.filter((i) => i.kind === "notice" && i.title?.startsWith("MoA · opencode-go"));
    expect(refs.map((i) => (i.kind === "notice" ? i.title : ""))).toEqual([
      "MoA · opencode-go:glm-5.3-flash (1/2)",
      "MoA · opencode-go:deepseek-v4.1-flash (2/2)",
    ]);
    expect(refs[0]).toMatchObject({ detailFormat: "markdown", detail: "## Advice one\n\nUse `cache` for repeats." });
    // The fan-out and the hand to the aggregator read on the status line, then clear.
    const statuses = events.flatMap((e) => (e.type === "extension_status" ? [e.text] : []));
    expect(statuses).toContain("MoA · 1/2 references done");
    expect(statuses).toContain("MoA · 2/2 references done");
    expect(statuses).toContain("MoA · aggregating with opencode-go:glm-5.3");
    expect(chat.snapshot().extensionStatus).toEqual({});
  });
});

describe("a gateway that refuses to start", () => {
  it("tells the chat why, from stderr, instead of the bare exit code", async () => {
    // What the real entry point does when another gateway owns the home
    // (tui_gateway/entry.py's _claim_launch_home): one line on stderr, exit 1.
    process.env.FAKE_HERMES_REFUSE = "/home/u/.hermes";
    try {
      await expect(adapter.openChat({ cwd: project })).rejects.toThrow(
        "hermes exited (code 1): [gateway-exit] refused: /home/u/.hermes is owned by a running gateway; attach to it instead",
      );
    } finally {
      delete process.env.FAKE_HERMES_REFUSE;
    }
  });
});

describe("gateway runtime", () => {
  it("runs the gateway with the environment the hermes launcher sets up", async () => {
    // A Nix-style wrapper: exports, then exec. The TUI's gateway inherits these.
    const launcher = path.join(tempDir("awui-hermes-bin-"), "hermes");
    writeFileSync(
      launcher,
      [
        "#!/bin/sh",
        "export HERMES_PYTHON='/opt/fake/python3'",
        "export HERMES_BUNDLED_PLUGINS='/opt/fake/plugins'",
        "PYTHONPATH=/opt/fake/site-packages",
        "export PYTHONPATH",
        'exec /opt/fake/hermes "$@"',
      ].join("\n"),
    );
    chmodSync(launcher, 0o755);
    const saved = { bin: process.env.HERMES_BIN, python: process.env.HERMES_PYTHON };
    process.env.HERMES_BIN = launcher;
    delete process.env.HERMES_PYTHON;
    try {
      const spec = await new HermesAdapter().spawnSpec();
      expect(spec.command).toBe("/opt/fake/python3");
      expect(spec.args).toEqual(["-m", "tui_gateway.entry"]);
      expect(spec.env).toMatchObject({ HERMES_BUNDLED_PLUGINS: "/opt/fake/plugins", PYTHONPATH: "/opt/fake/site-packages" });
    } finally {
      for (const [key, value] of [["HERMES_BIN", saved.bin], ["HERMES_PYTHON", saved.python]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("the reasoning block Hermes writes into the answer", () => {
  it("comes off the text, in each style a surface can ask for", () => {
    // display.reasoning_style "code" (the default): the label, a fence, then the answer.
    expect(splitReasoningBlock("💭 **Reasoning:**\n```\nhmm, thought about it\n```\n\nhermes says hi")).toEqual({ text: "hermes says hi", thinking: "hmm, thought about it" });
    // "blockquote": the label and the thought quoted line by line.
    expect(splitReasoningBlock("> 💭 **Reasoning:**\n> one\n> two\n\nanswer")).toEqual({ text: "answer", thinking: "one\ntwo" });
    // "subtext" (Discord): the label and the thought as "-" lines.
    expect(splitReasoningBlock("-# 💭 Reasoning\n-# one\n-# two\n\nanswer")).toEqual({ text: "answer", thinking: "one\ntwo" });
    // The gateway's own copy of the thought wins when it sends one (it is the fuller text).
    expect(splitReasoningBlock("💭 **Reasoning:**\n```\nshort\n```\n\nanswer", "the whole thought")).toEqual({ text: "answer", thinking: "the whole thought" });
  });

  it("leaves an answer that only looks like one alone", () => {
    const text = "💭 **Reasoning:** is how Hermes labels a thought, but this is prose.";
    expect(splitReasoningBlock(text)).toEqual({ text, thinking: "" });
    expect(splitReasoningBlock("plain answer", "  ")).toEqual({ text: "plain answer", thinking: "" });
  });

  it("keeps the answer clean and the thought on the item, as omp's arrives", async () => {
    const { chat } = await openChat();
    await chat.send("echoed greeting", "normal");
    await until(() => chat.status === "idle");
    const assistant = chat.snapshot().items.find((i) => i.kind === "assistant");
    // The prepended block is gone from the answer, and the reasoning is the item's own.
    expect(assistant).toMatchObject({ text: "hermes says echoed greeting", thinking: "hmm " });
    expect(assistant && assistant.kind === "assistant" && assistant.text).not.toContain("Reasoning:");
  });
});
