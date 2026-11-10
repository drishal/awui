// Builds the self-contained `awui` binary: the dist server plus the built web
// bundle, the harness extension sources, and both terminal clients (atui and
// Tern, the `awui:clients` module), embedded, compiled to a native executable
// per target with `bun build --compile`.
//
//   bun run scripts/build-binary.ts            # this machine's platform
//   bun run scripts/build-binary.ts --all      # every target (CI/release)
//   bun run scripts/build-binary.ts --with-desktop             # carry the packaged app
//   bun run scripts/build-binary.ts --with-desktop --electron  # package it from source first
//
// When ~/.local/bin exists, the built binary for this machine is linked there as
// `awui`, so `npm run build:binary` leaves a runnable command on the PATH. Only a
// link into this checkout's dist/ is replaced; a file or a link elsewhere is the
// user's and is left alone. `--no-link` (or AWUI_NO_LINK=1, or CI) skips it.
//
// Pipeline: `npm run build` (dist/server + dist/web), bundle the clients, generate
// the embedded asset module, then compile. The generated module's import runs
// registerEmbeddedAssets() at startup, so the server serves the web bundle from
// memory and materializes the extension sources into the state folder on first
// run of a harness chat. The clients bundle rides in as the `awui:clients` module:
// `awui tui` and `awui tern` (src/server/clients.ts) import it, so a binary needs
// no Bun and no fetched copy, and its clients always match its server.
import { $, type CompileTarget } from "bun";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, cp, lstat, mkdir, readdir, readFile, readlink, rename, rm, stat, symlink } from "node:fs/promises";
// The footer the runtime looks for (src/server/desktop-embed.ts): one definition,
// so the build and the reader cannot drift.
import { DESKTOP_MAGIC } from "../src/server/desktop-embed.ts";
// Static, by file: the package's "./bun-plugin" export map does not resolve under
// Bun (its "types" condition first), and this script runs under `bun run` only
// (the plugin's node build throws on Bun.build), so the file path is safe.
import { createSolidTransformPlugin } from "../node_modules/@opentui/solid/scripts/solid-plugin.js";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
process.chdir(root);

const ALL = process.argv.includes("--all");

/** A build flag from argv, or npm's own form of it: `npm run build:desktop --electron` reaches the script as npm_config_electron=true, not as an argument. */
function flag(name: string): boolean {
  const env = process.env[`npm_config_${name.replace(/-/g, "_")}`];
  return process.argv.includes(`--${name}`) || (env !== undefined && env !== "" && env !== "false" && env !== "0");
}

/**
 * `--electron` (`npm run build:desktop --electron`): force a desktop app package
 * from current source before embedding it. Normal cached-artifact validation uses
 * desktop src/assets/scripts/packaging fingerprints recorded with that artifact;
 * otherwise the app is rebuilt automatically rather than reusing stale shell code.
 * Implies `--with-desktop`: there is no reason to package the app and not carry it.
 */
const ELECTRON = flag("electron");
/**
 * `--with-desktop` (`npm run build:desktop`): append the packaged desktop app to
 * this platform's binary, so `awui desktop` needs no separate download or build.
 * The payload sits after the executable image — [payload][length u64 LE][magic] —
 * where a loader ignores it (an AppImage's own trick) and
 * src/server/desktop-embed.ts finds it again.
 */
const WITH_DESKTOP = ELECTRON || flag("with-desktop");
if (WITH_DESKTOP && ALL) {
  console.error("--with-desktop builds this platform's app into this platform's binary; it cannot ride in --all's cross-compiled ones");
  process.exit(64);
}

/** A packaged AppImage if there is one, otherwise the build step creates it. */
async function desktopPayload(): Promise<string | null> {
  if (process.platform !== "linux") {
    throw new Error(`--with-desktop needs a single-file desktop build; only the Linux AppImage is packaged as one so far (this is ${process.platform})`);
  }
  const release = path.join(root, "apps", "desktop", "release");
  const images = existsSync(release) ? (await readdir(release)).filter((f) => f.endsWith(".AppImage")).sort() : [];
  const image = images.at(-1);
  return image ? path.join(release, image) : null;
}

