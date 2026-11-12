// The user's settings: ~/.config/awui/config.yml (YAML, so it can carry
// comments), with the base16/base24 theme.yml beside it. Real environment
// variables win over the file; AWUI_CONFIG_DIR moves the folder ("" ignores
// it, as the tests do).
import { chmodSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { chatWidthSchema, densitySchema, themeChoiceSchema, toolStyleSchema, uiFontSchema, type ChatWidth, type Density, type ThemeChoice, type ToolStyle, type UiFont } from "../shared/protocol.js";
import { IS_WINDOWS, defaultConfigDir } from "./platform-win.js";

export const CONFIG_FILE = "config.yml";
export const THEME_FILE = "theme.yml";

/** What the browser needs from config.yml; re-read on every page load. */
export interface UiSettings {
  /** null: no preference, so a theme.yml is used when present. */
  theme: ThemeChoice | null;
  autocollapseSidebar: boolean;
  /** Show the bar under the conversation (connection, harness, model, folder, version). */
  showStatusBar: boolean;
  /** Shared chat text size; null: the 100% default. */
  textScale: number | null;
  /** Shared conversation width; null: comfortable. */
  chatWidth: ChatWidth | null;
  /** Shared row and gap density; null: comfortable. */
  density: Density | null;
  /** How a turn's work is drawn; null: cards. */
  toolStyle: ToolStyle | null;
  /** The web UI's type; null: the bundled font. */
  font: UiFont | null;
  /** Work with herdr (config.yml's `herdr`, or AWUI_HERDR): atui reads it to report its chats to a herdr pane. */
  herdr: boolean;
}

export class UserConfigError extends Error {}

const commandSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((v) => !/[\u0000-\u001f]/.test(v), "must not hold control characters");
/** Harness ids awui already ships: a config.yml ACP entry may not take one over. */
export const BUILT_IN_HARNESS_IDS = ["pi", "omp", "hermes", "claude", "codex", "opencode", "grok", "dsh", "awui", "fake", "fake-b"] as const;

/** An ACP agent's id: a slug, so it reads the same in a URL, an env list, and the sidebar. */
const acpIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "must be a slug: lowercase letters, digits, or '-', at most 32 characters, starting with a letter or digit");

const envNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "must be a variable name: letters, digits, or '_', not starting with a digit");

/**
 * One ACP agent awui starts itself: any app that speaks the Agent Client
 * Protocol over stdio (Gemini CLI, Qwen Code, Goose, Cline, …). Its own login,
 * models, and session files stay the agent's; `env` is the only secret awui
 * holds for it, and a value is never read back out to a browser.
 */
const acpAgentSchema = z
  .object({
    id: acpIdSchema,
    /** What the menus call it; the id when config.yml does not say. */
    name: z.string().trim().min(1).max(64).optional(),
    command: commandSchema,
    args: z.array(z.string().max(4096).refine((v) => !v.includes("\u0000"), "must not hold a NUL")).max(64).optional(),
    env: z.record(envNameSchema, z.string().max(8192).refine((v) => !v.includes("\u0000"), "must not hold a NUL")).optional(),
    /** The `authenticate` method to call, by the id the agent advertises; omitted leaves sign-in to the agent. */
    auth_method: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

/** At most this many ACP agents: each is a harness in every menu and a child process per chat. */
export const MAX_ACP_AGENTS = 16;

const acpListSchema = z
  .array(acpAgentSchema)
  .max(MAX_ACP_AGENTS)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    for (const [index, entry] of list.entries()) {
      if ((BUILT_IN_HARNESS_IDS as readonly string[]).includes(entry.id)) {
        ctx.addIssue({ code: "custom", path: [index, "id"], message: `"${entry.id}" is one of awui's own harness ids` });
      }
      if (seen.has(entry.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: `"${entry.id}" is already defined` });
      seen.add(entry.id);
    }
  });

const launchSchema = z
  .object({
    command: commandSchema.optional(),
    args: z.array(z.string().max(4096).refine((v) => !v.includes("\u0000"), "must not hold a NUL")).max(64).optional(),
  })
  .strict();

/**
 * The labels Claude Code itself uses for `CLAUDE_CODE_ENTRYPOINT`. Claiming one would pass awui off as that
 * client, so config.yml may not; an honest name of its own (`awui`) is the only thing it accepts.
 */
export const CLAUDE_BUILT_IN_ENTRYPOINTS = ["cli", "sdk-cli", "sdk-ts", "sdk-py", "claude-vscode", "claude-desktop", "claude-code"] as const;

const claudeEntrypointSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9._-]{0,31}$/, "must be a plain name: letters, digits, '.', '_' or '-', at most 32 characters, starting with a letter")
  .refine((v) => !(CLAUDE_BUILT_IN_ENTRYPOINTS as readonly string[]).includes(v.toLowerCase()) && !/^sdk-/i.test(v), "must not be one of Claude Code's own labels (cli, sdk-*, claude-vscode, claude-desktop, claude-code)");

