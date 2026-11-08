// The desktop app: one window over the awui server this machine already runs, or
// one it starts itself. It is a client, not a second implementation — the window
// loads the same bundle a browser does, with no preload and no Node in the
// renderer, so awui's security model (loopback Host, loopback peer, no proxy
// headers) is exactly what it is in a tab. What it adds is desktop plumbing: a
// tray, a menu, awui:// links, and a server it can start when none is running.
//
// It never starts a second server beside one that is already up: two processes
// over one state folder would both hold the same session files (AGENTS.md rule
// 2), so attaching beats any free port (src/shared/desktop.ts, planLaunch).
// Quitting stops a server this app started and never touches one it attached to.
import { app, BrowserWindow, Menu, Tray, desktopCapturer, dialog, nativeImage, session, shell, type MenuItemConstructorOptions } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PORT, ENDPOINT_FILE, expandHome, healthUrl, parseEndpoint, parseHealth, planLaunch, portsFrom, targetFromLink, targetUrl, titleCount, type Endpoint, type Health, type Probe, type Target } from "../../../src/shared/desktop.js";

/** Where a packaged app keeps the binary electron-builder put beside it. */
const BIN_NAME = process.platform === "win32" ? "awui.exe" : "awui";
/** How long a started server gets to answer before the app says it failed. */
const START_TIMEOUT_MS = 20_000;
/** The last lines a child printed, for the failure dialog. */
const LOG_LINES = 60;

const log: string[] = [];
function remember(text: string): void {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    log.push(line);
    if (log.length > LOG_LINES) log.shift();
  }
  process.stderr.write(text);
}

/** The app's own folder (apps/desktop in a checkout, app.asar when packaged). */
function appRoot(): string {
  return app.getAppPath();
}

/** The checkout a development run sits in: apps/desktop → the repo root. */
function checkoutRoot(): string {
  return path.resolve(appRoot(), "../..");
}

/**
 * The server to run when none is up: an explicit AWUI_BIN, the binary shipped
 * beside a packaged app, the one this checkout's build wrote, the checkout's own
 * `bin/awui`, and finally whatever `awui` is on the PATH.
 */
function serverCommand(): string {
  const explicit = process.env.AWUI_BIN;
  if (explicit) return explicit;
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, BIN_NAME);
    if (existsSync(bundled)) return bundled;
  }
  const root = checkoutRoot();
  const built = path.join(root, "dist", "bin", `${process.platform}-${process.arch}`, BIN_NAME);
  if (existsSync(built)) return built;
  const script = path.join(root, "bin", "awui");
  if (existsSync(script)) return script;
  return "awui";
}

/**
 * Ask one port who it is. A refused connection means the port is ours to take;
 * anything else that answers — a stranger, a hang, a proxy — is not.
 */
async function probePort(port: number): Promise<Probe> {
  try {
    const res = await fetch(healthUrl(port), { signal: AbortSignal.timeout(1500), redirect: "error" });
    return { port, state: parseHealth(await res.text()) ? "awui" : "other" };
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    return { port, state: code === "ECONNREFUSED" ? "free" : "other" };
  }
}

/** Every port the shell looks at, asked at once. */
async function probeAll(base: number): Promise<Probe[]> {
  return Promise.all(portsFrom(base).map(probePort));
}

/** Poll health until the child answers, the child dies, or the deadline passes. */
async function waitForHealth(port: number, child: ChildProcess): Promise<Health> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // No pid means the spawn itself failed (no such file, not executable); the
    // error handler has already put the reason in the log.
    if (child.pid === undefined) throw new Error("the awui binary could not be started");
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`awui exited (${child.exitCode ?? child.signalCode}) before it answered`);
    try {
      const res = await fetch(healthUrl(port), { signal: AbortSignal.timeout(1000) });
      const health = parseHealth(await res.text());
      if (health) return health;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`awui did not answer on port ${port} within ${START_TIMEOUT_MS / 1000}s`);
}

/** awui's state folder, as the server computes it (src/server/config.ts, stateBase). */
function stateFolder(): string {
  const explicit = process.env.AWUI_STATE_DIR;
  // `~/state` is a value the server accepts. path.resolve alone would look in a literal `./~/state`.
  if (explicit) return path.resolve(expandHome(explicit, os.homedir()));
  const home = os.homedir();
  const base = process.platform === "win32" ? process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local") : process.env.XDG_STATE_HOME || path.join(home, ".local", "state");
  return path.join(base, "awui");
}

/** Where the running server said it listens, if it said. Stale after a crash — the caller probes. */
async function publishedEndpoint(): Promise<Endpoint | null> {
  try {
    return parseEndpoint(await fs.readFile(path.join(stateFolder(), ENDPOINT_FILE), "utf8"));
  } catch {
    return null;
  }
}

