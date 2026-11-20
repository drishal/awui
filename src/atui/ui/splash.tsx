// The empty screen before a chat's first message: awui's chat-bubble mark
// (design/icon) drawn in box characters beside the name in a block font,
// both in a gradient of the theme's accent, then the question and a tip
// that changes every few seconds. Every paragraph is pre-wrapped to the
// chat column (the transcript's own text width) and drawn one centred
// line at a time, so a narrow pane or an open side panel centres the
// words instead of hanging wrapped lines off the pane's edges.
import { For, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { tipAt } from "../assist.js";
import { mix } from "../fx.js";
import { wrapLines } from "../format.js";
import { splashHints, type KeybindStyle } from "../keys.js";
import { useAtui, useTheme } from "./context.js";
import { tick } from "./ticker.js";

/** The bubble with its `❯ _` prompt, tail down at the left, as the app icon draws it. */
const BUBBLE = ["╭────────────╮", "│  ❯   ▁▁▁   │", "╰──╮─────────╯", "   ╰"];

export function Splash(p: { /** The chat column: the width the transcript and composer draw at. */ column: number; question: string; subtitle: string; /** The keys the hint row and tips name: the Emacs chords, or vim's. */ keybinds: KeybindStyle }) {
  const t = useTheme();
  const app = useAtui();
  const size = useTerminalDimensions();
  // The icon's gradient: light at the top left, the accent's deeper tone at the bottom.
  const shade = (row: number, rows: number) => mix(mix(t().accent, "#ffffff", 0.45), mix(t().accent, "#000000", 0.25), row / Math.max(1, rows - 1));
  const tip = () => {
    void tick();
    return tipAt(Date.now(), 8000, p.keybinds);
  };
  const hints = () => splashHints(p.keybinds);
  const big = () => p.column >= 90 && size().height >= 22;
  return (
    <box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center">
      {/* The column the transcript draws at already has its padding taken off, so the splash's
          box takes it back: the empty screen's words wrap exactly where the chat's will. */}
      <box flexDirection="column" width={p.column + 4} paddingLeft={2} paddingRight={2} alignItems="center">
        <Show when={big()}>
          <box flexDirection="row" alignItems="center" marginBottom={1}>
            <box flexDirection="column" marginRight={3}>
              <For each={BUBBLE}>{(line, i) => <text fg={shade(i(), BUBBLE.length)}>{line}</text>}</For>
            </box>
            <ascii_font text="awui" font="block" color={[mix(t().accent, "#ffffff", 0.45), t().accent, mix(t().accent, "#000000", 0.25)]} />
          </box>
        </Show>
        {/* Pre-wrapped, one centred text a line (a plain map, so each line is the box's own
            child and takes its centre axis): a text element that wraps itself hangs its
            shorter lines off its longest one, which reads lopsided on a narrow pane. */}
        {wrapLines(p.question, p.column).map((line) => (
          <text fg={t().text}>
            <b>{line}</b>
          </text>
        ))}
        {wrapLines(p.subtitle, p.column).map((line) => (
          <text fg={t().muted}>{line}</text>
        ))}
        <box marginTop={1}>
          {wrapLines(tip(), Math.max(10, p.column - 5)).map((line, i) => (
            <text fg={t().muted}>
              <Show when={i === 0}>
                <span style={{ fg: app.harness() ? t().accent : t().muted }}>Tip </span>
              </Show>
              {line}
            </text>
          ))}
        </box>
        {/* What an empty screen is for: the keys that get you somewhere in this style, quiet under the tip. */}
        <Show when={p.column >= 57}>
          <text fg={t().border} marginTop={1}>
            <For each={hints()}>
              {(h, i) => (
                <>
                  <Show when={i() > 0}>
                    <span style={{ fg: t().border }}> · </span>
                  </Show>
                  <span style={{ fg: t().text2 }}>{h.key}</span> {h.label}
                </>
              )}
            </For>
          </text>
        </Show>
      </box>
    </box>
  );
}
