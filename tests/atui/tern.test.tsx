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

async function start(project = "alpha", base = BASE): Promise<Client> {
  const tern = new FakeTern();
  const app = createRoot(() => createAtui(new Server(base), { cwd: path.join(server.root, project), harness: "fake" }));
  await app.init();
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

  it("answers an approval with its number key", async () => {
    client = await start();
    const { tern, app, until } = client;
    tern.type("ask please\r");
    await until(() => tern.nodes.has("dock.d.req"), "the approval card");
    expect(tern.text("dock")).toContain("Approve");
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
