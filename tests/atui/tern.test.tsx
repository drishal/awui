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
import { shortTokens, tokensOf } from "../../src/web/usage.js";
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

  it("words the live line with the run's phase once it has held steady", async () => {
    client = await start();
    const { tern, app, until } = client;
    const line = () => tern.find("shimmer").map((n) => String(n.p.text));
    tern.type("slow please\r");
    await until(() => line().includes("Working"), "the first phase");
    // Thinking and then writing follow within the hold, so the line goes from Working to Writing without flashing between.
    await until(() => line().includes("Writing"), "the writing phase");
    expect(app.chat()?.status).toBe("running");
    await until(() => app.chat()?.status === "idle" && line().length === 0, "the run to end");
    expect(tern.errors).toEqual([]);
  });

  it("opens a failed call from the palette or C-x f, and says when none failed", async () => {
    client = await start();
    const { tern, app, until } = client;
    tern.type("tool please\r");
    await until(() => app.chat()?.status === "idle" && tern.text("main").includes("Echo: tool please"), "a run without a failure");
    tern.type("\x18f");
    await until(() => tern.text("layer").includes("No call has failed in this chat"), "the notice");
    expect(tern.reveals).toEqual([]);

    tern.type("toolfail\r");
    await until(() => app.chat()?.status === "idle" && tern.text("main").includes("Echo: toolfail"), "the failing run");
    const fold = tern.find("section").filter((n) => n.p.role === "awui.fold").at(-1) as { id: string; p: Record<string, unknown> };
    expect(JSON.stringify(fold.p.head)).toContain("1 failed");
    expect(fold.p.collapsed).toBe(true);
    const row = () => tern.find("tool", fold.id).find((n) => n.p.status === "error");
    expect(row()).toBeDefined();

    // From the palette: filter to the entry and take it.
    tern.type("\x0b");
    await until(() => tern.find("picker", "layer").length === 1, "the palette");
    tern.type("failed");
    await until(() => ((tern.find("picker", "layer")[0]?.p.items ?? []) as Array<{ label: string }>).map((i) => i.label).join() === "Show failed calls", "the entry");
    tern.type("\r");
    await until(() => tern.reveals.length === 1, "the reveal");
    expect(tern.reveals[0]).toEqual({ id: row()?.id ?? "", present: true });
    expect(tern.nodes.get(fold.id)?.p.collapsed).toBe(false);

    // From the key, with the fold closed again.
    tern.event({ ev: "toggle", id: fold.id, collapsed: true });
    await until(() => tern.nodes.get(fold.id)?.p.collapsed === true, "the fold to close");
    tern.type("\x18f");
    await until(() => tern.reveals.length === 2 && tern.nodes.get(fold.id)?.p.collapsed === false, "the key to open it");
    expect(tern.reveals[1]).toEqual({ id: row()?.id ?? "", present: true });
    expect(tern.errors).toEqual([]);
  });

  it("opens Usage from the palette or C-x u with the chats' real totals, changes the range and scrolls, and Esc closes it", async () => {
    client = await start();
    const { tern, app, until } = client;
    tern.type("usagevary please\r");
    await until(() => app.chat()?.status === "idle" && tern.text("main").includes("Echo: usagevary please"), "the run");
    const report = await app.usageReport(30);
    expect(report.totals.calls).toBeGreaterThan(0);
    const tiles = () => JSON.stringify(tern.find("stats", "layer")[0]?.p.items ?? []);
    const open = () => tern.find("overlay", "layer").some((n) => n.p.head === "Usage");

    // From the palette: filter to the entry and take it.
    tern.type("\x0b");
    await until(() => tern.find("picker", "layer").length === 1, "the palette");
    tern.type("usage");
    await until(() => ((tern.find("picker", "layer")[0]?.p.items ?? []) as Array<{ label: string }>).map((i) => i.label).join() === "Usage", "the entry");
    tern.type("\r");
    await until(() => open() && tiles().includes(shortTokens(tokensOf(report.totals))), "the report");
    expect(tern.find("picker", "layer")).toEqual([]);
    expect(tiles()).toContain(`${report.totals.calls} model call`);
    // A day's bar each (30 of them), a table row for the harness and the model, the footer's keys.
    expect(tern.find("chart", "layer")[0]?.p).toMatchObject({ kind: "bars" });
    expect(((tern.find("chart", "layer")[0]?.p.series ?? []) as unknown[]).length).toBe(30);
    const rows = tern.find("table", "layer").map((t) => (t.p.rows as Array<{ id: string }>).map((r) => r.id));
    expect(rows).toEqual([report.byHarness.map((h) => h.harnessId), report.byModel.map((m) => m.model)]);
    expect(tern.text("layer")).toContain("Read from the harnesses' own session files");

    // The arrows change the range (a new read), and the scroll keys reach the body.
    tern.type("\x1b[D");
    await until(() => tern.find("overlay", "layer")[0]?.p.meta === "last 7 days" && ((tern.find("chart", "layer")[0]?.p.series ?? []) as unknown[]).length === 7, "the 7 day range");
    tern.type("\x1b[D");
    await wait(100);
    expect(tern.find("overlay", "layer")[0]?.p.meta).toBe("last 7 days");
    tern.type("\x1b[B");
    tern.type("\x1b[F");
    await until(() => tern.scrolls.length === 2, "the scrolls");
    expect(tern.scrolls).toEqual([{ id: "layer.usage.body", to: "line-down" }, { id: "layer.usage.body", to: "end" }]);
    // Keys other than these are swallowed: nothing reaches the composer behind it.
    tern.type("zz");
    await wait(100);
    expect(String(tern.nodes.get("dock.d.comp.ed")?.p.text ?? "")).toBe("");

    tern.type("\x1b");
    await until(() => !open(), "Esc to close it");

    // From the key, and a click on Close.
    tern.type("\x18u");
    await until(() => open() && tern.find("overlay", "layer")[0]?.p.meta === "last 30 days" && tiles().includes(shortTokens(tokensOf(report.totals))), "the report again");
    tern.event({ ev: "action", id: "layer.usage.end", act: "click" });
    await until(() => !open(), "the Close button");
    expect(tern.errors).toEqual([]);
  });

  it("shows Usage's wait and its error in the overlay, never a blank one", async () => {
    const slow = usageProxy({ ms: 700 });
    try {
      client = await start("alpha", slow.base);
      const { tern, until } = client;
      tern.type("\x18u");
      await until(() => tern.text("layer").includes("Reading sessions"), "the wait");
      expect(tern.find("spinner", "layer").length).toBe(1);
      expect(tern.find("stats", "layer")).toEqual([]);
      await until(() => tern.find("stats", "layer").length === 1 && tern.find("spinner", "layer").length === 0, "the report");
      await client.quit();
      client = null;
    } finally {
      slow.stop();
    }
    const broken = usageProxy({ status: 500 });
    try {
      client = await start("alpha", broken.base);
      const { tern, until } = client;
      tern.type("\x18u");
      await until(() => tern.text("layer").includes("Could not read usage: Usage cannot be read now"), "the error");
      expect(tern.find("stats", "layer")).toEqual([]);
      expect(tern.find("spinner", "layer")).toEqual([]);
      tern.type("\x1b");
      await until(() => tern.find("overlay", "layer").length === 0, "Esc to close it");
    } finally {
      broken.stop();
    }
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

  it("shows the phase on the working line, and the latest thought beside it only while the live fold is closed", async () => {
    client = await start();
    const { tern, until } = client;
    tern.type("slow please\r");
    const shimmer = () => tern.find("shimmer")[0]?.p.text as string | undefined;
    const thought = () => tern.find("text").find((n) => n.p.role === "awui.working-thought");
    const liveFold = () => tern.find("section").find((n) => n.p.role === "awui.fold-live");
    await until(() => liveFold() !== undefined && shimmer() !== undefined, "the live fold", 8000);
    // Open (as a live fold starts), and before the first phase has held: the line just says Working, and the
    // thought is a row in the fold, not on the line.
    expect(liveFold()?.p.collapsed).toBe(false);
    expect(shimmer()).toBe("Working");
    expect(thought()).toBeUndefined();
    // Closed, the line keeps the phase and shows the latest thought after it, as the web UI's closed card does.
    tern.event({ ev: "toggle", id: liveFold()?.id, collapsed: true });
    await until(() => shimmer() === "Writing", "the writing phase on the working line");
    await until(() => JSON.stringify(thought() ?? "").includes("Considering"), "the latest thought beside the phase");
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
