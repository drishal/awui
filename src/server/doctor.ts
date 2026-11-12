// `awui doctor`: checks the setup and prints a plain report, for when a harness
// does not start or the server will not come up. `evaluate` is pure (inputs in,
// checks out) so it is unit-tested; `gather` reads the machine and `runDoctor`
// prints. It starts no chat, calls no model, and never prints a secret: the
// password and credentials appear only as "configured" or not.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { loadConfig, type ServerConfig } from "./config.js";
import { isEmbedded } from "./embedded.js";
import { herdrSocketPath } from "./herdr.js";
import { HarnessRegistry } from "./harness/registry.js";
import { configDir, configEnv, herdrEnabled, readUserConfig, type UserConfig } from "./user-config.js";
import { IS_WINDOWS } from "./platform-win.js";
import { orchestrateExtension } from "./harness/render-extension.js";
import { Workspaces } from "./workspaces.js";
import type { HarnessStatus } from "../shared/protocol.js";

export interface Check {
  name: string;
  ok: boolean | "warn";
  detail: string;
}

/** What the port probe found: nothing, awui (its version), or something else. */
export type PortProbe = { kind: "free" } | { kind: "awui"; version: string | null } | { kind: "other"; detail: string };

export interface DoctorInput {
  /** The config problem (validation error text), or null when config.yml is absent or fine. */
  configError: string | null;
  /** The config file's path when one was read. */
  configFile: string | null;
  nodeVersion: string;
  bunVersion: string | null;
  harnesses: Pick<HarnessStatus, "id" | "displayName" | "available" | "version" | "reason" | "warnings">[];
  harnessError: string | null;
  host: string;
  port: number;
  workspaceWarnings: string[];
  workspaceRoots: number;
  /** The state folder: its path, whether it exists (or could be made), and its permission bits. */
  stateDir: { path: string; error: string | null; mode: number | null };
  portProbe: PortProbe;
  remote: { exposed: boolean; credentials: boolean };
  herdr: { enabled: boolean; socket: string; exists: boolean };
  /** The delegation surface: its switch and caps, and the bridge files a chat's child would be given. */
  orchestration: { enabled: boolean; maxChildrenPerChat: number; maxDepth: number; maxLiveTasks: number; missingBridges: string[] };
  /** Native Windows host: mode bits are not enforceable, so the state-folder mode is not a failure. */
  windows: boolean;
  /** This process is the compiled binary: the terminal clients are built in, so Bun is not needed for them. */
  embedded: boolean;
}

const MIN_NODE = [22, 19, 0];
const MIN_BUN = [1, 3, 14];

function atLeast(version: string, min: number[]): boolean {
  const parts = version.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const a = parts[i] ?? 0;
    if (a !== min[i]) return a > (min[i] ?? 0);
  }
  return true;
}