/** The AppImage's AppRun exports these; a spawned server must not inherit them. */
const APPIMAGE_ENV = ["LD_LIBRARY_PATH", "LD_PRELOAD", "APPDIR", "APPIMAGE", "ARGV0", "OWD"];

/**
 * The server's environment: this process's, less what the AppImage wrapper set.
 * AppRun puts Electron's own libraries on LD_LIBRARY_PATH, and a loader searches
 * that before a binary's RUNPATH — so the server, and every harness it starts,
 * could load Electron's copies of glibc's neighbours instead of their own.
 */
function serverEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of APPIMAGE_ENV) delete env[name];
  return env;
}

/** The port to look at: awui's default, or one the user named for this app. */
function basePort(): number {
  const wanted = Number(process.env.AWUI_DESKTOP_PORT ?? process.env.PORT ?? DEFAULT_PORT);
  return Number.isInteger(wanted) && wanted > 0 && wanted < 65536 ? wanted : DEFAULT_PORT;
}

interface Server {
  base: string;
  /** Set only when this app started it; quitting stops exactly this one. */
  child: ChildProcess | null;
}

/**
 * The server this app started, set the moment it is spawned. Signal handlers read this
 * rather than the `Server` ensureServer returns, so a signal during waitForHealth still
 * reaps the child instead of leaving it holding the port.
 */
let ownedChild: ChildProcess | null = null;

function stopOwned(): void {
  ownedChild?.kill("SIGTERM");
}

/** Attach to a running server, or start one and wait for it. */
async function ensureServer(): Promise<Server> {
  // A server on a port config.yml chose is not in the default range: ask the one
  // it published before scanning, and start on that port when it has gone.
  const endpoint = await publishedEndpoint();
  const base = endpoint?.port ?? basePort();
  if (endpoint) {
    const probe = await probePort(endpoint.port);
    if (probe.state === "awui") return { base: `http://127.0.0.1:${endpoint.port}`, child: null };
  }
  const launch = planLaunch(await probeAll(base));
  if (launch.action === "attach") return { base: `http://127.0.0.1:${launch.port}`, child: null };
  if (launch.action === "none") throw new Error(`ports ${base}–${base + portsFrom(base).length - 1} all belong to other programs; set AWUI_DESKTOP_PORT to a free one`);

  const command = serverCommand();
  const child = spawn(command, ["--port", String(launch.port)], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: serverEnv() });
  ownedChild = child;
  child.stdout?.on("data", (chunk: Buffer) => remember(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => remember(chunk.toString()));
  child.on("error", (error) => remember(`awui: cannot run ${command}: ${error.message}`));

  try {
    await waitForHealth(launch.port, child);
  } catch (error) {
    child.kill("SIGTERM");
    if (ownedChild === child) ownedChild = null;
    const tail = log.slice(-12).join("\n");
    throw new Error(`${error instanceof Error ? error.message : String(error)}${tail ? `\n\n${tail}` : ""}\n\nTried to run: ${command}`);
  }
  return { base: `http://127.0.0.1:${launch.port}`, child };
}

/** A window onto the running server. No preload: the page is the whole client. */
function createWindow(server: Server, target: Target): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 860,
    minHeight: 560,
    show: false,
    title: "awui",
    backgroundColor: "#15161a",
    icon: path.join(appRoot(), "assets", "icon.png"),
    // The window is the app: no File/View/Window row over it. The menu still
    // exists (its accelerators — Cmd/Ctrl+N, +Shift+O, +R — keep working, and Alt
    // reveals it), because a menu-less window loses them too.
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  win.setMenuBarVisibility(false);
  const origin = new URL(server.base).origin;
  const local = (url: string): boolean => {
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  };

  // Links in an answer belong in the browser, not in the app's only window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (local(url)) return;
    event.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });

  win.once("ready-to-show", () => win.show());
  win.on("focus", () => win.flashFrame(false));
  // A page that cannot load is worth one line in the log the failure dialog reads.
  win.loadURL(targetUrl(server.base, target)).catch((error: unknown) => remember(`awui: the window could not load its page: ${String(error)}\n`));
  return win;
}

/** The app menu: the shell's own items, then the roles Electron does for us. */
function buildMenu(open: (target: Target) => void, reload: () => void): Menu {
  const items: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" } as MenuItemConstructorOptions] : []),
    {
      label: "File",
      submenu: [
        { label: "New chat", accelerator: "CmdOrCtrl+N", click: () => open({ kind: "new" }) },
        { label: "Sessions", accelerator: "CmdOrCtrl+Shift+O", click: () => open({ kind: "sessions" }) },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: reload },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" } as MenuItemConstructorOptions]),
      ],
    },
    { role: "windowMenu" },
  ];
  return Menu.buildFromTemplate(items);
}

