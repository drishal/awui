// The empty screen before a chat's first message: awui's chat-bubble mark
// (design/icon) drawn in box characters beside the name in a block font,
// both in a gradient of the theme's accent, then the question and a tip
// that changes every few seconds.
import { For, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { tipAt } from "../assist.js";
import { mix } from "../fx.js";
import { useAtui, useTheme } from "./context.js";
import { tick } from "./ticker.js";

/** The bubble with its `❯ _` prompt, tail down at the left, as the app icon draws it. */
const BUBBLE = ["╭────────────╮", "│  ❯   ▁▁▁   │", "╰──╮─────────╯", "   ╰"];

export function Splash(p: { question: string; subtitle: string }) {
  const t = useTheme();
  const app = useAtui();
  const size = useTerminalDimensions();
  // The icon's gradient: light at the top left, the accent's deeper tone at the bottom.
  const shade = (row: number, rows: number) => mix(mix(t().accent, "#ffffff", 0.45), mix(t().accent, "#000000", 0.25), row / Math.max(1, rows - 1));
  const tip = () => {
    void tick();
    return tipAt(Date.now());
  };
  const big = () => size().width >= 90 && size().height >= 22;
  return (
    <box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center">
      <Show when={big()}>
        <box flexDirection="row" alignItems="center" marginBottom={1}>
          <box flexDirection="column" marginRight={3}>
            <For each={BUBBLE}>{(line, i) => <text fg={shade(i(), BUBBLE.length)}>{line}</text>}</For>
          </box>
          <ascii_font text="awui" font="block" color={[mix(t().accent, "#ffffff", 0.45), t().accent, mix(t().accent, "#000000", 0.25)]} />
        </box>
      </Show>
      <text fg={t().text}>
        <b>{p.question}</b>
      </text>
      <text fg={t().muted}>{p.subtitle}</text>
      <box marginTop={1}>
        <text fg={t().muted}>
          <span style={{ fg: app.harness() ? t().accent : t().muted }}>Tip </span>
          {tip()}
        </text>
      </box>
      {/* What an empty screen is for: the three keys that get you somewhere, quiet under the tip. */}
      <Show when={size().width >= 60}>
        <text fg={t().border} marginTop={1}>
          <span style={{ fg: t().text2 }}>C-k</span> commands{" "}
          <span style={{ fg: t().border }}>·</span> <span style={{ fg: t().text2 }}>C-r</span> history{" "}
          <span style={{ fg: t().border }}>·</span> <span style={{ fg: t().text2 }}>C-x s</span> sessions{" "}
          <span style={{ fg: t().border }}>·</span> <span style={{ fg: t().text2 }}>@</span> files
        </text>
      </Show>
    </box>
  );
}
