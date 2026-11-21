// Mesh ask approvals (P2 §2): the target-side queue a cap decision of "ask"
// waits on in daemon mode. One approval is one pending call — who asked, what
// capability, what it pointed at — bounded everywhere: ≤ 32 pending in total
// and ≤ 4 per node id (overflow is the wire's -33004, so a peer cannot flood
// the target's owner with cards), and every approval expires after 5 minutes,
// answering the waiting call with "no one answered on the target" rather than
// hanging forever. The three answers are exactly the spec's: allow once, allow
// for this link's lifetime (grants keyed by node id + cap + the policy root the
// call resolved into, dropped when that link ends), and deny. The queue never
// sees file contents or prompt text: the caller builds the summary (method +
// path/cwd/harness, ≤ 300 chars) and this module only stores it. Fail closed:
// an unknown id, an expired entry, a closed link — every one of them answers
// "no", never "yes".
import { randomBytes } from "node:crypto";
import type { Cap } from "./policy.js";
import { MeshErrorCode, MeshRpcError } from "./rpc.js";

/** The spec's bounds: how many approvals may wait at once, per node and in total. */
export const MAX_PENDING_APPROVALS = 32;
export const MAX_APPROVALS_PER_NODE = 4;
/** The spec's wait: five minutes, after which the call is answered with "no one answered". */
export const APPROVAL_TTL_MS = 5 * 60_000;
/** The summary's bound: method + path/cwd/harness, cut here, never file content or prompt text. */
export const MAX_APPROVAL_SUMMARY = 300;

export type MeshApprovalDecision = "allow-once" | "allow-for-link" | "deny";

/** One pending approval, as the target's owner reads it (CLI or UI). */
export interface MeshApproval {
  id: string;
  peerName: string;
  nodeId: string;
  method: string;
  cap: Cap;
  /** Method + path/cwd/harness, ≤ 300 chars; never file content or prompt text. */
  summary: string;
  /** The policy root the call resolved into, or null when the call named no path: what "allow for link" covers. */
  root: string | null;
  createdAt: number;
  expiresAt: number;
}

/** What a waiting call learned: allowed (once or by grant), denied, or expired with nobody answering. */
export type AskOutcome = "allow" | "deny" | "expired";

/** One link's "allow for link" grants, and the one way they end: with the link. */
export interface LinkGrants {
  /** The node id this link's grants are held for, bound at the first ask; null before one. */
  readonly nodeId: string | null;
  has(cap: Cap, root: string | null): boolean;
}

/** What a UI listener sees: a card raised, a card answered, a card gone with nobody answering. */
export type ApprovalEvent =
  | { type: "raised"; approval: MeshApproval }
  | { type: "decided"; id: string; decision: MeshApprovalDecision }
  | { type: "expired"; id: string };

export interface ApprovalQueueOpts {
  /** Epoch milliseconds; injected so tests run an expiry without waiting. */
  now?: () => number;
  /** How long one approval waits (default APPROVAL_TTL_MS). */
  ttlMs?: number;
  /** Test seams for the spec's caps; production passes nothing. */
  maxPending?: number;
  maxPerNode?: number;
}

/** One ask's facts, everything the queue needs to raise a card and key a grant. */
export interface ApprovalAsk {
  nodeId: string;
  peerName: string;
  method: string;
  cap: Cap;
  root: string | null;
  summary: string;
}

interface Waiter {
  link: LinkGrantsHandle;
  settle: (outcome: AskOutcome) => void;
}

interface Pending {
  approval: MeshApproval;
  /** The link that raised the card; "allow for link" grants land on it. */
  link: LinkGrantsHandle;
  /** Everyone waiting on this card: the raiser, and any same-node same-cap same-root ask that folded into it. */
  waiters: Waiter[];
}

class LinkGrantsHandle {
  nodeIdValue: string | null = null;
  private readonly grants = new Set<string>();
  private closed = false;

  get nodeId(): string | null {
    return this.nodeIdValue;
  }

  has(cap: Cap, root: string | null): boolean {
    return !this.closed && this.grants.has(`${cap}|${root ?? ""}`);
  }

  grant(cap: Cap, root: string | null): void {
    if (!this.closed) this.grants.add(`${cap}|${root ?? ""}`);
  }

  close(): void {
    this.closed = true;
    this.grants.clear();
  }
}

export class ApprovalQueue {
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(event: ApprovalEvent) => void>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxPending: number;
  private readonly maxPerNode: number;

  constructor(opts: ApprovalQueueOpts = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? APPROVAL_TTL_MS;
    this.maxPending = opts.maxPending ?? MAX_PENDING_APPROVALS;
    this.maxPerNode = opts.maxPerNode ?? MAX_APPROVALS_PER_NODE;
  }

  /** One served link's grant holder; `dropLink` ends it with the link. */
  openLink(): LinkGrants {
    return new LinkGrantsHandle();
  }

