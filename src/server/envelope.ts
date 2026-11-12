// The hidden envelope: a system contract that travels inside a send and is never
// chat content. The pattern, in one place, so a second user does not reinvent it:
//
//   - a send may carry a machine-readable contract between one BEGIN and one END
//     marker, the whole message and nothing else;
//   - remembered or quoted text that could contain the markers is broken first
//     (`escapeMarkers`), so history cannot forge a contract;
//   - a message that *is* one envelope is recorded without its text and shown
//     without it: the contract is the agent's business, never the room's transcript.
//
// Board consultations are the first user: a bot's entire reply may be one control
// document (consult.ts parses it), and the room records the run without the text.
// Everything here is bytes-and-markers only; what a contract means is the caller's.
export const ENVELOPE_BEGIN = "<<<AWUI_BOARD_CONTROL";
export const ENVELOPE_END = "AWUI_BOARD_CONTROL";

/**
 * Break the markers inside remembered text, so a quoted contract is read as quoted.
 * The replacement no longer contains a marker (the begin's replacement is broken
 * first, which also breaks any end inside it).
 */
export function escapeEnvelopeMarkers(text: string): string {
  return text
    .split(ENVELOPE_BEGIN)
    .join("<<<AWUI_BOARD_ CONTROL (quoted)")
    .split(ENVELOPE_END)
    .join("AWUI_BOARD_ CONTROL (quoted)");
}

/**
 * What a settled answer leaves visible: a message that is exactly one envelope
 * carries no showable text ("" — the caller records the run without it), and any
 * other message is shown whole.
 */
export function visibleOfEnvelope(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith(ENVELOPE_BEGIN)) return text;
  // After the begin marker: the end's bytes are inside the begin's, so a search from 0 finds the begin itself.
  const endAt = trimmed.indexOf(ENVELOPE_END, ENVELOPE_BEGIN.length);
  if (endAt < 0) return text;
  return trimmed.slice(endAt + ENVELOPE_END.length).trim();
}
