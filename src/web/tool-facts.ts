// Facts read from a tool call's output: "12 passed · 1 failed" for a test run,
// "3 errors in 2 files" for tsc, "4 results in 2 files" for rg, "added 12 packages"
// for npm. Each parser is small, deterministic, and claims an output only when
// it is sure of the shape (a log that merely mentions "passed" is nobody's);
// anything else returns nothing, and the row shows just its time. Parsers read
// the output as the item holds it (already cut to head and tail, 16 KB) and stop
// after MAX_LINES lines. Pure: atui and the Tern client may import it like turns.ts.
import type { ToolItem } from "../shared/protocol.js";

/** One structured line of a richer body: a search hit, a compiler error, a changed file. */
export interface FactRow {
  file?: string;
  line?: number;
  text: string;
}

export interface ToolFacts {
  kind?: "test" | "build" | "typecheck" | "git" | "search" | "listing" | "install" | "json";
  /** What the output says, shortest first: ["12 passed", "1 failed"]. */
  facts: string[];
  /** The first failing test, the first compiler error. */
  error?: string;
  rows?: FactRow[];
}

const MAX_LINES = 600;
const MAX_ROWS = 50;
const NONE: ToolFacts = { facts: [] };

type Args = Record<string, unknown>;

/** A call's arguments as an object; empty when they do not parse. */
export function toolArgs(raw: string): Args {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Args) : {};
  } catch {
    return {};
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

function cut(text: string, max = 140): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function count(line: string, word: string): number {
  const m = new RegExp(`(\\d+) ${word}\\b`).exec(line);
  return m ? Number(m[1]) : 0;
}

/** "12 passed", "1 failed", "2 skipped": the nonzero parts, passed first. */
function tally(passed: number, failed: number, skipped: number): string[] {
  const out: string[] = [];
  if (passed > 0) out.push(`${passed} passed`);
  if (failed > 0) out.push(`${failed} failed`);
  if (skipped > 0) out.push(`${skipped} skipped`);
  return out;
}

/** Vitest's `Tests  1 failed | 25 passed (26)` and Jest's `Tests:  1 failed, 25 passed, 26 total`. */
function jsTests(lines: string[]): ToolFacts | undefined {
  const summary = lines.find((l) => /^\s*Tests:?\s+.*(?:\(\d+\)|\d+ total)\s*$/.test(l));
  if (!summary) return undefined;
  const passed = count(summary, "passed");
  const failed = count(summary, "failed");
  const skipped = count(summary, "skipped") + count(summary, "todo");
  if (passed + failed + skipped === 0) return undefined;
  // The first failing test: Vitest's `FAIL  file > name` or Jest's `● suite › name`.
  let error: string | undefined;
  for (const l of lines) {
    const vitest = /^\s*FAIL\s+\S+\s+>\s+(.+)$/.exec(l);
    const jest = /^\s*●\s+(.+?)\s*$/.exec(l);
    const name = vitest ? (vitest[1] as string).split(" > ").pop() : jest ? (jest[1] as string).split(" › ").pop() : undefined;
    if (name && !/^Console\b/.test(name)) {
      error = cut(name);
      break;
    }
  }
  return { kind: "test", facts: tally(passed, failed, skipped), ...(error ? { error } : {}) };
}

/** pytest's `===== 1 failed, 2 passed in 0.12s =====`. */
function pytest(lines: string[]): ToolFacts | undefined {
  const summary = [...lines].reverse().find((l) => /^=+ .+ in [\d.]+s(?: \(.*\))? =+$/.test(l));
  if (!summary) return undefined;
  const passed = count(summary, "passed");
  const failed = count(summary, "failed") + count(summary, "errors?");
  const skipped = count(summary, "skipped");
  if (passed + failed + skipped === 0) return undefined;
  const failure = lines.find((l) => /^(?:FAILED|ERROR) \S+/.test(l));
  return { kind: "test", facts: tally(passed, failed, skipped), ...(failure ? { error: cut(failure.replace(/^(?:FAILED|ERROR) /, "")) } : {}) };
}

/** cargo test's `test result: FAILED. 3 passed; 1 failed; ...` (one per test binary) and go test's `--- FAIL:` and `ok  pkg` lines. */
function cargoOrGo(lines: string[]): ToolFacts | undefined {
  const results = lines.filter((l) => /^test result: (?:ok|FAILED)\./.test(l));
  if (results.length > 0) {
    let passed = 0;
    let failed = 0;
    let ignored = 0;
    for (const l of results) {
      passed += count(l, "passed");
      failed += count(l, "failed");
      ignored += count(l, "ignored");
    }
    const fail = lines.find((l) => /^test .+ \.\.\. FAILED$/.test(l));
    const name = fail ? /^test (.+) \.\.\. FAILED$/.exec(fail)?.[1] : undefined;
    return { kind: "test", facts: tally(passed, failed, ignored), ...(name ? { error: cut(name) } : {}) };
  }
  const verbose = lines.filter((l) => /^\s*--- (?:PASS|FAIL):/.test(l));
  const packages = lines.filter((l) => /^(?:ok|FAIL)\s+\S+\s+(?:[\d.]+s|\(cached\))/.test(l));
  if (verbose.length > 0 || packages.length > 0) {
    const fail = lines.find((l) => /^\s*--- FAIL: \S+/.test(l));
    const name = fail ? /--- FAIL: (\S+)/.exec(fail)?.[1] : undefined;
    const error = name ? { error: cut(name) } : {};
    if (verbose.length > 0) {
      const failed = verbose.filter((l) => /--- FAIL:/.test(l)).length;
      return { kind: "test", facts: tally(verbose.length - failed, failed, 0), ...error };
    }
    const failed = packages.filter((l) => l.startsWith("FAIL")).length;
    const ok = packages.length - failed;
    return { kind: "test", facts: [...(ok > 0 ? [`${plural(ok, "package")} ok`] : []), ...(failed > 0 ? [`${failed} failed`] : [])], ...error };
  }
  return undefined;
}

/** tsc's `file(line,col): error TS…` (or the pretty `file:line:col - error TS…`) and eslint's stylish report. */
function compiler(lines: string[]): ToolFacts | undefined {
  const rows: FactRow[] = [];
  const files = new Set<string>();
  let errors = 0;
  for (const l of lines) {
    const m = /^(\S[^()]*?)(?:\((\d+),\d+\): |:(\d+):\d+ - )error (TS\d+): (.*)$/.exec(l);
    if (!m) continue;
    errors++;
    files.add(m[1] as string);
    if (rows.length < MAX_ROWS) rows.push({ file: m[1] as string, line: Number(m[2] ?? m[3]), text: `${m[4]}: ${m[5]}` });
  }
  if (errors > 0) {
    const first = rows[0];
    return {
      kind: "typecheck",
      facts: [`${plural(errors, "error")} in ${plural(files.size, "file")}`],
      ...(first?.file ? { error: cut(`${first.file}:${first.line}: ${first.text}`) } : {}),
      rows,
    };
  }
  // eslint: a path line, then `  12:5  error  message  rule`, and `✖ 3 problems (2 errors, 1 warning)`.
  const problems = lines.find((l) => /^\s*✖ \d+ problems? \(/.test(l));
  if (problems) {
    const e = count(problems, "errors?");
    const w = count(problems, "warnings?");
    let file = "";
    let first: string | undefined;
    for (const l of lines) {
      if (/^\/?[\w@./-]+\.[A-Za-z]+$/.test(l.trim()) && !/^\s+\d+:\d+/.test(l)) file = l.trim();
      const m = /^\s+(\d+):\d+\s+error\s+(.+?)\s{2,}\S+\s*$/.exec(l);
      if (m && !first) first = cut(`${file}:${m[1]}: ${m[2]}`);
    }
    const facts = [e > 0 ? plural(e, "error") : "", w > 0 ? plural(w, "warning") : ""].filter(Boolean);
    return { kind: "build", facts, ...(first ? { error: first } : {}) };
  }
  return undefined;
}

/** `path:line:text` and `path:line:col:text` lines: grep -n, rg, and a search tool's output. Claimed only when nearly every line has the shape. */
function grepHits(lines: string[]): ToolFacts | undefined {
  const shaped = lines.filter((l) => l.trim());
  if (shaped.length === 0) return undefined;
  const hits: FactRow[] = [];
  const files = new Set<string>();
  for (const l of shaped) {
    const m = /^(\S[^:\n]*?):(\d+)(?::\d+)?:(.*)$/.exec(l);
    if (!m || /\s-\s/.test(m[1] as string)) continue;
    files.add(m[1] as string);
    if (hits.length < MAX_ROWS) hits.push({ file: m[1] as string, line: Number(m[2]), text: (m[3] as string).trim() });
  }
  let matched = 0;
  for (const l of shaped) if (/^\S[^:\n]*?:\d+(?::\d+)?:/.test(l)) matched++;
  if (matched === 0 || matched < shaped.length * 0.8) return undefined;
  return { kind: "search", facts: [`${plural(matched, "result")} in ${plural(files.size, "file")}`], rows: hits };
}

/** `git status --short` / the long form (given the command, which tells porcelain from a listing) and `git diff --stat`'s last line. */
function git(lines: string[], command: string): ToolFacts | undefined {
  const stat = [...lines].reverse().find((l) => /^\s*\d+ files? changed(?:, \d+ insertions?\(\+\))?(?:, \d+ deletions?\(-\))?\s*$/.test(l));
  if (stat) {
    const files = count(stat, "files?");
    const added = count(stat, "insertions?");
    const removed = count(stat, "deletions?");
    const change = [added > 0 ? `+${added}` : "", removed > 0 ? `−${removed}` : ""].filter(Boolean).join(" ");
    const rows = lines.flatMap((l): FactRow[] => {
      const m = /^\s*(\S.*?)\s+\|\s+\d+/.exec(l);
      return m ? [{ file: m[1] as string, text: l.trim() }] : [];
    });
    return { kind: "git", facts: [plural(files, "file"), ...(change ? [change] : [])], rows: rows.slice(0, MAX_ROWS) };
  }
  if (!/\bgit\s+(?:-\S+\s+)*status\b/.test(command)) return undefined;
  let changed = 0;
  let added = 0;
  const rows: FactRow[] = [];
  const short = lines.filter((l) => l.trim());
  if (short.length > 0 && short.every((l) => /^[ MADRCU?!]{2} \S/.test(l) || /^## /.test(l))) {
    for (const l of short) {
      if (l.startsWith("##")) continue;
      const code = l.slice(0, 2);
      if (code === "??" || code.includes("A")) added++;
      else changed++;
      if (rows.length < MAX_ROWS) rows.push({ file: l.slice(3), text: l });
    }
  } else if (lines.some((l) => /^On branch |^HEAD detached/.test(l))) {
    let untracked = false;
    for (const l of lines) {
      if (/^Untracked files:/.test(l)) untracked = true;
      else if (/^\S/.test(l) && !l.startsWith("(")) untracked = false;
      const m = /^\t(modified|deleted|renamed|new file|typechange):\s+(.+)$/.exec(l);
      if (m) {
        if (m[1] === "new file") added++;
        else changed++;
        if (rows.length < MAX_ROWS) rows.push({ file: m[2] as string, text: l.trim() });
      } else if (untracked && /^\t\S/.test(l)) {
        added++;
        if (rows.length < MAX_ROWS) rows.push({ file: l.trim(), text: l.trim() });
      }
    }
    if (changed + added === 0) return { kind: "git", facts: ["clean"] };
  } else return undefined;
  if (changed + added === 0) return undefined;
  return { kind: "git", facts: [changed > 0 ? `${changed} changed` : "", added > 0 ? `${added} new` : ""].filter(Boolean), rows };
}

/** npm's "added 12 packages, and audited 13 packages in 2s", pnpm's "Packages: +12", pip's "Successfully installed a-1 b-2". */
function install(lines: string[]): ToolFacts | undefined {
  for (const l of lines) {
    const pip = /^Successfully installed (.+)$/.exec(l);
    if (pip) return { kind: "install", facts: [`installed ${plural((pip[1] as string).split(/\s+/).length, "package")}`] };
    if (/^(?:added|removed|changed) \d+ packages?\b/.test(l)) {
      const added = /added (\d+) packages?/.exec(l);
      const removed = /removed (\d+) packages?/.exec(l);
      const changed = /changed (\d+) packages?/.exec(l);
      const facts = [added ? `added ${plural(Number(added[1]), "package")}` : "", removed ? `removed ${plural(Number(removed[1]), "package")}` : "", changed ? `changed ${plural(Number(changed[1]), "package")}` : ""].filter(Boolean);
      return { kind: "install", facts };
    }
    if (/^up to date, audited \d+ packages?/.test(l)) return { kind: "install", facts: ["up to date"] };
    const pnpm = /^Packages: \+(\d+)/.exec(l);
    if (pnpm) return { kind: "install", facts: [`added ${plural(Number(pnpm[1]), "package")}`] };
  }
  return undefined;
}

/** An output that is one JSON array: "12 items". An object says nothing; what it holds is not a fact about the call. */
function json(output: string): ToolFacts | undefined {
  const t = output.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return undefined;
  try {
    const parsed: unknown = JSON.parse(t);
    return Array.isArray(parsed) ? { kind: "json", facts: [parsed.length === 0 ? "no items" : plural(parsed.length, "item")] } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a finished call's output says, when a parser is sure of it; otherwise no
 * facts. A running call's output is partial, so it claims nothing.
 */
export function toolFacts(item: ToolItem): ToolFacts {
  if (item.status === "running" || !item.output.trim()) return NONE;
  const text = item.output.replace(ANSI, "");
  const lines = text.split("\n").slice(0, MAX_LINES);
  // A cut output (head, a gap, tail) keeps its summary at the tail, but its middle is missing: counts of lines are no longer true.
  const tail = item.truncated ? text.split("\n").slice(-200) : [];
  const seen = item.truncated ? [...lines.slice(0, 100), ...tail] : lines;
  const command = String(toolArgs(item.args).command ?? toolArgs(item.args).cmd ?? "");
  const category = item.category;
  if (category === "command" || category === "other" || category === "search") {
    if (category !== "search") {
      const found = jsTests(seen) ?? pytest(seen) ?? cargoOrGo(seen) ?? compiler(seen) ?? git(seen, command) ?? install(seen);
      if (found) return found;
    }
    // A truncated search lists only part of its hits: no count rather than a wrong one.
    if (!item.truncated) {
      const found = grepHits(lines) ?? json(text);
      if (found && (category !== "search" || found.kind === "search" || found.kind === "json")) return found;
    }
  }
  return NONE;
}

/** A test run's progress while it runs: how far, out of how many, what failed, and what runs now. */
export interface TestProgress {
  done: number;
  total: number;
  failed: number;
  /** The test running now (or the last one reported), as the runner names it. */
  current?: string;
}

/** e2e-parallel's tag on each line of a shard ("[1] "): never a Playwright [n/N] counter, which has a slash. */
const SHARD = /^\[(\d+)\] (.*)$/;

/**
 * How far a test run has got, read from the output it has printed so far: only
 * runners that announce their total up front can say "19 of 27" (Playwright's
 * "Running 27 tests", pytest's "collected 27 items", cargo's "running 27
 * tests"); Vitest and Jest say theirs only at the end, where toolFacts reads
 * it. Shards tagged by e2e-parallel ("[1] …") are counted apiece and added up.
 * Reads the head (the total) and tail (the newest progress) the item keeps.
 */
export function testProgress(output: string): TestProgress | null {
  const lines = output.replace(ANSI, "").split("\n");
  const shards = new Map<string, { total: number; done: number; failed: number; failedSeen: Set<string> }>();
  const shardOf = (key: string) => {
    let s = shards.get(key);
    if (!s) shards.set(key, (s = { total: 0, done: 0, failed: 0, failedSeen: new Set() }));
    return s;
  };
  let current: string | undefined;
  let pytestPercent: number | null = null;
  for (const raw of lines) {
    const tagged = SHARD.exec(raw);
    const key = tagged ? (tagged[1] as string) : "";
    const line = tagged ? (tagged[2] as string) : raw;
    const s = shardOf(key);
    let m: RegExpExecArray | null;
    // Playwright: the total, then the line reporter's [n/N] (test n starting) or the list reporter's "✓  12 [project] › …".
    if ((m = /^Running (\d+) tests? using \d+ workers?/.exec(line.trim()))) s.total = Number(m[1]);
    // Only with Playwright's "›" between project, file, and title: ninja and cmake print "[12/40] Building …" too.
    else if ((m = /^\[(\d+)\/(\d+)\] (.+ › .+)$/.exec(line.trim()))) {
      s.total = Number(m[2]);
      s.done = Math.max(s.done, Number(m[1]) - 1);
      current = (m[3] as string).trim();
    } else if ((m = /^\s*([✓✘×✔-])\s+(\d+) (\[.+ › .+)$/.exec(line))) {
      s.done = Math.max(s.done, Number(m[2]));
      if ((m[1] === "✘" || m[1] === "×") && !s.failedSeen.has(m[2] as string)) {
        s.failedSeen.add(m[2] as string);
        s.failed += 1;
      }
      current = (m[3] as string).replace(/\s+\(\d+(\.\d+)?m?s\)$/, "").trim();
    } else if ((m = /^\s{2}(\d+)\) \[/.exec(line))) {
      // The line reporter's numbered failures: the highest number is how many failed so far.
      s.failed = Math.max(s.failed, Number(m[1]));
    }
    // pytest: the total, then a file's result letters (or -v's PASSED/FAILED lines) with a percentage.
    else if ((m = /^collected (\d+) items?/.exec(line.trim()))) s.total = Number(m[1]);
    else if ((m = /^(\S+\.py)\s+([.FEsxX]+)\s+\[\s*(\d+)%\]$/.exec(line.trim()))) {
      s.done += (m[2] as string).length;
      s.failed += ((m[2] as string).match(/[FE]/g) ?? []).length;
      current = m[1];
      pytestPercent = Number(m[3]);
    } else if ((m = /^(\S+::\S+) (PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)\s+\[\s*(\d+)%\]$/.exec(line.trim()))) {
      s.done += 1;
      if (m[2] === "FAILED" || m[2] === "ERROR") s.failed += 1;
      current = m[1];
      pytestPercent = Number(m[3]);
    }
    // cargo test: each binary's "running N tests", then a line per test.
    else if ((m = /^running (\d+) tests?$/.exec(line.trim()))) s.total += Number(m[1]);
    else if ((m = /^test (\S+) \.\.\. (ok|FAILED|ignored)/.exec(line.trim()))) {
      s.done += 1;
      if (m[2] === "FAILED") s.failed += 1;
      current = m[1];
    }
  }
  let total = 0;
  let done = 0;
  let failed = 0;
  for (const s of shards.values()) {
    total += s.total;
    done += Math.min(s.done, s.total || s.done);
    failed += s.failed;
  }
  // pytest's output is cut to head and tail, so counted letters can fall short: its own percentage is the floor.
  if (pytestPercent !== null && total > 0) done = Math.max(done, Math.round((pytestPercent / 100) * total));
  if (total <= 0) return null;
  return { done: Math.min(done, total), total, failed, ...(current ? { current: cut(current, 160) } : {}) };
}