/** The checks for these inputs, in report order. */
export function evaluate(i: DoctorInput): Check[] {
  const out: Check[] = [];
  out.push(
    i.configError
      ? { name: "Config", ok: false, detail: i.configError }
      : { name: "Config", ok: true, detail: i.configFile ? `${i.configFile} is valid` : "no config.yml (defaults and environment)" },
  );
  out.push(
    atLeast(i.nodeVersion, MIN_NODE)
      ? { name: "Node", ok: true, detail: i.nodeVersion }
      : { name: "Node", ok: false, detail: `${i.nodeVersion} is older than 22.19` },
  );
  // A source run needs Bun for atui and `awui tern`; the binary carries both clients built in.
  out.push(
    i.embedded
      ? { name: "Bun", ok: true, detail: i.bunVersion ?? "not needed (the binary carries the terminal clients)" }
      : i.bunVersion === null
        ? { name: "Bun", ok: "warn", detail: "not found (needed for atui and awui tern)" }
        : atLeast(i.bunVersion, MIN_BUN)
          ? { name: "Bun", ok: true, detail: i.bunVersion }
          : { name: "Bun", ok: "warn", detail: `${i.bunVersion} is older than 1.3.14 (atui and awui tern need it)` },
  );
  if (i.harnessError) out.push({ name: "Harnesses", ok: false, detail: i.harnessError });
  for (const h of i.harnesses) {
    if (h.available) {
      out.push({ name: `Harness ${h.id}`, ok: h.warnings.length > 0 ? "warn" : true, detail: [h.version ?? "available", ...h.warnings].join("; ") });
    } else {
      // A harness that is not installed is only a note while another one works; with none, nothing can run.
      out.push({ name: `Harness ${h.id}`, ok: i.harnesses.some((o) => o.available) ? "warn" : false, detail: h.reason ?? "unavailable" });
    }
  }
  if (i.workspaceWarnings.length > 0) out.push({ name: "Workspace roots", ok: "warn", detail: i.workspaceWarnings.join("; ") });
  else out.push({ name: "Workspace roots", ok: true, detail: `${i.workspaceRoots} usable` });
  const s = i.stateDir;
  if (s.error || s.mode === null) out.push({ name: "State folder", ok: false, detail: `${s.path}: ${s.error ?? "cannot be read"}` });
  // Windows NTFS does not enforce POSIX mode bits: readable-by-others is judged by ACL, which a mode number cannot see.
  else if (!i.windows && (s.mode & 0o077) !== 0) out.push({ name: "State folder", ok: false, detail: `${s.path} has mode ${s.mode.toString(8)}; group/other can read it (chmod 700)` });
  else out.push({ name: "State folder", ok: true, detail: i.windows ? s.path : `${s.path} (mode ${s.mode.toString(8)})` });
  const where = `${i.host}:${i.port}`;
  const p = i.portProbe;
  out.push(
    p.kind === "free"
      ? { name: "Port", ok: true, detail: `${where} is free` }
      : p.kind === "awui"
        ? { name: "Port", ok: true, detail: `awui is running on ${where}${p.version ? ` (build ${p.version})` : ""}` }
        : { name: "Port", ok: false, detail: `${where} is held by something else (${p.detail})` },
  );
  if (i.remote.exposed) {
    out.push(
      i.remote.credentials
        ? { name: "Remote access", ok: true, detail: "reachable beyond this machine; a password is configured" }
        : { name: "Remote access", ok: "warn", detail: "reachable beyond this machine but no password is configured (npm run set-password)" },
    );
  }
  if (i.herdr.enabled) {
    out.push(
      i.herdr.exists
        ? { name: "herdr", ok: true, detail: `socket found at ${i.herdr.socket}` }
        : { name: "herdr", ok: "warn", detail: `enabled but no socket at ${i.herdr.socket}` },
    );
  }
  // The delegation surface: a chat's child reaches it through the extension awui loads into the
  // harness (pi/omp), or over the HTTP MCP endpoint awui serves itself (Claude Code, Codex, DSH), so
  // a missing extension is a warning even though the server itself is fine.
  const o = i.orchestration;
  if (!o.enabled) out.push({ name: "Orchestration", ok: true, detail: "off (orchestration.enabled is false in config.yml)" });
  else if (o.missingBridges.length > 0) out.push({ name: "Orchestration", ok: "warn", detail: `on, but ${o.missingBridges.join(" and ")} cannot be found, so the chats that load it get no tools` });
  else out.push({ name: "Orchestration", ok: true, detail: `on (max ${o.maxChildrenPerChat} children per chat, depth ${o.maxDepth}, ${o.maxLiveTasks} live tasks)` });
  return out;
}

/** One line per check, then a summary. */
export function render(checks: Check[]): string {
  const mark = (ok: Check["ok"]) => (ok === true ? "✓" : ok === "warn" ? "!" : "✗");
  const lines = checks.map((c) => `${mark(c.ok)} ${c.name}: ${c.detail}`);
  const bad = checks.filter((c) => c.ok === false).length;
  const warn = checks.filter((c) => c.ok === "warn").length;
  lines.push(bad > 0 ? `${bad} problem${bad === 1 ? "" : "s"}, ${warn} warning${warn === 1 ? "" : "s"}` : `No problems${warn > 0 ? `, ${warn} warning${warn === 1 ? "" : "s"}` : ""}`);
  return lines.join("\n");
}

