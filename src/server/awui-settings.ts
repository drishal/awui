// The awui harness's own settings: the providers it can call, read from and
// written to its isolated agent dir's models.json — never the user's real
// ~/.pi/agent — plus the opt-in that shares the user's pi login with the
// harness: the agent dir's auth.json becomes a symlink to the user's
// ~/.pi/agent/auth.json (pi resolves and rewrites that file in place, so one
// login serves both sides and token refreshes flow each way), and the
// providers from the user's models.json are copied in once, when sharing is
// turned on. auth.json is only linked and unlinked here; its bytes are never
// read, returned, or logged.
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { HarnessRegistry } from "./harness/registry.js";
import { ChatError } from "./chats/chat.js";

// apiKey is optional: providers behind no auth (a local llama server) omit it.
const awuiProviderSchema = z.object({
  baseUrl: z.string().max(2048).regex(/^https?:\/\//, "needs an http(s) URL"),
  api: z.string().min(1).max(64),
  apiKey: z.string().max(512).optional(),
  modelOverrides: z.record(z.string(), z.unknown()).optional(),
});
const awuiSettingsPatchSchema = z
  .object({
    providers: z.record(z.string().min(1).max(64), awuiProviderSchema).optional(),
    // Sent only when the checkbox changed, so a providers-only save never re-seeds.
    shareAuth: z.boolean().optional(),
  })
  .strict();

export interface AwuiProvider {
  baseUrl: string;
  api: string;
  /** Present only in the read-bytes shape; never returned to the browser. */
  apiKey?: string;
  modelOverrides?: Record<string, unknown>;
  /**
   * The rest of pi's provider shape (a `models` catalog, `auth`, headers).
   * The dialog does not edit these, so they ride along from what is stored —
   * the seed or an earlier save — through every save. The patch schema stays
   * closed, so the browser can never write them.
   */
  [piField: string]: unknown;
}

interface AwuiModelsFile {
  providers?: Record<string, AwuiProvider>;
}

async function readModelsFile(agentDir: string): Promise<AwuiModelsFile> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(agentDir, "models.json"), "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as AwuiModelsFile) : {};
  } catch {
    return {};
  }
}

/** Whole-file write through temp + rename, mode 0600 (it carries keys). */
async function writeModelsFile(agentDir: string, providers: Record<string, unknown>): Promise<void> {
  await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
  const target = path.join(agentDir, "models.json");
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify({ providers }, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, target);
}

/** The awui adapter's agent dir, or null when the harness is not registered. */
function agentDirFor(registry: HarnessRegistry): Promise<string> | null {
  const adapter = registry.get("awui");
  return adapter ? adapter.resolveAgentDir() : null;
}

/** The user's real pi agent dir: their terminal pi's login and providers. */
function piAgentDir(): string {
  return path.join(process.env.HOME ?? "", ".pi", "agent");
}

/** The agent dir's auth.json is the shared link to the user's pi login. */
async function authIsShared(agentDir: string): Promise<boolean> {
  try {
    return (await fs.lstat(path.join(agentDir, "auth.json"))).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * What linking needs before anything is written: a pi login to share, and no
 * isolated login of the harness's own in the way. That one belongs to the
 * harness; overwriting or merging it would mean reading credentials, so the
 * user removes it by hand instead. An empty `{}` file is replaceable.
 */
async function shareObstacle(agentDir: string): Promise<ChatError | null> {
  if (!(await fs.access(path.join(piAgentDir(), "auth.json")).then(() => true, () => false))) {
    return new ChatError(422, "no_pi_login", "No ~/.pi/agent/auth.json to share: log into pi first, then try again");
  }
  const target = path.join(agentDir, "auth.json");
  const st = await fs.lstat(target).catch(() => null);
  if (!st || st.isSymbolicLink()) return null;
  let own: unknown;
  try {
    own = JSON.parse(await fs.readFile(target, "utf8"));
  } catch {
    own = null; // an unparseable file is not an empty login either
  }
  if (typeof own !== "object" || own === null || Object.keys(own).length > 0) {
    return new ChatError(409, "awui_login_conflict", "The Awui harness has its own login already; remove its auth.json to share pi's instead");
  }
  return null;
}

/**
 * Point the agent dir's auth.json at the user's. pi resolves auth.json inside
 * whatever agent dir it runs with and rewrites it in place under a lock taken
 * at that path, so through the link one login serves both: a /login or a
 * token refresh on either side reaches the other. The two processes lock
 * their own paths, so a refresh racing in the user's pi and the awui child at
 * the same instant can drop one update (recovered by logging in again).
 */
async function sharePiLogin(agentDir: string): Promise<void> {
  const obstacle = await shareObstacle(agentDir);
  if (obstacle) throw obstacle;
  const target = path.join(agentDir, "auth.json");
  await fs.mkdir(agentDir, { recursive: true, mode: 0o700 }); // a settings save can be the first thing to touch the agent dir
  await fs.rm(target, { force: true }); // validated above: absent, the old link, or an empty file
  await fs.symlink(path.join(piAgentDir(), "auth.json"), target);
}

/** Take the link out and put back an empty isolated login. Seeded providers stay: they are the harness's own config now. */
async function unsharePiLogin(agentDir: string): Promise<void> {
  const target = path.join(agentDir, "auth.json");
  if (!(await fs.lstat(target).then((s) => s.isSymbolicLink(), () => false))) return;
  await fs.rm(target);
  await fs.writeFile(target, "{}", { mode: 0o600 });
}

/**
 * Copy the user's ~/.pi/agent/models.json providers into the isolated dir,
 * once, when sharing turns on — the same endpoints and keys, no retyping.
 * Entries are copied verbatim (a provider's `models` catalog included). The
 * seed stands down when the harness's own list holds a provider pi does not:
 * the user's edits here win over the copy.
 */
async function seedPiProviders(agentDir: string): Promise<void> {
  let pi: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(piAgentDir(), "models.json"), "utf8"));
    const providers = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).providers : undefined;
    if (typeof providers === "object" && providers !== null && Object.keys(providers).length > 0) pi = providers as Record<string, unknown>;
  } catch {
    return; // no pi models.json: the login is shared, the list stays the harness's own
  }
  if (!pi) return;
  const stored = (await readModelsFile(agentDir)).providers ?? {};
  if (Object.keys(stored).some((name) => !(name in pi))) return;
  await writeModelsFile(agentDir, pi);
}

