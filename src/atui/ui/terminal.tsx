// An interactive shell in the current project. The small terminal glyph beside
// the project's name opens this view, rather than adding another composer row.
// OpenTUI's VT renderer handles input and output; close kills the server PTY.
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { useKeyboard, extend } from "@opentui/solid";
import { EmbeddedTerminalRenderable } from "@opentui/core";
import { useTheme, useAtui } from "./context.js";
import { openProjectTerminal, type ProjectTerminal } from "../terminal-client.js";
import { message } from "../state.js";

extend({ embedded_terminal: EmbeddedTerminalRenderable });
declare module "@opentui/solid" { interface OpenTUIComponents { embedded_terminal: typeof EmbeddedTerminalRenderable } }

export function TerminalView(p: { onClose: () => void }) {
  const app = useAtui();
  const t = useTheme();
  let terminal: EmbeddedTerminalRenderable | undefined;
  let session: ProjectTerminal | null = null;
  let disposed = false;
  const [phase, setPhase] = createSignal<"starting" | "live" | "exited">("starting");
  const [error, setError] = createSignal<string | null>(null);

  const start = async () => {
    if (session || disposed) return;
    const ws = app.workspace();
    if (!ws || !terminal || terminal.width < 10 || terminal.height < 4) return;
    try {
      session = await openProjectTerminal(app.server.base, ws.id, terminal.width, terminal.height, {
        onOutput: (data) => { if (!disposed) terminal?.write(data); },
        onExit: (code) => {
          if (disposed) return;
          setPhase("exited");
          terminal?.blur();
          if (code !== 0) setError(`The shell exited (${code})`);
        },
      });
      if (disposed) return;
      setPhase("live");
      terminal.focus();
    } catch (e) {
      if (!disposed) setError(message(e));
      terminal?.blur();
    }
  };
  onMount(() => void start());
  onCleanup(() => { disposed = true; void session?.close(); });
  useKeyboard((key) => {
    if (key.defaultPrevented) return;
    if (key.name === "escape" || (key.ctrl && key.name === "b")) {
      key.preventDefault();
      p.onClose();
    }
  });

  return (
    <box position="absolute" top={0} left={0} width="100%" height="100%" zIndex={15} flexDirection="column" backgroundColor={t().bg} paddingLeft={2} paddingRight={2}>
      <text flexShrink={0} fg={t().text} marginTop={1}><b>Project terminal</b><span style={{ fg: t().muted }}>{`  ${app.workspace()?.name ?? ""}  ·  Esc or C-b back`}</span></text>
      <Show when={error()} fallback={
        <box marginTop={1} flexGrow={1} border borderStyle="rounded" borderColor={t().border} padding={1}>
          <embedded_terminal
            ref={(el: EmbeddedTerminalRenderable) => {
              terminal = el;
              el.onData = (data) => session?.write(data);
              el.onTerminalResize = (cols, rows) => session ? session.resize(cols, rows) : void start();
            }}
            cols={80} rows={24} width="100%" flexGrow={1} maxScrollback={10_000}
          />
        </box>
      }>
        {(why) => <text fg={t().danger} wrapMode="word" marginTop={1}>{why()}</text>}
      </Show>
      <text flexShrink={0} fg={t().muted}>{phase() === "starting" ? "Opening the project shell…" : phase() === "exited" ? "Shell closed · Esc returns" : "Type normally · Esc returns to the chat"}</text>
    </box>
  );
}
