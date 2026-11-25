// The user's settings: ~/.config/awui/config.yml (YAML, so it can carry
// comments), with the base16/base24 theme.yml beside it. Real environment
// variables win over the file; AWUI_CONFIG_DIR moves the folder ("" ignores
// it, as the tests do).
import { chmodSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { DEFAULT_BREAKDOWN_RULES, type BreakdownRules } from "../shared/breakdown.js";
import { chatWidthSchema, densitySchema, NORMALIZER_BACKENDS, themeChoiceSchema, themeIdSchema, toolStyleSchema, uiFontSchema, type ChatWidth, type Density, type ThemeChoice, type ToolStyle, type UiFont } from "../shared/protocol.js";
import { IS_WINDOWS, defaultConfigDir } from "./platform-win.js";

export const CONFIG_FILE = "config.yml";
export const THEME_FILE = "theme.yml";
/** The theme library's folder beside config.yml: one base16/base24 scheme per `<id>.yml`. */
export const THEMES_DIR = "themes";

/** What the browser needs from config.yml; re-read on every page load. */
export interface UiSettings {
  /** null: no preference, so a theme.yml is used when present. */
  theme: ThemeChoice | null;
  /** config.yml's `theme_scheme`: the theme library's id that `base16` uses; null is theme.yml. */
  themeScheme: string | null;
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
 * The mesh (docs/mesh.md): named peer machines this one can drive tasks on, with the
 * policies that bound what each may do here. Phase 0 is configuration only — nothing
 * listens — so this is file-only, checked like every other setting, and the mesh is
 * off unless the file says `enabled: true` (see meshEnabled).
 */
/** A machine or policy name: a slug of letters, digits, '.', '_' or '-'. */
const meshNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{1,64}$/, "must be a name of letters, digits, '.', '_' or '-', 1..64 characters");
const meshPolicyNameSchema = z
  .string()
  .regex(/^[a-z0-9_-]{1,32}$/, "must be a lowercase name of letters, digits, '_' or '-', 1..32 characters");
/** The capability vocabulary is fixed and closed; there is no exec cap. */
export const MESH_CAPS = ["discover", "task.run", "task.approve", "fs.read", "fs.write", "term.open"] as const;
export type MeshCap = (typeof MESH_CAPS)[number];

/**
 * One `host:port` a mesh peer can be dialed on over TLS (P2): a hostname, an
 * IPv4 address, or a bracketed IPv6 literal, and a port 1..65535 — never an
 * options shape, so a peer address cannot be read as anything but an address.
 * Config's schema and the transports share this one parser, so the wire and
 * the file agree on what a TLS peer is.
 */
export function parseMeshTlsAddress(value: string): { host: string; port: number } | null {
  const match = /^(\[[0-9A-Fa-f:.]{2,45}\]|[A-Za-z0-9][A-Za-z0-9.-]{0,252}):(\d{1,5})$/.exec(value.trim());
  if (match === null) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const host = match[1]!;
  if (host.startsWith("[")) return { host: host.slice(1, -1), port };
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && host.split(".").some((octet) => Number(octet) > 255)) return null;
  return { host, port };
}

const meshTlsAddressSchema = z
  .string()
  .trim()
  .min(3)
  .max(512)
  .refine((v) => parseMeshTlsAddress(v) !== null, "must be host:port — a hostname or IPv4, or [IPv6] with the port after it, the port 1..65535");

const meshPolicySchema = z
  .object({
    caps: z.array(z.enum(MESH_CAPS)).max(MESH_CAPS.length).optional(),
    ask: z.array(z.enum(MESH_CAPS)).max(MESH_CAPS.length).optional(),
    roots: z.array(z.string().trim().min(1).max(4096)).max(64).optional(),
    harnesses: z.array(z.string().trim().min(1).max(32)).max(16).optional(),
    permission_ceiling: z.enum(["read-only", "default", "auto-edit"]).optional(),
    max_tasks: z.number().int().min(1).max(32).optional(),
    max_file_bytes: z.number().int().min(1).max(1024 * 1024 * 1024).optional(),
    approvals_at: z.enum(["origin", "target", "both"]).optional(),
  })
  .strict();

