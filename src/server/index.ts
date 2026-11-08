import { createHmac } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import http from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, RECENT_SESSIONS_PER_HARNESS } from "./app.js";
import { ChatManager } from "./chats/manager.js";
import { RoomManager } from "./boards/manager.js";
import { ConfigError, loadConfig, migrateStateDir } from "./config.js";
import { liveOmpChildren } from "./harness/omp.js";
import { HarnessRegistry } from "./harness/registry.js";
import { hashPassword, loadCredentials, PasswordAuth } from "./auth.js";
import { cachedLanHosts, sampleLanHosts } from "./network.js";
import { loadOrCreateSecret, Security } from "./security.js";
import { embeddedVersion, extractEmbeddedExtensions, isEmbedded } from "./embedded.js";
import "./assets.gen.js";
import { installTui } from "./install-tui.js";
import { installService } from "./install-service.js";
import { installDesktop, installDesktopIcon, runDesktop } from "./desktop-app.js";
import { ENDPOINT_FILE } from "../shared/desktop.js";
import { writeJson } from "./state-file.js";
import { clientCommand, runClient } from "./clients.js";
import { runDoctor } from "./doctor.js";
import { SessionMarks } from "./session-marks.js";
import { Routines } from "./routines.js";
import { startDue } from "./routines-timer.js";
import { runRoutine } from "./routine-runner.js";
import { SessionOrder } from "./session-order.js";
import { SavedPrompts } from "./saved-prompts.js";
import { Limits } from "./limits.js";
import { Notifier, roomPushNote } from "./notify.js";
import { ThemeStore } from "./theme.js";
import { Herdr, herdrSocketPath } from "./herdr.js";
import { configDir, configEnv, herdrEnabled, migrateConfigDir, readUserConfig, UserConfigError } from "./user-config.js";
import { Workspaces } from "./workspaces.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Bad settings (EX_CONFIG): retrying cannot help, so supervisors should not restart on it. */
const EXIT_CONFIG = 78;

async function findRoot(): Promise<string> {
  let dir = here;
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === "awui") return dir;
    } catch {
      // keep walking up
    }
    dir = path.dirname(dir);
  }
  throw new Error("Cannot locate the awui package root");
}

/** config.yml's `herdr`, read again at most every two seconds, so the Settings dialog turns it on and off without a restart. */
function herdrSetting(dir: string | null, initial: Parameters<typeof herdrEnabled>[0]): () => boolean {
  let on = herdrEnabled(initial);
  let at = Date.now();
  return () => {
    if (Date.now() - at < 2000) return on;
    at = Date.now();
    try {
      on = herdrEnabled(readUserConfig(dir)?.config);
    } catch {
      // A config.yml broken since startup keeps the last good answer; startup logged the file's problems.
    }
    return on;
  };
}

