// Active work in Tern (the web UI's context panel): the chat's workers, runs, jobs, the requests
// waiting on a person, its comparisons, second opinions, review comments, and the context window,
// as cards of native rows with a status word each. The grouping and the words are shared with the
// browser and atui (web/context-panel.ts's contextCards, atui/rail.ts's flat list and summary), so
// the three clients agree on what exists; this file only lays it out as Tern nodes. Tern draws it
// but never takes the keyboard: app.ts keeps the selected row and closes it on Esc.
import { span, ui, type IconName, type Node } from "@stencil-hq/tern";
import type { ContextCard, ContextSectionId, StatusTone } from "../web/context-panel.js";
import { railEntries, railSummary } from "../atui/rail.js";
import { workAfterSegment, workSegments, type Turn } from "../web/turns.js";

/** The glyph each card's rows carry, so a group reads at a glance. */
const CARD_ICON: Record<ContextSectionId, IconName> = {
  agents: "agents",
  tasks: "task",
  jobs: "job",
  questions: "question",
  races: "split",
  opinions: "sparkle",
  review: "pencil",
  memory: "gauge",
};

/** A status tone as Tern's own colour. */
const TONE: Record<StatusTone, string> = { working: "accent", waiting: "warning", done: "success", failed: "error", quiet: "muted" };

export interface RailCx {
  chat: { title: string; harnessId: string; workspace: string };
  cards: ContextCard[];
  /** The selected row, as an index into the flat list of every card's rows. */
  selected: number;
  /** The project's branch and files, when git answered (the browser's summary card). */
  project: string | null;
  on: { close: () => void; select: (index: number) => void; pick: (index: number) => void };
}

/**
 * The rail: the chat's own summary, then one card a group. A row is Tern's own list item — its
 * title, the small print under it, and its status word at the right edge — so a click and a key
 * both open it. The item keys are the flat row index, which is how app.ts finds what was picked.
 */
export function railNode(cx: RailCx): Node {
  const entries = railEntries(cx.cards);
  let index = 0;
  const cards = cx.cards.map((card) => {
    const first = index;
    index += card.rows.length;
    return ui.card(
      {
        key: card.id,
        head: [span(card.label, "strong"), span(`  ${card.count > 0 ? card.count : ""}`, "muted")],
        ...(card.attention ? { meta: [span("●", card.attention === "warn" ? "warning" : "accent")] } : {}),
        variant: "bare",
      },
      ui.list(
        {
          key: "l",
          selected: cx.selected >= first && cx.selected < first + card.rows.length ? `layer.rail.${card.id}.l.r${cx.selected}` : undefined,
          max: { lines: Math.max(2, card.rows.length) },
          onSelect: (e) => {
            const n = Number(/\.r(\d+)$/.exec(e.item)?.[1] ?? -1);
            if (n >= 0) cx.on.select(n);
          },
          onActivate: (e) => {
            const n = Number(/\.r(\d+)$/.exec(e.item)?.[1] ?? -1);
            if (n >= 0) cx.on.pick(n);
          },
        },
        card.rows.map((row, i) => {
          const n = first + i;
          return ui.item({
            key: `r${n}`,
            label: row.title,
            detail: row.meta,
            value: [span(row.status.word, TONE[row.status.tone])],
            icon: CARD_ICON[card.id],
            ...(row.note ? { hint: [row.note] } : {}),
          });
        }),
      ),
    );
  });
  const selected = entries[cx.selected];
  return ui.overlay(
    {
      key: "rail",
      anchor: "center",
      size: "lg",
      head: "Active work",
      meta: [span(railSummary(cx.cards), "muted")],
      end: ui.button({ key: "close", text: "Close", keys: ["esc"], variant: "quiet", size: "sm", onClick: cx.on.close }),
      foot: ui.text({ key: "keys" }, [
        span("↑/↓ row · Enter opens", "muted"),
        ...(selected?.row.target.kind === "chat" ? [span(" · o opens the chat", "muted")] : []),
        span(" · Esc closes", "muted"),
      ]),
    },
    ui.scroll(
      { key: "body", gap: "md" },
      ui.col(
        { key: "head", gap: "xs" },
        ui.text({ key: "title" }, span(cx.chat.title, "strong"), span(`  ${cx.chat.harnessId} · ${cx.chat.workspace}`, "muted")),
        ...(cx.project ? [ui.text({ key: "git" }, span(cx.project, "muted"))] : []),
      ),
      ...(cards.length > 0 ? cards : [ui.text({ key: "none" }, span("Nothing to show: this chat has no workers, runs, or comments yet.", "muted"))]),
    ),
  );
}

/**
 * Where the conversation drew a tool call: the turn holding it, the key of the fold it is in (the
 * folds map's), and its row's node id under the conversation's column `page`. The rail's run and
 * job rows open the call they came from, and a call inside folded work is revealed by these.
 */
export function toolPlace(turns: Turn[], toolId: string, page: string): { turn: number; fold: string; row: string } | null {
  for (let t = 0; t < turns.length; t++) {
    const turn = turns[t] as Turn;
    // A turn without a prompt draws no fold (its rows stand bare), so there is nothing to open there.
    if (!turn.prompt) continue;
    const stretches = workSegments(turn).map((segment, i) => ({ segment, node: `w${i}` }));
    const after = workAfterSegment(turn);
    if (after) stretches.push({ segment: after, node: "after" });
    for (const { segment, node } of stretches) {
      const call = segment.items.find((item) => item.id === toolId);
      if (call) return { turn: t, fold: segment.key, row: `${page}.${turn.id}.${node}.items.${call.id}` };
    }
  }
  return null;
}
