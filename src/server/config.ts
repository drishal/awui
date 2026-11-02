import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { configDir, launchSettings, THEME_FILE, type UserConfig } from "./user-config.js";
import { IS_WINDOWS, defaultStateDir } from "./platform-win.js";

export const DEFAULT_PORT = 4783;

export interface ServerConfig {
  port: number;
  /** Bind address: 127.0.0.1 (this machine, no sign-in) or 0.0.0.0 (LAN; other devices sign in). */
  host: "127.0.0.1" | "0.0.0.0";
  /** Password-mode credentials (scrypt hash written by `npm run set-password`). */
  credentialsFile: string;
  /** Login from AUTH_USERNAME/AUTH_PASSWORD; takes precedence over credentialsFile. */
  login: { username: string; password: string } | null;
  workspaceRoots: string[];
  allowedHosts: string[];
  allowedTailscaleUsers: string[];
  /** ~/.config/awui (config.yml, theme.yml), or null when ignored. */
  configDir: string | null;
  themeFile: string | null;
  themeFileExplicit: boolean;
  stateDir: string;
  ompAgentDir: string | null;
  ompSessionDir: string | null;
  /** Comma list selecting adapters; tests use `fake`. Default: pi,omp,hermes,claude,opencode,grok,awui. */
  harnesses: string[];
  /** Each harness's executable and extra chat arguments (launchSettings); empty: names on PATH. */
  launch: ReturnType<typeof launchSettings>;
  home: string;
}

export class ConfigError extends Error {}

/** Same rules as `npm run set-password`. */
export const USERNAME_PATTERN = /^[A-Za-z0-9._@-]{1,64}$/;

export function expandHome(p: string, home = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

const portSchema = z.coerce
  .number()
  .int("PORT must be an integer")
  .min(1024, "PORT must be between 1024 and 65535")
  .max(65535, "PORT must be between 1024 and 65535");

const list = (value: string | undefined, sep: string | RegExp = ","): string[] =>
  (value ?? "")
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);

export interface Authority {
  hostname: string;
  port: string;
  authority: string;
}

/** The one host/authority parser: trim, reject anything but `host[:port]` (no `\
 * whitespace, `/`, `@`, `?`, `#`, or `\`), and lowercase. Used for both Host
 * headers and ALLOWED_HOSTS, so neither can accept what the other refuses. */
export function parseAuthority(value: string | undefined): Authority | null {
  const trimmed = value?.trim();
  if (!trimmed || /[\s/@?#\\]/.test(trimmed)) return null;
  try {
    const url = new URL(`http://${trimmed.toLowerCase()}`);
    return { hostname: url.hostname, port: url.port, authority: url.port ? `${url.hostname}:${url.port}` : url.hostname };
  } catch {
    return null;
  }
}

/** Normalize an ALLOWED_HOSTS entry to a lowercase `host` or `host:port` authority. */
export function normalizeAuthority(entry: string): string {
  const auth = parseAuthority(entry);
  if (!auth) throw new ConfigError(`Invalid ALLOWED_HOSTS entry: ${entry}`);
  return auth.authority;
}

/** The state folder's name under $XDG_STATE_HOME; it was agent-web-ui before the rename to awui. */
export const STATE_DIR_NAME = "awui";
const OLD_STATE_DIR_NAME = "agent-web-ui";

/**
 * Move the state folder from its old name (agent-web-ui) the first time this
 * version starts, so the sign-in, cookie secret, checkpoints, pins, and push
 * keys carry over. Nothing happens once the new folder exists.
 */
export function migrateStateDir(stateDir: string): "moved" | null {
  if (path.basename(stateDir) !== STATE_DIR_NAME || existsSync(stateDir)) return null;
  const old = path.join(path.dirname(stateDir), OLD_STATE_DIR_NAME);
  if (!existsSync(old)) return null;
  try {
    renameSync(old, stateDir);
    return "moved";
  } catch {
    return null;
  }
}

/** `file`: config.yml's settings that are not environment variables (the harnesses' launch). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, file?: UserConfig): ServerConfig {
  const home = homedir();
  let port = DEFAULT_PORT;
  if (env.PORT !== undefined && env.PORT !== "") {
    const parsed = portSchema.safeParse(env.PORT);
    if (!parsed.success) throw new ConfigError(parsed.error.issues[0]?.message ?? "Invalid PORT");
    port = parsed.data;
  }
  const roots = list(env.WORKSPACE_ROOTS, path.delimiter).map((r) => path.resolve(expandHome(r, home)));
  const xdgConfig = env.XDG_CONFIG_HOME || path.join(home, ".config");
  const themeFile = env.THEME_FILE ? path.resolve(expandHome(env.THEME_FILE, home)) : null;
  const host = env.HOST === undefined || env.HOST === "" ? "127.0.0.1" : env.HOST;
  if (host !== "127.0.0.1" && host !== "0.0.0.0") {
    throw new ConfigError("host (HOST) must be 127.0.0.1 (default) or 0.0.0.0 (LAN, username/password sign-in)");
  }
  // AWUI_STATE_DIR (what --state-dir sets) wins; else the platform's state dir.
  const stateDir = env.AWUI_STATE_DIR ? path.resolve(expandHome(env.AWUI_STATE_DIR, home)) : defaultStateDir(env, home);
  let login: ServerConfig["login"] = null;
  if (env.AUTH_PASSWORD) {
    const username = (env.AUTH_USERNAME ?? "").trim();
    if (!USERNAME_PATTERN.test(username)) {
      throw new ConfigError("auth.password (AUTH_PASSWORD) needs auth.username (AUTH_USERNAME): 1-64 letters, digits, or . _ @ -");
    }
    login = { username, password: env.AUTH_PASSWORD };
  }
  return {
    port,
    host,
    credentialsFile: env.AUTH_CREDENTIALS_FILE ? path.resolve(expandHome(env.AUTH_CREDENTIALS_FILE, home)) : path.join(stateDir, "credentials.json"),
    login,
    workspaceRoots: roots.length > 0 ? roots : [home],
    allowedHosts: list(env.ALLOWED_HOSTS).map(normalizeAuthority),
    allowedTailscaleUsers: list(env.ALLOWED_TAILSCALE_USERS).map((u) => u.toLowerCase()),
    configDir: configDir(env),
    themeFile: themeFile ?? path.join(configDir(env) ?? path.join(xdgConfig, "awui"), THEME_FILE),
    themeFileExplicit: themeFile !== null,
    stateDir,
    ompAgentDir: env.OMP_AGENT_DIR ? path.resolve(expandHome(env.OMP_AGENT_DIR, home)) : null,
    ompSessionDir: env.OMP_SESSION_DIR ? path.resolve(expandHome(env.OMP_SESSION_DIR, home)) : null,
    harnesses: list(env.AWUI_HARNESSES).length > 0 ? list(env.AWUI_HARNESSES) : ["pi", "omp", "hermes", "claude", "opencode", "grok", "awui"],
    launch: launchSettings(file, env, home),
    home,
  };
}
