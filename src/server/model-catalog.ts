// The start screen's model chip: each harness's models, thinking levels, and default for a
// project, before any chat exists. Asking a harness costs a spawn (Pi ~4.5 s, OpenCode ~3.5 s,
// omp and Grok ~3 s, Claude ~2 s measured), and each adapter's own cache lives in memory with
// its own idea of expiry (some block on a respawn once it passes), so every server restart and
// every few minutes the chip read "Default model" for seconds.
//
// This keeps one answer per harness and project and serves it at once, whatever its age: past
// FRESH_MS the next request also starts a refresh behind it (one at a time per entry), so a
// changed login or config shows up on the next look. The answers are saved in the state folder,
// so a restart serves the last ones instead of waiting on a spawn. The first look at a project
// also warms the other harnesses' answers there, one spawn at a time, so switching harness on
// the start screen is instant too. A refresh that fails keeps the last answer; only a request
// with nothing to serve sees the failure.
import { writeJson, readJson, isObj } from "./state-file.js";
import type { ModelInfo } from "../shared/protocol.js";
import type { HarnessAdapter } from "./harness/types.js";

/** Past this, the answer is still served, and a refresh starts behind it. */
const FRESH_MS = 60_000;
/** Projects × harnesses kept (and saved); the least recently asked goes first. */
const MAX_ENTRIES = 96;
/** A harness's whole catalog can be long (Hermes lists ~280 models); this bounds one saved entry. */
const MAX_MODELS = 2000;
/** How many projects a restart refreshes behind its start: the ones looked at last (each ask is a spawn). */
const MAX_WARM_PROJECTS = 3;

export interface CatalogAnswer {
  models: ModelInfo[];
  thinkingLevels: string[];
  defaultModel: { model: string; thinkingLevel: string | null } | null;
}

interface Entry extends CatalogAnswer {
  /** When the harness gave this answer. */
  at: number;
  /** When it was last asked for (the eviction order). */
  used: number;
}

type CatalogAdapter = Pick<HarnessAdapter, "id" | "listModels" | "listThinkingLevels" | "defaultModel" | "forgetModels">;

export class ModelCatalog {
  private entries = new Map<string, Entry>();
  private inflight = new Map<string, Promise<Entry>>();
  private loaded: Promise<void> | null = null;
  private warming = Promise.resolve();

  /** `file` is where answers are saved (null: memory only, as in tests). `now` is for tests. */
  constructor(
    private readonly file: string | null,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The answer for `adapter` in `cwd`: the saved one at once when there is one (refreshed behind it when
   * stale), else the harness's, waited for. `refresh` asks the harness now (the picker's Refresh).
   */
  async get(adapter: CatalogAdapter, cwd: string, refresh = false): Promise<CatalogAnswer> {
    await this.load();
    const key = keyOf(adapter.id, cwd);
    const entry = this.entries.get(key);
    if (entry && !refresh) {
      entry.used = this.now();
      if (this.now() - entry.at >= FRESH_MS) void this.fetch(adapter, cwd).catch(() => undefined);
      return answerOf(entry);
    }
    if (refresh) {
      adapter.forgetModels?.(cwd);
      // A refresh already on its way started before this ask; this one wants the harness asked after it.
      await this.inflight.get(key)?.catch(() => undefined);
    }
    return answerOf(await this.fetch(adapter, cwd));
  }

  /**
   * The kept answer for `adapterId` in `cwd` at any age, or null: never asks the harness. For a chat that is
   * still starting, whose own harness cannot say yet which models it has.
   */
  async peek(adapterId: string, cwd: string): Promise<CatalogAnswer | null> {
    await this.load();
    const entry = this.entries.get(keyOf(adapterId, cwd));
    return entry ? answerOf(entry) : null;
  }

  /**
   * Keep the models a started chat's harness listed, when nothing is kept for that harness and folder yet, so
   * the next resume has a list to show while its harness starts. Stamped as already stale (no default model is
   * known from a chat), so the start screen's next look still refreshes it behind its answer.
   */
  async learn(adapterId: string, cwd: string, config: { models: ModelInfo[]; thinkingLevels: string[] }): Promise<void> {
    await this.load();
    const key = keyOf(adapterId, cwd);
    if (this.entries.has(key) || config.models.length === 0) return;
    this.entries.set(key, { models: config.models.slice(0, MAX_MODELS), thinkingLevels: config.thinkingLevels, defaultModel: null, at: 0, used: this.now() });
    this.evict();
    this.save();
  }

  /** Whether an answer is kept for `adapter` in `cwd`, at any age. */
  async has(adapterId: string, cwd: string): Promise<boolean> {
    await this.load();
    return this.entries.has(keyOf(adapterId, cwd));
  }

  /**
   * Fill in the answers `cwd` has none of yet, one harness at a time behind everything else: a spawn
   * each, so never all at once. Failures are left for the start screen to report when it asks.
   */
  warm(adapters: CatalogAdapter[], cwd: string): Promise<void> {
    this.warming = this.warming.then(async () => {
      for (const adapter of adapters) {
        if (await this.has(adapter.id, cwd)) continue;
        await this.fetch(adapter, cwd).catch(() => undefined);
      }
    });
    return this.warming;
  }

