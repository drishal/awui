// `awui install service`: install the binary onto the PATH (~/.local/bin) and a
// systemd user unit that runs it, so awui starts with the session. The binary is
// copied by default; with --link it is symlinked instead (a dev checkout, where a
// rebuild should be live without reinstalling). The unit's Restart=always and the
// 78 exit-code carve-out match the source-run service (see contrib/systemd).
import { execFileSync } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChatError } from "./chats/chat.js";
import { isEmbedded } from "./embedded.js";

const UNIT_NAME = "awui.service";
const BIN_NAME = "awui";

/**
 * Which file `install service` puts on the PATH. The compiled binary is itself, so
 * process.execPath is the answer there. A source run is node — `bin/awui` execs node
 * on dist/server/server/index.js — and node is not awui: a unit running it starts a
 * REPL, takes EOF on /dev/null stdin, and restarts every RestartSec. So a source run
 * installs the binary the build wrote instead. `builtPath` is a thunk because only a
 * source run has a checkout to look in: the binary's own module URL is a bunfs path
 * with nothing above it.
 */
export function selfToInstall(execPath: string, embedded: boolean, builtPath: () => string): string {
  if (embedded) return execPath;
  const file = builtPath();
  if (existsSync(file)) return file;
  throw new ChatError(500, "no_binary", `cannot install: no compiled awui at ${file}; build it with \`bun run scripts/build-binary.ts\``);
}

/** Where scripts/build-binary.ts writes the binary for a platform and arch (awui.exe on Windows). */
export function builtBinaryPath(root: string, platform: string = process.platform, arch: string = process.arch): string {
  return path.join(root, "dist", "bin", `${platform}-${arch}`, platform === "win32" ? `${BIN_NAME}.exe` : BIN_NAME);
}

/** The checkout root, found by walking up to the package.json the way the extension finders do. */
function repoRoot(): string {
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    if (path.dirname(dir) === dir) throw new ChatError(500, "no_root", "cannot locate the awui package root");
  }
}

/** Where awui installs itself: the user's bin and the user systemd dir. */
function installPaths(): { bin: string; binPath: string; unitDir: string; unitPath: string } {
  const home = os.homedir();
  if (!home) throw new ChatError(500, "no_home", "$HOME is not set");
  const bin = path.join(home, ".local", "bin");
  const binPath = path.join(bin, BIN_NAME);
  const unitDir = path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "systemd", "user");
  return { bin, binPath, unitDir, unitPath: path.join(unitDir, UNIT_NAME) };
}

/** Where awui installs itself on Windows: the standard per-user Programs dir. */
function windowsPaths(): { bin: string; binPath: string } {
  const home = os.homedir();
  if (!home) throw new ChatError(500, "no_home", "$HOME is not set");
  const bin = path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Programs", "awui");
  return { bin, binPath: path.join(bin, `${BIN_NAME}.exe`) };
}

/** systemd reads % as a specifier and " as quoting: escape both inside quoted values. */
const unitValue = (s: string): string => s.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** The service unit for a binary at `binPath`, with the shell's PATH so the agents resolve. */
function unitFor(binPath: string, pathEnv: string): string {
  const entries = pathEnv.split(":").filter((p) => p && !/[/\\]node_modules[/\\]\.bin$/.test(p));
  const pathVal = [...new Set(entries)].join(":");
  return `[Unit]
Description=awui: the web UI for Pi, omp, Hermes, and Claude Code
After=network.target

[Service]
ExecStart=${unitValue(binPath)}
# The shell's PATH when installed, so pi, omp, hermes, claude, and the agents' own tools are found.
Environment="PATH=${unitValue(pathVal)}"
Restart=always
RestartSec=5
RestartPreventExitStatus=78

[Install]
WantedBy=default.target
`;
}

/** The legacy unit (the pre-rename node-run service): installing awui's binary retires it. */
const OLD_UNIT_NAME = "agent-web-ui.service";

/**
 * Windows install: copy awui.exe into the standard per-user Programs dir
 * (%LOCALAPPDATA%\Programs\awui), put that dir on the user's PATH so `awui`
 * runs from any terminal, and register the per-user Registry Run key so awui
 * starts at logon. The whole thing needs no admin and survives an SSH session.
 *
 * PATH goes through the Registry (HKCU\Environment), the way t3code's CLI
 * installer does it: read the current value back base64-encoded and only write
 * a changed one, keep REG_EXPAND_SZ so %VAR% entries survive, and broadcast
 * WM_SETTINGCHANGE so the new PATH is live without a re-login. A Scheduled
 * Task would be the systemd-timer analog, but creating one needs a full
 * interactive token Windows denies an SSH/WinRM session; `reg add` on HKCU
 * always works for the signed-in user.
 */
const WINDOWS_PATH_SCRIPT = `
$ErrorActionPreference = 'Stop'
if ($env:AWUI_SET -eq '1') {
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
  if ($key.GetValueNames() -contains 'Path' -and $key.GetValueKind('Path') -eq 'String') {
    $kind = [Microsoft.Win32.RegistryValueKind]::String
  }
  $key.SetValue('Path', $env:AWUI_PATH, $kind)
  Add-Type -Namespace A -Name E -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);'
  $r = [System.UIntPtr]::Zero
  [void][A.E]::SendMessageTimeout([System.IntPtr]0xffff, 0x1A, [System.UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)
} else {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
  $value = if ($key) { $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames') } else { '' }
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$value)))
}
`;

