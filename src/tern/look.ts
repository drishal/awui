// How awui looks in Tern: the server's theme as a stylesheet of Tern's colour
// variables, and one stylesheet that lays the chat out the way the web UI does (a centred
// reading column, the prompt as a pill on the right, quiet "Worked for …"
// folds, a composer card with its chips under it). Tern draws every node
// natively and owns fonts, spacing between blocks, and motion; the sheet only
// shapes our own roles (`awui.*`) and `el` classes, and colours come from
// Tern's variables (--t1…, --l1…, --accent) and the theme sheet's (--awui-*), so a
// light pane, a dark one, and a base16 scheme all read right.
import { DARK, LIGHT, type Theme } from "../atui/theme.js";

/**
 * The theme as a stylesheet. Tern 0.9 has no program palette (SDK 0.1's `palette` verb is gone), so the
 * pane's colours are Tern's own variables set on our two roots, which every node of the chat sits under.
 * A theme file is one scheme, dark or light: its colours are used whole in the pane's matching appearance
 * (`dark` is Tern's, and a new sheet is sent when it changes), and the other keeps Tern's own, since a
 * dark scheme's fills would be dark blotches on a light pane. Without a theme file the web UI's own
 * built-in palette for the pane's appearance is used, so both clients wear the same accent, ink, and
 * status colours. Tern's pane background stays its own: a program sheet cannot paint the region itself.
 * `--awui-harness` and `--awui-thinking` are not Tern's: the sheet below reads them.
 */
export function themeSheet(theme: Theme, harness: string, polarity: "dark" | "light" | null, dark: boolean): string {
  const scheme = polarity ? ((polarity === "dark") === dark ? theme : null) : dark ? DARK : LIGHT;
  const own = [`--awui-harness: ${harness}`, `--awui-thinking: ${(scheme ?? theme).thinking}`];
  const vars = scheme
    ? [
        `--t1: ${scheme.text}`,
        `--t2: ${scheme.text2}`,
        `--t3: ${scheme.muted}`,
        `--t4: ${scheme.muted}`,
        `--accent: ${scheme.accent}`,
        `--accent-ink: ${scheme.accent}`,
        `--sf-accent: ${scheme.accent}`,
        `--sf-c-accent: ${scheme.accent}`,
        // Links, paths, and list bullets otherwise follow Tern's own theme (its omp tokens), not the web UI's.
        `--sf-c-link: ${scheme.link}`,
        `--sf-c-path: ${scheme.text}`,
        `--omp-mdLink: ${scheme.link}`,
        `--omp-mdListBullet: ${scheme.muted}`,
        `--ok: ${scheme.ok}`,
        `--sf-c-success: ${scheme.ok}`,
        `--sf-c-ins: ${scheme.ok}`,
        `--warn: ${scheme.warn}`,
        `--sf-c-warning: ${scheme.warn}`,
        `--bad: ${scheme.danger}`,
        `--sf-c-error: ${scheme.danger}`,
        `--sf-c-del: ${scheme.danger}`,
      ]
    : [];
  return `[data-role='awui.page'], [data-role='awui.dock'] { ${[...own, ...vars].join("; ")}; }\n`;
}

/** A colour that follows the theme sheet's harness colour, mixed into the pane's ink. */
const HARNESS = "var(--awui-harness, var(--accent))";
/** The web UI's easings (motion.css): eased out for what streams in, a slight overshoot for what you just did. */
const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";
const SPRING = "cubic-bezier(0.34, 1.4, 0.64, 1)";
const INK = "var(--t1, currentColor)";
const tint = (pct: number, color = INK) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;
/**
 * The pane's own background as a solid colour (the terminal's, which a Tern theme sets), for what floats over
 * the scrolling conversation: the dock. A tint over transparent lets the text scrolling under it show through.
 */
const SOLID = "var(--tv-bg, var(--panel, var(--page)))";
/** A tint laid on the solid background, so a card in the dock is opaque. */
const solidTint = (pct: number, color = INK) => `color-mix(in srgb, ${color} ${pct}%, ${SOLID})`;

