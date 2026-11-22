// The decision cache: the same failing suite, run twice, is asked about once.
//
// The key is a digest of everything that could change the answer — the backend and model, both
// thresholds, the tool's name, the candidates, and a tail fingerprint of the output — so a changed
// threshold or a different runner's output re-asks, while two runs of one suite collide as they
// should. The tail fingerprint is the last 40 non-empty lines with digits replaced by "#": the
// counts in a summary line change between runs, the failing assertions do not.
//
// Only the decision is stored, never the output and never the request: a cache file that leaked a
// tool's output would undo everything the redaction in redact.ts promises. It is in memory, bounded
// (2 000 entries, least recently used out first) and expires in 7 days, and it is optional — a
// server with no state folder keeps it in memory only.
import { createHash } from "node:crypto";
import type { ToolDecision, ToolKind } from "../../shared/protocol.js";
import { isObj, readJson, writeJson } from "../state-file.js";

/** Past this, a decision is asked again: a week-old failure may not be the same failure. */
const TTL_MS = 7 * 24 * 60 * 60_000;
/** Entries kept (and saved); the least recently used goes first. */
const MAX_ENTRIES = 2_000;
/** Writes are coalesced: a busy chat settles many calls in a row. */
const SAVE_DELAY_MS = 1_000;

/** What one call was decided to be: the row's new family, and why. */
export interface CachedDecision {
  toolKind: ToolKind;
  decided: ToolDecision;
}

interface Entry extends CachedDecision {
  /** When the decision was made (the expiry). */
  at: number;
}

/** What a decision's identity is made of (§8.5): a change to any of these asks again. */
export interface DecisionKeyParts {
  backend: string;
  model: string;
  minChoice: number;
  minNoul: number;
  toolName: string;
  candidates: Array<[string, string | number]>;
  /** The clipped output as it was sent (see redact.ts): a hit and a request read the same text. */
  output: string;
}

/**
 * The output's stable shape: its last 40 non-empty lines, digits blanked and whitespace collapsed.
 * Two runs of the same failing suite collide; two different failures keep their own words.
 */
export function tailFingerprint(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines
    .slice(-40)
    .join("\n")
    .replace(/\d/g, "#")
    .replace(/\s+/g, " ");
}

export function decisionKey(parts: DecisionKeyParts): string {
  const material = [
    parts.backend,
    parts.model,
    String(parts.minChoice),
    String(parts.minNoul),
    parts.toolName,
    JSON.stringify(parts.candidates.map(([key, value]) => [key, value])),
    tailFingerprint(parts.output),
  ].join("\n");
  return createHash("sha256").update(material).digest("hex");
}

export class DecisionCache {
  /** How many decisions were answered from the cache, and how many had to be asked. */
  hits = 0;
  misses = 0;
  private entries = new Map<string, Entry>();
  private loaded: Promise<void> | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private saving = Promise.resolve();

  /** `file` is where decisions are saved (null: memory only, as in tests). */
  constructor(
    private readonly file: string | null,
    private readonly now: () => number = Date.now,
  ) {}

  /** The saved decisions, read once (a decision made while it loads simply misses). */
  ready(): Promise<void> {
    this.loaded ??= this.load();
    return this.loaded;
  }

  private async load(): Promise<void> {
    const saved = await readJson(this.file);
    if (!isObj(saved)) return;
    const entries = isObj(saved.entries) ? saved.entries : {};
    const at = this.now();
    for (const [key, raw] of Object.entries(entries)) {
      const entry = entryOf(raw, at);
      if (entry) this.entries.set(key, entry);
    }
  }

  get(key: string): CachedDecision | null {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    if (this.now() - entry.at >= TTL_MS) {
      this.entries.delete(key);
      this.misses += 1;
      return null;
    }
    // Re-inserting moves it to the end of the map's order: the least recently used is the first key.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return { toolKind: entry.toolKind, decided: entry.decided };
  }

  set(key: string, decision: CachedDecision): void {
    this.entries.delete(key);
    this.entries.set(key, { ...decision, at: this.now() });
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.scheduleSave();
  }

  /** Write the decisions out now (tests and shutdown), coalescing nothing. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.save();
  }

  private scheduleSave(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  private save(): Promise<void> {
    if (!this.file) return Promise.resolve();
    this.saving = this.saving.then(() => writeJson(this.file, { version: 1, entries: Object.fromEntries(this.entries) })).catch(() => undefined);
    return this.saving;
  }
}

/** One saved entry, or null when the record is not one (an older or hand-edited file). */
function entryOf(raw: unknown, now: number): Entry | null {
  if (!isObj(raw) || typeof raw.toolKind !== "string" || typeof raw.at !== "number" || !isObj(raw.decided)) return null;
  const decided = raw.decided;
  if (typeof decided.by !== "string" || typeof decided.probability !== "number" || typeof decided.at !== "number") return null;
  if (now - raw.at >= TTL_MS) return null;
  return raw as unknown as Entry;
}