  /**
   * One call waiting on a person. A grant already held answers immediately; a
   * card already raised for the same node+cap+root is folded into rather than
   * duplicated; over either cap this throws the wire's -33004. The returned
   * promise settles only through a decision, an expiry, or the link's end.
   */
  ask(link: LinkGrants, info: ApprovalAsk): Promise<AskOutcome> {
    const handle = link as LinkGrantsHandle;
    if (handle.nodeId !== null && handle.nodeId !== info.nodeId) {
      // One link authenticates exactly one key, so this is a caller bug, never a peer's doing.
      return Promise.reject(new Error("one mesh link cannot ask approvals for two node ids"));
    }
    handle.nodeIdValue = info.nodeId;
    this.prune();
    if (handle.has(info.cap, info.root)) return Promise.resolve("allow");
    const key = `${info.nodeId}|${info.cap}|${info.root ?? ""}`;
    for (const entry of this.pending.values()) {
      if (grantsKeyOf(entry.approval) === key) {
        return new Promise<AskOutcome>((resolve) => entry.waiters.push({ link: handle, settle: resolve }));
      }
    }
    if (this.pending.size >= this.maxPending) {
      return Promise.reject(new MeshRpcError(MeshErrorCode.limit, `the approval queue already holds ${this.pending.size} pending approvals`, { code: "limit" }));
    }
    let perNode = 0;
    for (const entry of this.pending.values()) if (entry.approval.nodeId === info.nodeId) perNode++;
    if (perNode >= this.maxPerNode) {
      return Promise.reject(new MeshRpcError(MeshErrorCode.limit, `"${info.peerName}" already holds ${perNode} pending approvals`, { code: "limit" }));
    }
    const approval: MeshApproval = {
      id: `ap_${randomBytes(8).toString("hex")}`,
      peerName: info.peerName,
      nodeId: info.nodeId,
      method: info.method,
      cap: info.cap,
      summary: info.summary.length > MAX_APPROVAL_SUMMARY ? info.summary.slice(0, MAX_APPROVAL_SUMMARY) : info.summary,
      root: info.root,
      createdAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
    };
    const entry: Pending = { approval, link: handle, waiters: [] };
    this.pending.set(approval.id, entry);
    const waited = new Promise<AskOutcome>((resolve) => entry.waiters.push({ link: handle, settle: resolve }));
    // The expiry settles the waiter even if nobody ever looks at the queue again; unref'd so it never holds the process.
    const timer = setTimeout(() => this.prune(), this.ttlMs + 1000);
    timer.unref?.();
    this.emit({ type: "raised", approval: { ...approval } });
    return waited;
  }

  /**
   * One person's answer. "allow for link" also grants the card's node+cap+root
   * on the link that raised it. Unknown or already-answered ids are
   * "not-found" — an answer never lands on a card nobody is waiting for.
   */
  decide(id: string, decision: MeshApprovalDecision): "ok" | "not-found" {
    this.prune();
    const entry = this.pending.get(id);
    if (entry === undefined) return "not-found";
    this.pending.delete(id);
    for (const waiter of entry.waiters) waiter.settle(decision === "deny" ? "deny" : "allow");
    if (decision === "allow-for-link") entry.link.grant(entry.approval.cap, entry.approval.root);
    this.emit({ type: "decided", id, decision });
    return "ok";
  }

  /** The cards waiting now, oldest first, with the expired ones already gone. */
  list(): MeshApproval[] {
    this.prune();
    return [...this.pending.values()].map((entry) => ({ ...entry.approval }));
  }

  /** The link's end: its grants end with it, and the waiters it holds are answered "expired", never "allow". */
  dropLink(link: LinkGrants): void {
    const handle = link as LinkGrantsHandle;
    handle.close();
    for (const [id, entry] of this.pending) {
      const mine = entry.waiters.filter((waiter) => waiter.link === handle);
      if (mine.length === 0) continue;
      for (const waiter of mine) waiter.settle("expired");
      entry.waiters = entry.waiters.filter((waiter) => waiter.link !== handle);
      if (entry.link === handle && entry.waiters.length === 0) {
        // Raised by this link and waited on by nobody else: a card with no caller behind it.
        this.pending.delete(id);
        this.emit({ type: "expired", id });
      }
    }
  }

  /** UI listeners (the REST routes, a future sidebar): every raise, decision, and expiry. */
  events(listener: (event: ApprovalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Settles every card past its time with "expired"; every read of the queue prunes first. */
  private prune(): void {
    const now = this.now();
    for (const [id, entry] of this.pending) {
      if (entry.approval.expiresAt > now) continue;
      this.pending.delete(id);
      for (const waiter of entry.waiters) waiter.settle("expired");
      this.emit({ type: "expired", id });
    }
  }

  private emit(event: ApprovalEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

/** The dedupe/grant key of an approval: node id + cap + root, exactly what "allow for link" covers. */
function grantsKeyOf(approval: MeshApproval): string {
  return `${approval.nodeId}|${approval.cap}|${approval.root ?? ""}`;
}
