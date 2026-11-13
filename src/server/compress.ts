// Compressed static assets. The web bundle is about 1.2 MB of JavaScript and CSS, and the server also
// answers other devices over the LAN and Tailscale (a phone), where sending it raw is the slowest part of
// opening the app. Each text asset is compressed once, off the event loop, kept in memory next to its
// source (a few hundred KB in all), and served as brotli or gzip to a client that accepts it. Only
// `node:zlib`: no dependency, and the same code serves the web folder on disk and the binary's embedded copy.
import { brotliCompress, createGzip, gzip, constants, type Gzip } from "node:zlib";
import type { Request, RequestHandler, Response } from "express";
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

/** A JSON answer smaller than this goes out as it is. */
const API_MIN_BYTES = 2048;

/**
 * Large `/api` JSON answers (the session list is about 200 KB, a chat's snapshot and a diff more) as brotli
 * or gzip, per request at a light level: cheap enough to do on every call, and several times smaller on a
 * phone's connection. It wraps `res.end`, the last step of any route's answer, so no route knows about it, and
 * mounted before the idempotency store it leaves that store the plain body to keep and replay.
 */
export function compressApi(): RequestHandler {
  return (req, res, next) => {
    const encoding = negotiate(req.headers["accept-encoding"]);
    if (!encoding) return next();
    const end = res.end.bind(res) as (chunk?: unknown, ...rest: unknown[]) => Response;
    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      const text = typeof chunk === "string";
      const size = text ? Buffer.byteLength(chunk) : Buffer.isBuffer(chunk) ? chunk.length : 0;
      const type = String(res.getHeader("Content-Type") ?? "");
      if (size < API_MIN_BYTES || res.headersSent || res.getHeader("Content-Encoding") || !/json/i.test(type) || res.statusCode === 204 || res.statusCode === 304) return end(chunk, ...rest);
      const raw = text ? Buffer.from(chunk, typeof rest[0] === "string" ? (rest[0] as BufferEncoding) : "utf8") : (chunk as Buffer);
      const done = (error: Error | null, out: Buffer) => {
        res.vary("Accept-Encoding");
        if (error) return void end(chunk, ...rest);
        res.setHeader("Content-Encoding", encoding);
        res.setHeader("Content-Length", out.length);
        end(out);
      };
      if (encoding === "br") brotliCompress(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }, done);
      else gzip(raw, { level: 5 }, done);
      return res;
    }) as typeof res.end;
    next();
  };
}

/**
 * A server-sent stream as gzip, flushed after every event so a frame reaches the page as it is written. A
 * chat's first frame is its whole snapshot (hundreds of KB for a long chat), the largest thing a phone loads
 * when it opens one. Only for a client that asked (`?z=1`): other stream readers (the terminal clients) get
 * plain text, since not every HTTP client delivers a compressed stream before it fills a buffer.
 */
export function gzipEventStream(req: Request, res: Response): { write: (chunk: string) => void; end: () => void; headers: Record<string, string> } {
  const wanted = req.query.z === "1" && negotiate(req.headers["accept-encoding"]) !== null;
  if (!wanted) return { write: (chunk) => void res.write(chunk), end: () => void res.end(), headers: {} };
  const stream: Gzip = createGzip({ level: 4 });
  stream.pipe(res);
  // A flush is asked of the stream; its output reaches the socket through the pipe.
  const write = (chunk: string) => {
    stream.write(chunk);
    stream.flush(constants.Z_SYNC_FLUSH);
  };
  return { write, end: () => void stream.end(), headers: { "Content-Encoding": "gzip", Vary: "Accept-Encoding" } };
}