export const meshPeerSchema = z
  .object({
    name: meshNameSchema,
    // Destinations go to ssh/docker as argv (never a shell), but one starting with '-'
    // would still be read as an option, so each is held to a plain host/container shape.
    ssh: z.string().trim().max(512).regex(/^[A-Za-z0-9_.@:%\[\]][A-Za-z0-9_.@:%\[\]-]*$/, "must be a plain [user@]host (no spaces, not starting with '-')").optional(),
    // A direct TLS address (P2): the same host:port the wire dials, no options.
    tls: meshTlsAddressSchema.optional(),
    docker: z.string().trim().max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "must be a container name or id").optional(),
    ssh_opts: z
      .array(z.string().min(1).max(256).refine((v) => !/[\n\r\u0000]/.test(v), "must not hold a newline or a NUL"))
      .max(16)
      .optional(),
    awui_path: z.string().trim().min(1).max(4096).optional(),
    engine: z.enum(["docker", "podman"]).optional(),
    inbound_policy: meshPolicyNameSchema.optional(),
  })
  .strict()
  .superRefine((peer, ctx) => {
    // `ssh`, `docker`, and `tls` are three ways to reach the same peer; exactly one may be set.
    const ways = [peer.ssh, peer.docker, peer.tls].filter((v) => v !== undefined).length;
    if (ways !== 1) {
      ctx.addIssue({ code: "custom", path: ["ssh"], message: "a peer takes exactly one of `ssh`, `docker`, or `tls`" });
    }
  });

/** At most this many peers: each is a machine awui may run tasks on. */
export const MAX_MESH_PEERS = 64;

const meshSchema = z
  .object({
    enabled: z.boolean().optional(),
    name: meshNameSchema.optional(),
    max_hops: z.literal(1).optional(),
    max_remote_tasks: z.number().int().min(1).max(64).optional(),
    chats: z.enum(["lead-only", "all"]).optional(),
    // How long a daemon-mode task with no attached link stays once settled (hours).
    detached_ttl_hours: z.number().int().min(1).max(720).optional(),
    // The direct TLS listener (P2): off unless an address is named. "0.0.0.0"
    // and "::" are accepted (a person may mean them) and doctor warns on them.
    listen: z
      .object({
        host: z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9._:\[\]-]+$/, "must be a hostname or IP address, no spaces").refine((v) => !v.startsWith("-"), "must not start with '-'"),
        port: z.number().int().min(1).max(65535).optional(),
      })
      .strict()
      .optional(),
    policies: z.record(meshPolicyNameSchema, meshPolicySchema).optional(),
    peers: z
      .array(meshPeerSchema)
      .max(MAX_MESH_PEERS)
      .superRefine((peers, ctx) => {
        const seen = new Set<string>();
        for (const [index, peer] of peers.entries()) {
          const key = peer.name.toLowerCase();
          if (seen.has(key)) ctx.addIssue({ code: "custom", path: [index, "name"], message: `"${peer.name}" is already defined` });
          seen.add(key);
        }
      })
      .optional(),
  })
  .strict()
  .superRefine((mesh, ctx) => {
    // `none` is the built-in do-nothing policy; every other name starts from it.
    if (mesh.policies && "none" in mesh.policies) {
      ctx.addIssue({ code: "custom", path: ["policies", "none"], message: "`none` is the built-in do-nothing policy and cannot be overridden" });
    }
    for (const [index, peer] of (mesh.peers ?? []).entries()) {
      const named = peer.inbound_policy ?? "none";
      if (named !== "none" && named !== "worker" && named !== "peer" && !(mesh.policies && named in mesh.policies)) {
        ctx.addIssue({ code: "custom", path: ["peers", index, "inbound_policy"], message: `"${named}" is not a built-in policy (none, worker, peer) and names no policy under mesh.policies` });
      }
    }
  });

export type MeshConfig = z.infer<typeof meshSchema>;


/**
 * The tool-card normalizer's block (see schema.normalizer). Every number here is re-read at each
 * decision, so a change needs no restart; the keys are what a save writes, and the Settings dialog
 * is the surface that fills them in (it never reads one back).
 */
