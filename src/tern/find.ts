// Find in chat for the Tern client: the web UI's Ctrl+F, as a list of places to go. The browser
// walks its DOM and paints matches; Tern has no DOM, so this works out where each match is in the
// view's node tree (the ids `view.ts` gives its keys) and the app opens the fold and reveals it.
// Matching is the web UI's (`web/find.ts`), so both clients find the same words.
import type { ChatItem, UserItem } from "../shared/protocol.js";
import type { Turn } from "../web/turns.js";
import { workAfterSegment, workSegments } from "../web/turns.js";
import { findOffsets } from "../web/find.js";
import { toolSentence } from "../web/tool-sentence.js";

/** The most places one query lists: a common word in a long chat would otherwise fill the sheet. */
export const FIND_LIMIT = 50;

/** One place a query was found, and the row to reveal. */
export interface FindHit {
  /** The turn's index in `turns`, so the app can widen the window to show it. */
  turn: number;
  /** The node's id under the conversation's column (`PAGE_ID`). */
  node: string;
  /** The fold to open first (`w0`, `w1`, …, `after`), or null when the row is not in one. */
  fold: string | null;
  /** The fold's key in the client's folds map (`<turn id>#<n>`, `<turn id>#after`), or null. */
  foldKey: string | null;
  /** The row as the picker names it: "You: …", "Ran npm test", "Answer: …". */
  label: string;
  /** The words around the first match, one line. */
  detail: string;
}

/** The words around a match: 28 characters each way, cut at the ends of the line. */
function around(line: string, at: number, length: number): string {
  const from = Math.max(0, at - 28);
  const to = Math.min(line.length, at + length + 28);
  return `${from > 0 ? "…" : ""}${line.slice(from, to)}${to < line.length ? "…" : ""}`;
}

/** A row's label cut to one line: the picker's detail carries the match itself. */
function label(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 64 ? `${line.slice(0, 63)}…` : line;
}

/** A tool call's searchable words: what the row says plus its output, as the browser searches the drawn row. */
function toolText(item: Extract<ChatItem, { kind: "tool" }>): string {
  const sentence = toolSentence(item, "");
  return [item.name, item.summary, sentence.text, ...sentence.facts, sentence.error ?? "", item.output].join("\n");
}

/** What a plain item (a notice, a request) says. */
function plainText(item: ChatItem): string {
  if (item.kind === "notice") return `${item.text}\n${item.detail ?? ""}`;
  if (item.kind === "request") return `${item.request.title}\n${item.request.message ?? ""}\n${item.outcome ?? ""}`;
  return "";
}

interface Unit {
  text: string;
  label: string;
  node: string;
  fold: string | null;
  foldKey: string | null;
}

/**
 * The places a query is found in `turns`, in reading order: each prompt, every row of work (inside
 * its fold, with the fold to open), plans, rendered pages, replies, the answer, and the notes after
 * it. At most `FIND_LIMIT`, and at most one hit per row (the first match, its words, how many).
 */
export function findHits(turns: readonly Turn[], page: string, query: string): FindHit[] {
  const q = query.trim();
  if (!q) return [];
  const out: FindHit[] = [];
  const add = (turn: number, unit: Unit) => {
    if (out.length >= FIND_LIMIT) return;
    const line = unit.text.replace(/\s+/g, " ").trim();
    const offsets = findOffsets(line, q);
    const at = offsets[0];
    if (at === undefined) return;
    out.push({
      turn,
      node: unit.node,
      fold: unit.fold,
      foldKey: unit.foldKey,
      label: unit.label,
      detail: `${around(line, at, q.length)}${offsets.length > 1 ? `  (${offsets.length} matches)` : ""}`,
    });
  };
  turns.forEach((turn, i) => {
    const at = `${page}.${turn.id}`;
    const row = (fold: string | null, foldKey: string | null, item: ChatItem) => {
      const node = `${at}.${fold ? `${fold}.items.` : ""}${item.id}`;
      if (item.kind === "tool") {
        // The row's own words ("Asked tracker: triage ticket"), not its raw arguments: the detail carries the match.
        add(i, { text: toolText(item), label: label(toolSentence(item, "").text || item.name), node, fold, foldKey });
      } else if (item.kind === "assistant") {
        if (item.text.trim()) add(i, { text: item.text, label: `Reply: ${label(item.text)}`, node, fold, foldKey });
        // A thought is its own node beside the reply, keyed `<item id>~t`.
        if (item.thinking.trim()) add(i, { text: item.thinking, label: `Thought: ${label(item.thinking)}`, node: `${node}~t`, fold, foldKey });
      } else {
        const text = plainText(item);
        add(i, { text, label: label(text) || item.kind, node, fold, foldKey });
      }
    };
    if (turn.prompt) {
      const p = turn.prompt as UserItem;
      add(i, { text: p.text, label: `You: ${label(p.text)}`, node: `${at}.ask.p`, fold: null, foldKey: null });
      workSegments(turn).forEach((segment, n) => {
        for (const item of segment.items) row(`w${n}`, segment.key, item);
        // The answer's own thinking is drawn in the stretch it belongs to, keyed by the answer's id and `~t`.
        if (segment.answerAt >= 0 && turn.answer?.thinking.trim()) {
          const thought = turn.answer;
          add(i, { text: thought.thinking, label: `Thought: ${label(thought.thinking)}`, node: `${at}.w${n}.items.${thought.id}~t`, fold: `w${n}`, foldKey: segment.key });
        }
        if (segment.reply) add(i, { text: segment.reply.text, label: `Reply: ${label(segment.reply.text)}`, node: `${at}.r${n}`, fold: null, foldKey: null });
      });
      const after = workAfterSegment(turn);
      for (const item of after?.items ?? []) row("after", after?.key ?? `${turn.id}#after`, item);
      for (const plan of turn.plans) add(i, { text: plan.plan, label: `Plan: ${label(plan.plan)}`, node: `${at}.plan-${plan.id}.m`, fold: null, foldKey: null });
      for (const rendered of turn.renders) add(i, { text: rendered.title, label: `Page: ${label(rendered.title)}`, node: `${at}.page-${rendered.id}`, fold: null, foldKey: null });
    } else {
      // A turn without a prompt draws its rows bare: no fold to open.
      for (const item of [...turn.process, ...turn.workAfter]) row(null, null, item);
    }
    const answer = turn.answer;
    if (answer?.text.trim()) add(i, { text: answer.text, label: `Answer: ${label(answer.text)}`, node: `${at}.answer`, fold: null, foldKey: null });
    for (const e of turn.errors) add(i, { text: e.text, label: `Error: ${label(e.text)}`, node: `${at}.${e.id}`, fold: null, foldKey: null });
    for (const n of turn.after) add(i, { text: n.text, label: `Note: ${label(n.text)}`, node: `${at}.${n.id}`, fold: null, foldKey: null });
  });
  return out;
}
