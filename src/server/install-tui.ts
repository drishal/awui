// `awui install tui`: the terminal client is a Bun/OpenTUI script, so it cannot
// ride in the binary; this fetches the atui source (the build's pinned commit,
// or the repo's default branch from source) into the state folder and drops an
// `atui` wrapper on the user's PATH (~/.local/bin). The wrapper runs the cached
// copy directly.
import { spawnSync } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatError } from "./chats/chat.js";

// The build's `define` constants; undefined outside the binary.
declare const AWUI_REPO: string | undefined;
declare const AWUI_COMMIT: string | undefined;

const DEFAULT_REPO = "github.com/drishal/awui";
const ATUI_MAIN = path.join("src", "atui", "main.tsx");
const TERN_MAIN = path.join("src", "tern", "main.ts");
const ATUI_PRELOAD = path.join("node_modules", "@opentui", "solid", "scripts", "preload.js");

export async function installTui(stateDir: string): Promise<void> {
  if (process.platform === "win32") {
    // The wrapper is a #!/bin/sh script in ~/.local/bin, which Windows cannot
    // run. atui is for a terminal anyway; run it from a POSIX shell (WSL,
    // Git Bash) or a Linux host pointed at this server.
    throw new ChatError(500, "no_atui_windows", "atui's launcher is a Unix shell script. On Windows run atui under WSL/Git Bash, or use the web UI.");
  }
  const home = os.homedir();
  if (!home) throw new ChatError(500, "no_home", "$HOME is not set");
  const bin = spawnSync("bun", ["--version"], { stdio: "ignore" });
  if (bin.error || bin.status !== 0) {
    throw new ChatError(500, "no_bun", "atui needs Bun (1.3.14 or later): https://bun.sh");
  }
  const atuiDir = path.join(stateDir, "atui");
  const mainFile = path.join(atuiDir, ATUI_MAIN);
  // A copy fetched before the Tern client existed is fetched again, so `awui tern` finds it (and its packages).
  if (!existsSync(mainFile) || !existsSync(path.join(atuiDir, TERN_MAIN))) {
    await fs.mkdir(atuiDir, { recursive: true, mode: 0o700 });
    const ref = typeof AWUI_COMMIT !== "undefined" ? AWUI_COMMIT : "main";
    const repo = typeof AWUI_REPO !== "undefined" && AWUI_REPO ? AWUI_REPO : DEFAULT_REPO;
    const host = repo.startsWith("http") ? repo : `https://${repo.replace(/\.git$/, "")}`;
    const url = `${host}/archive/${ref}.tar.gz`;
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new ChatError(502, "fetch_failed", `could not fetch the atui source (${url}: HTTP ${res.status})`);
    const tmp = path.join(atuiDir, "atui.tar.gz");
    await fs.writeFile(tmp, Buffer.from(await res.arrayBuffer()), { mode: 0o600 });
    const untar = spawnSync("tar", ["-xzf", tmp, "--strip-components=1", "-C", atuiDir], { stdio: "inherit" });
    await fs.rm(tmp, { force: true });
    if (untar.status !== 0) throw new ChatError(500, "untar_failed", "could not unpack the atui source");
    const install = spawnSync("bun", ["install", "--no-save"], { cwd: atuiDir, stdio: "inherit" });
    if (install.status !== 0) throw new ChatError(500, "deps_failed", "could not install atui's dependencies");
  }
  const binPath = path.join(home, ".local", "bin", "atui");
  await fs.mkdir(path.dirname(binPath), { recursive: true, mode: 0o700 });
  const preload = path.join(atuiDir, ATUI_PRELOAD);
  await fs.writeFile(
    binPath,
    `#!/bin/sh\nexec bun --preload "${preload.replace(/"/g, '\\"')}" "${mainFile.replace(/"/g, '\\"')}" "$@"\n`,
    { mode: 0o755 },
  );
  console.log(`atui installed at ${binPath}; run it with \`atui\` (in a Tern pane, \`awui tern\` draws awui natively).`);
}
