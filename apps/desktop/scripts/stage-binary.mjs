// Copies this platform's awui binary into the desktop app's resources, so the
// packaged app can start a server of its own instead of needing one installed.
// A missing binary is not fatal: the app then attaches to an awui already
// running (or one on the PATH) — the "light" shape.
//
// The binary is staged *without* the desktop payload: `npm run build:desktop`
// leaves a binary that carries this very app, and packaging that would nest the
// app inside itself (a 169 MB AppImage becoming 322 MB, and so on). The server
// the app starts never needs the payload — only the CLI does.
import { cp, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const repo = path.resolve(appDir, "../..");
const name = process.platform === "win32" ? "awui.exe" : "awui";
const from = path.join(repo, "dist", "bin", `${process.platform}-${process.arch}`, name);
const to = path.join(appDir, "resources", name);

/** The footer src/server/desktop-embed.ts writes: [length u64 LE][AWUIDESK01]. */
const MAGIC = "AWUIDESK01";
const FOOTER = 8 + MAGIC.length;

if (!existsSync(from)) {
  console.warn(`awui-desktop: no binary at ${from} — packaging a light app that attaches to an installed awui.\n  Build one first: npm run build:binary`);
  process.exit(0);
}

/** How many bytes of `file` are the executable — i.e. without a desktop payload. */
async function bareLength(file) {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    if (size < FOOTER) return size;
    const footer = Buffer.alloc(FOOTER);
    await handle.read(footer, 0, FOOTER, size - FOOTER);
    if (footer.subarray(8).toString("utf8") !== MAGIC) return size;
    const payload = Number(footer.readBigUInt64LE(0));
    const start = size - FOOTER - payload;
    return payload > 0 && start > 0 ? start : size;
  } finally {
    await handle.close();
  }
}

await mkdir(path.dirname(to), { recursive: true });
const bytes = await readFile(from);
const bare = await bareLength(from);
await mkdir(path.dirname(to), { recursive: true });
const content = bare < bytes.length ? bytes.subarray(0, bare) : bytes;
// A foreground running app-server on Linux keeps its executable mapped, making
// copyFile/truncate unportable across package rebuilds. Rename the finished copy
// over its inode instead; existing children retain it, later starts use the new one.
const temporary = `${to}.${process.pid}.tmp`;
await writeFile(temporary, content, { mode: 0o755 });
await open(temporary, "r").then((handle) => handle.sync().finally(() => handle.close()));
await rename(temporary, to);
console.log(`awui-desktop: staged ${from} → resources/${name}${bare < bytes.length ? ` (payload stripped, ${(bare / 1_048_576).toFixed(0)} MB)` : ""}`);

// src/server/binary-runtime.ts resolves CommonJS providers beside this exact
// server executable. The root build's sibling node_modules is not inherited by
// the unpacked Electron app, nor by any AppImage extracted outside this repo.
const provider = path.join(repo, "node_modules", "playwright-core");
if (!existsSync(provider)) throw new Error("awui-desktop: required playwright-core provider is missing; run npm ci at the repository root");
await cp(provider, path.join(appDir, "resources", "node_modules", "playwright-core"), {
  recursive: true,
  filter: (source) => !source.split(path.sep).includes("vite"),
});
