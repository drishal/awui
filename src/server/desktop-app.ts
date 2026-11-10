// `awui desktop` and `awui install desktop`: the CLI's way to the optional
// Electron app. The app is not inside this binary — it is Electron plus the web
// bundle, ~170 MB — so the command finds an installed copy (or a checkout's) and
// starts it detached, the way `awui tui` runs atui. Nothing here drives the
// server: the app attaches to a running one itself (apps/desktop/README.md).
// `awui desktop --install-icon` writes the application-menu entry and its icon
// under $XDG_DATA_HOME, so the launcher lists the app like any other.
import { spawn } from "node:child_process";
import { constants as fsConstants, existsSync, promises as fs, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChatError } from "./chats/chat.js";
import { bundledDesktop } from "./desktop-embed.js";
import { embeddedVersion, embeddedWeb } from "./embedded.js";
import { launchExclusive } from "./desktop-instance.js";

export interface DesktopLaunch {
  command: string;
  args: string[];
  /** Where it came from, for the one line `awui desktop` prints. */
  how: string;
}

/** The name the desktop command is installed and looked up as. */
export function desktopName(platform: string = process.platform): string {
  return platform === "win32" ? "awui-desktop.exe" : "awui-desktop";
}

/** Where `awui install desktop` puts the command: ~/.local/bin/awui-desktop. */
export function desktopLink(home: string, platform: string = process.platform): string {
  return path.join(home, ".local", "bin", desktopName(platform));
}

/** `name` found on the PATH, or null. PATHEXT is not consulted: the name carries its extension. */
export function onPath(name: string, env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = existsSync): string | null {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    if (exists(file)) return file;
  }
  return null;
}

export interface DesktopSearch {
  /** The checkout this build came from; null in a compiled binary with nothing around it. */
  root: string | null;
  home: string;
  /** The app this very binary carries, already extracted; null when it carries none. */
  bundled?: string | null;
  platform?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
}

/**
 * Everything `awui desktop` will try, in order: an explicit AWUI_DESKTOP_BIN
 * (the user said which one), the app this binary carries, the command `install
 * desktop` left on the PATH, any `awui-desktop` already on the PATH, then a
 * checkout's Electron (a development run). Only entries that exist come back; a
 * packaged build is what `install desktop` is for.
 */
export function desktopLaunches(search: DesktopSearch): DesktopLaunch[] {
  const platform = search.platform ?? process.platform;
  const env = search.env ?? process.env;
  const exists = search.exists ?? existsSync;
  const out: DesktopLaunch[] = [];

  const explicit = env.AWUI_DESKTOP_BIN;
  if (explicit && exists(explicit)) out.push({ command: explicit, args: [], how: "AWUI_DESKTOP_BIN" });

  if (search.bundled && exists(search.bundled)) out.push({ command: search.bundled, args: [], how: "bundled with this awui" });

  const link = desktopLink(search.home, platform);
  if (exists(link)) out.push({ command: link, args: [], how: "installed" });

  const named = onPath(desktopName(platform), env, exists);
  if (named && named !== link) out.push({ command: named, args: [], how: "on the PATH" });

  if (search.root) {
    const app = path.join(search.root, "apps", "desktop");
    const electron = path.join(app, "node_modules", ".bin", platform === "win32" ? "electron.cmd" : "electron");
    if (exists(electron) && exists(path.join(app, "package.json"))) {
      out.push({ command: electron, args: [app], how: "this checkout (electron .)" });
    }
  }
  return out;
}

/** The first launch that exists, or null. */
export function findDesktop(search: DesktopSearch): DesktopLaunch | null {
  return desktopLaunches(search)[0] ?? null;
}

/**
 * Which file `install desktop` links, from the names in apps/desktop/release:
 * the AppImage (self-contained), else the unpacked app the build wrote.
 */
export function chooseArtifact(files: string[], platform: string = process.platform, arch: string = process.arch): string | null {
  if (platform === "darwin") return macArtifact(files, arch);
  if (platform === "win32") return files.includes("win-unpacked") ? path.join("win-unpacked", desktopName(platform)) : null;
  const image = files.filter((f) => f.endsWith(".AppImage")).sort()[0];
  if (image) return image;
  return files.includes("linux-unpacked") ? path.join("linux-unpacked", desktopName(platform)) : null;
}

/**
 * electron-builder writes `mac` (x64) and `mac-arm64`. When both are present, the
 * directory for this arch wins; readdir order must not hand an arm64 binary to an
 * x64 install. A bare `.app` is the other shape the build can leave.
 */
function macArtifact(files: string[], arch: string): string | null {
  const named = `mac-${arch === "arm64" ? "arm64" : "x64"}`;
  const dir = files.includes(named) ? named : arch !== "arm64" && files.includes("mac") ? "mac" : files.find((f) => f.startsWith("mac"));
  if (dir) return path.join(dir, "awui.app", "Contents", "MacOS", "awui");
  const app = files.find((f) => f.endsWith(".app"));
  return app ? path.join(app, "Contents", "MacOS", "awui") : null;
}

