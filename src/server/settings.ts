// The Settings dialog's server side: config.yml read and rewritten in place
// (yaml's Document keeps comments and key order), every change checked the way
// startup checks it, so a save can never leave a server that will not start.
// The password is write-only: the browser learns whether one is set, never it.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import type { RestartSetting, ServerSettings, ServerSettingsValues, SettingsPatch } from "../shared/protocol.js";
import { ChatError } from "./chats/chat.js";
import { ConfigError, DEFAULT_PORT, expandHome, loadConfig, normalizeAuthority, USERNAME_PATTERN } from "./config.js";
import { checkUserConfig, CONFIG_FILE, configEnv, UserConfigError, type UserConfig } from "./user-config.js";

/** The settings the running server started with, as config.yml would state them. */
export interface RunningSettings {
  port: number;
  host: "127.0.0.1" | "0.0.0.0";
  username: string;
  /** config.yml's password at startup (to tell whether it changed since); never sent anywhere. */
  password: string | null;
  workspaceRoots: string[];
  allowedHosts: string[];
  allowedTailscaleUsers: string[];
}

export interface SettingsContext {
  configDir: string | null;
  running: RunningSettings;
  /** Environment variables set when the server started: they beat config.yml. */
  envSet: ReadonlySet<string>;
  /** Where `npm run set-password` keeps a login. */
  credentialsFile: string;
  /** A supervisor brings the server back when it exits (systemd sets INVOCATION_ID). */
  canRestart: boolean;
  home: string;
}

const ENV_OF: Partial<Record<keyof ServerSettingsValues, string>> = {
  port: "PORT",
  host: "HOST",
  username: "AUTH_USERNAME",
  hasPassword: "AUTH_PASSWORD",
  workspaceRoots: "WORKSPACE_ROOTS",
  allowedHosts: "ALLOWED_HOSTS",
  allowedTailscaleUsers: "ALLOWED_TAILSCALE_USERS",
  herdr: "AWUI_HERDR",
};

function fileOf(ctx: SettingsContext): string | null {
  return ctx.configDir ? path.join(ctx.configDir, CONFIG_FILE) : null;
}

function readFile(file: string | null): string {
  if (!file) return "";
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function parseConfig(text: string, file: string): UserConfig {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new UserConfigError(`${file} is not valid YAML: ${doc.errors[0]?.message.split("\n")[0]}`);
  return checkUserConfig(doc.toJS({ maxAliasCount: 10 }), file);
}

function credentialsUser(file: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { username?: unknown };
    return typeof raw.username === "string" ? raw.username : null;
  } catch {
    return null;
  }
}

