// What a decision request may carry of a tool call, and what it must never carry.
//
// `buildEgressState` is the only function that produces the `state` a backend receives, and the
// service calls it immediately before `fetch`. Everything that bounds or scrubs a call's output
// happens inside it, so nothing un-clipped and (for a remote backend) un-redacted can reach a wire
// by construction — there is no other path to one.
//
// Order matters. The fold already capped the output at 16 KB head and tail (agent-events.ts), and
// that is the ceiling; this clips to 4 KB (head 1 KB, tail 3 KB, since a runner prints its summary
// last), then strips the secret classes below, then rewrites the two absolute prefixes a path would
// otherwise leak (the home folder, and the project's own folder) the way the UI already shows paths.
//
// The local backend runs the same clip but not the redaction: nothing leaves the machine, and a
// scrub there would only make its cache fingerprints and eval fixtures disagree with a remote run.
import type { ToolItem } from "../../shared/protocol.js";

/** At most this much output reaches a backend (head and tail, middle omitted). */
export const MAX_EGRESS_CHARS = 4096;
/** The head's share; the rest is the tail, which holds a runner's summary. */
const HEAD_CHARS = 1_024;
/** A candidate list is bounded too: a call cannot make a request large by proposing a lot. */
const MAX_STATE_CANDIDATES = 24;

/** _redacted_ instead of a secret, so the line structure a model reads survives the scrub. */
const SECRET_RULES: Array<{ pattern: RegExp; replace: string }> = [
  // PEM private keys, whole blocks: a key pasted into a file the agent read.
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: "[redacted private key]" },
  { pattern: /\b(ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}\b/g, replace: "[redacted github token]" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: "[redacted github token]" },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replace: "[redacted api key]" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: "[redacted aws key]" },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replace: "[redacted slack token]" },
  { pattern: /(Authorization:\s*Bearer\s+)\S+/gi, replace: "$1[redacted]" },
  // A credential inside a URL keeps the scheme and the user, loses the password.
  { pattern: /([a-z][a-z0-9+.-]*:)\/\/([^:\s/@]+):([^@\s/]+)@/gi, replace: "$1//$2:[redacted]@" },
  // NAME=value and NAME: value for the usual secret-shaped names: the name stays, the value goes.
  { pattern: /\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD))(=|:)\s*\S+/gi, replace: "$1$2[redacted]" },
];

/** A call's output as a request may carry it: the clip, and how much the clip left out. */
export interface EgressText {
  text: string;
  /** Characters omitted by the clip (0 when the whole output fits). */
  omitted: number;
}

/** Head and tail at `MAX_EGRESS_CHARS`, joined by the omission marker the UI uses, or the text whole. */
export function clipForSend(output: string): EgressText {
  if (output.length <= MAX_EGRESS_CHARS) return { text: output, omitted: 0 };
  const head = output.slice(0, HEAD_CHARS);
  const tail = output.slice(-(MAX_EGRESS_CHARS - HEAD_CHARS));
  const omitted = output.length - head.length - tail.length;
  return { text: `${head}…[${omitted} chars omitted]…${tail}`, omitted };
}

/** Every secret class of the settings' own promise, replaced with a short token (see SECRET_RULES). */
export function redactForEgress(text: string): string {
  let out = text;
  for (const rule of SECRET_RULES) out = out.replace(rule.pattern, rule.replace);
  return out;
}

/** The two absolute prefixes a path would leak: the user's home, and the chat's project folder. */
export function relativizeForEgress(text: string, home: string, workspace: string): string {
  let out = text;
  // The project's own folder first: under a home folder, it is the longer of the two prefixes.
  if (workspace.length > 1) out = out.split(workspace).join(".");
  if (home.length > 1) out = out.split(home).join("~");
  return out;
}

/** Who is asking, for the parts of a state that are about a place rather than a call. */
export interface EgressIdentity {
  harness: string;
  /** The chat's workspace: its absolute prefix becomes "." in what is sent. */
  workspace: string;
  /** The user's home folder, whose prefix becomes "~". */
  home: string;
}

/**
 * The one egress: the state object a backend receives, and the exact text it carries (so the cache
 * fingerprint is computed over what was actually sent). Never the call's raw arguments, its
 * environment, or a sibling path: the one-line command, the bounded output, and the candidates.
 */
export function buildEgressState(item: ToolItem, identity: EgressIdentity, remote: boolean): { state: Record<string, unknown>; sent: string } {
  const clipped = clipForSend(item.output);
  const scrubbed = remote ? redactForEgress(clipped.text) : clipped.text;
  const sent = relativizeForEgress(scrubbed, identity.home, identity.workspace);
  const state: Record<string, unknown> = {
    harness: identity.harness,
    tool: item.name,
    command: relativizeForEgress(item.summary, identity.home, identity.workspace),
    ended: item.status,
    truncated: item.truncated || clipped.omitted > 0,
    output: sent,
    sniffer_candidates: candidatePairs(item),
  };
  return { state, sent };
}

/** The candidates as `{ key, value }` pairs: what a model may choose among, never a value it may invent. */
export function candidatePairs(item: ToolItem): Array<{ key: string; value: string | number }> {
  return (item.candidates ?? []).slice(0, MAX_STATE_CANDIDATES).map((c) => ({ key: c.key, value: c.value }));
}
