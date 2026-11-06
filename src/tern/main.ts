// `awui tern`: awui drawn natively by Tern (stencil.so/tern) through the Tern
// Surface Protocol, a client of the same server as the browser and atui. It
// runs under Bun with Solid's reactive build (`--conditions=browser`; the
// default build Bun picks is Solid's server one, where effects never run).
// Outside a Tern pane (another terminal, or tmux, screen, zellij, or herdr,
// which swallow the protocol) it says so and points to atui.
import { createMemo, createRoot, createSignal } from "solid-js";
import { connect } from "@stencil-hq/tern";
import type { ThemeInfo } from "../shared/protocol.js";
import { Server } from "../atui/client.js";
import { createAtui, message } from "../atui/state.js";
import { parseTernArgs, TERN_USAGE } from "./args.js";
import { createTernApp, notify } from "./app.js";

/** Whether Solid runs reactively here: under its server build a memo never updates. */
function reactive(): boolean {
  return createRoot((dispose) => {
    const [n, setN] = createSignal(1);
    const double = createMemo(() => n() * 2);
    setN(2);
    const ok = double() === 4;
    dispose();
    return ok;
  });
}

/** Run the Tern client with `argv` (its options, without the command): from source under Bun, or `awui tern` inside the binary. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseTernArgs(argv, process.env);
  if ("help" in parsed) {
    console.log(TERN_USAGE);
    return;
  }
  if ("error" in parsed) {
    console.error(`awui tern: ${parsed.error}\n\n${TERN_USAGE}`);
    process.exit(2);
  }
  if (!reactive()) {
    console.error("awui tern: Solid loaded its server build; run it with `bun --conditions=browser` (awui tern does)");
    process.exit(1);
  }
  const server = new Server(parsed.url);
  const write = (data: string) => void process.stdout.write(data);
  // The server first: a client that cannot reach it says so before taking the pane.
  const theme = await server.call<ThemeInfo>("/api/theme").catch(() => null);
  const app = createRoot(() => createAtui(server, { ...parsed, notify: notify(write) }));
  try {
    await app.init();
  } catch (error) {
    console.error(`awui tern: ${message(error)} (is the awui server running at ${parsed.url}?)`);
    process.exit(1);
  }

  const session = await connect({ app: "awui", version: parsed.version, features: ["edit", "undo", "send"] });
  if (!session) {
    app.dispose();
    const why = process.env.TMUX || process.env.STY || process.env.ZELLIJ || process.env.HERDR_ENV ? "a multiplexer (tmux, screen, zellij, herdr) is in the way" : "this terminal is not Tern";
    console.error(`awui tern draws in a Tern pane, and ${why}. In any terminal, atui is awui's terminal client.`);
    process.exit(1);
  }

  const tern = createTernApp(session, app, { url: parsed.url, version: parsed.version, polarity: theme?.source === "file" ? (theme.polarity ?? "dark") : null, write });
  await tern.run();
  const c = app.chat();
  app.dispose();
  await session.close();
  if (c && c.items.some((i) => i.kind === "user")) {
    console.log(`The chat keeps running on the server: awui tern --chat ${c.chatId}, or ${parsed.url}/#chat=${c.chatId}`);
  }
  process.exit(0);
}

if (import.meta.main) void main();