/** The checkout root, walking up from this module to the package.json. */
function checkoutRoot(): string | null {
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

/** `awui desktop [args]`: start the app and return; it outlives this command. */
export async function runDesktop(opts: { args: string[]; stateDir: string }): Promise<void> {
  const home = os.homedir();
  if (!home) throw new ChatError(500, "no_home", "$HOME is not set");
  const bundled = await bundledDesktop(process.execPath, opts.stateDir, embeddedVersion ?? "dev");
  const launch = findDesktop({ root: checkoutRoot(), home, bundled });
  if (!launch) {
    throw new ChatError(
      500,
      "no_desktop",
      "the desktop app is not installed, and this awui does not carry one. Build it with `cd apps/desktop && npm ci && npm run dist:linux && awui install desktop`, or build awui with `--with-desktop` (see apps/desktop/README.md).",
    );
  }
  if (process.platform === "linux") {
    await launchExclusive(opts.stateDir, opts.args, () => spawnOrphan(launch.command, [...launch.args, ...opts.args]));
    console.log(`awui desktop: ${launch.command} (${launch.how})`);
    return;
  }
  const child = spawn(launch.command, [...launch.args, ...opts.args], { detached: true, stdio: "ignore", windowsHide: true });
  const failed = await new Promise<Error | null>((resolve) => {
    child.once("spawn", () => resolve(null));
    child.once("error", (error) => resolve(error));
  });
  if (failed) throw new ChatError(500, "desktop_failed", `cannot run ${launch.command}: ${failed.message}`);
  child.unref();
  console.log(`awui desktop: ${launch.command} (${launch.how})`);
}

/**
 * Start `command` as a grandchild that this process does not parent, and return its pid.
 * The launcher stays alive until the app registers, and a sandboxing wrapper (NixOS's
 * appimage-run is bubblewrap with --die-with-parent) arms PR_SET_PDEATHSIG against its
 * parent in that window: were that parent this CLI, the app would be killed as it exits.
 */
async function spawnOrphan(command: string, args: string[]): Promise<number> {
  try {
    await fs.access(command, fsConstants.X_OK);
  } catch (error) {
    throw new ChatError(500, "desktop_failed", `cannot run ${command}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const shell = spawn("/bin/sh", ["-c", '"$0" "$@" </dev/null >/dev/null 2>&1 & echo $!', command, ...args], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  shell.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
  const failed = await new Promise<Error | null>((resolve) => {
    shell.once("error", (error) => resolve(error));
    shell.once("close", () => resolve(null));
  });
  const pid = Number(out.trim());
  if (failed || !Number.isSafeInteger(pid) || pid <= 0) throw new ChatError(500, "desktop_failed", `cannot run ${command}: ${failed?.message ?? "no process started"}`);
  return pid;
}

/** Show the desktop command and the artifact it will select, without launching it. */
export async function desktopHelp(opts: { stateDir: string }): Promise<void> {
  console.log(`Usage:
  awui desktop                  Launch the optional app (or start a server for it)
  awui desktop --install-icon   Add the application-menu entry and icon
  awui desktop --help           Show this help
  awui install desktop         Install the awui-desktop command
  npm run build:desktop         Build the server and its packaged app automatically`);
  const bundled = await bundledDesktop(process.execPath, opts.stateDir, embeddedVersion ?? "dev");
  const launch = findDesktop({ root: checkoutRoot(), home: os.homedir(), bundled });
  if (launch) console.log(`App: ${launch.command} (${launch.how})`);
  else console.log("No desktop app is currently selected. Run `npm run build:desktop` first.");
}

/** `awui install desktop`: link the app this binary carries, or the one a checkout built, as `awui-desktop`. */
export async function installDesktop(opts: { stateDir: string }): Promise<void> {
  const platform = process.platform;
  if (platform === "win32") {
    // The Windows build ships an NSIS installer; a link in ~/.local/bin is not how Windows starts apps.
    throw new ChatError(500, "no_desktop_windows", "on Windows, run the awui desktop installer from `npm run dist:win`");
  }
  const home = os.homedir();
  if (!home) throw new ChatError(500, "no_home", "$HOME is not set");

  // A binary that carries the app installs that one; a checkout installs what it built.
  const bundled = await bundledDesktop(process.execPath, opts.stateDir, embeddedVersion ?? "dev");
  let target = bundled ?? "";
  if (!target) {
    const root = checkoutRoot();
    const release = root ? path.join(root, "apps", "desktop", "release") : "";
    if (!root || !existsSync(release)) {
      throw new ChatError(500, "no_desktop_build", "no desktop build to install: run `cd apps/desktop && npm ci && npm run dist:linux` first");
    }
    const artifact = chooseArtifact(await fs.readdir(release), platform);
    target = artifact ? path.join(release, artifact) : "";
    if (!target || !existsSync(target)) {
      throw new ChatError(500, "no_desktop_build", `no app in ${release}: run \`npm run dist\` in apps/desktop first`);
    }
  }

  const file = desktopLink(home, platform);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.rm(tmp, { force: true });
  await fs.symlink(target, tmp);
  await fs.rename(tmp, file);
  console.log(`awui-desktop installed at ${file} → ${target}; run it with \`awui desktop\` (or \`awui-desktop\`).`);
}

