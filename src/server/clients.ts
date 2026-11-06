// The terminal clients behind the awui command: `awui tui` (or the binary run
// as `atui`, through a symlink) is atui, and `awui tern` (or `awui --tern`) is
// the Tern client. Both are Bun programs on OpenTUI/Solid. The compiled binary
// carries them, bundled by scripts/build-binary.ts as the `awui:clients`
// module, so a binary needs no Bun and no fetched copy, and its clients always
// match its server. From source (dev, `npm start`) there is no such module:
// the checkout's client runs under Bun, with OpenTUI's Solid transform for
// atui and Solid's reactive build for Tern (--conditions=browser; the default
// Bun picks is Solid's server build, where effects never run).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** A terminal client: atui, or the Tern client. */
export type Client = "atui" | "tern";

/**
 * Which client a command line asks for, and the options it gets: the binary
 * linked as `atui` (any arguments), `awui tui …`, `awui tern …`, or `--tern`
 * anywhere. Null runs something else (the server, a subcommand).
 */
export function clientCommand(args: string[], argv0: string): { client: Client; args: string[] } | null {
  if (path.basename(argv0).replace(/\.exe$/i, "") === "atui") return { client: "atui", args };
  if (args[0] === "tui") return { client: "atui", args: args.slice(1) };
  if (args[0] === "tern") return { client: "tern", args: args.slice(1) };
  if (args.includes("--tern")) return { client: "tern", args: args.filter((a) => a !== "--tern") };
  return null;
}

/** The checkout this module runs from: the nearest folder up with a package.json, or null. */
function checkout(): string | null {
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

/** The client's entry and the Bun options it runs under, in a checkout at `root`. */
export function sourceRun(client: Client, root: string): { entry: string; bunArgs: string[]; needs: string } {
  if (client === "atui") {
    const entry = path.join(root, "src", "atui", "main.tsx");
    return { entry, bunArgs: ["--preload", path.join(root, "node_modules", "@opentui", "solid", "scripts", "preload.js"), entry], needs: path.join("@opentui", "solid") };
  }
  const entry = path.join(root, "src", "tern", "main.ts");
  return { entry, bunArgs: ["--conditions=browser", entry], needs: path.join("@stencil-hq", "tern") };
}

/** The package version for Tern's status strip: the binary's, else the checkout's package.json. */
function versionOf(root: string | null, embedded: string | undefined): string {
  if (embedded) return `v${embedded}`;
  try {
    const pkg = JSON.parse(readFileSync(path.join(root ?? "", "package.json"), "utf8")) as { version?: string };
    return pkg.version ? `v${pkg.version}` : "dev";
  } catch {
    return "dev";
  }
}

/** The command a client is run by, for its messages. */
const named = (client: Client) => (client === "atui" ? "atui" : "awui tern");

/**
 * Run a client in this terminal. In the binary it runs in this process (the
 * client exits it when done); from source it runs under Bun as a child, and
 * this process exits with its status.
 */
export async function runClient(client: Client, args: string[], embedded: { binary: boolean; version: string | undefined }): Promise<void> {
  const root = embedded.binary ? null : checkout();
  process.env.AWUI_VERSION ??= versionOf(root, embedded.version);
  if (embedded.binary) {
    const clients = await import("awui:clients");
    await clients[client](args);
    return;
  }
  if (!root) {
    console.error(`${named(client)}: cannot locate the awui checkout`);
    process.exit(1);
  }
  const run = sourceRun(client, root);
  if (!existsSync(path.join(root, "node_modules", run.needs))) {
    console.error(`${named(client)}: ${root} has no node_modules/${run.needs}; run \`npm ci\` there`);
    process.exit(1);
  }
  const bun = spawnSync("bun", ["--version"], { stdio: "ignore" });
  if (bun.error || bun.status !== 0) {
    console.error(`${named(client)} from source needs Bun (1.3.14 or later): https://bun.sh (the compiled awui binary carries it)`);
    process.exit(1);
  }
  const child = spawnSync("bun", [...run.bunArgs, ...args], { stdio: "inherit", cwd: process.cwd(), env: process.env });
  if (child.error) {
    console.error(`${named(client)}: ${child.error.message}`);
    process.exit(1);
  }
  process.exit(child.status ?? 1);
}
