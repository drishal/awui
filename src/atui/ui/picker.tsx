// A search box over a list, centred over the screen: the C-k palette and
// the model and harness pickers. Matching is the web palette's (rankItems);
// the letters that matched are drawn brighter. A picker given `preview`
// (history) shows the highlighted item beside the list on a wide terminal.
import { createEffect, createMemo, createResource, createSignal, For, Index, on, Show } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { rankItems, type PaletteItem } from "../../web/palette.js";
import { matchSpans } from "../assist.js";
import { clip } from "../format.js";
import { useTheme } from "./context.js";

/** What a preview pane shows: a heading and the text under it. */
export interface PreviewText {
  head: string;
  body: string;
}

/** From this terminal width a picker with a preview shows it. */
const PREVIEW_WIDTH = 110;

const PAGE = 8;

/** `firstHeading`: name the first section too (the palette's "Actions" goes without saying; a project or "Hand off" does not). */
export function Picker(p: {
  title: string;
  placeholder: string;
  items: PaletteItem[];
  onClose: () => void;
  firstHeading?: boolean;
  preview?: (item: PaletteItem) => Promise<PreviewText | null> | null;
  /** Columns the side panel takes: the picker fits what is left of the screen, never under the panel. */
  side?: number;
}) {
  const t = useTheme();
  const size = useTerminalDimensions();
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  const shown = createMemo(() => rankItems(p.items, query()));
  createEffect(
    on(shown, (list) => {
      const first = list.findIndex((i) => !i.disabled);
      setActive(first < 0 ? 0 : first);
    }),
  );
  const room = () => size().width - (p.side ?? 0);
  const previewing = () => Boolean(p.preview) && room() >= PREVIEW_WIDTH;
  const width = () => Math.max(30, Math.min(previewing() ? 128 : 72, room() - 4));
  /** The list's own width: all of it, or about half beside a preview. */
  const listWidth = () => (previewing() ? Math.min(64, Math.floor(width() * 0.52)) : width() - 2);
  const [shownPreview] = createResource(
    () => (previewing() ? shown()[active()] : undefined),
    (item) => p.preview?.(item) ?? null,
  );
  const height = () => Math.min(22, size().height - 4);
  const visible = () => height() - 4;
  const offset = () => Math.max(0, Math.min(active() - Math.floor(visible() / 2), shown().length - visible()));

  const move = (step: number) => {
    const list = shown();
    if (list.length === 0) return;
    let i = active();
    for (let n = 0; n < Math.abs(step); n++) {
      let next = i;
      do next += Math.sign(step);
      while (next >= 0 && next < list.length && list[next]?.disabled);
      if (next < 0 || next >= list.length) break;
      i = next;
    }
    setActive(i);
  };

  const run = (item: PaletteItem | undefined) => {
    if (!item || item.disabled) return;
    p.onClose();
    item.run();
  };

  useKeyboard((key) => {
    if (key.defaultPrevented) return;
    const step = ({ down: 1, up: -1, pagedown: PAGE, pageup: -PAGE } as Record<string, number>)[key.name];
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      key.preventDefault();
      p.onClose();
    } else if (step !== undefined) {
      key.preventDefault();
      move(step);
    } else if (key.name === "return") {
      key.preventDefault();
      run(shown()[active()]);
    }
  });

  return (
    <box
      alignSelf="center"
      marginTop={1}
      width={width()}
      height={height()}
      flexShrink={0}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={t().accent}
      backgroundColor={t().surface}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={t().muted}>
        <b>{p.title}</b>
        <span style={{ fg: t().muted }}>{"   ↑↓ Enter · Esc"}</span>
      </text>
      <input focused placeholder={p.placeholder} textColor={t().text} backgroundColor={t().surface} focusedBackgroundColor={t().surface} onInput={(value: string) => setQuery(value)} />
      <box flexDirection="row" flexGrow={1} marginTop={1}>
        <box flexDirection="column" width={listWidth()} flexShrink={0}>
          <For each={shown().slice(offset(), offset() + visible())}>
            {(item, i) => {
              const at = () => i() + offset();
              const head = () => at() === 0 || shown()[at() - 1]?.section !== item.section;
              return (
                <box flexDirection="column">
                  <Show when={head() && (i() > 0 || p.firstHeading)}>
                    <text fg={t().muted}>{item.section}</text>
                  </Show>
                  <box flexDirection="row" backgroundColor={at() === active() ? t().selection : undefined} onMouseDown={() => run(item)}>
                    <text flexGrow={1} fg={item.disabled ? t().muted : at() === active() ? t().text : t().text2} wrapMode="none" truncate>
                      {item.current ? "✓ " : "  "}
                      <Index each={matchSpans(clip(item.label, listWidth() - 20), query())}>
                        {(part) => <span style={part().hit && !item.disabled ? { fg: t().accent } : {}}>{part().text}</span>}
                      </Index>
                    </text>
                    <Show when={item.hint}>
                      <text flexShrink={0} fg={t().muted}>{` ${clip(item.hint ?? "", 18)}`}</text>
                    </Show>
                  </box>
                </box>
              );
            }}
          </For>
          <Show when={shown().length === 0}>
            <text fg={t().muted}>{`Nothing matches “${query().trim()}”`}</text>
          </Show>
        </box>
        <Show when={previewing()}>
          <box flexDirection="column" flexGrow={1} border={["left"]} borderColor={t().border} paddingLeft={1} overflow="hidden">
            <Show when={shownPreview()} fallback={<text fg={t().muted}>{shownPreview.loading ? "…" : "No preview"}</text>}>
              {(view) => (
                <>
                  <text fg={t().text2} wrapMode="word">
                    <b>{view().head}</b>
                  </text>
                  <text fg={t().muted} wrapMode="word" marginTop={1}>
                    {view().body}
                  </text>
                </>
              )}
            </Show>
          </box>
        </Show>
      </box>
    </box>
  );
}
