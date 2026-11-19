// The C-x prefix's panel, as Emacs's which-key draws it: after C-x, every key
// and what it does in columns above the status line (`b → side panel (on)`,
// menus in their own colour), until a key is pressed or Esc/C-g cancels. State
// that a key toggles is shown beside it. Every line fits its column's cell
// (keys.js), so the columns never cut into one another.
import { For } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { LEADER_KEYS, whichKeyColumns, WHICH_KEY_CELL, type PrefixKey } from "../keys.js";
import { useTheme } from "./context.js";

export function WhichKey(p: { state: Partial<Record<string, string>>; onPick: (key: string) => void }) {
  const t = useTheme();
  const size = useTerminalDimensions();
  // A narrow pane keeps its columns by trimming the panel's padding to one column.
  const pad = () => (size().width < 90 ? 1 : 2);
  const columns = () => whichKeyColumns(LEADER_KEYS, size().width - pad() * 2, WHICH_KEY_CELL);
  const label = (k: PrefixKey) => (p.state[k.key] ? `${k.label} (${p.state[k.key]})` : k.label);
  return (
    <box flexDirection="row" flexShrink={0} border={["top"]} borderColor={t().border} paddingLeft={pad()} paddingRight={pad()} backgroundColor={t().bg}>
      <For each={columns()}>
        {(column) => (
          <box flexDirection="column" width={WHICH_KEY_CELL} flexShrink={0}>
            <For each={column}>
              {(k) => (
                <text wrapMode="none" truncate onMouseDown={() => p.onPick(k.key)}>
                  <span style={{ fg: t().accent }}>{k.key}</span>
                  <span style={{ fg: t().muted }}>{" → "}</span>
                  <span style={{ fg: k.menu ? t().thinking : t().text2 }}>{label(k)}</span>
                </text>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  );
}
