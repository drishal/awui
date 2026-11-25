// Mermaid fences in an answer, as Pele draws them: which fence counts, what a
// failure means while the answer is still being written, the wording of the quiet
// line under a diagram that did not draw, and the module Pele is loaded from.
// Everything here runs without a DOM, so the policy is unit-tested in node; the
// drawing itself is MermaidDiagram.tsx, which mounts Pele into the page.
//
// Pele is not in the main bundle: `loadPele` is the only import of it, it is
// dynamic, and pele/lazy loads a diagram type when one is first seen.
//
// The line between "partial" and "invalid" is deliberately late. An answer's text
// is half-written most of the time it is on screen, so a parse error that points
// at the end of the text means the text stops mid-token and may still become a
// diagram — that is never a note to the reader, however the run ended.
import type { MountOptions } from "pele/lazy";

/** What one fence's text became: the SVG, text that may still grow, or text Pele rejected. */
export type MermaidOutcome = { ok: true; svg: string } | { ok: false; reason: "partial" } | { ok: false; reason: "invalid"; message: string };

/** Pele's rejection as the fields the policy reads: its error states the line and column it stopped at. */
export interface DiagramRejection {
  message: string;
  line?: number;
  /** 1-based, one past the last character of the line for a token cut in half. */
  column?: number;
}

/** Draws one source; throws whatever Pele throws. */
export type Drawer = (source: string) => string | Promise<string>;

/** True for a fence tagged mermaid: any case, and the fence's own padding is not part of the word. */
export function isMermaidFence(lang: string | null): boolean {
  return lang !== null && lang.trim().toLowerCase() === "mermaid";
}

/** Read anything a draw threw as a rejection. Pele's error class is not imported: a chunk that fails to load throws too. */
export function rejectionOf(error: unknown): DiagramRejection {
  const thrown = unwrapError(error);
  const record = typeof thrown === "object" && thrown !== null ? (thrown as { message?: unknown; line?: unknown; column?: unknown }) : null;
  const message = thrown instanceof Error ? thrown.message : typeof thrown === "string" ? thrown : typeof record?.message === "string" ? record.message : "The diagram could not be drawn.";
  const line = typeof record?.line === "number" ? record.line : undefined;
  const column = typeof record?.column === "number" ? record.column : undefined;
  return { message, ...(line === undefined ? {} : { line }), ...(column === undefined ? {} : { column }) };
}

/** A redraw that fails after a good one throws a plain object holding the error Pele caught; its own fields are counters. */
function unwrapError(error: unknown): unknown {
  if (error === null || typeof error !== "object" || error instanceof Error) return error;
  for (const value of Object.values(error)) if (value instanceof Error) return value;
  return error;
}

/** What a rejected text is: still growing, or wrong enough to say so. `final` says the answer has stopped writing. */
export function rejectedMermaid(source: string, rejection: DiagramRejection, final: boolean): MermaidOutcome {
  if (!final || stopsMidText(source, rejection)) return { ok: false, reason: "partial" };
  return { ok: false, reason: "invalid", message: firstLine(rejection.message) };
}

/** Draw `source` with `draw` and say what happened. Kept for callers that want the string; the answer mounts Pele instead, so it can measure the column. */
export async function drawMermaid(draw: Drawer, source: string, final: boolean): Promise<MermaidOutcome> {
  if (source.trim() === "") return { ok: false, reason: "partial" };
  try {
    return { ok: true, svg: await draw(source) };
  } catch (error) {
    return rejectedMermaid(source, rejectionOf(error), final);
  }
}

/** The quiet line under a diagram that did not draw; null while the answer is still streaming, so no error flashes. */
export function mermaidNote(outcome: MermaidOutcome, final: boolean): string | null {
  if (outcome.ok || !final) return null;
  return outcome.reason === "partial" ? "This diagram stops before it is finished." : `Couldn't draw this diagram as Mermaid. ${outcome.message}`;
}

/** The furthest a diagram can grow beyond its fitted frame. */
export const MERMAID_MAX_ZOOM = 4;

/** The options every diagram is drawn with: no remote images (Markdown loads none either), and links as Markdown leaves them. */
export function mermaidOptions(idPrefix: string): Pick<MountOptions, "idPrefix" | "images" | "linkRel" | "zoom"> {
  // Pele handles pan and the zoom transform. MermaidDiagram owns the controls so their state follows React.
  return { idPrefix, images: false, linkRel: "noopener noreferrer nofollow", zoom: { maxScale: MERMAID_MAX_ZOOM, controls: false } };
}

let idSerial = 0;

/** A fresh prefix for one diagram's SVG ids: the page's CSP has no nonce for SVG, and ids must not collide across answers. */
export function nextMermaidId(): string {
  idSerial += 1;
  return `mermaid-${idSerial}`;
}

/**
 * A diagram's markup with its style attributes emptied, and their declarations in
 * document order. The app's CSP is style-src 'self', which refuses an inline style
 * attribute the browser parses; setting the same declarations through the CSSOM is
 * allowed. An empty attribute is nothing to apply, so it stays behind as the marker
 * of which element held one — the elements a diagram's styles belong to are not the
 * elements in it. MermaidDiagram.tsx puts the declarations back. Pele escapes `"`
 * inside both text and attribute values, so a quoted style attribute is unambiguous.
 */
export function takeStyles(markup: string): { markup: string; styles: string[] } {
  const styles: string[] = [];
  const plain = markup.replace(/ style="([^"]*)"/g, (_attribute, css: string) => {
    styles.push(css);
    return ' style=""';
  });
  return { markup: plain, styles };
}

/** Pele's lazy entry point, its types included. */
export type Pele = typeof import("pele/lazy");

let pele: Promise<Pele> | null = null;

/** Pele, loaded the first time a fence asks for it; a failed load is forgotten so the next fence tries again. */
export function loadPele(): Promise<Pele> {
  pele ??= import("pele/lazy").catch((error: unknown) => {
    pele = null;
    throw error;
  });
  return pele;
}

/** True when Pele stopped at the very end of the text: a token cut in half says nothing about the diagram. */
function stopsMidText(source: string, rejection: DiagramRejection): boolean {
  const { line, column } = rejection;
  // A failure with no position is a verdict on the whole text (an unknown diagram type), never a cut.
  if (line === undefined || column === undefined || line < 1) return false;
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let last = lines.length - 1;
  while (last > 0 && (lines[last] ?? "").trim() === "") last -= 1;
  if (line - 1 < last) return false;
  if (line - 1 > last) return true;
  return column >= (lines[last] ?? "").length;
}

const NOTE_LIMIT = 160;

/** Pele's message as one short sentence: the detail under it is a diagram snippet, which is not ours to show. */
function firstLine(message: string): string {
  const first = (message.split("\n").map((row) => row.trim()).find((row) => row !== "") ?? "").replace(/\s+/g, " ").replace(/:$/, ".");
  if (first === "") return "Pele could not read this text.";
  const capped = first.length > NOTE_LIMIT ? `${first.slice(0, NOTE_LIMIT - 1)}…` : first;
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}