/** Where the application-menu entry and its icon go: $XDG_DATA_HOME (or ~/.local/share). */
export function desktopIconPaths(home: string, env: NodeJS.ProcessEnv = process.env): { entry: string; icon: string } {
  const data = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return {
    entry: path.join(data, "applications", "awui.desktop"),
    icon: path.join(data, "icons", "hicolor", "512x512", "apps", "awui.png"),
  };
}

/**
 * One argument as a desktop entry's `Exec` wants it: bare when the spec's
 * reserved characters are absent, else double-quoted with `"`, backtick, `$` and
 * `\` escaped (the spec's own quoting rules, which are not a shell's).
 */
export function execArg(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["`$\\])/g, "\\$1")}"`;
}

/**
 * The command a menu entry runs. A desktop entry looks a bare executable name up
 * in the launcher session's `$PATH` (Desktop Entry Specification, "The Exec
 * key"), so when that `awui` is this very binary the bare name is both correct
 * and stable — the entry survives the binary moving. Otherwise the absolute path
 * is used: it always names the binary that wrote the entry.
 */
export function menuCommand(absolute: string[], onPathAwui: string | null, same: (a: string, b: string) => boolean = sameFile): string[] {
  if (onPathAwui && absolute[0] && same(onPathAwui, absolute[0])) return ["awui", ...absolute.slice(1)];
  return absolute;
}

/** Two paths naming the same file (symlinks resolved). */
export function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** The `.desktop` file: one launcher entry that runs `exec`. */
export function desktopEntry(exec: string[]): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=awui",
    "GenericName=Coding agent UI",
    "Comment=A local, private web UI for Pi, omp, Hermes, Claude Code, OpenCode, Grok Build and DSH",
    `Exec=${exec.map(execArg).join(" ")}`,
    "Icon=awui",
    "Terminal=false",
    "Categories=Development;Utility;",
    // The scheme the packaged app registers, so a awui:// link in a browser or a
    // chat opens through this entry (`Exec` carries %u).
    "MimeType=x-scheme-handler/awui;",
    // The --class the app sets before Chromium starts, so the desktop links the
    // running window to this entry instead of showing a second, unnamed app.
    "StartupWMClass=awui-desktop",
    "Keywords=agent;ai;chat;claude;codex;pi;omp;hermes;opencode;grok;",
    "",
  ].join("\n");
}

/** The app's icon: the web bundle's own PNG, embedded in a binary or read from a checkout. */
async function iconPng(): Promise<Buffer> {
  const embedded = embeddedWeb()?.get("/icon-512.png")?.text;
  if (embedded) return Buffer.isBuffer(embedded) ? embedded : Buffer.from(embedded);
  const root = checkoutRoot();
  const file = root ? path.join(root, "src", "web", "public", "icon-512.png") : "";
  if (file && existsSync(file)) return fs.readFile(file);
  throw new ChatError(500, "no_icon", "no icon to install: this build carries none");
}

/** `awui desktop --install-icon`: add the app to the application menu. */
export async function installDesktopIcon(opts: { stateDir: string }): Promise<void> {
  if (process.platform === "win32") {
    throw new ChatError(500, "no_menu_windows", "the Windows installer adds the Start menu entry; `awui desktop --install-icon` is for XDG desktops");
  }
  if (process.platform === "darwin") {
    throw new ChatError(500, "no_menu_mac", "macOS reads the icon from the .app bundle; `awui desktop --install-icon` is for XDG desktops");
  }
  const home = os.homedir();
  if (!home) throw new ChatError(500, "no_home", "$HOME is not set");

  const bundled = await bundledDesktop(process.execPath, opts.stateDir, embeddedVersion ?? "dev");
  const launch = findDesktop({ root: checkoutRoot(), home, bundled });
  if (!launch) {
    throw new ChatError(500, "no_desktop", "no desktop app to point the menu entry at: build awui with `npm run build:desktop`, or `awui install desktop`");
  }
  // A binary that carries the app is the entry's command, so the launcher keeps
  // working wherever the binary lives (it extracts the app again if it must).
  const absolute = launch.how === "bundled with this awui" ? [process.execPath, "desktop", "%u"] : [launch.command, ...launch.args, "%u"];
  const exec = menuCommand(absolute, onPath("awui", process.env));

  const { entry, icon } = desktopIconPaths(home);
  const png = await iconPng();
  await fs.mkdir(path.dirname(icon), { recursive: true });
  await fs.writeFile(icon, png);
  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.writeFile(entry, desktopEntry(exec), { mode: 0o644 });
  console.log(`awui is in the application menu: ${entry}\n  icon: ${icon}\n  runs: ${exec.map(execArg).join(" ")}`);
}
