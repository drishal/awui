// Context occupancy ring, for every harness that reports its own figure (Pi,
// omp, Hermes, Claude Code, Codex, Grok, DeepSeek Harness, OpenCode). Its
// popover holds the whole picture, in DeepSeek Harness's sections: what fills
// the context window, the session's tokens, and model timing. On a phone the
// popover is the same body drawn as a bottom sheet (Dialog); the desktop keeps
// the anchored popover. Its foot opens the full view — the same sections at a
// dialog's width, plus the space left and the latest turn's time (TimingView).
// Hidden until the harness reports a percentage (context-tone.ts holds that
// rule and the amber/red lines). Beside it, the draft's estimated size once it
// is worth a mention (token-estimate.ts), which stays even where the ring is
// hidden; the panel adds what sending it does to the context.
import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatItem, ChatStatus, ContextCategory, ContextPoint, ContextUsage, SessionUsage } from "../../shared/protocol.js";
import { contextTone, hasContextFigure } from "../context-tone.js";
import { coarse } from "../gestures.js";
import { useDismiss, useLeave } from "../hooks.js";
import { sparkline, SPARK_H, SPARK_W } from "../sparkline.js";
import { type DraftSize, draftRow, draftSize, draftWarning } from "../token-estimate.js";
import { buildTurns, type Turn } from "../turns.js";
import { Dialog } from "./Dialog.js";
import { IconChevronRight } from "../icons.js";
import { TimingView } from "./TimingView.js";
import { Dot } from "./Dot.js";
import { Rolling } from "./Rolling.js";

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return String(n);
}

const full = (n: number) => n.toLocaleString("en-US");

function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/** Category colours: the system prompt grey, tools purple, messages blue (DeepSeek Harness), the rest after. */
const SWATCH: Record<string, string> = {
  system: "var(--muted-text)",
  "system-prompt": "var(--muted-text)",
  tools: "var(--thinking)",
  "system-tools": "var(--thinking)",
  messages: "var(--link)",
  skills: "var(--ok)",
  "system-context": "var(--warn)",
};
const FALLBACK = ["var(--accent)", "var(--danger)", "var(--text-2)"];
const swatch = (c: ContextCategory, i: number) => SWATCH[c.id] ?? FALLBACK[i % FALLBACK.length];

function Row({
  label,
  value,
  color,
  title,
  hover,
  state,
}: {
  label: string;
  value: string;
  color?: string | undefined;
  title?: string;
  /** Makes the row focusable and reports it being looked at (pointer or keyboard); null when it is left. */
  hover?: (on: boolean) => void;
  /** "dim" while another row is looked at; "busy" while the harness works on it (compacting). */
  state?: "dim" | "busy" | undefined;
}) {
  return (
    <div
      className="usage-row"
      title={title}
      data-state={state}
      tabIndex={hover ? 0 : undefined}
      onMouseEnter={hover ? () => hover(true) : undefined}
      onMouseLeave={hover ? () => hover(false) : undefined}
      onFocus={hover ? () => hover(true) : undefined}
      onBlur={hover ? () => hover(false) : undefined}
    >
      <span className="usage-label">
        {color ? <span className="usage-swatch" style={{ background: color }} aria-hidden="true" /> : null}
        {label}
      </span>
      <span className="usage-value">{value}</span>
    </div>
  );
}

/** A share of the window as the headline writes it. */
const share = (pct: number) => (pct < 1 ? "<1%" : `${Math.round(pct)}%`);

/**
 * The sections. Drawn in the anchored popover, the phone's bottom sheet, and the
 * full dialog alike; `onShowMore` adds the popover's foot, and `details` the two
 * parts only the dialog has room for.
 */
