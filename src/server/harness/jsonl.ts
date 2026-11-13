// Streaming reads of a harness's JSONL session file, and the incremental fold the sidebar's listing uses.
//
// Claude Code, Pi and omp append one JSON object per line, and a real session reaches 100 MB and more
// (images, tool results, thinking). Reading the whole file as one string, splitting it, and parsing every
// line into an array held several copies of it at once, for each file the sidebar listed; the process
// peaked above 2 GB after a restart. Here a file is read in 1 MiB chunks and one line at a time is
// handed on, so memory is the largest line, not the file. And because the files only grow, a listing
// that has folded a file once resumes from the byte where it stopped instead of reading it again.
import { promises as fs } from "node:fs";
import { isObj, type Obj } from "./agent-events.js";

const CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;
/** How much of a file's start is compared to tell an appended file from a rewritten one. */
const HEAD_BYTES = 512;

export interface JsonlScan {
  /** The byte after the last newline-terminated line: where the next scan of a grown file starts. */
  end: number;
  /** A last line with no newline yet (a writer is mid-append, or the file does not end in one). */
  tail: string;
}

/**
 * Calls `onLine` with every newline-terminated line from `from` on (empty lines are skipped), reading in
 * chunks. Lines are decoded as UTF-8 only once whole, so a multi-byte character split by a chunk edge is safe.
 */
export async function scanJsonlLines(file: string, onLine: (line: string) => void, from = 0, chunkBytes = CHUNK_BYTES): Promise<JsonlScan> {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(chunkBytes);
    let carry: Buffer[] = [];
    let carried = 0;
    let position = from;
    let end = from;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, chunkBytes, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      let lineStart = 0;
      for (;;) {
        const newline = buffer.indexOf(NEWLINE, lineStart);
        if (newline < 0 || newline >= bytesRead) break;
        const piece = buffer.subarray(lineStart, newline);
        const line = carried > 0 ? Buffer.concat([...carry, piece]).toString("utf8") : piece.toString("utf8");
        carry = [];
        carried = 0;
        end = position - bytesRead + newline + 1;
        if (line.trim()) onLine(line);
        lineStart = newline + 1;
      }
      if (lineStart < bytesRead) {
        // Copied: the read buffer is reused by the next chunk.
        carry.push(Buffer.from(buffer.subarray(lineStart, bytesRead)));
        carried += bytesRead - lineStart;
      }
    }
    return { end, tail: carried > 0 ? Buffer.concat(carry).toString("utf8") : "" };
  } finally {
    await handle.close();
  }
}

/** One parsed object per line, a torn or foreign line skipped (a writer mid-append, a crashed write). */
export function parseJsonlLine(line: string): Obj | null {
  try {
    const entry: unknown = JSON.parse(line);
    return isObj(entry) ? entry : null;
  } catch {
    return null;
  }
}

/** The whole file's entries, read as a stream: no copy of the file as one string and no array of its lines. */
export async function readJsonlEntries(file: string): Promise<Obj[]> {
  const out: Obj[] = [];
  const push = (line: string) => {
    const entry = parseJsonlLine(line);
    if (entry) out.push(entry);
  };
  const { tail } = await scanJsonlLines(file, push);
  if (tail.trim()) push(tail);
  return out;
}

/** What a listing keeps per file to resume it: where it stopped, and enough to notice a rewrite. */
export interface FoldProgress<S> {
  size: number;
  mtimeMs: number;
  /** Bytes already folded into `state` (whole lines only). */
  offset: number;
  head: string;
  /** The unterminated last line at that point, kept so an unchanged file answers without a read. */
  tail: string;
  state: S;
}

async function headOf(file: string, size: number): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(Math.min(HEAD_BYTES, size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString("latin1", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Folds a JSONL file into a small state, starting from `previous` when the file has only grown since
 * (same first bytes, larger size) and from scratch otherwise. `clone` copies a state so the unterminated
 * last line can be folded into a result without becoming part of the saved progress, which only ever
 * holds whole lines. Returns null when the file cannot be read.
 */
export async function foldJsonlFile<S>(
  file: string,
  previous: FoldProgress<S> | undefined,
  fold: { init: () => S; clone: (state: S) => S; push: (state: S, entry: Obj) => void },
): Promise<{ progress: FoldProgress<S>; state: S } | null> {
  let stat: { size: number; mtimeMs: number };
  try {
    stat = await fs.stat(file);
  } catch {
    return null;
  }
  try {
    if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) return { progress: previous, state: finishTail(previous, fold, previous.tail) };
    const head = await headOf(file, stat.size);
    const resume = previous !== undefined && stat.size > previous.offset && previous.head === head.slice(0, previous.head.length);
    const state = resume ? fold.clone(previous.state) : fold.init();
    const scan = await scanJsonlLines(
      file,
      (line) => {
        const entry = parseJsonlLine(line);
        if (entry) fold.push(state, entry);
      },
      resume ? previous.offset : 0,
    );
    const progress: FoldProgress<S> = { size: stat.size, mtimeMs: stat.mtimeMs, offset: scan.end, head, tail: scan.tail, state };
    return { progress, state: finishTail(progress, fold, scan.tail) };
  } catch {
    return null;
  }
}

function finishTail<S>(progress: FoldProgress<S>, fold: { clone: (state: S) => S; push: (state: S, entry: Obj) => void }, tail: string): S {
  if (!tail.trim()) return progress.state;
  const entry = parseJsonlLine(tail);
  if (!entry) return progress.state;
  const state = fold.clone(progress.state);
  fold.push(state, entry);
  return state;
}