/** The tray: the app's state at a glance, and a way back in. */
function createTray(win: BrowserWindow, open: (target: Target) => void): Tray {
  const tray = new Tray(nativeImage.createFromPath(path.join(appRoot(), "assets", "icon.png")));
  tray.setToolTip("awui");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open awui", click: () => { win.show(); win.focus(); } },
      { type: "separator" },
      { label: "New chat", click: () => open({ kind: "new" }) },
      { label: "Sessions", click: () => open({ kind: "sessions" }) },
      { type: "separator" },
      { role: "quit" },
    ]),
  );
  tray.on("click", () => { win.show(); win.focus(); });
  return tray;
}

/** An `awui://` link anywhere in an argv (Windows and Linux hand them to the second instance). */
function linkFrom(argv: string[]): string | null {
  return argv.find((arg) => arg.startsWith("awui://")) ?? null;
}

async function main(): Promise<void> {
  app.setName("awui");
  // Electron's own caches, cookies and localStorage belong in awui's state
  // folder, not in ~/.config/awui beside config.yml and theme.yml. A launcher
  // that already chose a profile (--user-data-dir) keeps it: the profile path is
  // read once, before the app is ready, and moving it later is not a move.
  const profileGiven = app.commandLine.hasSwitch("user-data-dir");
  const stateHome = process.platform === "win32" ? process.env.LOCALAPPDATA ?? "" : process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  if (!profileGiven && stateHome) app.setPath("userData", path.join(stateHome, "awui", "desktop"));
  if (process.platform === "win32") app.setAppUserModelId("dev.awui.desktop");
  // The WM_CLASS the packaged .desktop entry names (StartupWMClass), set before
  // Chromium starts: Wayland's global-shortcut and notification portals register
  // the first identity they see, and setting it later is too late.
  if (process.platform === "linux") app.commandLine.appendSwitch("class", "awui-desktop");

  // A link that opened the app — macOS hands it over before `ready`, so the
  // listener must exist now, and what it hears waits until a window can open it.
  const queuedLinks: Target[] = [];
  let deliver: ((target: Target) => void) | null = null;
  app.on("open-url", (event, url) => {
    event.preventDefault();
    const target = targetFromLink(url);
    if (!target) return;
    if (deliver) deliver(target);
    else queuedLinks.push(target);
  });

  // One app per machine: a second launch focuses the first, and its link (if any) opens there.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  await app.whenReady();

  // awui's screenshot button asks for the screen; Electron needs a source to give it.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      void desktopCapturer
        .getSources({ types: ["screen"] })
        .then((sources) => {
          const first = sources[0];
          callback(first ? { video: first } : {});
        })
        // A refused or failed capture must answer, or the page waits forever.
        .catch(() => callback({}));
    },
    { useSystemPicker: true },
  );

  // Before the spawn: a signal during startup must take the child with it. Electron
  // does not turn SIGTERM into `before-quit`, so a handler registered only after
  // ensureServer returns leaves the just-spawned server running.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      stopOwned();
      app.quit();
    });
  }

  let server: Server;
  try {
    server = await ensureServer();
  } catch (error) {
    dialog.showErrorBox("awui could not start", error instanceof Error ? error.message : String(error));
    app.quit();
    return;
  }

  let win: BrowserWindow | null = null;
  let tray: Tray | null = null;

  const open = (target: Target): void => {
    if (!win || win.isDestroyed()) {
      win = createWindow(server, target);
      wire(win);
      return;
    }
    win.show();
    win.focus();
    void win.loadURL(targetUrl(server.base, target));
  };

  const wire = (window: BrowserWindow): void => {
    window.on("page-title-updated", (_event, title) => {
      const count = titleCount(title);
      tray?.setToolTip(count > 0 ? `awui — ${count} need${count === 1 ? "s" : ""} you` : "awui");
      if (count > 0 && !window.isFocused()) window.flashFrame(true);
      if (process.platform === "darwin") app.dock?.setBadge(count > 0 ? String(count) : "");
    });
    window.on("closed", () => {
      win = null;
    });
  };

  win = createWindow(server, { kind: "home" });
  wire(win);
  tray = createTray(win, open);
  Menu.setApplicationMenu(buildMenu(open, () => win?.webContents.reload()));

  // A link that opened the app the first time, and one handed to a later launch.
  const firstLink = linkFrom(process.argv);
  if (firstLink) {
    const target = targetFromLink(firstLink);
    if (target) open(target);
  }
  app.on("second-instance", (_event, argv) => {
    const link = linkFrom(argv);
    const target = link ? targetFromLink(link) : null;
    open(target ?? { kind: "home" });
  });
  // Whatever arrived before the window existed, now that it does.
  deliver = open;
  for (const target of queuedLinks.splice(0)) open(target);
  if (app.isPackaged) app.setAsDefaultProtocolClient("awui");

  // Closing the window quits, as a browser tab would: the tray is a shortcut, not
  // a place to hide. A server this app started stops with it; an attached one is
  // someone else's (systemd) and keeps running.
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => stopOwned());
}

void main();
