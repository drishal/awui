// A search box over a list, centred over the screen: the C-k palette and
// the model and harness pickers. Matching is the web palette's (rankItems);
// the letters that matched are drawn brighter. A picker given `preview`
// (history) shows the highlighted item beside the list on a wide terminal.
import { createEffect, createMemo, createResource, createSignal, For, Index, on, Show } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { rankItems, type PaletteItem } from "../../web/palette.js";
import { matchSpans } from "../assist.js";
import { clip } from "../format.js";
import { mix } from "../fx.js";
import { useTheme } from "./context.js";

/** A row that also draws a span of a track (a step's place on a turn's time, a day's share of the busiest): `[from, to]`, each 0 to 1. */
export type PickerItem = PaletteItem & { bar?: [number, number] };

/** The track as a run of rule, a solid run, the eighth-block edge that finishes it, and the rule after. The start rounds to a cell, the end to an eighth, so equal times draw equal bars and a few hundred milliseconds show. */
const EDGES = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
function trackParts(bar: [number, number], cells: number): { before: string; solid: number; edge: string; after: string } {
  // A span of exactly nothing from nothing (a day with no use) draws no track at all: a full rule would read as the longest bar. An instant step still gets its sliver.
  if (bar[0] === 0 && bar[1] === 0) return { before: " ".repeat(cells), solid: 0, edge: "", after: "" };
  const start = Math.min(cells - 1, Math.max(0, Math.round(bar[0] * cells)));
  const width8 = Math.max(2, Math.round((bar[1] - bar[0]) * cells * 8));
  const end8 = Math.min((cells - start) * 8, width8);
  const solid = Math.floor(end8 / 8);
  const edge = EDGES[end8 % 8] ?? "";
  return { before: "─".repeat(start), solid, edge, after: "─".repeat(Math.max(0, cells - start - solid - (edge ? 1 : 0))) };
}

