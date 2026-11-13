// The screen while a session opens (the web UI's SwitchSplash): the
// session's title and harness at once, over a ghost of a thread (a prompt
// card, a fold, an answer's lines) with a band of light sweeping across it,
// so a switch shows something the moment it is asked for, and the thread
// takes its place when it arrives.
import { Index, Show } from "solid-js";
import { ghostLines, mix, shimmer } from "../fx.js";
import { harnessGlyph } from "../neat.js";
import { accentOf } from "../theme.js";
import { useAtui, useTheme } from "./context.js";
import { Spinner } from "./fx.js";
import { tick } from "./ticker.js";

/** A bar of the ghost: the sweep reaches lower rows a little later, so it runs down the thread as well as across. */
function Bar(p: { width: number; row: number }) {
  const t = useTheme();
  const colors = () => shimmer(p.width, tick() * 2 - p.row * 3, mix(t().bg, t().border, 0.7), mix(t().bg, t().muted, 0.75), 8);
  return (
    <text wrapMode="none">
      <Index each={colors()}>{(c) => <span style={{ fg: c() }}>━</span>}</Index>
    </text>
  );
}

export function SwitchGhost(p: { title: string; harnessId: string; column: () => number }) {
  const app = useAtui();
  const t = useTheme();
  const harness = () => app.boot()?.harnesses.find((h) => h.id === p.harnessId);
  // The transcript's column, as app.tsx reads it from the chat width.
  const layout = () => ghostLines(p.column());
  return (
    <box flexDirection="column" flexGrow={1} alignItems="center" paddingLeft={2} paddingRight={2}>
      <box flexDirection="column" width="100%" maxWidth={p.column()}>
        <text marginTop={1} wrapMode="none" truncate>
          <Spinner harnessId={p.harnessId} color={accentOf(t(), harness()?.accent)} />
          <span style={{ fg: t().muted }}>{" Opening "}</span>
          <span style={{ fg: t().text }}>{p.title}</span>
          <Show when={harness()}>{(h) => <span style={{ fg: accentOf(t(), h().accent) }}>{`  ${harnessGlyph(h().id)} ${h().displayName}`}</span>}</Show>
        </text>
        <box border borderStyle="rounded" borderColor={mix(t().bg, t().border, 0.8)} paddingLeft={1} paddingRight={1} marginTop={1}>
          <Bar width={layout().prompt} row={0} />
        </box>
        <box flexDirection="column" marginTop={1}>
          <Index each={layout().lines}>{(w, i) => (w() > 0 ? <Bar width={w()} row={i + 2} /> : <text> </text>)}</Index>
        </box>
      </box>
    </box>
  );
}