const schema = z
  .object({
    port: z.number().int().optional(),
    host: z.string().optional(),
    auth: z.object({ username: z.string().optional(), password: z.string().optional() }).strict().optional(),
    workspace_roots: z.array(z.string()).optional(),
    allowed_hosts: z.array(z.string()).optional(),
    allowed_tailscale_users: z.array(z.string()).optional(),
    theme: themeChoiceSchema.optional(),
    autocollapse_sidebar: z.boolean().optional(),
    /** Show the bar under the conversation; on unless false. */
    show_status_bar: z.boolean().optional(),
    /** The desktop app keeps running in the tray when its window closes; on unless false. */
    desktop_background: z.boolean().optional(),
    /** Shared chat text size (a scale on the 14.5px base); null when unset. */
    text_scale: z.number().min(0.5).max(2).optional(),
    /** Shared conversation width: comfortable (960px), wide (1400px), or full. */
    chat_width: chatWidthSchema.optional(),
    /** Shared density of the web UI's rows and gaps: comfortable (today's look) or compact. */
    density: densitySchema.optional(),
    /** How a turn's work is drawn: the card (today's look), or the flat line list older versions drew. */
    tool_style: toolStyleSchema.optional(),
    /** The web UI's type: the bundled font (the same on every machine), or each device's system font. */
    font: uiFontSchema.optional(),
    /** Work with herdr (herdr.ts, atui/herdr.ts); on unless false. */
    herdr: z.boolean().optional(),
    /**
     * The orchestration surface's bounds (limits.ts holds the defaults and what each one means).
     * Every number is re-read while the server runs, so none of them needs a restart.
     */
    orchestration: z
      .object({
        enabled: z.boolean().optional(),
        maxChildrenPerChat: z.number().int().min(1).max(32).optional(),
        maxTasksPerChat: z.number().int().min(1).max(500).optional(),
        maxLiveTasks: z.number().int().min(1).max(64).optional(),
        maxDepth: z.number().int().min(0).max(4).optional(),
        taskWallClockMs: z.number().int().min(60_000).max(24 * 60 * 60_000).optional(),
        wakeParents: z.boolean().optional(),
        maxWakesPerHour: z.number().int().min(0).max(1000).optional(),
        callsPerMinute: z.number().int().min(1).max(6000).optional(),
      })
      .strict()
      .optional(),
    /**
     * Claude Code's own settings (file-only: read at startup, no Settings dialog field). The prompt
     * cache lifetime its subagents use, `5m` or `1h`, which a delegated child here is given too, and an
     * `entrypoint` name for `CLAUDE_CODE_ENTRYPOINT` (see ClaudeSettings.entrypoint).
     */
    claude: z.object({ subagent_prompt_cache_ttl: z.enum(["5m", "1h"]).optional(), entrypoint: claudeEntrypointSchema.optional() }).strict().optional(),
    /** Herdr's API socket, when not the default session's (file-only; HERDR_SOCKET_PATH wins). */
    herdr_socket: z.string().trim().min(1).max(4096).optional(),
    /** How each harness's CLI starts: its executable, and arguments for every chat child. File-only (see HarnessLaunch). */
    harnesses: z
      .object({
        pi: launchSchema.optional(),
        omp: launchSchema.optional(),
        claude: launchSchema.optional(),
        // Codex's chats run one `codex app-server` child each, so it takes a command line too.
        codex: launchSchema.optional(),
        // Grok's chats run one `grok agent --no-leader stdio` child each, so it takes a command line like pi's and claude's.
        grok: launchSchema.optional(),
        // DSH's chats run one `dsh --profile acp` child each; args land after the profile name.
        dsh: launchSchema.optional(),
        // Hermes's chats run its gateway from its Python package: there is no command line to add to.
        hermes: z.object({ command: commandSchema.optional() }).strict().optional(),
        // OpenCode's chats share one `opencode serve`: no per-chat command line either.
        opencode: z.object({ command: commandSchema.optional() }).strict().optional(),
        // Any other Agent Client Protocol app: one entry per agent, each registering a harness of its own.
        acp: acpListSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type UserConfig = z.infer<typeof schema>;

/** The settings folder, or null when AWUI_CONFIG_DIR is set to "". */
export function configDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.AWUI_CONFIG_DIR !== undefined) return env.AWUI_CONFIG_DIR ? path.resolve(env.AWUI_CONFIG_DIR) : null;
  return defaultConfigDir(env, homedir());
}

/** One-time rename of the pre-rename settings folder; returns "moved" when it happened. */
export function migrateConfigDir(env: NodeJS.ProcessEnv = process.env): "moved" | null {
  if (env.AWUI_CONFIG_DIR !== undefined) return null; // an explicit dir is authoritative; nothing to move
  const dir = defaultConfigDir(env, homedir());
  const old = path.join(path.dirname(dir), "agentwebui");
  const target = dir;
  if (!existsSync(old) || existsSync(target)) return null;
  try {
    renameSync(old, target);
    return "moved";
  } catch {
    return null;
  }
}

/** config.yml parsed and checked, or null when there is none. A file holding a password is made 0600. */
export function readUserConfig(dir: string | null): { file: string; config: UserConfig; tightened: boolean } | null {
  if (!dir) return null;
  const file = path.join(dir, CONFIG_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new UserConfigError(`cannot read ${file}: ${(error as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = parse(text, { maxAliasCount: 10 }) ?? {};
  } catch (error) {
    throw new UserConfigError(`${file} is not valid YAML: ${(error as Error).message.split("\n")[0]}`);
  }
  const config = checkUserConfig(raw, file);
  let tightened = false;
  if (config.auth?.password && (statSync(file).mode & 0o077) !== 0) {
    chmodSync(file, 0o600);
    tightened = true;
  }
  return { file, config, tightened };
}

/** config.yml's content checked against its schema (startup and the Settings dialog share it). */
export function checkUserConfig(raw: unknown, file: string): UserConfig {
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : "top level";
    throw new UserConfigError(`${file}: ${where}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}

/** The file's settings as the environment variables loadConfig reads. */
export function configEnv(c: UserConfig): Record<string, string> {
  const env: Record<string, string> = {};
  if (c.port !== undefined) env.PORT = String(c.port);
  if (c.host !== undefined) env.HOST = c.host;
  if (c.auth?.username) env.AUTH_USERNAME = c.auth.username;
  if (c.auth?.password) env.AUTH_PASSWORD = c.auth.password;
  if (c.workspace_roots?.length) env.WORKSPACE_ROOTS = c.workspace_roots.join(path.delimiter);
  if (c.allowed_hosts?.length) env.ALLOWED_HOSTS = c.allowed_hosts.join(",");
  if (c.allowed_tailscale_users?.length) env.ALLOWED_TAILSCALE_USERS = c.allowed_tailscale_users.join(",");
  return env;
}

/** Environment variables that name a harness's executable; they win over config.yml, as every variable does. */
const BIN_ENV = { pi: "PI_BIN", omp: "OMP_BIN", hermes: "HERMES_BIN", claude: "CLAUDE_BIN", codex: "CODEX_BIN", opencode: "OPENCODE_BIN", grok: "GROK_BIN", dsh: "DSH_BIN" } as const;

/**
 * Each harness's launch settings: config.yml's `harnesses:` block, its
 * command overridden by PI_BIN, OMP_BIN, HERMES_BIN, CLAUDE_BIN, CODEX_BIN, OPENCODE_BIN, GROK_BIN, or DSH_BIN, and `~/`
 * expanded. A harness with neither is left out (its name on PATH, as before).
 */
export function launchSettings(c: UserConfig | undefined, env: NodeJS.ProcessEnv, home: string): Partial<Record<keyof typeof BIN_ENV, { command?: string; args: string[] }>> {
  const out: Partial<Record<keyof typeof BIN_ENV, { command?: string; args: string[] }>> = {};
  for (const id of Object.keys(BIN_ENV) as Array<keyof typeof BIN_ENV>) {
    const file = c?.harnesses?.[id];
    const raw = env[BIN_ENV[id]]?.trim() || file?.command;
    const args = file && "args" in file ? (file.args ?? []) : [];
    if (!raw && args.length === 0) continue;
    const command = raw ? (raw === "~" || raw.startsWith("~/") ? path.join(home, raw.slice(1)) : raw) : undefined;
    out[id] = { ...(command ? { command } : {}), args };
  }
  return out;
}

/** Whether to work with herdr: AWUI_HERDR (1 or 0) wins over config.yml's `herdr`, which is on unless false. */
export function herdrEnabled(c: UserConfig | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AWUI_HERDR === "0" || env.AWUI_HERDR === "1") return env.AWUI_HERDR === "1";
  return c?.herdr ?? true;
}

export function uiSettings(c: UserConfig | undefined, env: NodeJS.ProcessEnv = process.env): UiSettings {
  const theme = c?.theme === "custom" ? "base16" : (c?.theme ?? null);
  return {
    theme,
    autocollapseSidebar: c?.autocollapse_sidebar ?? true,
    showStatusBar: c?.show_status_bar ?? true,
    textScale: c?.text_scale ?? null,
    chatWidth: c?.chat_width ?? null,
    density: c?.density ?? null,
    toolStyle: c?.tool_style ?? null,
    font: c?.font ?? null,
    herdr: herdrEnabled(c, env),
  };
}
