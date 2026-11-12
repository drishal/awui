// The compiled binary's embedded assets: the web bundle, the harness extension
// sources, the orchestration skills, and the package version, all baked in by
// scripts/build-binary.ts as a generated file map plus `define` constants. From
// source (dev, `npm start`) none of this exists: the constants are undefined and
// every helper falls back to the on-disk paths dist/ and the repo already provide.
//
// The web bundle is served from this map by Express (app.ts). Extension sources
// still have to be real files for pi/omp's `-e`, so they are written into the
// state folder once at startup and the finders hand over that path.

import { promises as fsp } from "node:fs";
import path from "node:path";

// The build's `define` constants; undefined outside a binary.
declare const AWUI_VERSION: string | undefined;
declare const AWUI_EMBEDDED: boolean | undefined;

/** True when this process is the self-contained binary (its assets are embedded). */
export const isEmbedded = typeof AWUI_EMBEDDED !== "undefined" && AWUI_EMBEDDED === true;

/** The package version, baked into a binary; the caller reads package.json otherwise. */
export const embeddedVersion: string | undefined = typeof AWUI_VERSION !== "undefined" ? AWUI_VERSION : undefined;

/** One embedded web-bundle file: text or bytes, plus its content type. */
export interface EmbeddedWebFile {
  /** The body: a string for text assets, a Buffer for binary (icons, fonts). */
  text: string | Buffer;
  contentType: string;
}

// Populated by the generated asset module at startup (its import side effect).
let webFiles: Map<string, EmbeddedWebFile> = new Map();
let extensionSources: Map<string, string> = new Map();
/** The orchestration skills by name (council, advisor, handoff): served as prompts, never written to disk. */
let skillSources: Map<string, string> = new Map();
/** Materialized extension paths, set by extractEmbeddedExtensions (binary only). */
const extractedExtensions = new Map<string, string>();

/** Called by the generated asset module's import side effect at startup. */
export function registerEmbeddedAssets(web: Map<string, EmbeddedWebFile>, extensions: Map<string, string>, skills: Map<string, string>): void {
  webFiles = web;
  extensionSources = extensions;
  skillSources = skills;
}

/** The embedded web bundle, or null when this is not the binary. */
export function embeddedWeb(): Map<string, EmbeddedWebFile> | null {
  return isEmbedded && webFiles.size > 0 ? webFiles : null;
}

/** The embedded source of a harness extension by file name, or null in source runs. */
export function embeddedExtensionSource(name: string): string | null {
  return isEmbedded ? (extensionSources.get(name) ?? null) : null;
}

/** The embedded text of an orchestration skill by name, or null in source runs. */
export function embeddedSkillSource(name: string): string | null {
  return isEmbedded ? (skillSources.get(name) ?? null) : null;
}

/** The materialized path of an embedded extension, after extractEmbeddedExtensions ran; null from source. */
export function extractedExtensionPath(name: string): string | null {
  return extractedExtensions.get(name) ?? null;
}

/**
 * Write every embedded extension source into the state folder once, so the sync
 * finders in harness/render-extension.ts and rewind-extension.ts can hand pi/omp
 * a stable `-e` path. A no-op from source.
 */
export async function extractEmbeddedExtensions(stateDir: string): Promise<void> {
  if (!isEmbedded) return;
  const dir = path.join(stateDir, "extensions");
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  for (const [name, source] of extensionSources) {
    const file = path.join(dir, name);
    const existing = await fsp.readFile(file, "utf8").catch(() => null);
    if (existing !== source) {
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, source, { mode: 0o600 });
      await fsp.rename(tmp, file);
    }
    extractedExtensions.set(name, file);
  }
}