function UsageBody({
  context,
  usage,
  draft,
  canCompact,
  history,
  compacting,
  compacted,
  onShowMore,
  details,
  turn,
  workspace,
}: {
  context: ContextUsage;
  usage: SessionUsage | null;
  draft: DraftSize | null;
  canCompact: boolean;
  history: ContextPoint[];
  compacting: boolean;
  compacted: boolean;
  /** The compact view's foot: opens the full dialog. */
  onShowMore?: (() => void) | undefined;
  /** The full dialog: the space left in the window, and the latest turn's time. */
  details: boolean;
  /** The latest turn of the chat, for its waterfall; null where there is none (or none with times). */
  turn: Turn | null;
  workspace: string;
}) {
  const pct = Math.max(0, Math.min(100, context.percent ?? 0));
  const categories = context.categories?.filter((x) => x.tokens > 0) ?? [];
  // Looking at a row (hover or focus) puts that part in the headline and dims the others.
  const [look, setLook] = useState<string | null>(null);
  const looked = categories.find((x) => x.id === look) ?? null;
  const headline = looked ? share((looked.tokens / context.window) * 100) : share(pct);
  const spark = useMemo(() => sparkline(history), [history]);
  const warning = draft ? draftWarning(draft, canCompact) : null;

  const uncached = usage ? usage.input + usage.cacheWrite : 0;
  const inputTotal = usage ? uncached + usage.cachedInput : 0;
  const cacheHit = inputTotal > 0 && usage ? `${Math.round((usage.cachedInput / inputTotal) * 100)}%` : "—";
  const timed = usage !== null && (usage.llmMs !== null || usage.tokensPerSecond !== null);
  // A fresh session has nothing to report but zeros; show those sections after its first model call.
  const used = usage !== null && usage.steps > 0 ? usage : null;

  return (
    <>
      <section className="usage-section" aria-label="Context">
        <div className="usage-head">
          <span>
            <strong data-testid="context-headline">
              <Rolling text={headline} />
            </strong>{" "}
            {looked ? looked.label : "of context used"}
          </span>
          <span className="usage-value">{context.tokens !== null ? `${compact(context.tokens)} / ${compact(context.window)}` : compact(context.window)}</span>
        </div>
        {spark ? (
          <svg className="usage-spark" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} width={SPARK_W} height={SPARK_H} role="img" aria-label={spark.label} data-testid="context-sparkline">
            <line className="usage-spark-warn" x1="0" x2={SPARK_W} y1={spark.warnY} y2={spark.warnY} />
            <path className="usage-spark-line" d={spark.path} fill="none" />
            {spark.points.map((p, i) => (p.drop ? <circle key={i} className="usage-spark-drop" cx={p.x} cy={p.y} r="2.5" /> : null))}
          </svg>
        ) : null}
        <div className="usage-bar" aria-hidden="true">
          {categories.length > 0 ? (
            categories.map((x, i) => (
              <span key={x.id} className={look !== null && look !== x.id ? "is-dim" : undefined} style={{ width: `${(x.tokens / context.window) * 100}%`, background: swatch(x, i) }} />
            ))
          ) : (
            <span style={{ width: `${pct}%`, background: "currentColor" }} />
          )}
        </div>
        {categories.map((x, i) => (
          <Row
            key={x.id}
            label={x.label}
            value={compact(x.tokens)}
            color={swatch(x, i)}
            title={`${full(x.tokens)} tokens (estimated)`}
            hover={(on) => setLook((cur) => (on ? x.id : cur === x.id ? null : cur))}
            state={compacting && x.id === "messages" ? "busy" : look !== null && look !== x.id ? "dim" : undefined}
          />
        ))}
        {details && context.tokens !== null ? (
          <Row label="Free space" value={compact(context.window - context.tokens)} title={`${full(context.window - context.tokens)} tokens left of ${full(context.window)}`} />
        ) : null}
        {compacted ? (
          <p className="usage-note usage-compacted" role="status" data-testid="compacted">
            Compacted ✓
          </p>
        ) : null}
        {draft ? (
          <p className={`usage-note usage-draft${draft.near ? " is-near" : ""}`} data-testid="draft-row">
            {draftRow(draft)}
            {warning ? <strong>{warning}</strong> : null}
          </p>
        ) : null}
      </section>

      {used ? (
        <section className="usage-section" aria-label="Tokens">
          <div className="usage-head">
            <span>Tokens this session</span>
            <span className="usage-value">{full(inputTotal + used.output)}</span>
          </div>
          <Row label="Cache hit" value={cacheHit} />
          <Row label="Uncached input" value={full(uncached)} />
          <Row label="Cached input" value={full(used.cachedInput)} />
          <Row label="Output" value={full(used.output)} />
          {used.cost !== null ? <Row label="Cost" value={`$${used.cost.toFixed(used.cost < 1 ? 4 : 2)}`} /> : null}
        </section>
      ) : null}

      {used ? (
        <section className="usage-section" aria-label="Session">
          <div className="usage-head">
            <span>Session</span>
            <span className="usage-value">
              {used.turns} {used.turns === 1 ? "turn" : "turns"}
              <Dot />
              {used.steps} {used.steps === 1 ? "step" : "steps"}
            </span>
          </div>
          <Row label="LLM time" value={used.llmMs !== null ? duration(used.llmMs) : "—"} />
          <Row label="Avg time to first token" value={used.ttftMs !== null ? duration(used.ttftMs) : "—"} />
          <Row label="Tokens per second" value={used.tokensPerSecond !== null ? `${used.tokensPerSecond} tok/s` : "—"} />
          {!timed ? <p className="usage-note">Timing is measured from runs this server watches.</p> : null}
        </section>
      ) : null}

      {details ? (
        <section className="usage-section" aria-label="This turn">
          <div className="usage-head">
            <span>This turn</span>
          </div>
          {turn ? <TimingView turn={turn} workspace={workspace} /> : <p className="usage-note" data-testid="usage-timing-empty">No times reported for this chat yet.</p>}
        </section>
      ) : null}

      {onShowMore ? (
        <button type="button" className="usage-more" data-testid="usage-more" onClick={onShowMore}>
          Show more
          <IconChevronRight size={13} />
        </button>
      ) : null}
    </>
  );
}

