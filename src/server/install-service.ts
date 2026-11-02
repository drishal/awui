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
 * Windows autostart: the per-user Registry Run key
 * (HKCU\Software\Microsoft\Windows\CurrentVersion\Run), the standard way a
 * per-user program starts at logon without admin. A Scheduled Task would be
 * the systemd-timer analog, but both it and the ScheduledTasks cmdlets need a
 * full interactive token — over an SSH/WinRM session Windows denies them —
 * whereas `reg add` on HKCU always works for the signed-in user. The value
 * points straight at awui.exe; the harnesses pi/omp/claude resolve through
 * their own PATH in the logon session's environment.
 */
async function installAutostartWindows(): Promise<void> {
  const exe = selfToInstall(process.execPath, isEmbedded, () => builtBinaryPath(repoRoot()));
  const key = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`;
  try {
    execFileSync("reg.exe", ["add", key, "/v", "awui", "/t", "REG_SZ", "/d", `"${exe}"`, "/f"], { stdio: "inherit" });
    console.log(`awui autostart installed (run key, starts at logon as ${os.userInfo().username}): ${exe}`);
    console.log(`remove with: reg delete ${key} /v awui`);
  } catch (error) {
    throw new ChatError(500, "autostart_failed", `could not set the Run key: ${error instanceof Error ? error.message : String(error)}`);
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
    // systemd has no Windows port; autostart there is a per-user logon task.
    await installAutostartWindows();
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
