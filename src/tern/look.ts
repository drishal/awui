// How awui looks in Tern: the server's theme as a stylesheet of Tern's colour
// variables, and one stylesheet that lays the chat out the way the web UI does (a centred
// reading column, the prompt as a pill on the right, quiet "Worked for …"
// folds, a composer card with its chips under it). Tern draws every node
// natively and owns fonts, spacing between blocks, and motion; the sheet only
// shapes our own roles (`awui.*`) and `el` classes, and colours come from
// Tern's variables (--t1…, --l1…, --accent) and the theme sheet's (--awui-*), so a
// light pane, a dark one, and a base16 scheme all read right.
import type { Theme } from "../atui/theme.js";

/**
 * The theme as a stylesheet. Tern 0.9 has no program palette (SDK 0.1's `palette` verb is gone), so the
 * pane's colours are Tern's own variables set on our two roots, which every node of the chat sits under.
 * A theme file is one scheme, dark or light: its colours are used whole in the pane's matching appearance
 * (`dark` is Tern's, and a new sheet is sent when it changes), and the other keeps Tern's own, since a
 * dark scheme's fills would be dark blotches on a light pane. Without a theme file only the harness's
 * colour is ours. `--awui-harness` and `--awui-thinking` are not Tern's: the sheet below reads them.
 */
export function themeSheet(theme: Theme, harness: string, polarity: "dark" | "light" | null, dark: boolean): string {
  const own = [`--awui-harness: ${harness}`, `--awui-thinking: ${theme.thinking}`];
  const scheme =
    polarity && (polarity === "dark") === dark
      ? [
          `--t1: ${theme.text}`,
          `--t2: ${theme.text2}`,
          `--t3: ${theme.muted}`,
          `--t4: ${theme.muted}`,
          `--accent: ${theme.accent}`,
          `--sf-accent: ${theme.accent}`,
          `--sf-c-accent: ${theme.accent}`,
          `--ok: ${theme.ok}`,
          `--warn: ${theme.warn}`,
          `--bad: ${theme.danger}`,
        ]
      : [];
  return `[data-role='awui.page'], [data-role='awui.dock'] { ${[...own, ...scheme].join("; ")}; }\n`;
}

/** A colour that follows the theme sheet's harness colour, mixed into the pane's ink. */
const HARNESS = "var(--awui-harness, var(--accent))";
const INK = "var(--t1, currentColor)";
const tint = (pct: number, color = INK) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