const normalizerSchema = z
  .object({
    enabled: z.boolean().optional(),
    backend: z.enum(NORMALIZER_BACKENDS).optional(),
    /** The local backend's URL, e.g. http://127.0.0.1:8000/v1/systemone. */
    endpoint: z.string().trim().max(2048).optional(),
    /** The Jev backend's URL and model: any System One-compatible proxy, and the model it serves. */
    jev_base_url: z.string().trim().max(2048).optional(),
    jev_model: z.string().trim().max(128).optional(),
    jev_api_key: z.string().max(512).optional(),
    /** Command Code's Provider API: its key (CMD_API_KEY wins over this). */
    command_code_api_key: z.string().max(512).optional(),
    cloudflare_account_id: z.string().trim().max(128).optional(),
    cloudflare_api_token: z.string().max(512).optional(),
    min_choice_probability: z.number().min(0.05).max(1).optional(),
    min_noul: z.number().min(0.05).max(1).optional(),
    cache: z.boolean().optional(),
    /** 100–5000 ms; unset is each backend's own default. */
    timeout_ms: z.number().int().min(100).max(5000).optional(),
    /** Reserved for a schema-constrained extractor; it gates nothing today. */
    allow_free_text: z.boolean().optional(),
  })
  .strict();

export type NormalizerFileConfig = z.infer<typeof normalizerSchema>;

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

/**
 * `false`, or the key with nothing after it, asks for the CLI's own label instead of awui's: the variable is
 * removed and the chat is `sdk-cli`, which drains the 5-hour window 1.7–3× faster for the same tokens
 * (anthropics/claude-code#97074). It exists because a label is a claim about who is calling, and that is the
 * user's call to make.
 */
const claudeEntrypointValueSchema = z.union([z.literal(false), claudeEntrypointSchema], { error: "must be a plain name of awui's own, or false to leave Claude Code's own label (sdk-cli) alone" });