/**
 * Read the raw user PATH from HKCU\Environment: "" when there is none, null when it
 * could not be read. The two differ on purpose: a PATH written back after a failed
 * read would hold only awui's folder, and every other entry would be gone.
 */
function readUserPathWindows(): string | null {
  try {
    const out = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PATH_SCRIPT], { env: { ...process.env }, encoding: "buffer" });
    return Buffer.from(out.toString("utf8").trim(), "base64").toString("utf8");
  } catch {
    return null;
  }
}

/** Set the user PATH in HKCU\Environment and broadcast the change. */
function setUserPathWindows(value: string): void {
  execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PATH_SCRIPT], {
    env: { ...process.env, AWUI_SET: "1", AWUI_PATH: value },
    stdio: "inherit",
  });
}

async function installWindows(opts: { link: boolean }): Promise<void> {
  const self = selfToInstall(process.execPath, isEmbedded, () => builtBinaryPath(repoRoot()));
  // On Windows a file symlink needs Developer Mode or admin (a directory
  // junction can't link an exe), so there is no live-rebuild link install.
  // A dev checkout re-runs `install service` after a build: the copy below
  // overwrites the installed exe and the Run key keeps pointing at it.
  if (opts.link) console.warn("awui: --link has no effect on Windows; re-run `install service` after a rebuild instead.");
  const { bin, binPath } = windowsPaths();

  await fs.mkdir(bin, { recursive: true });
  // Windows locks a running exe, so write to a temp file and rename over it.
  const tmp = `${binPath}.${process.pid}.tmp`;
  await fs.copyFile(self, tmp);
  await fs.rename(tmp, binPath);

  // PATH: append the install dir unless it is already there (case-insensitive).
  const existing = readUserPathWindows();
  const entries = (existing ?? "").split(";").filter((e) => e.length > 0);
  const has = entries.some((e) => e.replace(/[\\/]+$/, "").toLowerCase() === bin.replace(/[\\/]+$/, "").toLowerCase());
  if (existing === null) {
    // Unread, the PATH is left alone: writing one back would drop every entry it had.
    console.warn(`awui: could not read the user PATH, so it was left as it is; add ${bin} to it yourself to run \`awui\` from a terminal`);
  } else if (!has) {
    setUserPathWindows([...entries, bin].join(";"));
    console.log(`added ${bin} to the user PATH (open a new terminal to pick it up)`);
  }

  const key = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`;
  try {
    execFileSync("reg.exe", ["add", key, "/v", "awui", "/t", "REG_SZ", "/d", `"${binPath}"`, "/f"], { stdio: "inherit" });
    console.log(`awui installed: ${binPath} (on PATH, starts at logon as ${os.userInfo().username})`);
    console.log(`remove autostart with: reg delete ${key} /v awui`);
  } catch (error) {
    throw new ChatError(500, "autostart_failed", `installed ${binPath} but could not set the Run key: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Install awui at binPath (copy, or symlink when link=true), write the unit,
 * daemon-reload, and enable+start it. Which file gets installed is selfToInstall's
 * decision, so `bin/awui install service` from a checkout installs the built binary
 * rather than node. A leftover agent-web-ui.service from the old name is disabled
 * first, so the two do not fight over the port.
 */
export async function installService(opts: { link: boolean }): Promise<void> {
  if (process.platform === "win32") {
    // systemd has no Windows port: install to Programs + PATH + the Run key.
    await installWindows(opts);
    return;
  }
  const { bin, binPath, unitDir, unitPath } = installPaths();
  const oldUnitPath = path.join(unitDir, OLD_UNIT_NAME);
  if (existsSync(oldUnitPath)) {
    try {
      execFileSync("systemctl", ["--user", "disable", "--now", OLD_UNIT_NAME], { stdio: "inherit" });
    } catch {
      // Not loaded or not running: fine, the file is removed below either way.
    }
    await fs.rm(oldUnitPath, { force: true });
    console.log(`retired legacy ${OLD_UNIT_NAME}`);
  }
  const self = selfToInstall(process.execPath, isEmbedded, () => builtBinaryPath(repoRoot()));
  await fs.mkdir(bin, { recursive: true, mode: 0o700 });
  if (opts.link) {
    await fs.rm(binPath, { force: true });
    await fs.symlink(self, binPath);
  } else {
    const tmp = `${binPath}.${process.pid}.tmp`;
    await fs.copyFile(self, tmp);
    await fs.chmod(tmp, 0o755);
    await fs.rename(tmp, binPath);
  }
  await fs.mkdir(unitDir, { recursive: true, mode: 0o700 });
  const unit = unitFor(binPath, process.env.PATH ?? "");
  const tmpUnit = `${unitPath}.${process.pid}.tmp`;
  await fs.writeFile(tmpUnit, unit, { mode: 0o644 });
  await fs.rename(tmpUnit, unitPath);
  // Enable + start; tolerable failures are surfaced, not fatal (systemd may be absent).
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    execFileSync("systemctl", ["--user", "enable", "--now", UNIT_NAME], { stdio: "inherit" });
    console.log(`awui installed: ${binPath} → ${unitPath} (enabled, started)`);
  } catch (error) {
    throw new ChatError(500, "systemd_failed", `wrote ${unitPath} and ${binPath} but systemd failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