  /**
   * Refresh the saved answers that have gone stale, for the projects asked about most recently (at most
   * `projects` of them), one harness at a time behind `warm` so it never spawns all at once: a restart
   * then names a model at the first look instead of after a spawn. `adapters` are the harnesses to use
   * (the available ones); an entry for a harness not listed is left alone. With nothing saved, the answer
   * for `fallbackCwd` is filled in instead. Failures are swallowed, and reported once at most: a harness
   * that is down must neither fail startup nor repeat itself for every project.
   */
  warmSaved(adapters: CatalogAdapter[], opts: { projects?: number; fallbackCwd?: string | null; onError?: (error: unknown) => void } = {}): Promise<void> {
    const { projects = MAX_WARM_PROJECTS, fallbackCwd = null, onError } = opts;
    this.warming = this.warming.then(async () => {
      await this.load();
      let reported = false;
      const note = (error: unknown): void => {
        if (reported) return;
        reported = true;
        onError?.(error);
      };
      const dirs: string[] = [];
      // Most recently asked for first: `used` is what eviction sorts by.
      for (const [key] of [...this.entries].sort((a, b) => b[1].used - a[1].used)) {
        const cwd = key.slice(key.indexOf("\0") + 1);
        if (!dirs.includes(cwd)) dirs.push(cwd);
        if (dirs.length >= projects) break;
      }
      if (dirs.length === 0) {
        if (!fallbackCwd) return;
        for (const adapter of adapters) await this.fetch(adapter, fallbackCwd).catch(note);
        return;
      }
      for (const cwd of dirs) {
        for (const adapter of adapters) {
          const entry = this.entries.get(keyOf(adapter.id, cwd));
          // Only an answer this project already has, and only once it has gone stale: each ask is a spawn.
          if (!entry || this.now() - entry.at < FRESH_MS) continue;
          await this.fetch(adapter, cwd).catch(note);
        }
      }
    });
    return this.warming;
  }

  /** One ask of the harness per entry at a time; a second caller joins it. */
  private fetch(adapter: CatalogAdapter, cwd: string): Promise<Entry> {
    const key = keyOf(adapter.id, cwd);
    const running = this.inflight.get(key);
    if (running) return running;
    const pending = this.ask(adapter, cwd)
      .then((answer) => {
        const entry: Entry = { ...answer, at: this.now(), used: this.now() };
        this.entries.set(key, entry);
        this.evict();
        this.save();
        return entry;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, pending);
    return pending;
  }

  private async ask(adapter: CatalogAdapter, cwd: string): Promise<CatalogAnswer> {
    // thinkingLevels is the harness's own default list, for a picker with no model chosen yet;
    // a model's own levels (ModelInfo.levels) win when one is. Both are the harness's words, never invented.
    // defaultModel is the harness's own default so the start screen can name it; null when the harness does not say.
    const [models, thinkingLevels, defaultModel] = await Promise.all([
      adapter.listModels(cwd),
      adapter.listThinkingLevels(cwd).catch(() => [] as string[]),
      adapter.defaultModel ? adapter.defaultModel(cwd).catch(() => null) : Promise.resolve(null),
    ]);
    return { models: models.slice(0, MAX_MODELS), thinkingLevels, defaultModel };
  }

  private evict(): void {
    if (this.entries.size <= MAX_ENTRIES) return;
    const oldest = [...this.entries].sort((a, b) => a[1].used - b[1].used).slice(0, this.entries.size - MAX_ENTRIES);
    for (const [key] of oldest) this.entries.delete(key);
  }

  private saving: Promise<void> = Promise.resolve();

  private save(): void {
    this.saving = writeJson(this.file, { version: 1, entries: Object.fromEntries(this.entries) });
  }

  /** Resolves once the last answer kept is on disk (writes to one file are queued in order). */
  saved(): Promise<void> {
    return this.saving;
  }

  /** The saved answers, read once; a missing or unreadable file is an empty catalog. */
  private load(): Promise<void> {
    this.loaded ??= readJson(this.file).then((raw) => {
      const saved = isObj(raw) && raw.version === 1 && isObj(raw.entries) ? raw.entries : {};
      for (const [key, value] of Object.entries(saved)) {
        const entry = entryOf(value);
        // An answer this process already has is newer than the file's.
        if (entry && !this.entries.has(key)) this.entries.set(key, entry);
      }
    });
    return this.loaded;
  }
}

const keyOf = (adapterId: string, cwd: string) => `${adapterId}\0${cwd}`;

const answerOf = (entry: Entry): CatalogAnswer => ({ models: entry.models, thinkingLevels: entry.thinkingLevels, defaultModel: entry.defaultModel });

/** A saved entry, checked: the file is ours, but an older or hand-edited one must not reach the client malformed. */
function entryOf(value: unknown): Entry | null {
  if (!isObj(value) || typeof value.at !== "number" || !Array.isArray(value.models)) return null;
  const models = value.models.filter((m): m is ModelInfo => isObj(m) && typeof m.key === "string" && typeof m.provider === "string" && typeof m.id === "string" && typeof m.name === "string").slice(0, MAX_MODELS);
  const thinkingLevels = Array.isArray(value.thinkingLevels) ? value.thinkingLevels.filter((l): l is string => typeof l === "string") : [];
  const d = value.defaultModel;
  const defaultModel = isObj(d) && typeof d.model === "string" ? { model: d.model, thinkingLevel: typeof d.thinkingLevel === "string" ? d.thinkingLevel : null } : null;
  return { at: value.at, used: typeof value.used === "number" ? value.used : value.at, models, thinkingLevels, defaultModel };
}
