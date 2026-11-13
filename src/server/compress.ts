// Compressed static assets. The web bundle is about 1.2 MB of JavaScript and CSS, and the server also
// answers other devices over the LAN and Tailscale (a phone), where sending it raw is the slowest part of
// opening the app. Each text asset is compressed once, off the event loop, kept in memory next to its
// source (a few hundred KB in all), and served as brotli or gzip to a client that accepts it. Only
// `node:zlib`: no dependency, and the same code serves the web folder on disk and the binary's embedded copy.
import { brotliCompress, gzip, constants } from "node:zlib";
import { promisify } from "node:util";

const brotli = promisify(brotliCompress);
const deflate = promisify(gzip);

export type Encoding = "br" | "gzip";

/** Text types worth compressing; images, fonts, and anything already compressed stay as they are. */
const TEXT_TYPE = /^(?:text\/|application\/(?:javascript|json|manifest\+json)|image\/svg\+xml)/;
/** Below this the headers outweigh the saving. */
const MIN_BYTES = 1024;
/** What is kept compressed, so the cache cannot grow with a long-lived process. */
const MAX_ENTRIES = 256;

/** Whether this content type is compressed at all. */
export function compressible(contentType: string, byteLength: number): boolean {
  return byteLength >= MIN_BYTES && TEXT_TYPE.test(contentType);
}

/** The best encoding an `Accept-Encoding` header allows (brotli over gzip), or null. A `;q=0` refuses it. */
export function negotiate(acceptEncoding: string | undefined): Encoding | null {
  if (!acceptEncoding) return null;
  const allowed = new Set<string>();
  for (const part of acceptEncoding.split(",")) {
    const [name = "", ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    if (q !== undefined && !(Number(q.slice(2)) > 0)) continue;
    allowed.add(name.trim());
  }
  if (allowed.has("br")) return "br";
  if (allowed.has("gzip") || allowed.has("*")) return "gzip";
  return null;
}

const cache = new Map<string, Promise<Buffer>>();

/**
 * The body compressed, once per `key` (a path and its version): concurrent first requests share one run.
 * A failure is not kept, so the next request tries again and the caller can fall back to the raw bytes.
 */
export function compressed(key: string, encoding: Encoding, body: Buffer): Promise<Buffer> {
  const at = `${encoding}:${key}`;
  const held = cache.get(at);
  if (held) return held;
  // Brotli 9 keeps the one-time cost near half a second for the main bundle; gzip 9 is the fallback for old clients.
  const run =
    encoding === "br"
      ? brotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } })
      : deflate(body, { level: 9 });
  const entry = run.then((out) => out);
  entry.catch(() => cache.delete(at));
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(at, entry);
  return entry;
}