/** The packaging script apps/desktop has for this platform. */
function desktopDistScript(): string {
  const script = ({ linux: "dist:linux", darwin: "dist:mac", win32: "dist:win" } as Record<string, string | undefined>)[process.platform];
  if (!script) throw new Error(`no desktop packaging script for ${process.platform}`);
  return script;
}

/**
 * `--electron` packages from apps/desktop, so its own toolchain (electron-builder,
 * which npm ci there installs) has to be present. Checked before the server build,
 * so a missing one fails in a second instead of after a minute of compiling.
 */
async function requireDesktopCheckout(): Promise<void> {
  const bin = path.join(root, "apps", "desktop", "node_modules", ".bin", "electron-builder");
  if (!existsSync(bin)) {
    console.log("apps/desktop lacks electron-builder; installing its pinned toolchain");
    await $`npm --prefix apps/desktop ci`;
  }
  if (!existsSync(bin)) throw new Error("apps/desktop could not install its pinned electron-builder toolchain");
}

async function filesUnder(directory: string): Promise<string[]> {
  if (!existsSync(directory)) return [];
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(file));
    else if (entry.isFile()) result.push(file);
  }
  return result.sort();
}

/** Changes to the shell, not just the binary's embedded web bundle, invalidate its AppImage. */
async function desktopSourceFingerprint(): Promise<string> {
  const base = path.join(root, "apps", "desktop");
  const files = [
    ...await filesUnder(path.join(base, "src")),
    ...await filesUnder(path.join(base, "assets")),
    ...await filesUnder(path.join(base, "scripts")),
    ...["package.json", "package-lock.json", "electron-builder.yml", "tsconfig.json"].map((file) => path.join(base, file)),
  ];
  const hash = createHash("sha256");
  for (const file of files) {
    if (!existsSync(file)) continue;
    hash.update(path.relative(base, file));
    hash.update(await readFile(file));
  }
  return hash.digest("hex");
}

