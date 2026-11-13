// A command run from an answer (C-x x, the web UI's Run on a code block): the
// command, how it ended and how long it took, and what it printed (its last
// lines, scrollable). Enter puts the command and its output into the message,
// Esc closes.
import { Show } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import type { RunResult } from "../../shared/protocol.js";
import { formatDuration } from "../../web/turns.js";
import { runStatus } from "../assist.js";
import { useTheme } from "./context.js";
import { Spinner } from "./fx.js";

/** Lines of output kept on screen: the rest of a long one scrolls. */
const SHOWN_LINES = 400;

export function RunOutput(p: { command: string; result: RunResult | null; onAdd: () => void; onClose: () => void; side?: number }) {
  const t = useTheme();
  const size = useTerminalDimensions();
  const width = () => Math.max(30, Math.min(110, size().width - (p.side ?? 0) - 4));
  useKeyboard((key) => {
    if (key.defaultPrevented) return;
    key.preventDefault();
    if (key.name === "escape" || (key.ctrl && key.name === "c")) p.onClose();
    else if (key.name === "return" && p.result) p.onAdd();
  });
  const failed = () => (p.result ? p.result.exitCode !== 0 : false);
  const output = () => {
    const lines = (p.result?.output ?? "").replace(/\n$/, "").split("\n");
    return lines.length > SHOWN_LINES ? `… ${lines.length - SHOWN_LINES} lines above\n${lines.slice(-SHOWN_LINES).join("\n")}` : lines.join("\n");
  };
  return (
    <box
      alignSelf="center"
      marginTop={1}
      width={width()}
      height={Math.max(8, size().height - 8)}
      flexShrink={0}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={p.result ? (failed() ? t().danger : t().ok) : t().accent}
      backgroundColor={t().surface}
      title={" Run "}
      bottomTitle={p.result ? ` ${runStatus(p.result)} · ${formatDuration(p.result.durationMs)}${p.result.truncated ? " · cut short" : ""} ` : undefined}
      paddingLeft={1}
      paddingRight={1}
    >
      <text wrapMode="word" flexShrink={0}>
        <span style={{ fg: t().muted }}>$ </span>
        <span style={{ fg: t().link }}>{p.command}</span>
      </text>
      <Show when={p.result} fallback={<text fg={t().muted}><Spinner /> running in the project folder…</text>}>
        <scrollbox flexGrow={1} marginTop={1} stickyScroll stickyStart="bottom" verticalScrollbarOptions={{ visible: false }}>
          <text fg={t().text2} wrapMode="char">
            {output() || "(no output)"}
          </text>
        </scrollbox>
      </Show>
      <text flexShrink={0} fg={t().muted}>
        {p.result ? "Enter puts the command and its output into your message · Esc closes" : "Esc closes (the command keeps running)"}
      </text>
    </box>
  );
}
