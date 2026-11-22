// The one quiet line an answered request leaves above the composer while its
// card folds away: "Approved: Allow tool: read". The conversation keeps the
// real record (the request row, with the server's own outcome); this is only
// the card's last moment, worded from the answer that was just sent. Pure.
import type { InteractionAnswer, InteractionRequest } from "../shared/protocol.js";

export interface FoldedRequest {
  /** The request's id, so a second answer restarts the fold. */
  id: string;
  /** "Approved: Allow tool: read". */
  text: string;
  /** False for a refusal or a dismissal: the mark is a cross. */
  ok: boolean;
}

/** What the folded line says about this answer; the request's first line is its subject, cut short. */
export function foldRequest(request: InteractionRequest, answer: InteractionAnswer): FoldedRequest {
  const subject = (request.title.split("\n")[0] ?? "").trim().slice(0, 80);
  let verb: string;
  let ok = true;
  switch (answer.kind) {
    case "cancel":
      verb = "Dismissed";
      ok = false;
      break;
    case "confirm":
      verb = answer.confirmed ? "Approved" : "Denied";
      ok = answer.confirmed;
      break;
    case "select":
      if (/^deny$/i.test(answer.value)) {
        verb = "Denied";
        ok = false;
      } else verb = /^approve$/i.test(answer.value) ? "Approved" : `Chose “${answer.value.slice(0, 40)}”`;
      break;
    case "form":
      verb = "Submitted";
      break;
    default:
      verb = request.kind === "editor" ? "Edited" : "Answered";
  }
  return { id: request.id, text: subject ? `${verb}: ${subject}` : verb, ok };
}