// Reuse the cached artifact only if the source fingerprint recorded at its
// packaging time matches. Never infer freshness from mtimes (a source checkout
// may be older than a stale binary) or from an equality hashed into itself.
const DESKTOP_PAYLOAD = WITH_DESKTOP && !ELECTRON
  ? await (async () => {
    const artifact = await desktopPayload();
    if (!artifact) return null;
    const recorded = await readFile(path.join(path.dirname(artifact), "source.json"), "utf8")
      .then((body) => (JSON.parse(body) as { fingerprint?: unknown }).fingerprint)
      .catch(() => null);
    if (recorded === await desktopSourceFingerprint()) return artifact;
    console.log("desktop source or packaging settings changed; rebuilding the Electron app");
    return null;
  })().catch((error: unknown) => {
      console.error(`build:desktop: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(64);
    })
  : null;
const BUILD_ELECTRON = ELECTRON || (WITH_DESKTOP && DESKTOP_PAYLOAD === null);
if (BUILD_ELECTRON) {
  try {
    // The app is packaged per platform (dist:mac, dist:win too), but only the Linux
    // AppImage is a single file to carry; say so before a multi-minute package run.
    if (process.platform !== "linux") throw new Error("--electron carries the app inside the binary, and only the Linux AppImage is packaged as one file so far; package this platform's app with `npm --prefix apps/desktop run dist:<platform>` instead");
    await requireDesktopCheckout();
  } catch (error) {
    console.error(`build:desktop: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(64);
  }
}

const DESKTOP_FINGERPRINT = WITH_DESKTOP ? await desktopSourceFingerprint() : null;

// The embeds read from dist/: build the server and web bundle first.
await $`npm run build`;

// The clients bundle: atui and Tern as the `awui:clients` module (src/atui/embed.ts).
// It gets the settings the server must not: OpenTUI's Solid transform for atui, and
// Tern rides whatever `--conditions` the server bundle does not set (Solid's reactive
// build is picked by the client's own `bun --conditions=browser` from source; here the
// bundler resolves the browser conditions directly). The native @opentui/core-<platform>
// packages stay external: the compiled bundle handles each one's with-type-file import
// (the .so/.dll embeds there), and npm's os/cpu gates mean only this platform's package
// is installed — the others are stubs that fail loudly if ever imported.
const NATIVE_PACKAGES = ["@opentui/core-darwin-x64", "@opentui/core-darwin-arm64", "@opentui/core-linux-x64", "@opentui/core-linux-x64-musl", "@opentui/core-linux-arm64", "@opentui/core-linux-arm64-musl", "@opentui/core-win32-x64", "@opentui/core-win32-arm64"];

/** Bundle the terminal clients into dist/clients.js. */
async function bundleClients(): Promise<void> {
  // The native packages npm did not install (other platforms): real stub modules, since
  // Bun.build's onResolve must give the "file" namespace an absolute path.
  const missing = NATIVE_PACKAGES.filter((pkg) => !existsSync(path.join(root, "node_modules", pkg)));
  const stubDir = path.join(root, "dist", "client-stubs");
  await mkdir(stubDir, { recursive: true });
  for (const pkg of missing) {
    const name = pkg.split("/")[1]!;
    await Bun.write(path.join(stubDir, `${name}.js`), `throw new Error("native library for another platform rides in ${pkg}'s package only");\nexport default "";\n`);
  }
  const stubbed = new Set(missing.map((pkg) => pkg.split("/")[1]!));
  const clients = await Bun.build({
    entrypoints: [path.join(root, "src", "atui", "embed.ts")],
    target: "bun",
    format: "esm",
    minify: false,
    sourcemap: "none",
    plugins: [
      createSolidTransformPlugin(),
      {
        name: "client-native-stubs",
        setup(build) {
          for (const pkg of missing) {
            const name = pkg.split("/")[1]!;
            build.onResolve({ filter: new RegExp(`^${pkg.replace(/[-/]/g, "\\$&")}$`) }, () => ({ path: path.join(stubDir, `${name}.js`) }));
          }
        },
      },
    ],
    // Every native package rides external: this platform's so the compiled bundle embeds
    // its library, the stubbed ones so their stubs stay small loader-time failures.
    external: NATIVE_PACKAGES,
  });
  if (!clients.success) throw new Error(`the clients bundle failed: ${clients.logs.slice(0, 5).map(String).join("; ")}`);
  await Bun.write(path.join(root, "dist", "clients.js"), clients.outputs[0]!);
  if (stubbed.size > 0) await rm(stubDir, { recursive: true, force: true });
}

await bundleClients();

/** Append the payload and its footer to a compiled binary, before it is renamed into place. */
async function appendDesktop(binary: string, payload: string): Promise<void> {
  const bytes = await readFile(payload);
  const footer = Buffer.alloc(8 + DESKTOP_MAGIC.length);
  footer.writeBigUInt64LE(BigInt(bytes.length), 0);
  footer.write(DESKTOP_MAGIC, 8, "utf8");
  await appendFile(binary, bytes);
  await appendFile(binary, footer);
  console.log(`  + desktop app ${path.basename(payload)} (${(bytes.length / 1_048_576).toFixed(0)} MB)`);
}
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

/** Recursively collect dist/web into `/`-relative URL paths. */
async function webFiles(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string) => {
    for (const name of await readdir(dir)) {
      const full = path.join(dir, name);
      const st = await stat(full);
      if (st.isDirectory()) await walk(full, `${prefix}${name}/`);
      else out.push(`${prefix}${name}`);
    }
  };
  await walk(path.join(root, "dist", "web"), "/");
  return out.sort();
}

// The extension sources ride in as text; they are written to disk at startup for -e.
const EXTENSIONS = ["rewind-to.ts", "render-html.ts", "render-html-mcp.mjs", "eval-python.ts", "acp-flow.mjs"];