async function probePort(host: string, port: number): Promise<PortProbe> {
  const target = host === "0.0.0.0" ? "127.0.0.1" : host;
  try {
    const res = await fetch(`http://${target}:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    // /api/health answers { ok, build }: build is the web bundle's id (a string, or null), not a release version.
    const body = (await res.json().catch(() => null)) as { ok?: unknown; build?: unknown } | null;
    if (body && body.ok === true && "build" in body) {
      return { kind: "awui", version: typeof body.build === "string" ? body.build : null };
    }
    return { kind: "other", detail: `HTTP ${res.status}, not awui` };
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    if (code === "ECONNREFUSED") return { kind: "free" };
    return { kind: "other", detail: code ?? (error instanceof Error ? error.message : String(error)) };
  }
}

/**
 * The file a chat's child needs for the orchestration tools: pi and omp load `orchestrate.ts` with
 * `-e`. Claude Code, Codex, and DSH need no file at all — they connect to awui's own HTTP MCP
 * endpoint — so a missing bridge here means only those two harnesses lose the tools.
 */
function missingOrchestrationBridges(): string[] {
  return orchestrateExtension() === null ? ["extensions/orchestrate.ts"] : [];
}

function bunVersion(): string | null {
  const r = spawnSync("bun", ["--version"], { encoding: "utf8", timeout: 3000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Read the machine into the inputs. */
export async function gather(env: NodeJS.ProcessEnv = process.env): Promise<DoctorInput> {
  let configError: string | null = null;
  let settings: ReturnType<typeof readUserConfig> = null;
  try {
    settings = readUserConfig(configDir(env));
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }
  let config: ServerConfig;
  try {
    config = loadConfig({ ...(settings ? configEnv(settings.config) : {}), ...env }, settings?.config);
  } catch (error) {
    configError ??= error instanceof Error ? error.message : String(error);
    config = loadConfig({}); // Defaults, so the other checks still run.
  }
  const userConfig: UserConfig | undefined = settings?.config;
  let harnesses: DoctorInput["harnesses"] = [];
  let harnessError: string | null = null;
  try {
    harnesses = await HarnessRegistry.fromConfig(config).refreshStatus();
  } catch (error) {
    harnessError = error instanceof Error ? error.message : String(error);
  }
  const { workspaces, warnings } = await Workspaces.create(config.workspaceRoots, config.home);
  const stateDir: DoctorInput["stateDir"] = { path: config.stateDir, error: null, mode: null };
  try {
    if (!existsSync(config.stateDir)) mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    stateDir.mode = statSync(config.stateDir).mode & 0o777;
  } catch (error) {
    stateDir.error = error instanceof Error ? error.message : String(error);
  }
  const exposed = config.host === "0.0.0.0" || config.allowedHosts.length > 0;
  const socket = herdrSocketPath(env, config.home ?? homedir(), userConfig?.herdr_socket);
  return {
    configError,
    configFile: settings?.file ?? null,
    nodeVersion: process.version,
    bunVersion: bunVersion(),
    harnesses,
    harnessError,
    host: config.host,
    port: config.port,
    workspaceWarnings: warnings,
    workspaceRoots: workspaces.rootList.length,
    stateDir,
    portProbe: await probePort(config.host, config.port),
    remote: { exposed, credentials: config.login !== null || existsSync(config.credentialsFile) },
    herdr: { enabled: herdrEnabled(userConfig, env), socket, exists: existsSync(socket) },
    orchestration: { ...config.orchestration, missingBridges: missingOrchestrationBridges() },
    windows: IS_WINDOWS,
    embedded: isEmbedded,
  };
}

/** `awui doctor [--json]`: print the report; the exit code is 1 when a check failed. */
export async function runDoctor(args: string[]): Promise<number> {
  const checks = evaluate(await gather());
  console.log(args.includes("--json") ? JSON.stringify(checks, null, 2) : render(checks));
  return checks.some((c) => c.ok === false) ? 1 : 0;
}