/** The sheet, under one name so a later send replaces it. Reading width as the web UI's thread. */
export const STYLESHEET = `
[data-role='awui.page'] { width: 100%; max-width: 780px; margin: 0 auto; font-family: var(--sans); gap: 18px; }
[data-role='awui.page'] .md { font-family: var(--sans); }
/*
 * The dock floats over the conversation as it scrolls: a solid backdrop (blurred too, for a translucent
 * window whose background is itself see-through) so what scrolls under it never shows through its cards.
 */
[data-role='awui.dock'] { width: 100%; max-width: 792px; margin: 0 auto; font-family: var(--sans); gap: 8px; padding-top: 6px; background: ${SOLID}; backdrop-filter: blur(24px); }

/* The header: the title on its own line, then the harness badge, status, and project, as the web UI's. */
[data-role='awui.head'] { gap: 4px; padding: 2px 0 10px; border-bottom: 1px solid ${tint(8)}; }
[data-role='awui.head-meta'] { align-items: center; gap: 10px; }
[data-role='awui.title'] { font-weight: 600; font-size: 1.15em; }
.harness { border-radius: 999px; padding: 1px 9px; font-size: 0.86em; color: ${HARNESS}; background: ${tint(18, HARNESS)}; }
.harness.big { padding: 3px 12px; font-size: 1em; }
.state { font-size: 0.86em; color: var(--t3); }
.state::before { content: '●'; margin-right: 5px; color: var(--t4); }
.state.idle::before { color: var(--ok); }
.state.busy::before { color: ${HARNESS}; }
.state.asks::before { color: var(--warn); }
.state.failed::before { color: var(--bad); }

/* A prompt: a pill on the right, as in the web UI. */
[data-role='awui.ask'] { align-items: flex-end; gap: 4px; }
[data-role='awui.prompt'] { align-self: flex-end; max-width: 82%; padding: 9px 15px; border-radius: 18px; background: ${tint(11)}; }
[data-role='awui.prompt'].sf-act:hover { background: ${tint(15)}; }
[data-role='awui.prompt-acts'] { gap: 2px; }
[data-role='awui.prompt-acts'] .sf-icon, [data-role='awui.answer-acts'] .sf-icon { color: var(--t3); padding: 5px; border-radius: 7px; }
[data-role='awui.prompt-acts'] .sf-icon:hover, [data-role='awui.answer-acts'] .sf-icon:hover { color: var(--t1); background: ${tint(9)}; }
[data-role='awui.prompt-meta'] { font-size: 0.82em; color: var(--t4); }
[data-role='awui.prompt-time'] { font-size: 0.8em; color: var(--t4); padding-right: 6px; }

/*
 * The work between a prompt and its answer, as the web UI's card: a rounded frame whose head carries the
 * kinds of tool used (a stack of round icons), the words, and the +/− at the right; open, the calls follow
 * under a hairline, one divided row each with a round icon chip and the facts pushed to the right edge.
 */
[data-role^='awui.fold'] { border: 1px solid ${tint(10)}; border-radius: 12px; background: ${tint(2)}; }
/* A closed card is as tall as an open card's row and in the same text size, as the web UI's are. */
[data-role^='awui.fold'] > .sf-section-head { color: var(--t3); font-size: 1em; padding: 6px 12px !important; min-height: 30px; }
/* Tern's head hover is a pill 3 px wider than its section on each side: inside the card, it fills the frame
   exactly instead, rounded with it (the top corners while open, all four when the card is closed). */
[data-role^='awui.fold'] > .sf-section-head { margin: 0 !important; border-radius: 11px 11px 0 0; }
[data-role^='awui.fold'].collapsed > .sf-section-head { border-radius: 11px; }
[data-role='awui.fold-live'] { border-color: ${tint(28, HARNESS)}; }
[data-role='awui.fold-live'] > .sf-section-head { color: var(--t2); }
[data-role^='awui.fold'] > .sf-section-head .sf-head { flex: 1 1 auto; min-width: 0; }
[data-role='awui.work-head'] { width: 100%; }
[data-role='awui.kinds'] { gap: 3px; }
[data-role='awui.kinds'] .sf-icon { padding: 2px; border-radius: 999px; color: var(--t2); background: ${tint(12)}; }
[data-role='awui.kinds'] .sf-icon svg { width: 11px; height: 11px; }
[data-role='awui.kinds-more'] { margin-left: 8px; font-size: 0.85em; color: var(--t3); }
[data-role='awui.work-stat'] { font-family: var(--mono, monospace); font-size: 0.88em; white-space: nowrap; padding-right: 4px; }
[data-role='awui.calls'] { gap: 0; border-top: 1px solid ${tint(8)}; }
[data-role='awui.calls'] > * { padding: 0; }
/* The row's head carries the padding, so its hover lights the whole row edge to edge, as the web UI's rows do,
   not Tern's inset pill; the last closed row rounds with the card's bottom corners. */
[data-role='awui.calls'] .sf-tool-head { margin: 0 !important; padding: 4px 12px !important; border-radius: 0 !important; }
[data-role='awui.calls'] > :last-child.collapsed .sf-tool-head { border-radius: 0 0 11px 11px !important; }
[data-role='awui.calls'] > * + * { border-top: 1px solid ${tint(6)}; }
[data-role^='awui.fold'] > .sf-section-body { margin: 0; padding: 0; border: 0; }
[data-role^='awui.fold'] > .sf-section-body::before { display: none; }
[data-role='awui.calls'] .sf-tool.inline .sf-tool-ic { width: 19px; height: 19px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border-radius: 999px; color: var(--t2); background: ${tint(9)}; }
[data-role='awui.calls'] .sf-tool.inline .sf-tool-ic svg { width: 12px; height: 12px; }
[data-role='awui.calls'] .sf-tool.inline .sf-tool-title { font-weight: 500; font-family: var(--sans); }
/* The row's line is a flex row ending in a spacer: the facts go after it, to the right edge, as the web UI's. */
[data-role='awui.calls'] .sf-tool.inline .sf-tool-sp { order: 1; }
[data-role='awui.calls'] .sf-tool.inline .sf-tool-meta { order: 2; font-family: var(--sans); color: var(--t3); }
[data-role='awui.calls'] .sf-tool.st-done .sf-tool-st { color: var(--ok); }
/* A thought reads as the web UI's: the word, then the reasoning's title, both quiet and in the reading font. */
[data-role='awui.thought'] .sf-tool-title { font-weight: 400; color: var(--t3); }
[data-role='awui.thought'] .sf-tool-target { font-family: var(--sans); color: var(--t3); }
[data-role='awui.thought'] .md { color: var(--t3); }
[data-role='awui.note'] { color: var(--t3); font-size: 0.92em; }
[data-role='awui.answer-acts'] { gap: 10px; margin-top: -6px; }
[data-role='awui.changed'] { font-size: 0.88em; color: var(--t3); }
[data-role='awui.changed'] .sf-icon { color: var(--t3); }
[data-role='awui.changed'] .sf-t-path { font-family: var(--mono, monospace); color: var(--t2); }
[data-role='awui.working'] { color: var(--t2); }
[data-role='awui.after'] { color: var(--t3); font-size: 0.9em; }
[data-role='awui.render'] { border-radius: 12px; }

/* The empty chat: a welcome with the harnesses and this project's recent sessions. */
[data-role='awui.welcome'] { align-items: center; gap: 14px; padding-top: 12vh; }
[data-role='awui.brand'] { font-size: 1.6em; font-weight: 600; letter-spacing: 0.02em; font-family: var(--mono, monospace); color: ${HARNESS}; }
[data-role='awui.start-title'] { font-size: 1.45em; font-weight: 600; text-align: center; }
[data-role='awui.harnesses'] { gap: 8px; justify-content: center; flex-wrap: wrap; }
.pick { border-radius: 999px; padding: 4px 13px; background: ${tint(7)}; color: var(--t2); }
.pick:hover { background: ${tint(12)}; }
.pick.on { color: ${HARNESS}; background: ${tint(18, HARNESS)}; }
[data-role='awui.recent'] { width: 100%; max-width: 560px; }

/* The dock: queued steps, the git row, the composer card, the status strip. */
[data-role='awui.queue'] { gap: 4px; padding: 6px 12px; border-radius: 12px; background: ${solidTint(5)}; font-size: 0.9em; }
[data-role='awui.git'] { align-items: center; gap: 10px; padding: 3px 11px; border-radius: 10px; background: ${solidTint(6)}; font-size: 0.86em; color: var(--t2); }
[data-role='awui.git'].sf-act:hover { background: ${tint(9)}; }
[data-role^='awui.composer'] { gap: 6px; padding: 9px 10px 8px; border-radius: 18px; background: ${solidTint(7)}; border: 1px solid ${tint(10)}; }
[data-role='awui.composer-busy'] { border-color: ${tint(40, HARNESS)}; }
[data-role^='awui.composer'] .sf-editor { background: transparent; box-shadow: none; border: 0; outline: 0; padding-left: 4px; }
[data-role='awui.chips'] { align-items: center; gap: 6px; }
.chip { border-radius: 999px; padding: 2px 10px; font-size: 0.86em; color: var(--t2); background: ${tint(8)}; }
.chip:hover { background: ${tint(13)}; color: var(--t1); }
.chip.think { display: inline-flex; align-items: center; gap: 5px; }
.chip.harness-chip { color: ${HARNESS}; background: ${tint(18, HARNESS)}; }
.chip.caution { color: var(--warn); background: ${tint(14, 'var(--warn)')}; }

/* The todo card over the composer, as the web UI's status stack. */
[data-role='awui.todos'] { border-radius: 14px; background: ${solidTint(4)} !important; }
.send { border-radius: 999px; min-width: 26px; padding: 2px 8px; text-align: center; color: var(--t1); background: ${tint(16)}; }
.send.ready { color: var(--page, #000); background: ${INK}; }
.send.stop { color: var(--page, #000); background: ${HARNESS}; }

/* An approval or a question from the agent, above the composer. */
[data-role='awui.request'] { gap: 8px; padding: 12px 14px; border-radius: 16px; background: ${solidTint(7)}; border: 1px solid ${tint(30, 'var(--warn)')}; }
[data-role='awui.request-title'] { font-weight: 600; }
[data-role='awui.request-buttons'] { gap: 6px; flex-wrap: wrap; }
.answer { border-radius: 9px; padding: 3px 12px; background: ${tint(9)}; color: var(--t1); }
.answer:hover { background: ${tint(15)}; }
.answer.primary { color: var(--page, #000); background: ${INK}; }
.answer.deny { color: var(--bad); }
.answer .n { color: var(--t4); margin-right: 6px; }
/* An approval is a tool row's ask panel. Tern draws an Enter keycap on Allow; Enter sends the composer here, so none is shown. */
[data-role='awui.approval'] .sf-tool-ask-btn .sf-kbd, [data-role='awui.approval'] .sf-tool-ask-btn .kbd { display: none; }

/*
 * Motion, after the web UI's (styles/motion.css): short and eased out, with what you just did landing on a
 * spring. A turn that arrives while the chat is on screen (awui.turn-new; one drawn with the chat stays
 * awui.turn) rises in: its prompt on the spring, its reply eased, each call sliding into the open card, a new
 * kind of tool popping into the head's stack. A fold or a call's body exists only while open, so it unfurls
 * from under its head as it opens (a program gets no exit hook, so closing is Tern's own). Chevrons turn on
 * the spring, and a fold that settles, a composer that starts or stops, a status dot, and the chips change
 * colour smoothly. Tern zeroes it all under the system's Reduce Motion; its own setting (.sf-still) is ours.
 */
@keyframes awui-rise { from { opacity: 0; transform: translateY(6px); } }
@keyframes awui-slide { from { opacity: 0; transform: translateY(-3px); } }
@keyframes awui-row { from { opacity: 0; transform: translateY(-4px); max-height: 0; } to { max-height: 120px; } }
@keyframes awui-unfurl { from { opacity: 0; transform: translateY(-8px); clip-path: inset(0 0 100% 0); } to { clip-path: inset(0 0 -24px 0); } }
@keyframes awui-pop { from { opacity: 0; transform: scale(0.4) rotate(-30deg); } }
[data-role='awui.turn-new'] [data-role='awui.prompt'] { animation: awui-rise 0.38s ${SPRING}; }
[data-role='awui.turn-new'] [data-role='awui.prompt-time'] { animation: awui-rise 0.38s ${EASE_OUT}; }
[data-role='awui.turn-new'] [data-role^='awui.fold'] { animation: awui-slide 0.22s ${EASE_OUT}; }
[data-role='awui.turn-new'] [data-role='awui.reply'] { animation: awui-rise 0.18s ${EASE_OUT}; }
[data-role='awui.turn-new'] [data-role='awui.calls'] > * { animation: awui-row 0.28s ${EASE_OUT}; }
[data-role='awui.turn-new'] [data-role='awui.kinds'] .sf-icon { animation: awui-pop 0.38s ${SPRING}; }
[data-role='awui.turn-new'] [data-role='awui.answer-acts'], [data-role='awui.turn-new'] [data-role='awui.changed'] { animation: awui-slide 0.22s ${EASE_OUT}; }
[data-role^='awui.fold'] > .sf-section-body { animation: awui-unfurl 0.28s ${SPRING}; }
[data-role='awui.calls'] .sf-tool-body { animation: awui-unfurl 0.24s ${SPRING}; }
[data-role='awui.request'] { animation: awui-rise 0.38s ${SPRING}; }
[data-role='awui.page'] .sf-chev, [data-role='awui.dock'] .sf-chev { transition: transform 0.38s ${SPRING}; }
[data-role^='awui.fold'] { transition: border-color 0.4s ${EASE_OUT}, background-color 0.4s ${EASE_OUT}; }
[data-role^='awui.composer'] { transition: border-color 0.3s ${EASE_OUT}; }
.state::before { transition: color 0.3s ${EASE_OUT}; }
.chip, .pick, .answer, .send, [data-role='awui.prompt'], [data-role='awui.git'] { transition: background-color 0.12s ${EASE_OUT}, color 0.12s ${EASE_OUT}; }
.sf-still [data-role^='awui.'], .sf-still [data-role^='awui.'] * { animation: none !important; transition: none !important; }

/* Tabs along the top, when there are two or more. */
[data-role='awui.tabs'] { margin-bottom: -6px; }
`;