/** The settings as the dialog sees them: apiKeys redacted to a flag, never the key (peer to how the login password is write-only). */
export interface AwuiSettingsSnapshot {
  providers: Record<string, { baseUrl: string; api: string; hasApiKey: boolean; modelOverrides?: Record<string, unknown> }>;
  /** The agent dir's auth.json is the shared link to the user's pi login. */
  shareAuth: boolean;
  /** A ~/.pi/agent/auth.json exists, so sharing can be offered. */
  piLogin: boolean;
}

export async function readAwuiConfig(registry: HarnessRegistry): Promise<AwuiSettingsSnapshot> {
  const agentDir = agentDirFor(registry);
  if (!agentDir) throw new ChatError(404, "no_awui_harness", "The awui harness is not enabled");
  const dir = await agentDir;
  const file = await readModelsFile(dir);
  const providers: AwuiSettingsSnapshot["providers"] = {};
  for (const [name, p] of Object.entries(file.providers ?? {})) {
    providers[name] = { baseUrl: p.baseUrl, api: p.api, hasApiKey: Boolean(p.apiKey), ...(p.modelOverrides !== undefined ? { modelOverrides: p.modelOverrides } : {}) };
  }
  return { providers, shareAuth: await authIsShared(dir), piLogin: await fs.access(path.join(piAgentDir(), "auth.json")).then(() => true, () => false) };
}

/**
 * Replace the providers and apply the share toggle. An omitted apiKey keeps
 * the stored one (the dialog's leave-it-blank convention); an empty string
 * clears it. Sharing is checked before anything is written, so a refused
 * toggle leaves the providers untouched too; turning it on links the login
 * and then seeds, so a save that empties the list while opting in still ends
 * with Pi's providers in it.
 */
export async function writeAwuiConfig(registry: HarnessRegistry, body: unknown): Promise<AwuiSettingsSnapshot> {
  const agentDirPromise = agentDirFor(registry);
  if (!agentDirPromise) throw new ChatError(404, "no_awui_harness", "The awui harness is not enabled");
  const patch = awuiSettingsPatchSchema.parse(body);
  const agentDir = await agentDirPromise;
  if (patch.shareAuth === true) {
    const obstacle = await shareObstacle(agentDir);
    if (obstacle) throw obstacle;
  }
  if (patch.providers !== undefined) {
    const existing = await readModelsFile(agentDir);
    const merged: Record<string, AwuiProvider> = {};
    for (const [name, p] of Object.entries(patch.providers)) {
      const prior = existing.providers?.[name];
      const modelOverrides = p.modelOverrides ?? prior?.modelOverrides;
      // pi-shaped fields the dialog never edits ride along from what is stored.
      const next: AwuiProvider = { ...prior, baseUrl: p.baseUrl, api: p.api };
      // apiKey tri-state: undefined (dialog left it blank) keeps the stored
      // key; "" clears it; anything else replaces it.
      if (p.apiKey === undefined) {
        if (prior?.apiKey !== undefined) next.apiKey = prior.apiKey;
      } else if (p.apiKey === "") delete next.apiKey;
      else next.apiKey = p.apiKey;
      if (modelOverrides !== undefined) next.modelOverrides = modelOverrides;
      merged[name] = next;
    }
    await writeModelsFile(agentDir, merged);
  }
  if (patch.shareAuth === true) {
    await sharePiLogin(agentDir);
    await seedPiProviders(agentDir);
  } else if (patch.shareAuth === false) {
    await unsharePiLogin(agentDir);
  }
  return readAwuiConfig(registry);
}