/** The generated module the binary embeds: registers web files and extension sources. */
async function assetModule(): Promise<string> {
  const files = await webFiles();
  const webEntries: string[] = [];
  for (const abs of files) {
    const ext = path.extname(abs);
    // Source maps are huge and the binary has no debugger to read them; skip.
    if (ext === ".map") continue;
    const bytes = await readFile(path.join(root, "dist", "web", abs.slice(1)));
    const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
    // Text assets go as a string; binary (icons, fonts) ride as base64 so bytes survive intact.
    if (contentType.startsWith("text/") || ext === ".json" || ext === ".webmanifest" || ext === ".svg") {
      webEntries.push(`  m.set(${JSON.stringify(abs)}, { text: ${JSON.stringify(bytes.toString("utf8"))}, contentType: ${JSON.stringify(contentType)} });`);
    } else {
      webEntries.push(`  m.set(${JSON.stringify(abs)}, { text: Buffer.from(${JSON.stringify(bytes.toString("base64"))}, "base64"), contentType: ${JSON.stringify(contentType)} });`);
    }
  }
  const extEntries: string[] = [];
  for (const name of EXTENSIONS) {
    const text = await readFile(path.join(root, "extensions", name), "utf8");
    extEntries.push(`  e.set(${JSON.stringify(name)}, ${JSON.stringify(text)});`);
  }
  return [
    `// Generated by scripts/build-binary.ts; the binary embeds it.`,
    `import { registerEmbeddedAssets } from "./embedded.js";`,
    `const m = new Map();`,
    ...webEntries,
    `const e = new Map();`,
    ...extEntries,
    `registerEmbeddedAssets(m, e);`,
  ].join("\n");
}

const assetSource = await assetModule();
const assetPath = path.join(root, "src", "server", "assets.gen.ts");
const stubSource = await readFile(assetPath, "utf8");

const commit = (await $`git rev-parse HEAD`.text()).trim();
const repo = (await $`git remote get-url origin`.text()).trim().replace(/^git@([^:]+):/, "https://$1/").replace(/\.git$/, "");

const targets = ALL
  ? ["bun-linux-x64", "bun-linux-arm64", "bun-darwin-x64", "bun-darwin-arm64", "bun-windows-x64"]
  : [`bun-${process.platform}-${process.arch}`] as const;

// The generated module is the embed payload: write it, then recompile just it into
// dist (the earlier npm build compiled the checked-in stub), so the bundle carries it.
// Inside the try: a failed compile must still put the checked-in stub back, or the
// multi-megabyte generated file is left in src/ to be committed by accident.
try {
  await Bun.write(assetPath, assetSource);
  await $`npx tsc -p tsconfig.server.json`;
  for (const target of targets) {
    const name = target.replace(/^bun-/, "");
    const outDir = path.join(root, "dist", "bin", name);
    await $`mkdir -p ${outDir}`;
    const outfile = path.join(outDir, name.includes("windows") ? "awui.exe" : "awui");
    // Compile to a sibling and rename over the target: the running service's binary is
    // often this very file (the service's symlink points at dist/bin), and a page load
    // mid-compile would read a torn one. rename(2) is atomic on POSIX. Bun appends
    // `.exe` to a Windows target's outfile unless the name already ends with it.
    const staged = name.includes("windows") ? `${outfile}.new.exe` : `${outfile}.new`;
    console.log(`compiling awui ${pkg.version} → ${name}`);
    await Bun.build({
      // Compile the built JS, not the TS source: the bundler already resolved it,
      // and a raw-TS entry plus the generated module hit a bun --compile crash here.
      entrypoints: ["./dist/server/server/index.js"],
      format: "esm",
      minify: true,
      sourcemap: "none",
      target: "bun",
      // The clients bundle rides in as the `awui:clients` module (src/server/clients-module.d.ts);
      // the declared module has no real file, so a resolver hands the import dist/clients.js.
      plugins: [
        {
          name: "awui-clients-module",
          setup(build) {
            build.onResolve({ filter: /^awui:clients$/ }, () => ({ path: path.join(root, "dist", "clients.js") }));
          },
        },
      ],
      external: ["playwright-core"],
      compile: { target: target as CompileTarget, outfile: staged },
      define: {
        AWUI_EMBEDDED: "true",
        AWUI_VERSION: JSON.stringify(pkg.version),
        AWUI_COMMIT: JSON.stringify(commit),
        AWUI_REPO: JSON.stringify(repo),
      },
    });
    if (DESKTOP_PAYLOAD) await appendDesktop(staged, DESKTOP_PAYLOAD);
    // The pinned Chromium backend is external so its ordinary CommonJS loader
    // can resolve lazy transports without bundling their optional dependencies.
    // It downloads nothing here: a preview uses only an installed browser (the
    // devenv Playwright browser, an explicit executable path, or the usual cache).
    await cp(path.join(root, "node_modules", "playwright-core"), path.join(outDir, "node_modules", "playwright-core"), { recursive: true, filter: (source) => !source.split(path.sep).includes("vite") });
    await Bun.$`mv -f ${staged} ${outfile}`;
    console.log(`  → ${outfile}`);
  }
} finally {
  await Bun.write(assetPath, stubSource);
}

