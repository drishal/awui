// The tail of a Markdown answer still arriving: a marker the stream is part-way through (a "**" with its
// words but no closer yet, a lone "*" typed a moment before its span) is held back or completed, so a run in
// progress never draws raw asterisks where the words will be bold. Pure, and only for the streaming text:
// the settled answer renders exactly what the agent wrote.

/** The marker characters a partly-typed span can end in; a tilde needs its pair, since a lone "~" is prose (singleTilde is off). */
const TRAILING = /(?:\*{1,3}|_{1,3}|`{1,2}|~{2})$/;

/** How many of `marker` a text holds, without counting the same characters twice (`***` is one `**`). */
function countOf(text: string, marker: string): number {
  let count = 0;
  for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + marker.length)) count += 1;
  return count;
}

/** The delimiter a trailing run would close: a code span pairs with its own fence, `***` and `___` with the pair they start, the rest with themselves. */
function markerOf(run: string): string {
  if (run[0] === "`") return run;
  if (run.startsWith("**") || run.startsWith("__") || run.startsWith("~~")) return run.slice(0, 2);
  return run[0]!;
}

/**
 * The text to render while it streams: a trailing marker run that nothing opens is dropped, one that closes a
 * span is kept, and a bold span still open is closed for this frame. Complete Markdown passes through unchanged.
 */
export function streamTail(text: string): string {
  let body = text;
  const run = TRAILING.exec(text)?.[0];
  if (run) {
    const head = text.slice(0, text.length - run.length);
    // An odd count of the marker before the run means the run closes it; an even one means nothing opened it.
    if (countOf(head, markerOf(run)) % 2 === 0) body = head;
  }
  // Bold is the span that most often reaches the tail mid-word; closing it keeps the frame from flashing its
  // "**" at the reader, the same way a code span shows code only once its backtick closes.
  return countOf(body, "**") % 2 === 1 ? `${body}**` : body;
}
