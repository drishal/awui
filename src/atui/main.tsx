// atui: awui in the terminal, in OpenCode's TUI style (OpenTUI and
// Solid, run by Bun). A client of the same server as the browser, so every
// harness, session, approval, and setting is shared with the web UI.
import { createEffect, createRoot } from "solid-js";
import { render } from "@opentui/solid";
import { Server } from "./client.js";
import { DEFAULT_URL, parseArgs, USAGE } from "./args.js";
import { notifySequence } from "./assist.js";
import { createHerdrReporter, herdrPane, paneReport, resumeArgv } from "./herdr.js";
import { readPrefs, writePrefs } from "./prefs.js";
import { createAtui, message, type Atui } from "./state.js";
import { isBusy } from "../web/session-groups.js";
import { progressSequence, speaksProgress, type Progress, type TerminalState } from "./terminal.js";
import { App } from "./ui/app.js";
import { startTicker, stopTicker } from "./ui/ticker.js";

/** Run atui with `argv` (its options, without the command): from bin/atui, or `awui tui` inside the binary. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv, process.env);
  if ("help" in parsed) {
    console.log(USAGE);
    return;
  }
  if ("error" in parsed) {
    console.error(`atui: ${parsed.error}\n\n${USAGE}`);
    process.exit(2);
  }
  const server = new Server(parsed.url);
  const prefs = readPrefs();
  // A desktop notification through the terminal (OSC 9 / 777): it moves no cursor, so it can go between frames.
  const notify = (title: string, body: string) => void process.stdout.write(notifySequence(process.env, title, body));
  const app = createRoot(() => createAtui(server, { ...parsed, glass: prefs.glass ?? false, notify }));
  try {
    await app.init();
  } catch (error) {
    console.error(`atui: ${message(error)}`);
    process.exit(1);
  }
  reportToHerdr(app, parsed.url, parsed.herdr);
  startTicker();
  let done = false;
  const exit = () => {
    if (done) return;
    done = true;
    const c = app.chat();
    app.dispose();
    stopTicker();
    // The tab's progress outlives atui unless it is taken away.
    if (shown) process.stdout.write(progressSequence(null));
    renderer.setTerminalTitle("");
    // OpenTUI restores the terminal asynchronously: wait for it, or the line below and the shell's prompt land in it.
    renderer.destroy();
    void renderer.closed
      .catch(() => {})
      .then(() => {
        if (c && c.items.some((i) => i.kind === "user")) {
          console.log(`The chat keeps running on the server: atui --chat ${c.chatId}, or ${parsed.url}/#chat=${c.chatId}`);
        }
        process.exit(0);
      });
  };
  const renderer = await (async () => {
    const { createCliRenderer } = await import("@opentui/core");
    return createCliRenderer({ exitOnCtrlC: false, useMouse: true, targetFps: 30 });
  })();
  // The title through the renderer; the progress (OSC 9;4) moves no cursor either, so it goes between frames.
  const progress = speaksProgress(process.env);
  let shown: Progress = null;
  const onTerminal = (state: TerminalState) => {
    renderer.setTerminalTitle(state.title);
    if (progress && state.progress !== shown) process.stdout.write(progressSequence(state.progress));
    if (progress) shown = state.progress;
  };
  // The command line, else $ATUI_VIM, else what C-x v last chose.
  const vim = parsed.vim ?? (process.env.ATUI_VIM ? process.env.ATUI_VIM === "1" : (prefs.vim ?? false));
  await render(() => <App app={app} onExit={exit} vim={vim} onVim={(on) => writePrefs({ vim: on })} onGlass={(on) => writePrefs({ glass: on })} onTerminal={onTerminal} />, renderer);
}

/** In a herdr pane, and unless the server's setting or --no-herdr says not: tell herdr what this atui's chats do. */
function reportToHerdr(app: Atui, url: string, wanted: boolean | undefined): void {
  const pane = herdrPane(process.env);
  if (!pane || wanted === false || app.boot()?.ui.herdr === false) return;
  // Herdr starts the resume command by name after a restart, so only an atui it can find on PATH is offered.
  const command = Bun.which("atui") ? "atui" : null;
  const reporter = createHerdrReporter(pane, { resume: (sessionId) => resumeArgv(command, url, DEFAULT_URL, sessionId) });
  createRoot(() =>
    createEffect(() => {
      const c = app.chat();
      const shown = c?.chatId ?? null;
      const live = new Map(app.overview().sessions.flatMap((s) => (s.liveChatId ? [[s.liveChatId, s] as const] : [])));
      const others = { busy: 0, asking: 0 };
      for (const tab of app.tabs().tabs) {
        const s = tab.chatId && tab.chatId !== shown ? live.get(tab.chatId) : undefined;
        if (s?.asking) others.asking += 1;
        else if (s && isBusy(s.status)) others.busy += 1;
      }
      reporter.report(paneReport(c && c.status !== "disposed" ? c : null, others));
    }),
  );
}

if (import.meta.main) void main();