const schema = z
  .object({
    port: z.number().int().optional(),
    host: z.string().optional(),
    auth: z.object({ username: z.string().optional(), password: z.string().optional() }).strict().optional(),
    workspace_roots: z.array(z.string()).optional(),
    allowed_hosts: z.array(z.string()).optional(),
    allowed_tailscale_users: z.array(z.string()).optional(),
    theme: themeChoiceSchema.optional(),
    /** Which theme library file (~/.config/awui/themes/<id>.yml) `theme: base16` uses; theme.yml when unset. */
    theme_scheme: themeIdSchema.optional(),
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
     * Sessions nobody has touched for this many days are settled by an hourly sweep (so a
     * year of routine nights does not fill the sidebar). Unset or 0 turns the sweep off; a
     * pinned, archived, snoozed, or already settled session is never touched.
     */
    settle_after_days: z.number().int().min(1).max(3650).optional(),
    /**
     * Finished chats nobody has looked at for this many minutes have their harness child parked
     * (disposed) by the reaper; opening the chat again resumes the same native session from its
     * transcript. Only adapters that can read the transcript back park (a real resume), and a
     * chat waiting on an answer, holding a chain, or carrying background work is never parked.
     * Unset or 0 turns hibernation off. Read at startup.
     */
    hibernate_after_minutes: z.number().int().min(1).max(60 * 24 * 30).optional(),
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
     * `entrypoint` name for `CLAUDE_CODE_ENTRYPOINT` (see ClaudeSettings.entrypoint), `awui` unless the
     * file opts out with `false`.
     */
    claude: z.object({ subagent_prompt_cache_ttl: z.enum(["5m", "1h"]).optional(), entrypoint: claudeEntrypointValueSchema.nullable().optional() }).strict().optional(),
    /** Herdr's API socket, when not the default session's (file-only; HERDR_SOCKET_PATH wins). */
    herdr_socket: z.string().trim().min(1).max(4096).optional(),
    /**
     * Shared agent profiles: named provider/model/thinking/mode bundles kept in
     * config.yml, so every room and delegation can use the same seat. Credentials
     * never appear here (the provider login stays in the harness's own auth);
     * the Settings dialog's Agents section manages the list.
     */
    agent_profiles: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(64),
            harness: z.string().trim().min(1).max(64),
            model: z.string().trim().min(1).max(512).nullable().optional(),
            thinking: z.string().trim().min(1).max(64).nullable().optional(),
            permission_mode: z.string().trim().min(1).max(64).nullable().optional(),
            note: z.string().trim().min(1).max(200).nullable().optional(),
          })
          .strict(),
      )
      .max(64)
      .superRefine((list, ctx) => {
        const seen = new Set<string>();
        for (const [index, entry] of list.entries()) {
          const key = entry.name.toLowerCase();
          if (seen.has(key)) ctx.addIssue({ code: "custom", path: [index, "name"], message: `"${entry.name}" is already defined` });
          seen.add(key);
        }
      })
      .optional(),
    /**
     * Which changed paths a worktree or race card counts as tests and as generated
     * output (shared/breakdown.ts holds the defaults). File-only; globs, `**` crossing
     * folders; anything that matches neither list is the project's own code.
     */
    breakdown: z
      .object({
        tests: z.array(z.string().trim().min(1).max(200)).max(64).optional(),
        generated: z.array(z.string().trim().min(1).max(200)).max(64).optional(),
      })
      .strict()
      .optional(),
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
    mesh: meshSchema.optional(),
    /**
     * The optional tool-card normalizer (server/normalizer/): a small decision model that reads the
     * output of a settled call the built-in parsers could not place, and may redraw its row. Off
     * unless `enabled: true`; the default backend is a local one that needs `endpoint` set, so
     * turning it on never sends anything off this machine by itself. The Settings dialog manages
     * this block; the three keys are write-only there (a blank save keeps the stored one).
     */
    normalizer: normalizerSchema.optional(),
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
  // A sign-in password is not the only secret this file may hold: the normalizer keeps a provider
  // key here too, so a file that carries one is made 0600 the same way.
  const holdsSecret = Boolean(config.auth?.password) || Boolean(config.normalizer && (config.normalizer.jev_api_key || config.normalizer.command_code_api_key || config.normalizer.cloudflare_api_token));
  if (holdsSecret && (statSync(file).mode & 0o077) !== 0) {
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
    themeScheme: c?.theme_scheme ?? null,
    autocollapseSidebar: c?.autocollapse_sidebar ?? true,
    showStatusBar: c?.show_status_bar ?? false,
    textScale: c?.text_scale ?? null,
    chatWidth: c?.chat_width ?? null,
    density: c?.density ?? null,
    toolStyle: c?.tool_style ?? null,
    font: c?.font ?? null,
    herdr: herdrEnabled(c, env),
  };
}

/**
 * The globs a card sorts changed files by: config.yml's `breakdown:` block over the
 * defaults, so a project that names its tests differently can say so. Read on every
 * page load (bootstrap), so a change needs no restart.
 */
export function breakdownRules(c: UserConfig | undefined): BreakdownRules {
  const block = c?.breakdown;
  return {
    tests: block?.tests ?? DEFAULT_BREAKDOWN_RULES.tests,
    generated: block?.generated ?? DEFAULT_BREAKDOWN_RULES.generated,
  };
}

/** config.yml's `mesh:` block as parsed, or undefined when the file has none. */
export function meshConfig(c: UserConfig | undefined): MeshConfig | undefined {
  return c?.mesh;
}

/**
 * How long a daemon-mode task with no attached link stays once it is settled
 * (config `mesh.detached_ttl_hours`, hours; a task still running keeps running).
 */
export function meshDetachedTtlHours(c: UserConfig | undefined): number {
  return c?.mesh?.detached_ttl_hours ?? 24;
}

/**
 * config.yml's `mesh.listen` with the default port applied, or null when this
 * node opens no TLS listener. Pure, so doctor reports and the daemon's switch
 * read the same one address.
 */
export function meshListen(c: UserConfig | undefined): { host: string; port: number } | null {
  const listen = c?.mesh?.listen;
  return listen === undefined ? null : { host: listen.host, port: listen.port ?? 4784 };
}

/**
 * Whether the mesh is on. AWUI_MESH=0 forces it off; no variable forces it on, so
 * `enabled: true` in config.yml is the only switch that does.
 */
export function meshEnabled(c: UserConfig | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AWUI_MESH === "0") return false;
  return c?.mesh?.enabled === true;
}