async function main(): Promise<void> {
  // In the binary there is no package root or dist tree on disk: the version is
  // baked in and the web bundle is embedded, so root/webDir only matter to the
  // source layout.
  const root = isEmbedded ? null : await findRoot();
  let settings: ReturnType<typeof readUserConfig> = null;
  let config;
  try {
    if (migrateConfigDir(process.env) === "moved") console.log(`  config: moved from agentwebui to ${configDir()}`);
    settings = readUserConfig(configDir());
    // Real environment variables win over config.yml; the password never enters process.env.
    config = loadConfig({ ...(settings ? configEnv(settings.config) : {}), ...process.env }, settings?.config);
  } catch (error) {
    if (error instanceof ConfigError || error instanceof UserConfigError) {
      console.error(`awui: ${error.message}`);
      process.exit(EXIT_CONFIG);
    }
    throw error;
  }
  if (migrateStateDir(config.stateDir) === "moved") console.log(`  state: moved from agent-web-ui to ${config.stateDir}`);
  // The binary's extension sources need to be real files for pi/omp's -e; write them before the adapters resolve them.
  await extractEmbeddedExtensions(config.stateDir);
  // Which settings the environment overrides (they beat config.yml), noted before the password leaves it.
  const envSet = new Set(["PORT", "HOST", "AUTH_USERNAME", "AUTH_PASSWORD", "WORKSPACE_ROOTS", "ALLOWED_HOSTS", "ALLOWED_TAILSCALE_USERS", "AWUI_HERDR"].filter((n) => process.env[n] !== undefined));
  // The agents' shells inherit process.env; the password must not reach them.
  delete process.env.AUTH_PASSWORD;
  const herdr = new Herdr(herdrSocketPath(process.env, config.home, settings?.config.herdr_socket), herdrSetting(config.configDir, settings?.config));
  // A server started in a herdr pane must not hand that pane to its harness children: herdr's Claude Code
  // and Hermes hooks would report every chat's session as the pane's own.
  for (const name of ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID"]) delete process.env[name];
  if (settings) console.log(`  settings: ${settings.file}`);
  if (settings?.tightened) console.log(`  ${settings.file} holds a password; its mode is now 0600`);
  const pkg = { version: embeddedVersion ?? JSON.parse(await fs.readFile(path.join(root as string, "package.json"), "utf8")).version };
  const secret = await loadOrCreateSecret(config.stateDir);
  // Other devices (LAN via HOST=0.0.0.0, or Tailscale Serve) sign in with a
  // password; this machine never needs to.
  const remote = config.host === "0.0.0.0" || config.allowedHosts.length > 0;
  let password: PasswordAuth | undefined;
  if (config.login) {
    // Salt from the install secret: the same password keeps the same cookie
    // fingerprint, so a restart does not sign devices out; a new one does.
    const salt = createHmac("sha256", secret).update(`login-salt\0${config.login.username}`).digest().subarray(0, 16);
    password = new PasswordAuth(await hashPassword(config.login.username, config.login.password, salt));
  } else {
    try {
      password = new PasswordAuth(await loadCredentials(config.credentialsFile));
    } catch (error) {
      if (remote) {
        console.error(`awui: ${error instanceof Error ? error.message : String(error)}`);
        console.error(
          "awui: host 0.0.0.0 and allowed_hosts need a login for other devices (auth.username and auth.password in config.yml, or `npm run set-password`); refusing to start.",
        );
        process.exit(EXIT_CONFIG);
      }
    }
  }
  const security = new Security({
    port: config.port,
    allowedHosts: config.allowedHosts,
    allowedTailscaleUsers: config.allowedTailscaleUsers,
    secret,
    ...(password ? { password } : {}),
    ...(config.host === "0.0.0.0" ? { lanHosts: cachedLanHosts() } : {}),
    log: (m) => console.error(`awui: ${m}`),
    revokedFile: path.join(config.stateDir, "signed-out.json"),
  });
  await security.ready;
  const { workspaces, warnings } = await Workspaces.create(config.workspaceRoots, config.home);
  for (const w of warnings) console.error(`awui: ${w}`);
  if (workspaces.rootList.length === 0) {
    console.error("awui: no usable WORKSPACE_ROOTS");
    process.exit(EXIT_CONFIG);
  }
  const registry = HarnessRegistry.fromConfig(config);
  for (const status of await registry.refreshStatus()) {
    const state = status.available ? `available (${status.versionDetail ?? status.version ?? "unknown version"})` : `unavailable: ${status.reason}`;
    console.log(`  ${status.displayName}: ${state}`);
    for (const w of status.warnings) console.log(`    warning: ${w}`);
    for (const [name, value] of Object.entries(status.overrides)) console.log(`    ${name}: ${value}`);
  }
  // Warm each harness's session listing now, so the first sidebar load does
  // not wait for it (a Hermes probe gateway alone takes ~2.4 s to start).
  for (const adapter of registry.list()) {
    if (registry.isAvailable(adapter.id)) void adapter.listRecentSessions(RECENT_SESSIONS_PER_HARNESS).catch(() => undefined);
  }
  const theme = new ThemeStore(config.themeFile, config.themeFileExplicit, (m) => console.error(`awui: ${m}`));
  const active = await theme.get();
  console.log(`  theme: ${active.name ?? "built-in light/dark"}`);
  const manager = new ChatManager();
  // Chats' render tools always post back over loopback, even when the server
  // also serves the LAN: the page stays on the machine the project is on.
  manager.render = { baseUrl: `http://127.0.0.1:${config.port}` };
  const marks = await SessionMarks.open(config.stateDir);
  const routines = await Routines.open(config.stateDir);

  // Scheduled runs: every 30 seconds, start whatever is due. The store claims a
  // routine before it starts, so overlapping ticks cannot run one twice; a failure
  // is logged and the routine's next slot is its retry.
  const routineTimer = setInterval(() => {
    void startDue(
      routines,
      async (routine) => {
        const adapter = registry.get(routine.harnessId);
        if (!adapter) throw new Error(`no ${routine.harnessId} adapter`);
        await runRoutine(routine, await workspaces.get(routine.workspaceId), adapter, manager);
      },
      Date.now(),
      (routine, error) => console.error(`awui: routine "${routine.name}" did not start: ${error instanceof Error ? error.message : String(error)}`),
    );
  }, 30_000);
  routineTimer.unref();
  const order = await SessionOrder.open(config.stateDir);
  const prompts = await SavedPrompts.open(config.stateDir);
  const limits = await Limits.open(registry, config.stateDir);
  limits.warm();
  const notifier = await Notifier.open(config.stateDir, (m) => console.error(`awui: ${m}`));
  // Board rooms: load their durable state before any route exists, and mark
  // work interrupted by the previous process as interrupted (nothing paid resumes).
  const boards = new RoomManager({
    registry,
    workspaces,
    chats: manager,
    stateDir: config.stateDir,
    log: (m) => console.error(`awui: boards: ${m}`),
    notify: (note) => void notifier.notify(roomPushNote(note)),
  });
  await boards.start();
  const lanUrls = config.host === "0.0.0.0" ? sampleLanHosts().ipv4.map((ip) => `http://${ip}:${config.port}/`) : [];
  const pairingUrls = [...lanUrls, ...config.allowedHosts.map((h) => `https://${h}/`)];
  const webDir = process.env.AWUI_WEB_DIR ?? (root === null ? null : path.join(root, "dist", "web"));
  const app = createApp({
    version: pkg.version,
    home: config.home,
    registry,
    manager,
    workspaces,
    security,
    theme,
    pairingUrls,
    webDir,
    configDir: config.configDir,
    herdr,
    marks,
    routines,
    order,
    prompts,
    limits,
    notifier,
    boards,
    checkpointsDir: path.join(config.stateDir, "checkpoints"),
    stateDir: config.stateDir,
    settings: {
      configDir: config.configDir,
      running: {
        port: config.port,
        host: config.host === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1",
        username: settings?.config.auth?.username ?? "",
        password: settings?.config.auth?.password ?? null,
        workspaceRoots: config.workspaceRoots,
        allowedHosts: config.allowedHosts,
        allowedTailscaleUsers: config.allowedTailscaleUsers,
      },
      envSet,
      credentialsFile: config.credentialsFile,
      // systemd sets INVOCATION_ID for its services; the unit restarts on any exit.
      canRestart: Boolean(process.env.INVOCATION_ID),
      home: config.home,
    },
    ...(process.env.AWUI_HEARTBEAT_MS ? { heartbeatMs: Number(process.env.AWUI_HEARTBEAT_MS) } : {}),
  });

  const server = http.createServer(app);
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(`awui: port ${config.port} on 127.0.0.1 is already in use. Stop the other process or set PORT.`);
    } else {
      console.error(`awui: cannot listen: ${error.message}`);
    }
    process.exit(1);
  });
  // A server on a configured port other than 4783 is invisible to a port scan of
  // the defaults, so it says where it is. A stale file after a crash is fine: the
  // reader still asks the port who it is (src/shared/desktop.ts, parseEndpoint).
  const endpointFile = path.join(config.stateDir, ENDPOINT_FILE);
  server.listen(config.port, config.host, () => {
    void writeJson(endpointFile, { port: config.port, host: config.host, pid: process.pid, version: pkg.version, startedAt: new Date().toISOString() });
    console.log(`awui ${pkg.version} listening on http://${config.host}:${config.port}`);
    console.log(`Local: http://127.0.0.1:${config.port}/ (no sign-in on this machine)`);
    for (const url of lanUrls) console.log(`LAN:   ${url}`);
    for (const h of config.allowedHosts) console.log(`Serve: https://${h}/`);
    if (password && remote) {
      console.log(`  other devices sign in as "${password.username}" (${config.login ? "AUTH_PASSWORD" : "npm run set-password"})`);
    }
    if (lanUrls.length > 0) {
      console.log("  warning: LAN access is plain HTTP; the password and chats are not encrypted on the network. Prefer Tailscale.");
    }
    if (webDir !== null && !existsSync(path.join(webDir, "index.html"))) {
      console.log("  (no built UI found; run `npm run build`, or use `npm run dev`)");
    }
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`awui: ${signal}, shutting down`);
    // A stuck harness child (one that ignores SIGTERM, or whose exit never
    // surfaces) must not hold the process: this is systemd's Restart=always
    // unit, and a wedged stop leaves it deactivated until the stop timeout.
    // Bound the whole teardown; whatever is left is reaped with the process.
    // Not unref'd — the exit below would race a detached timer.
    const force = setTimeout(() => {
      console.log(`awui: shutdown hit its deadline; forcing exit`);
      process.exit(0);
    }, 5_000);
    clearInterval(routineTimer);
    server.close();
    for (const socket of sockets) socket.destroy();
    try {
      // Rooms first: their schedulers may still reach chats the manager is about to close.
      await boards.shutdown();
      await manager.shutdown();
      await registry.shutdown();
    } finally {
      clearTimeout(force);
    }
    await fs.rm(endpointFile, { force: true }).catch(() => undefined);
    const left = liveOmpChildren();
    console.log(`awui: stopped (omp children left: ${left})`);
    process.exit(0);
  };
  // A stray rejection (a write that failed, a child's pipe that broke) is logged, not fatal: one failure
  // in a side feature must not take every live chat down with the server.
  process.on("unhandledRejection", (reason) => {
    console.error(`awui: unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
  });
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}


/** awui's CLI surface. Beyond the subcommands, a few flags; everything else is env or config.yml. */
const HELP = `awui ${embeddedVersion ?? ""} — local web UI for coding agents

Usage:
  awui [flags]           Run the web UI + API (default)
  awui tui [options]     atui, awui in the terminal (also \`atui\`; awui tui --help)
  awui tern [options]    awui drawn natively in a Tern pane (also awui --tern; awui tern --help)
  awui doctor [--json]   Check the setup (config, harnesses, state folder, port) and print a report; exit 1 on a problem
  awui desktop [args]    The optional desktop app (Electron): attaches to a running server, or starts one
                         [--install-icon: add it to the application menu (~/.local/share/applications)]
  awui install tui       Put the \`atui\` command on the PATH (~/.local/bin/atui, a link to this awui)
  awui install desktop   Put the \`awui-desktop\` command on the PATH (~/.local/bin, a link to the built app)
  awui install service   Install the binary for autostart: ~/.local/bin (with atui) + systemd on Linux/macOS,
                         a logon Scheduled Task on Windows
                         [--link symlinks it instead of copying (POSIX only), for a dev checkout]

Flags:
  --port <n>             Listen port (default 4783; env PORT)
  --host <addr>          127.0.0.1 (this machine) or 0.0.0.0 (LAN, sign-in) (env HOST)
  --state-dir <path>     State folder (default $XDG_STATE_HOME/awui; env AWUI_STATE_DIR)
  --version              Print version and exit
  --help                 This help
`;

/** Parse the small flag set into env overrides; unknown flags fail loudly instead of silently serving. */
function parseFlags(argv: string[]): { port?: string; host?: string; stateDir?: string; link?: boolean; help?: boolean; version?: boolean } | string {
  const out: { port?: string; host?: string; stateDir?: string; link?: boolean; help?: boolean; version?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const take = (k: "port" | "host" | "stateDir") => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      out[k] = v;
    };
    try {
      if (a === "--port" || a === "-p") take("port");
      else if (a === "--host") take("host");
      else if (a === "--state-dir") take("stateDir");
      else if (a === "--link") out.link = true;
      else if (a === "--help" || a === "-h") out.help = true;
      else if (a === "--version" || a === "-v") out.version = true;
      else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
      // A stray word is a mistyped command (`awui instal tui`): say so rather than start serving.
      else throw new Error(`unknown command: ${a}`);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
  return out;
}

/** A client (`awui tui`, `awui tern`, the binary as `atui`), `awui doctor`, `awui install tui|service`, or flags that run the web server; anything else is a usage error. */
const args = process.argv.slice(2);
// First: the binary linked as `atui` hands atui every argument, `doctor` and `install` included.
const client = clientCommand(args, process.argv0);
if (client) {
  // The clients take their own options (--url, --harness, --resume, --chat), not the server's.
  runClient(client.client, client.args, { binary: isEmbedded, version: embeddedVersion }).catch((error: unknown) => {
    console.error(`awui: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
} else if (args[0] === "doctor") {
  runDoctor(args.slice(1)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`awui: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
} else if (args[0] === "desktop") {
  // The optional Electron app: the one this binary carries, else one installed or
  // built here. Started detached, so this command returns and the app outlives it.
  // `--install-icon` is this command's own flag; everything else goes to the app.
  let stateDir = "";
  try {
    stateDir = loadConfig().stateDir;
  } catch (error) {
    console.error(`awui desktop: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(EXIT_CONFIG);
  }
  const rest = args.slice(1);
  const wantsIcon = rest.includes("--install-icon");
  const work = wantsIcon ? installDesktopIcon({ stateDir }) : runDesktop({ args: rest.filter((a) => a !== "--install-icon"), stateDir });
  work.catch((error: unknown) => {
    console.error(`awui desktop: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
} else if (args[0] === "install" && args[1] !== "tui" && args[1] !== "service" && args[1] !== "desktop") {
  console.error(`awui install: expected \`tui\`, \`service\` or \`desktop\`${args[1] ? `, not \`${args[1]}\`` : ""}\n\n${HELP}`);
  process.exit(64);
} else if (args[0] === "install") {
  const what = args[1] as string;
  const rest = args.slice(2);
  const flags = parseFlags(rest);
  if (typeof flags === "string") {
    console.error(`awui install ${what}: ${flags}`);
    process.exit(64);
  }
  const link = flags.link === true;
  // process.env first, so a state folder set there is the one installed into; --state-dir wins.
  const config = loadConfig({ ...process.env, ...(flags.stateDir ? { AWUI_STATE_DIR: flags.stateDir } : {}) });
  if (what === "service") {
    installService({ link }).catch((error: unknown) => {
      console.error(`awui: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
  } else if (what === "desktop") {
    installDesktop({ stateDir: config.stateDir }).catch((error: unknown) => {
      console.error(`awui install desktop: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
  } else {
    installTui(config.stateDir).catch((error: unknown) => {
      console.error(`awui: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
  }
} else {
  const flags = parseFlags(args);
  if (typeof flags === "string") {
    console.error(`awui: ${flags}\n\n${HELP}`);
    process.exit(64);
  }
  if (flags.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (flags.version) {
    console.log(embeddedVersion ?? "dev");
    process.exit(0);
  }
  // Flags become env so a flag matches its documented precedence (it beats config.yml, loses to a real env var).
  if (flags.port && process.env.PORT === undefined) process.env.PORT = flags.port;
  if (flags.host && process.env.HOST === undefined) process.env.HOST = flags.host;
  if (flags.stateDir && process.env.AWUI_STATE_DIR === undefined) process.env.AWUI_STATE_DIR = flags.stateDir;
  main().catch((error: unknown) => {
    console.error(`awui: fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
