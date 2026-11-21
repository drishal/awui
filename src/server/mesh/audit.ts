// Mesh audit log (P0): one append-only line per decision the target made about
// a peer's request, so a person can read afterwards who asked for what and
// what this machine answered. The log is evidence, not a queue: appends are
// serialized so concurrent entries never interleave bytes, every string is cut
// to a bounded length, and a failed write is reported to a logger and swallowed
// — answering a peer never waits on bookkeeping, and bookkeeping never throws
// into a request's own path.
import { promises as fs } from "node:fs";
import path from "node:path";

export interface AuditEntry {
  /** When the decision was made, epoch milliseconds. */
  ts: number;
  /** The peer's node id or configured name, or null for an unidentified caller. */
  peer: string | null;
  /** What was asked for, e.g. a mesh method name. */
  method: string;
  /** What the request pointed at, when it named one. */
  target?: string;
  decision: "allow" | "ask" | "deny" | "error";
  /** What actually happened, when the decision had a result worth recording. */
  outcome?: string;
  detail?: string;
}

/** Every string field's bound: one audit line stays short enough to read and grep. */
const MAX_TEXT = 500;

const cut = (s: string): string => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s);

/** The live log's size bound before it rolls to `.1`. */
const MAX_AUDIT_BYTES = 16 * 1024 * 1024;
/** How much of the log `tail` reads. */
const TAIL_READ_BYTES = 512 * 1024;

export class AuditLog {
  /** One pending write: the next append queues behind it, so lines never interleave. */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string | null,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  /** One entry, appended as one JSON line. Resolves once it is on disk; never rejects. */
  append(entry: Omit<AuditEntry, "ts">): Promise<void> {
    if (!this.file) return Promise.resolve();
    const file = this.file;
    const line: AuditEntry = {
      ts: Date.now(),
      peer: entry.peer === null ? null : cut(entry.peer),
      method: cut(entry.method),
      decision: entry.decision,
      ...(entry.target !== undefined ? { target: cut(entry.target) } : {}),
      ...(entry.outcome !== undefined ? { outcome: cut(entry.outcome) } : {}),
      ...(entry.detail !== undefined ? { detail: cut(entry.detail) } : {}),
    };
    // JSON.stringify escapes every newline and control character, so an entry is
    // always exactly one line however hostile its strings are.
    const next = this.chain.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      // Bounded on disk: past MAX_AUDIT_BYTES the log rolls to one ".1" generation.
      const size = await fs.stat(file).then((st) => st.size, () => 0);
      if (size > MAX_AUDIT_BYTES) await fs.rename(file, `${file}.1`);
      await fs.appendFile(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    });
    // The chain a later append queues behind is the already-logged promise, so one
    // failed write neither rejects to the caller nor poisons the next one.
    this.chain = next.catch((error: unknown) => {
      this.log(`mesh audit: could not append to ${file}: ${error instanceof Error ? error.message : String(error)}`);
    });
    return this.chain;
  }

  /** The last n entries, oldest first; unreadable lines are skipped, never fatal. */
  async tail(n: number): Promise<AuditEntry[]> {
    if (!this.file || n <= 0) return [];
    let text: string;
    try {
      // Only the file's last TAIL_READ_BYTES: a long log never becomes one big read.
      const handle = await fs.open(this.file, "r");
      try {
        const { size } = await handle.stat();
        const start = Math.max(0, size - TAIL_READ_BYTES);
        const buf = Buffer.alloc(size - start);
        await handle.read(buf, 0, buf.length, start);
        text = buf.toString("utf8");
        // A cut first line is partial JSON; drop it.
        if (start > 0) text = text.slice(text.indexOf("\n") + 1);
      } finally {
        await handle.close();
      }
    } catch {
      return [];
    }
    const out: AuditEntry[] = [];
    const lines = text.split("\n");
    for (let at = lines.length - 1; at >= 0 && out.length < n; at--) {
      const line = lines[at]!.trim();
      if (!line) continue;
      try {
        out.unshift(JSON.parse(line) as AuditEntry);
      } catch {
        // A torn or foreign line is skipped; the log is read-only here.
      }
    }
    return out;
  }
}