/** The chip's full view: mounted only while it is open, so a closed chip never folds the chat into turns. */
function ContextDetails({
  context,
  usage,
  draft,
  canCompact,
  history,
  compacting,
  compacted,
  timing,
  onClose,
}: {
  context: ContextUsage;
  usage: SessionUsage | null;
  draft: DraftSize | null;
  canCompact: boolean;
  history: ContextPoint[];
  compacting: boolean;
  compacted: boolean;
  timing: { items: ChatItem[]; status: ChatStatus; workspace: string } | null;
  onClose: () => void;
}) {
  const items = timing?.items;
  const status = timing?.status;
  const turn = useMemo(() => {
    if (!items || !status) return null;
    const turns = buildTurns(items, status);
    return turns[turns.length - 1] ?? null;
  }, [items, status]);
  return (
    <Dialog title="Context, usage, and timing" onClose={onClose} className="usage-details">
      <UsageBody context={context} usage={usage} draft={draft} canCompact={canCompact} history={history} compacting={compacting} compacted={compacted} details turn={turn} workspace={timing?.workspace ?? ""} />
    </Dialog>
  );
}

/** `draft` is the composer's text and image count, for the figure of what sending adds; `canCompact` whether the harness can answer a full window with Compact. */
export function ContextRing({
  context,
  usage,
  draft,
  canCompact,
  history,
  compacting,
  timing,
}: {
  context: ContextUsage | null;
  usage: SessionUsage | null;
  draft: { text: string; images: number };
  canCompact: boolean;
  history: ContextPoint[];
  compacting: boolean;
  /** The chat's items and status, for the full view's turn timing; null where there is no chat to time. */
  timing: { items: ChatItem[]; status: ChatStatus; workspace: string } | null;
}) {
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState(false);
  const { render: showPop, leaving } = useLeave(open);
  const wrap = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLButtonElement>(null);

  useDismiss(wrap, open, () => setOpen(false), { escape: true });

  // The context panel's "Open context and timings" row asks this ring (the main pane's own, so a split
  // pane's is untouched) for the full view, not the small popover a click gives. App.tsx sends the event.
  const present = hasContextFigure(context);
  useEffect(() => {
    const el = ring.current;
    if (!present || !el) return undefined;
    const show = () => {
      setOpen(false);
      setDetails(true);
    };
    el.addEventListener("awui:context-details", show);
    return () => el.removeEventListener("awui:context-details", show);
  }, [present]);

  // The ring sits anywhere in the composer's wrapped control row, so the panel
  // pulls itself back inside the viewport and inside the room above the ring.
  // Measured from the layout box, since the opening animation scales the
  // painted one. (Desktop only; a phone draws the panel as a sheet.)
  useLayoutEffect(() => {
    const el = pop.current;
    const anchor = wrap.current?.getBoundingClientRect();
    if (!open || !el || !anchor) return;
    el.style.removeProperty("--usage-shift");
    el.style.removeProperty("--usage-max-h");
    const room = anchor.top - 16; // its gap above the pill, then its own margin
    if (el.offsetHeight > room) el.style.setProperty("--usage-max-h", `${Math.max(120, room)}px`);
    const left = anchor.right - el.offsetWidth;
    const slack = window.innerWidth - 8 - anchor.right;
    const shift = Math.min(Math.max(0, 8 - left), Math.max(0, slack));
    if (shift > 0) el.style.setProperty("--usage-shift", `${shift}px`);
  }, [open]);

  // "Compacted ✓" for two seconds after a compaction ends; the numbers roll down on their own.
  const [compacted, setCompacted] = useState(false);
  const was = useRef(false);
  useEffect(() => {
    if (compacting) setCompacted(false);
    if (was.current && !compacting) {
      setCompacted(true);
      const t = setTimeout(() => setCompacted(false), 2000);
      was.current = compacting;
      return () => clearTimeout(t);
    }
    was.current = compacting;
    return undefined;
  }, [compacting]);

  // The estimate lags a keystroke rather than holding one up: a draft can be a huge paste.
  const text = useDeferredValue(draft.text);
  const size = useMemo(() => draftSize(text, draft.images, context), [text, draft.images, context]);
  const figure = size ? (
    <span className={`draft-size${size.near ? " is-near" : ""}`} title={draftRow(size)} data-testid="draft-size">
      {size.label}
    </span>
  ) : null;

  // Hidden until the harness itself knows how full the window is: an empty ring reads like a spinner.
  if (!hasContextFigure(context)) return figure ? <div className="context-ring-wrap">{figure}</div> : null;
  const pct = Math.max(0, Math.min(100, context.percent));
  // A pie, which no loader looks like: a faint disc, and the used share drawn as a stroke as wide as its own
  // diameter (r 3.5, width 7) so it fills a sector out to the disc's edge.
  const r = 3.5;
  const c = 2 * Math.PI * r;
  const tone = contextTone(pct);
  const detail = `${Math.round(pct)}% of context used${context.tokens !== null ? ` · ${compact(context.tokens)} / ${compact(context.window)} tokens` : ""}`;
  const peek = { context, usage, draft: size, canCompact, history, compacting, compacted, details: false as const, turn: null, workspace: "" };

  return (
    <div className="context-ring-wrap" ref={wrap}>
      {figure}
      <button
        ref={ring}
        type="button"
        className={`context-ring tone-${tone}`}
        aria-label={detail}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="context-ring"
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="7" fill="currentColor" fillOpacity="0.2" />
          <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth={r * 2} strokeDasharray={`${(pct / 100) * c} ${c}`} transform="rotate(-90 8 8)" />
        </svg>
        <span className="context-pct">{Math.round(pct)}%</span>
      </button>
      {showPop && !coarse() ? (
        <div className={`usage-pop${leaving ? " is-leaving" : ""}`} ref={pop} role="dialog" aria-label="Context and usage" data-testid="usage-panel">
          <UsageBody {...peek} onShowMore={() => { setOpen(false); setDetails(true); }} />
        </div>
      ) : null}
      {open && coarse() ? (
        <Dialog title="Context and usage" onClose={() => setOpen(false)} className="usage-sheet">
          <UsageBody {...peek} onShowMore={() => { setOpen(false); setDetails(true); }} />
        </Dialog>
      ) : null}
      {/* The dialog closed on its own terms: focus comes back to the chip, since the foot that opened it is gone. */}
      {details ? (
        <ContextDetails
          {...peek}
          timing={timing}
          onClose={() => {
            setDetails(false);
            ring.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
