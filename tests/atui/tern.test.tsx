// awui's Tern client end to end: the built server with fake harnesses, the
// client's real state and view, and a stand-in Tern (tern-fake.ts) that keeps
// the document the frames build. Driven by the bytes a pty would carry.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";
import { createRoot } from "solid-js";
import { connect } from "@stencil-hq/tern";
import { Server } from "../../src/atui/client.js";
import { createAtui, type Atui } from "../../src/atui/state.js";
import { createTernApp } from "../../src/tern/app.js";
import { BASE, startServer, wait } from "./helpers.js";
import { FakeTern } from "./tern-fake.js";

let server: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server.stop();
});

/** Drop `keys` from every object in a JSON value: what a server from before those fields sends. */
function strip(value: unknown, keys: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => strip(v, keys));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k)).map(([k, v]) => [k, strip(v, keys)]));
  return value;
}

/**
 * A server older than the client: the test server behind a proxy that takes
 * `keys` out of every JSON reply and every event of the chat stream.
 */
function olderServer(keys: readonly string[]): { base: string; stop: () => void } {
  const proxy = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const upstream = await fetch(`${BASE}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body: req.method === "GET" ? null : await req.text() });
      const type = upstream.headers.get("content-type") ?? "";
      if (type.includes("application/json")) return Response.json(strip(await upstream.json(), keys), { status: upstream.status });
      if (!type.includes("text/event-stream") || !upstream.body) return upstream;
      // Event by event: each `data:` line's JSON rewritten, lines split across chunks put back together first.
      let rest = "";
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      const body = upstream.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, out) {
            rest += decoder.decode(chunk, { stream: true });
            const lines = rest.split("\n");
            rest = lines.pop() ?? "";
            out.enqueue(encoder.encode(lines.map((l) => (l.startsWith("data: ") ? `data: ${JSON.stringify(strip(JSON.parse(l.slice(6)), keys))}` : l)).join("\n") + "\n"));
          },
        }),
      );
      return new Response(body, { status: upstream.status, headers: { "content-type": "text/event-stream" } });
    },
  });
  return { base: `http://127.0.0.1:${proxy.port}`, stop: () => void proxy.stop(true) };
}

/** The test server behind a proxy that holds back each chat's event stream by `ms`: a chat that is shown but not yet connected. */
function slowStream(ms: number): { base: string; stop: () => void } {
  const proxy = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/events")) await wait(ms);
      return fetch(`${BASE}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body: req.method === "GET" ? null : await req.text() });
    },
  });
  return { base: `http://127.0.0.1:${proxy.port}`, stop: () => void proxy.stop(true) };
}

/** The test server behind a proxy that holds /api/usage back by `ms`, or answers it with `status` and an error when one is given. */
function usageProxy(opts: { ms?: number; status?: number }): { base: string; stop: () => void } {
  const proxy = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/usage") {
        if (opts.ms) await wait(opts.ms);
        if (opts.status) return Response.json({ error: "Usage cannot be read now", code: "usage_failed" }, { status: opts.status });
      }
      return fetch(`${BASE}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body: req.method === "GET" ? null : await req.text() });
    },
  });
  return { base: `http://127.0.0.1:${proxy.port}`, stop: () => void proxy.stop(true) };
}

interface Client {
  tern: FakeTern;
  app: Atui;
  written: string[];
  running: Promise<void>;
  until: (check: () => boolean, what: string, ms?: number) => Promise<void>;
  quit: () => Promise<void>;
}

let client: Client | null = null;
afterEach(async () => {
  await client?.quit();
  client = null;
});

/** `lateInit` draws the first frame before the server has answered (init is the test's to call); `chatId` opens that chat. */
async function start(project = "alpha", base = BASE, opts: { lateInit?: boolean; chatId?: string } = {}): Promise<Client> {
  const tern = new FakeTern();
  const app = createRoot(() => createAtui(new Server(base), { cwd: path.join(server.root, project), harness: "fake", ...(opts.chatId ? { chatId: opts.chatId } : {}) }));
  if (!opts.lateInit) await app.init();
  const session = await connect({ app: "awui", input: tern.input, output: tern.output, env: { TERM_PROGRAM: "tern" }, exitHooks: false, features: ["edit", "undo", "send"] });
  if (!session) throw new Error("the stand-in Tern did not answer hello");
  const written: string[] = [];
  const ui = createTernApp(session, app, { url: base, version: "test", polarity: null, write: (s) => void written.push(s) });
  const running = ui.run();
  let done = false;
  void running.then(() => (done = true));
  const until = async (check: () => boolean, what: string, ms = 10_000) => {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}; main:\n${tern.text("main")}\ndock:\n${tern.text("dock")}\nlayer:\n${tern.text("layer")}`);
      await wait(30);
    }
  };
  await until(() => tern.nodes.has("dock"), "the first frame");
  return {
    tern,
    app,
    written,
    running,
    until,
    quit: async () => {
      if (!done) {
        tern.type("\x18");
        await wait(40);
        tern.type("q");
        await Promise.race([running, wait(2000)]);
      }
      app.dispose();
      await session.close();
    },
  };
}

describe("awui tern", () => {
  it("opens one inline surface with the stylesheet and theme sheet, and the web UI's start screen", async () => {
    client = await start();
    const { tern } = client;
    expect(tern.sent.find((m) => m.verb === "o")?.body).toMatchObject({ mode: "inline", role: "awui.chat" });
    expect(tern.sent.some((m) => m.verb === "s" && (m.body as { name: string }).name === "awui")).toBe(true);
    expect(tern.sent.some((m) => m.verb === "s" && (m.body as { name: string }).name === "awui-theme")).toBe(true);
    expect(tern.text("main")).toContain("What should Fake do in alpha?");
    expect(tern.text("main")).toContain("Explain this project's structure");
    expect(tern.focus).toBe("dock.d.comp.ed");
    expect(tern.errors).toEqual([]);
  });

  it("asks Tern to hold startup typing until the start screen has its data, then never again", async () => {
    client = await start("alpha", BASE, { lateInit: true });
    const { tern, app, until } = client;
    const held = () => tern.nodes.get("dock.d.comp.ed")?.p.typeahead === true;
    // Drawn before the server has answered: nothing real to type into yet.
    expect(held()).toBe(true);
    await wait(150);
    expect(held()).toBe(true);
    await app.init();
    await until(() => !held(), "typeahead to clear");
    expect(tern.text("main")).toContain("What should Fake do in alpha?");
    // Once cleared it stays cleared: a run and its end do not set it again.
    tern.type("tool please\r");
    await until(() => app.chat()?.status === "idle" && tern.text("main").includes("Echo: tool please"), "a run");
    expect(held()).toBe(false);
    expect(tern.errors).toEqual([]);
  });

  it("holds startup typing for a chat until its stream is connected", async () => {
    const first = await start();
    first.tern.type("hello\r");
    await first.until(() => first.app.chat()?.status === "idle" && first.tern.text("main").includes("Echo: hello"), "the first chat");
    const chatId = first.app.chat()?.chatId;
    await first.quit();
    // The chat's snapshot is shown at once, but its event stream opens late.
    const slow = slowStream(500);
    try {
      client = await start("alpha", slow.base, { chatId });
      const { tern, app, until } = client;
      const held = () => tern.nodes.get("dock.d.comp.ed")?.p.typeahead === true;
      expect(app.chat()?.chatId).toBe(chatId ?? "");
      expect(app.conn()).toBe("connecting");
      expect(held()).toBe(true);
      await until(() => app.conn() === "connected" && !held(), "the stream to connect and typeahead to clear");
      expect(tern.text("main")).toContain("Echo: hello");
      expect(tern.errors).toEqual([]);
    } finally {
      slow.stop();
    }
  });

  it("sends a message and draws the prompt, the folded work, and the streamed answer", async () => {
    client = await start();
    const { tern, app, until } = client;
    tern.type("tool please");
    await until(() => tern.nodes.get("dock.d.comp.ed")?.p.text === "tool please", "the draft");
    tern.type("\r");
    await until(() => tern.text("main").includes("Echo: tool please") && app.chat()?.status === "idle", "the answer");
    const main = tern.text("main");
    expect(main).toContain("tool please");
    expect(main).toMatch(/Worked for \d+s · /);
    expect(tern.find("md").some((n) => n.p.role === "awui.reply" && n.p.stream === false)).toBe(true);
    // The fold opens on a toggle from Tern, and holds the tool rows.
    const fold = tern.find("section").find((n) => n.p.role === "awui.fold");
    expect(fold).toBeDefined();
    expect(tern.find("tool").length).toBeGreaterThan(0);
    expect(tern.nodes.get("dock.d.comp.ed")?.p.text ?? "").toBe("");
    expect(tern.errors).toEqual([]);
  });

  it("draws a background job's widget as a native job card", async () => {
    client = await start();
    const { tern, app, until } = client;
    tern.type("bgjob\r");
    await until(() => app.chat()?.status === "idle" && tern.text("main").includes("Echo: bgjob"), "the background job run");
    const job = tern.find("tool").find((n) => n.p.role === "awui.job");
    if (!job) throw new Error("the wait call has no job card");
    expect(job.p).toMatchObject({ name: "job", status: "done", title: "Running the e2e suite", target: "npm run test:e2e:fast" });
    expect(tern.find("meter", job.id)[0]?.p).toMatchObject({ value: 1, total: "12/12", tone: "warning" });
    expect(tern.find("stats", job.id)[0]?.p.items).toEqual([
      { label: "passed", value: "11", tone: "success" },
      { label: "failed", value: "1", tone: "error" },
    ]);
    expect(tern.find("kv", job.id)[0]?.p.items).toHaveLength(12);
    expect(tern.errors).toEqual([]);
  });

  it("draws an MCP-like call's JSON arguments and result as native JSON trees", async () => {
    client = await start();
    const { tern, app, until } = client;
    tern.type("showcase\r");
    await until(() => app.chat()?.status === "idle" && tern.text("main").includes("Echo: showcase"), "the showcase run");
    const call = tern.find("tool").find((n) => n.p.name === "mcp__tracker__triage_ticket");
    if (!call) throw new Error("the MCP-like call is missing");
    const trees = tern.find("json", call.id);
    expect(trees).toHaveLength(2);
    expect(trees[0]?.p.value).toMatchObject({ query: "listen", filter: { state: "open", labels: ["bug", "server"] }, limit: 2 });
    expect(trees[1]?.p.value).toMatchObject({ total: 2 });
    expect(trees.every((n) => n.p.open === 2)).toBe(true);
    expect(tern.find("ansi", call.id)).toHaveLength(0);
    expect(tern.errors).toEqual([]);
  });

  it("answers an approval with its number key", async () => {
    client = await start();
    const { tern, app, until } = client;
    tern.type("ask please\r");
    await until(() => tern.nodes.has("dock.d.req"), "the approval card");
    // Tern's own ask panel draws the buttons: the row carries their labels.
    expect(tern.find("tool", "dock")[0]?.p).toMatchObject({ status: "ask", ask: { allow: "Approve · 1", deny: "Deny · 2" } });
    tern.type("1");
    await until(() => !tern.nodes.has("dock.d.req") && app.chat()?.status === "idle", "the approval to go");
    expect(tern.text("main")).toContain("Approved");
  });

  it("opens the palette with C-k and the / menu at the caret, and Tab completes", async () => {
    client = await start();
    const { tern, until } = client;
    tern.type("\x0b");
    await until(() => tern.find("picker", "layer").length === 1, "the palette");
    expect(tern.text("layer")).toContain("Commands");
    tern.type("\x1b");
    await until(() => tern.find("picker", "layer").length === 0, "the palette to close");
    tern.type("/");
    await until(() => tern.find("overlay", "layer").length === 1, "the / menu");
    expect(tern.find("overlay", "layer")[0]?.p.anchor).toEqual({ caret: "dock.d.comp.ed" });
    expect(tern.text("layer")).toContain("/new");
    tern.type("\t");
    await until(() => String(tern.nodes.get("dock.d.comp.ed")?.p.text).startsWith("/new "), "the completion");
  });

  it("toggles a fold from Tern's event and keeps it open", async () => {
    client = await start();
    const { tern, app, until } = client;
    tern.type("tool please\r");
    await until(() => app.chat()?.status === "idle" && tern.find("section").some((n) => n.p.role === "awui.fold"), "the fold");
    const fold = tern.find("section").find((n) => n.p.role === "awui.fold") as { id: string; p: Record<string, unknown> };
    expect(fold.p.collapsed).toBe(true);
    tern.event({ ev: "toggle", id: fold.id, collapsed: false });
    await until(() => tern.nodes.get(fold.id)?.p.collapsed === false, "the fold to stay open");
  });

  it("offers the model before the first message: the chip starts the chat and opens the picker", async () => {
    client = await start();
    const { tern, app, until } = client;
    const chip = tern.nodes.get("dock.d.comp.chips.l.m");
    expect(chip?.p.text).toBe("Model ⌄");
    expect(app.chat()).toBeNull();
    tern.event({ ev: "action", id: "dock.d.comp.chips.l.m", act: "click" });
    const labels = () => ((tern.find("picker", "layer")[0]?.p.items ?? []) as Array<{ label: string }>).map((i) => i.label);
    await until(() => labels().includes("Fake Echo"), "the model picker");
    expect(app.chat()).not.toBeNull();
    expect(String(tern.nodes.get("dock.d.comp.chips.l.m")?.p.text)).not.toBe("Model ⌄");
  });

  it("opens thinking and permission as searchable picker sheets", async () => {
    client = await start();
    const { tern, app, until } = client;
    tern.type("\x18");
    tern.type("t");
    await until(() => tern.text("layer").includes("Thinking"), "the thinking menu");
    const thinking = tern.find("picker", "layer")[0];
    if (!thinking) throw new Error("thinking is not a picker sheet");
    expect(thinking.p).toMatchObject({ title: "Thinking", noun: "levels", current: ["low"] });
    tern.type("high");
    await until(() => ((tern.nodes.get(thinking.id)?.p.items ?? []) as Array<{ label: string }>).map((i) => i.label).join(",") === "high", "the thinking query");
    tern.type("\r");
    await until(() => app.chat()?.config.thinkingLevel === "high" && tern.find("picker", "layer").length === 0, "the thinking choice");

    tern.event({ ev: "action", id: "dock.d.comp.chips.l.p", act: "click" });
    await until(() => tern.text("layer").includes("Permissions"), "the permission menu");
    const permission = tern.find("picker", "layer")[0];
    if (!permission) throw new Error("permission is not a picker sheet");
    expect(permission.p).toMatchObject({ title: "Permissions", noun: "modes", current: ["default"] });
    tern.type("bypass");
    await until(() => ((tern.nodes.get(permission.id)?.p.items ?? []) as Array<{ label: string }>).map((i) => i.label).join(",") === "Bypass", "the permission query");
    tern.type("\r");
    await until(() => app.chat()?.config.permissionMode === "bypass" && tern.find("picker", "layer").length === 0, "the permission choice");
    expect(tern.errors).toEqual([]);
  });

  it("draws a chat from a server older than itself (no chain, checkpoints)", async () => {
    const older = olderServer(["chain", "chainPaused", "checkpoints"]);
    try {
      client = await start("alpha", older.base);
      const { tern, app, until } = client;
      tern.type("tool please\r");
      await until(() => app.chat()?.status === "idle" && tern.text("main").includes("Echo: tool please"), "the answer");
      expect(app.chat()?.chain).toBeUndefined();
      expect(tern.nodes.has("main.page.broken")).toBe(false);
      expect(tern.errors).toEqual([]);
    } finally {
      await client?.quit();
      client = null;
      older.stop();
    }
  });

  it("names the latest thought on the working line only while the live fold is closed", async () => {
    client = await start();
    const { tern, until } = client;
    tern.type("slow please\r");
    const shimmer = () => tern.find("shimmer")[0]?.p.text as string | undefined;
    const liveFold = () => tern.find("section").find((n) => n.p.role === "awui.fold-live");
    await until(() => liveFold() !== undefined && shimmer() !== undefined, "the live fold", 8000);
    // Open (as a live fold starts), the thought is a row in it: the line just says Working.
    expect(liveFold()?.p.collapsed).toBe(false);
    expect(shimmer()).toBe("Working");
    tern.event({ ev: "toggle", id: liveFold()?.id, collapsed: true });
    await until(() => shimmer()?.startsWith("Considering") === true, "the thought on the working line");
  }, 20_000);

  it("quits with C-c C-c, and leaves the chat on the server", async () => {
    client = await start();
    const { tern, app, running, until } = client;
    tern.type("hello\r");
    await until(() => app.chat()?.status === "idle", "the run");
    tern.type("\x03");
    await wait(40);
    tern.type("\x03");
    await Promise.race([running, wait(3000).then(() => Promise.reject(new Error("C-c C-c did not quit")))]);
    expect(app.chat()?.chatId).toBeTruthy();
  });
});
