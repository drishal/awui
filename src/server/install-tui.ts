// `awui install tui`: put the `atui` command on the user's PATH
// (~/.local/bin/atui). The compiled binary carries atui (see clients.ts), so
// the command is a symlink to it: run as `atui`, the binary is atui. From a
// checkout it links the checkout's bin/atui, which runs the source under Bun.
// `install service` makes the same link beside the binary it installs.
import { existsSync, promises as fs, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChatError } from "./chats/chat.js";
import { isEmbedded } from "./embedded.js";

/**
 * What ~/.local/bin/atui links to: `awui` beside it when that is this very
 * binary (so a reinstalled awui is the new atui too), else this binary, else
 * the checkout's bin/atui.
 */
export function atuiTarget(bin: string, execPath: string, embedded: boolean, checkoutRoot: () => string): string {
  if (!embedded) return path.join(checkoutRoot(), "bin", "atui");
  const sibling = path.join(bin, "awui");
  try {
    if (realpathSync(sibling) === realpathSync(execPath)) return "awui";
  } catch {
    // No awui beside it: link the binary where it is.
  }
  return execPath;
}

/** Make `bin`/atui a symlink to `target`, replacing what was there (a link, or the old Bun wrapper script) in one rename. */
export async function linkAtui(bin: string, target: string): Promise<string> {
  const file = path.join(bin, "atui");
  await fs.mkdir(bin, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.rm(tmp, { force: true });
  await fs.symlink(target, tmp);
  await fs.rename(tmp, file);
  return file;
}

/** The checkout root, walking up from this module to the package.json. */
function checkoutRoot(): string {
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    if (path.dirname(dir) === dir) throw new ChatError(500, "no_root", "cannot locate the awui package root");
  }
}

export async function installTui(stateDir: string): Promise<void> {
  if (process.platform === "win32") {
    // A file symlink needs Developer Mode or admin on Windows; the binary's own subcommand needs neither.
    throw new ChatError(500, "no_atui_windows", "on Windows, run atui as `awui tui` (an `atui` link needs Developer Mode or admin)");
  }
  const home = os.homedir();
  if (!home) throw new ChatError(500, "no_home", "$HOME is not set");
  const bin = path.join(home, ".local", "bin");
  const file = await linkAtui(bin, atuiTarget(bin, process.execPath, isEmbedded, checkoutRoot));
  // Earlier binaries fetched atui's source and packages into the state folder for a Bun wrapper; nothing runs that copy now.
  const fetched = path.join(stateDir, "atui");
  if (existsSync(path.join(fetched, "src", "atui", "main.tsx"))) {
    await fs.rm(fetched, { recursive: true, force: true });
    console.log(`removed the old fetched atui copy at ${fetched}`);
  }
  console.log(`atui installed at ${file}; run it with \`atui\` (or \`awui tui\`; in a Tern pane, \`awui tern\`).`);
}