function valuesOf(c: UserConfig, ctx: SettingsContext): ServerSettingsValues {
  const stored = credentialsUser(ctx.credentialsFile);
  return {
    port: c.port ?? DEFAULT_PORT,
    host: c.host === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1",
    username: c.auth?.username ?? stored ?? "",
    hasPassword: Boolean(c.auth?.password) || stored !== null,
    workspaceRoots: c.workspace_roots ?? [],
    allowedHosts: c.allowed_hosts ?? [],
    allowedTailscaleUsers: c.allowed_tailscale_users ?? [],
    theme: c.theme === "custom" ? "base16" : (c.theme ?? null),
    textScale: c.text_scale ?? null,
    chatWidth: c.chat_width ?? null,
    density: c.density ?? null,
    toolStyle: c.tool_style ?? null,
    font: c.font ?? null,
    autocollapseSidebar: c.autocollapse_sidebar ?? true,
    showStatusBar: c.show_status_bar ?? true,
    herdr: c.herdr ?? true,
    desktopBackground: c.desktop_background ?? true,
    orchestrationEnabled: c.orchestration?.enabled ?? true,
  };
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Saved settings the running server does not use yet. */
function pending(c: UserConfig, ctx: SettingsContext): RestartSetting[] {
  const r = ctx.running;
  const v = valuesOf(c, ctx);
  const roots = (c.workspace_roots ?? []).map((p) => path.resolve(expandHome(p, ctx.home)));
  const out: RestartSetting[] = [];
  if (!ctx.envSet.has("PORT") && v.port !== r.port) out.push("port");
  if (!ctx.envSet.has("HOST") && v.host !== r.host) out.push("host");
  if (!ctx.envSet.has("AUTH_USERNAME") && (c.auth?.username ?? "") !== r.username && Boolean(c.auth?.username || r.username)) out.push("username");
  if (!ctx.envSet.has("AUTH_PASSWORD") && (c.auth?.password ?? null) !== r.password) out.push("password");
  if (!ctx.envSet.has("WORKSPACE_ROOTS") && !sameList(roots.length > 0 ? roots : [ctx.home], r.workspaceRoots)) out.push("workspaceRoots");
  if (!ctx.envSet.has("ALLOWED_HOSTS") && !sameList(v.allowedHosts.map((h) => normalizeAuthority(h)), r.allowedHosts)) out.push("allowedHosts");
  if (!ctx.envSet.has("ALLOWED_TAILSCALE_USERS") && !sameList(v.allowedTailscaleUsers.map((u) => u.toLowerCase()), r.allowedTailscaleUsers)) {
    out.push("allowedTailscaleUsers");
  }
  return out;
}

export function readSettings(ctx: SettingsContext, editable: boolean): ServerSettings {
  const file = fileOf(ctx);
  const config = file ? parseConfig(readFile(file), file) : {};
  return {
    editable,
    writable: file !== null,
    values: valuesOf(config, ctx),
    restartPending: pending(config, ctx),
    envOverrides: (Object.keys(ENV_OF) as Array<keyof ServerSettingsValues>).filter((k) => ctx.envSet.has(ENV_OF[k] as string)),
    canRestart: ctx.canRestart,
  };
}

const invalid = (message: string) => new ChatError(422, "invalid_settings", message);

/** Who is saving. A device other than this machine must still get in once the change takes effect. */
export interface Requester {
  local: boolean;
  kind: "loopback" | "lan" | "remote";
  /** The Host it came in on (a LAN address, or an allowed Serve name). */
  authority: string;
  /** Its Tailscale login, when it came through Tailscale Serve. */
  tailscaleUser: string | null;
}

const THIS_MACHINE: Requester = { local: true, kind: "loopback", authority: "127.0.0.1", tailscaleUser: null };

/** Why `effective` would shut out the device saving it, or null. */
function lockout(effective: ReturnType<typeof loadConfig>, who: Requester): string | null {
  if (who.local) return null;
  if (who.kind === "lan" && effective.host !== "0.0.0.0") return "the server would listen on its own machine only, and this device reaches it over the network";
  if (who.kind === "remote") {
    const hostname = who.authority.replace(/:\d+$/, "");
    const allowed = effective.allowedHosts.some((entry) => (entry.includes(":") ? entry === who.authority : entry === hostname));
    if (!allowed) return `${hostname} would no longer be an allowed host, and this device comes in through it`;
    if (effective.allowedTailscaleUsers.length > 0 && !(who.tailscaleUser && effective.allowedTailscaleUsers.includes(who.tailscaleUser))) {
      return "your Tailscale login would no longer be an allowed user";
    }
  }
  return null;
}

/**
 * Apply a change to config.yml. The result is checked before anything is
 * written: the schema, then loadConfig as startup runs it (host, username
 * rules, host names), then the start-up refusals (other devices with no login
 * to sign in with, no usable workspace root).
 */
export function writeSettings(ctx: SettingsContext, patch: SettingsPatch, who: Requester = THIS_MACHINE): ServerSettings {
  const file = fileOf(ctx);
  if (!file) throw new ChatError(409, "no_settings_folder", "This server runs without a settings folder (AWUI_CONFIG_DIR is empty)");
  const doc = parseDocument(readFile(file));
  if (doc.errors.length > 0) throw invalid(`${CONFIG_FILE} is not valid YAML; fix it by hand first`);
  const set = (keys: string[], value: unknown) => {
    const empty = value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
    if (empty) doc.deleteIn(keys);
    else doc.setIn(keys, value);
  };
  if (patch.port !== undefined) set(["port"], patch.port);
  if (patch.host !== undefined) set(["host"], patch.host);
  if (patch.username !== undefined) set(["auth", "username"], patch.username);
  if (patch.password !== undefined) set(["auth", "password"], patch.password);
  if (patch.workspaceRoots !== undefined) set(["workspace_roots"], patch.workspaceRoots);
  if (patch.allowedHosts !== undefined) set(["allowed_hosts"], patch.allowedHosts);
  if (patch.allowedTailscaleUsers !== undefined) set(["allowed_tailscale_users"], patch.allowedTailscaleUsers);
  if (patch.theme !== undefined) set(["theme"], patch.theme);
  if (patch.textScale !== undefined) set(["text_scale"], patch.textScale);
  if (patch.chatWidth !== undefined) set(["chat_width"], patch.chatWidth);
  if (patch.density !== undefined) set(["density"], patch.density);
  if (patch.toolStyle !== undefined) set(["tool_style"], patch.toolStyle);
  if (patch.font !== undefined) set(["font"], patch.font);
  if (patch.autocollapseSidebar !== undefined) set(["autocollapse_sidebar"], patch.autocollapseSidebar);
  if (patch.showStatusBar !== undefined) set(["show_status_bar"], patch.showStatusBar);
  if (patch.herdr !== undefined) set(["herdr"], patch.herdr);
  if (patch.desktopBackground !== undefined) set(["desktop_background"], patch.desktopBackground);
  const auth = doc.getIn(["auth"]) as { items?: unknown[] } | undefined;
  if (auth && Array.isArray(auth.items) && auth.items.length === 0) doc.deleteIn(["auth"]);
  // On is the default: the switch saves as no key at all, and the block goes when nothing else is in it.
  if (patch.orchestrationEnabled !== undefined) {
    if (patch.orchestrationEnabled) doc.deleteIn(["orchestration", "enabled"]);
    else doc.setIn(["orchestration", "enabled"], false);
  }
  const orch = doc.getIn(["orchestration"]) as { items?: unknown[] } | undefined;
  if (orch && Array.isArray(orch.items) && orch.items.length === 0) doc.deleteIn(["orchestration"]);

  let next: UserConfig;
  try {
    next = checkUserConfig(doc.toJS({ maxAliasCount: 10 }), CONFIG_FILE);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error));
  }
  if (next.auth?.username && !USERNAME_PATTERN.test(next.auth.username)) throw invalid("The username takes 1-64 letters, digits, or . _ @ -");
  // As startup sees it: the file's values under whatever the environment overrides.
  const env: NodeJS.ProcessEnv = { ...configEnv(next) };
  for (const name of ctx.envSet) if (process.env[name] !== undefined) env[name] = process.env[name];
  env.HOME = ctx.home;
  let effective: ReturnType<typeof loadConfig>;
  try {
    effective = loadConfig(env);
  } catch (error) {
    throw invalid(error instanceof ConfigError ? error.message : String(error));
  }
  const remote = effective.host === "0.0.0.0" || effective.allowedHosts.length > 0;
  if (remote && !effective.login && !existsSync(ctx.credentialsFile) && !ctx.envSet.has("AUTH_PASSWORD")) {
    throw invalid("Other devices need a username and password to sign in with before the server can listen beyond this machine");
  }
  if (!effective.workspaceRoots.some((root) => existsSync(root) && statSync(root).isDirectory())) {
    throw invalid("None of the workspace roots is an existing folder");
  }
  const shut = lockout(effective, who);
  if (shut) throw invalid(`Not saved: ${shut}, which would lock this device out. Make that change on the machine running the server.`);

  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  // 0600 always: the file may hold the sign-in password.
  writeFileSync(tmp, doc.toString(), { mode: 0o600 });
  renameSync(tmp, file);
  return readSettings(ctx, true);
}
