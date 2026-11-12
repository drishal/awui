// Which harness requests are plain approvals (a confirm, or a choice between
// exactly Approve and Deny), and the two answers they take. The composer's
// approval card and the server's notifications both read it, so a phone can
// approve from its lock screen exactly what the card would approve.
import type { InteractionAnswer, InteractionRequest } from "./protocol.js";

export type { InteractionAnswer };

/** A yes/no request: one the card shows as Deny and Approve buttons. */
export function isApproval(r: InteractionRequest): boolean {
  if (r.kind === "confirm") return true;
  const opts = (r.options ?? []).map((o) => o.toLowerCase());
  return r.kind === "select" && opts.length === 2 && opts.includes("approve") && opts.includes("deny");
}

/** The answers Approve and Deny send for an approval; null for any other request. */
export interface ApprovalAnswers {
  approve: InteractionAnswer;
  deny: InteractionAnswer;
}

export function approvalAnswers(r: InteractionRequest): ApprovalAnswers | null {
  if (!isApproval(r)) return null;
  if (r.kind === "confirm") return { approve: { kind: "confirm", confirmed: true }, deny: { kind: "confirm", confirmed: false } };
  const approve = r.options?.find((o) => o.toLowerCase() === "approve") ?? "Approve";
  const deny = r.options?.find((o) => o.toLowerCase() === "deny") ?? "Deny";
  return { approve: { kind: "select", value: approve }, deny: { kind: "select", value: deny } };
}

/** Whether an answer is the request's explicit Deny, rather than a cancel or another option. */
export function isDenial(request: InteractionRequest, answer: InteractionAnswer): boolean {
  const deny = approvalAnswers(request)?.deny;
  if (!deny) return false;
  if (answer.kind === "confirm") return deny.kind === "confirm" && !answer.confirmed;
  return answer.kind === "select" && deny.kind === "select" && answer.value === deny.value;
}