// A forced shell build, or a missing/stale/outdated-source AppImage: package it
// now from the current sources. `stage:bin` inside
// it copies the bare binary this run just wrote into the app's resources — the one
// a packaged app starts beside itself when no server is up, so it must be this
// build, not last week's. Then the AppImage it produced rides in the CLI's binary.
const packagedApp = BUILD_ELECTRON;
if (packagedApp) {
  const name = `${process.platform}-${process.arch}`;
  const outfile = path.join(root, "dist", "bin", name, process.platform === "win32" ? "awui.exe" : "awui");
  const script = desktopDistScript();
  console.log(`packaging the desktop app (apps/desktop → ${script}); its resources/awui is the binary just built`);
  await $`npm --prefix apps/desktop run ${script}`;
  await Bun.write(path.join(root, "apps", "desktop", "release", "source.json"), JSON.stringify({ fingerprint: DESKTOP_FINGERPRINT }) + "\n");
  const payload = await desktopPayload();
  if (!payload) throw new Error(`apps/desktop package did not produce an AppImage in apps/desktop/release`);
  // Append to a copy and rename it over: the service's symlink points at this file,
  // and rewriting it in place would hand a restart that lands mid-append a torn
  // executable. rename(2) swaps the finished one in atomically.
  const staged = `${outfile}.new`;
  await $`cp -f ${outfile} ${staged}`;
  await appendDesktop(staged, payload);
  await $`mv -f ${staged} ${outfile}`;
  console.log(`  → ${outfile} carries ${path.basename(payload)}`);
  console.log("  restart the service and relaunch the app to use it: `awui desktop` re-extracts the carried copy on launch");
}

/**
 * Put the binary this run built on the PATH when the user keeps a `~/.local/bin`.
 * A stale link into `dist/` is repointed; anything else there is not ours to touch.
 */
async function linkOnPath(): Promise<void> {
  if (process.platform === "win32" || process.argv.includes("--no-link") || process.env.AWUI_NO_LINK === "1" || (process.env.CI !== undefined && process.env.CI !== "" && process.env.CI !== "false")) return;
  const home = process.env.HOME || os.homedir();
  const bin = path.join(home, ".local", "bin");
  if (!existsSync(bin) || !(await stat(bin)).isDirectory()) return;
  const platformName = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  const built = path.join(root, "dist", "bin", platformName, "awui");
  if (!existsSync(built)) return;
  const link = path.join(bin, "awui");
  const existing = await lstat(link).catch(() => null);
  if (existing?.isSymbolicLink()) {
    const target = await readlink(link).catch(() => "");
    const resolved = path.resolve(bin, target);
    if (resolved !== built && !resolved.startsWith(`${path.join(root, "dist")}${path.sep}`)) {
      console.log(`awui: left ${link} alone (it points to ${resolved})`);
      return;
    }
  } else if (existing) {
    console.log(`awui: left ${link} alone (a file, not a link; remove it to let the build link there)`);
    return;
  }
  const tmp = `${link}.${process.pid}.tmp`;
  await rm(tmp, { force: true });
  await symlink(built, tmp);
  await rename(tmp, link);
  console.log(`awui: linked ${link} → ${path.relative(home, built)}`);
}

await linkOnPath();
console.log("done.");