/** A scale's labels set along `cells` columns, each centred on its tick and kept inside the track. A label that would touch the one before it is left out, except the last (the axis's end), which wins the place instead. */
function axisLine(ticks: Array<{ at: number; label: string }>, cells: number): string {
  const placed: Array<{ from: number; label: string }> = [];
  ticks.forEach((tick, n) => {
    const centre = Math.round(tick.at * (cells - 1));
    const from = Math.max(0, Math.min(cells - tick.label.length, centre - Math.floor(tick.label.length / 2)));
    const before = placed[placed.length - 1];
    const touches = before !== undefined && from <= before.from + before.label.length;
    if (touches && n === ticks.length - 1) placed.pop();
    else if (touches) return;
    placed.push({ from, label: tick.label });
  });
  const line: string[] = Array(cells).fill(" ");
  for (const item of placed) [...item.label].forEach((c, k) => (line[item.from + k] = c));
  return line.join("");
}

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
  items: PickerItem[];
  onClose: () => void;
  firstHeading?: boolean;
  preview?: (item: PaletteItem) => Promise<PreviewText | null> | null;
  /** Items made from the query itself (find in chat): instead of ranking `items`, which stay empty. Nothing is listed until something is typed. */
  search?: (query: string) => PaletteItem[];
  /** Rows that only inform (timing, usage): nothing is highlighted, and Enter just closes. */
  info?: boolean;
  /** A key pressed over the highlighted row, when the query is empty (the queue picker's `x` removes): true when it took the key. */
  onRowKey?: (key: string, item: PickerItem | undefined) => boolean;
  /** What the list says when it has no rows at all and nothing is typed ("No queued messages"), instead of "Nothing matches". */
  empty?: string;
  /** Tab does this (the usage picker's 7, 30, 90 days). */
  onTab?: () => void;
  /** A scale for the bar rows under the first heading: labels at fractions (0 to 1) of the track, from the same ticks the web draws. */
  axis?: Array<{ at: number; label: string }>;
  /** The title over the bar rows' figure column ("start     took"), set at the right of the scale's line. */
  axisHead?: string;
  /** What Tab does, in words ("Tab: 30 days"): it leads the key hints, so the title stays a name. */
  tabHint?: string;
  /** What a row is, for the match count when a row is not one match (find lists turns): singular and plural. */
  noun?: [string, string];
  /** Columns the side panel takes: the picker fits what is left of the screen, never under the panel. */
  side?: number;
}) {
  const t = useTheme();
  const size = useTerminalDimensions();
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  const shown = createMemo((): PickerItem[] => (p.search ? p.search(query()) : (rankItems(p.items, query()) as PickerItem[])));
  createEffect(
    on(shown, (list) => {
      const first = list.findIndex((i) => !i.disabled);
      setActive(first < 0 ? 0 : first);
    }),
  );
  const room = () => size().width - (p.side ?? 0);
  const previewing = () => Boolean(p.preview) && room() >= PREVIEW_WIDTH;
  const width = () => Math.max(30, Math.min(previewing() ? 128 : p.info ? 100 : 72, room() - 4));
  /** The list's own width: all of it, or about half beside a preview. The box's border and padding come off first. */
  const listWidth = () => (previewing() ? Math.min(64, Math.floor(width() * 0.52)) : width() - 4);
  const [shownPreview] = createResource(
    () => (previewing() ? shown()[active()] : undefined),
    (item) => p.preview?.(item) ?? null,
  );
  // The box fits its list: a handful of rows, or "Nothing matches", is not a frame of eighteen empty ones. A preview keeps the tall box.
  const rowsNeeded = () => {
    const list = shown();
    const headings = query().trim() ? 0 : list.filter((item, at) => (at === 0 ? Boolean(p.firstHeading) : list[at - 1]?.section !== item.section)).length;
    return Math.max(1, list.length) + headings * 2 + (p.axis ? 1 : 0);
  };
  const height = () => Math.min(previewing() ? 22 : Math.max(8, rowsNeeded() + 5), 22, size().height - 4);
  /** Is a heading drawn above row `at`? Not while a query is typed; the first one only when the picker names it. */
  const headed = (list: PickerItem[], at: number) => !query().trim() && (list[at - 1]?.section !== list[at]?.section) && (at > 0 || Boolean(p.firstHeading));
  /** Lines a row takes: itself, a heading over it, and a blank line above a heading that is not the first. */
  const cost = (list: PickerItem[], at: number) => 1 + (at === 0 && p.axis ? 1 : 0) + (headed(list, at) ? (at > 0 ? 2 : 1) : 0);
  /** A bar row's label column: the track starts here, a little over a third of the list. */
  const barLabel = () => Math.max(18, Math.floor(listWidth() * (listWidth() > 70 ? 0.4 : 0.37)));
  /** The track takes what the label and the widest figure leave, so a wide sheet has a long bar and no dead gap: 12 cells at least, 44 at most. */
  const track = (section?: string) => {
    const figures = Math.max(0, ...shown().filter((i) => i.bar && (section === undefined || i.section === section)).map((i) => (i.hint ?? "").length));
    return Math.max(12, Math.min(44, listWidth() - barLabel() - figures - 3));
  };
  const lines = () => height() - 5;
  /** The rows that fit: from the first one that keeps the highlighted row in view, as many as the box holds, and the room a "more below" line takes. */
  const windowed = createMemo(() => {
    const list = shown();
    const room = lines();
    const fit = (from: number, budget: number) => {
      let used = 0;
      let to = from;
      while (to < list.length && used + cost(list, to) <= budget) used += cost(list, to++);
      return to;
    };
    let from = 0;
    const budget = list.length > 0 && fit(0, room) < list.length ? room - 1 : room;
    while (from < list.length - 1 && fit(from, budget) <= active()) from++;
    const to = fit(from, budget);
    return { from, to, more: list.length - to };
  });

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
    if (!p.info) item.run();
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
    } else if (p.onRowKey && !query() && !key.ctrl && !key.meta && key.name.length === 1 && p.onRowKey(key.name, shown()[active()])) {
      key.preventDefault();
    } else if (key.name === "tab" && p.onTab) {
      key.preventDefault();
      p.onTab();
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
        <span style={{ fg: t().muted }}>{`   ${p.tabHint ? `${p.tabHint} · ` : ""}↑↓ Enter · Esc`}</span>
      </text>
      <box flexDirection="row" flexShrink={0}>
        <text fg={t().accent} flexShrink={0}>{"› "}</text>
        <input focused flexGrow={1} placeholder={p.placeholder} textColor={t().text} backgroundColor={t().surface} focusedBackgroundColor={t().surface} onInput={(value: string) => setQuery(value)} />
        <Show when={query().trim()}>
          <text fg={t().muted} flexShrink={0}>{`${shown().length} ${shown().length === 1 ? (p.noun?.[0] ?? "match") : (p.noun?.[1] ?? "matches")}`}</text>
        </Show>
      </box>
      <box flexDirection="row" flexGrow={1} marginTop={1}>
        <box flexDirection="column" width={listWidth()} flexShrink={0}>
          <For each={shown().slice(windowed().from, windowed().to)}>
            {(item, i) => {
              const at = () => i() + windowed().from;
              const lit = () => !p.info && at() === active();
              return (
                <box flexDirection="column">
                  <Show when={headed(shown(), at())}>
                    <text fg={t().muted} marginTop={at() > 0 ? 1 : 0}><b>{item.section}</b></text>
                  </Show>
                  <Show when={at() === 0 && p.axis && item.bar}>
                    <box flexDirection="row" flexShrink={0}>
                      <text fg={t().muted} flexShrink={0} wrapMode="none">{`${" ".repeat(barLabel())}${axisLine(p.axis ?? [], track(item.section))}`}</text>
                      <box flexGrow={1} flexDirection="row" justifyContent="flex-end"><text fg={t().muted} wrapMode="none">{p.axisHead ? `${p.axisHead}` : ""}</text></box>
                    </box>
                  </Show>
                  <box flexDirection="row" backgroundColor={lit() ? t().selection : undefined} onMouseDown={() => run(item)}>
                    <text flexGrow={item.bar ? 0 : 1} width={item.bar ? barLabel() : undefined} fg={item.disabled ? t().muted : lit() ? t().text : t().text2} wrapMode="none" truncate>
                      {item.current ? "✓ " : "  "}
                      <Index each={matchSpans(clip(item.label, item.bar ? barLabel() - 3 : listWidth() - 3 - (item.hint ? Math.min(item.hint.length, listWidth() >= 60 ? 30 : 18) + 3 : 0)), query())}>
                        {(part) => <span style={part().hit && !item.disabled ? { fg: t().accent } : {}}>{part().text}</span>}
                      </Index>
                    </text>
                    {/* A bar row reads label, track, then the figures, so the track sits beside what it measures. */}
                    <Show when={item.bar}>
                      {(bar) => (
                        <text flexShrink={0} fg={t().muted}>
                          {trackParts(bar(), track(item.section)).before}
                          <span style={{ bg: t().accent }}>{" ".repeat(trackParts(bar(), track(item.section)).solid)}</span>
                          <span style={{ fg: t().accent, bg: mix(t().surface, t().accent, 0.5) }}>{trackParts(bar(), track(item.section)).edge}</span>
                          {trackParts(bar(), track(item.section)).after}
                        </text>
                      )}
                    </Show>
                    <Show when={item.hint}>
                      {/* A bar row's figures sit at the right edge, so one column of them lines up down the sheet. */}
                      <box flexGrow={item.bar ? 1 : 0} flexShrink={item.bar ? 1 : 0} flexDirection="row" justifyContent={item.bar ? "flex-end" : undefined}>
                        <text flexShrink={item.bar ? 1 : 0} wrapMode="none" truncate fg={t().muted}>{` ${item.bar ? item.hint : clip(item.hint ?? "", listWidth() >= 60 ? 30 : 18)}`}</text>
                      </box>
                    </Show>
                  </box>
                </box>
              );
            }}
          </For>
          <Show when={windowed().more > 0}>
            <text fg={t().muted}>{`  ↓ ${windowed().more} more`}</text>
          </Show>
          <Show when={shown().length === 0}>
            <text fg={t().muted}>{p.search && !query().trim() ? p.placeholder : p.empty && !query().trim() ? p.empty : `Nothing matches “${query().trim()}”`}</text>
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