/** The sheet, under one name so a later send replaces it. Reading width as the web UI's thread. */
export const STYLESHEET = `
[data-role='awui.page'] { width: 100%; max-width: 780px; margin: 0 auto; font-family: var(--sans); gap: 18px; }
[data-role='awui.page'] .md { font-family: var(--sans); }
[data-role='awui.dock'] { width: 100%; max-width: 792px; margin: 0 auto; font-family: var(--sans); gap: 8px; }

/* The header: title, harness badge, status, project. */
[data-role='awui.head'] { align-items: center; gap: 10px; padding: 2px 0 6px; border-bottom: 1px solid ${tint(8)}; }
[data-role='awui.title'] { font-weight: 600; }
.harness { border-radius: 999px; padding: 1px 9px; font-size: 0.86em; color: ${HARNESS}; background: ${tint(18, HARNESS)}; }
.harness.big { padding: 3px 12px; font-size: 1em; }
.state { font-size: 0.86em; color: var(--t3); }
.state::before { content: '●'; margin-right: 5px; color: var(--t4); }
.state.busy::before { color: ${HARNESS}; }
.state.asks::before { color: var(--warn); }
.state.failed::before { color: var(--bad); }

/* A prompt: a pill on the right, as in the web UI. */
[data-role='awui.ask'] { align-items: flex-end; gap: 4px; }
[data-role='awui.prompt'] { align-self: flex-end; max-width: 82%; padding: 9px 15px; border-radius: 18px; background: ${tint(11)}; }
[data-role='awui.prompt'].sf-act:hover { background: ${tint(15)}; }
[data-role='awui.prompt-acts'] { gap: 2px; }
[data-role='awui.prompt-acts'] .sf-icon, [data-role='awui.answer-acts'] .sf-icon { color: var(--t3); padding: 3px; border-radius: 6px; }
[data-role='awui.prompt-acts'] .sf-icon:hover, [data-role='awui.answer-acts'] .sf-icon:hover { color: var(--t1); background: ${tint(9)}; }
[data-role='awui.prompt-meta'] { font-size: 0.82em; color: var(--t4); }

/* The work between a prompt and its answer, folded to one quiet line with a hairline under it. */
[data-role^='awui.fold'] { padding-bottom: 6px; border-bottom: 1px solid ${tint(8)}; }
[data-role^='awui.fold'] > .sf-section-head { color: var(--t3); font-size: 0.92em; }
[data-role='awui.fold-live'] > .sf-section-head { color: var(--t2); }
[data-role='awui.thought'] > .sf-section-head { color: var(--t3); font-style: italic; }
[data-role='awui.thought'] .md { color: var(--t3); }
[data-role='awui.note'] { color: var(--t3); font-size: 0.92em; }
[data-role='awui.answer-acts'] { gap: 2px; margin-top: -8px; }
[data-role='awui.changed'] { font-size: 0.88em; color: var(--t3); }
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
[data-role='awui.queue'] { gap: 4px; padding: 6px 12px; border-radius: 12px; background: ${tint(5)}; font-size: 0.9em; }
[data-role='awui.git'] { align-items: center; gap: 10px; padding: 3px 11px; border-radius: 10px; background: ${tint(6)}; font-size: 0.86em; color: var(--t2); }
[data-role='awui.git'].sf-act:hover { background: ${tint(9)}; }
[data-role^='awui.composer'] { gap: 6px; padding: 9px 10px 8px; border-radius: 18px; background: ${tint(7)}; border: 1px solid ${tint(10)}; }
[data-role='awui.composer-busy'] { border-color: ${tint(40, HARNESS)}; }
[data-role^='awui.composer'] .sf-editor { background: transparent; box-shadow: none; border: 0; outline: 0; padding-left: 4px; }
[data-role='awui.chips'] { align-items: center; gap: 6px; }
.chip { border-radius: 999px; padding: 2px 10px; font-size: 0.86em; color: var(--t2); background: ${tint(8)}; }
.chip:hover { background: ${tint(13)}; color: var(--t1); }
.chip.think { display: inline-flex; align-items: center; gap: 5px; }
.chip.harness-chip { color: ${HARNESS}; background: ${tint(18, HARNESS)}; }
.chip.caution { color: var(--warn); background: ${tint(14, 'var(--warn)')}; }

/* The todo card over the composer, as the web UI's status stack. */
[data-role='awui.todos'] { border-radius: 14px; }
.send { border-radius: 999px; min-width: 26px; padding: 2px 8px; text-align: center; color: var(--t1); background: ${tint(16)}; }
.send.ready { color: var(--page, #000); background: ${INK}; }
.send.stop { color: var(--page, #000); background: ${HARNESS}; }

/* An approval or a question from the agent, above the composer. */
[data-role='awui.request'] { gap: 8px; padding: 12px 14px; border-radius: 16px; background: ${tint(7)}; border: 1px solid ${tint(30, 'var(--warn)')}; }
[data-role='awui.request-title'] { font-weight: 600; }
[data-role='awui.request-buttons'] { gap: 6px; flex-wrap: wrap; }
.answer { border-radius: 9px; padding: 3px 12px; background: ${tint(9)}; color: var(--t1); }
.answer:hover { background: ${tint(15)}; }
.answer.primary { color: var(--page, #000); background: ${INK}; }
.answer.deny { color: var(--bad); }
.answer .n { color: var(--t4); margin-right: 6px; }
/* An approval is a tool row's ask panel. Tern draws an Enter keycap on Allow; Enter sends the composer here, so none is shown. */
[data-role='awui.approval'] .sf-tool-ask-btn .sf-kbd, [data-role='awui.approval'] .sf-tool-ask-btn .kbd { display: none; }

/* Tabs along the top, when there are two or more. */
[data-role='awui.tabs'] { margin-bottom: -6px; }
`;
