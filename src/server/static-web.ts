// How the server hands out the web app itself: the built folder on disk (express.static plus compressed text
// assets) or the copy a compiled binary carries in memory. Both share one caching rule (index.html and the
// worker are never cached; Vite's content-hashed /assets files are immutable) and one compression path
// (compress.ts), so the two cannot drift. Kept out of app.ts, which is routes.
import { promises as fsp } from "node:fs";
import path from "node:path";
import express, { type RequestHandler, type Response } from "express";
import { compressed, compressible, negotiate } from "./compress.js";
import type { EmbeddedWebFile } from "./embedded.js";

/** index.html and the worker are how a deploy reaches a page; Vite's hashed /assets files never change under their name. */
export function cacheControlFor(urlPath: string): string {
  if (urlPath.endsWith(".html") || urlPath === "/index.html" || urlPath === "/sw.js") return "no-store";
  if (urlPath.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  return "public, max-age=3600";
}

export function setStaticHeaders(res: Response, filePath: string, webDir: string): void {
  res.setHeader("Cache-Control", cacheControlFor(`/${path.relative(webDir, filePath).split(path.sep).join("/")}`));
}

/**
 * The web folder's text assets as brotli or gzip, compressed once and kept (compress.ts): about 1.2 MB of
 * script and style becomes about 0.3 MB. Anything it does not take (an image, a missing file, a client that
 * accepts no encoding) falls through to express.static unchanged.
 */
export function compressedStatic(webDir: string): RequestHandler {
  const root = path.resolve(webDir);
  return async (req, res, next) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      const encoding = negotiate(req.headers["accept-encoding"]);
      if (!encoding || req.path.endsWith("/")) return next();
      let relative: string;
      try {
        relative = decodeURIComponent(req.path);
      } catch {
        return next();
      }
      const file = path.join(root, relative);
      if (!file.startsWith(root + path.sep)) return next();
      const stat = await fsp.stat(file).catch(() => null);
      if (!stat?.isFile()) return next();
      res.type(path.extname(file));
      const contentType = String(res.getHeader("Content-Type") ?? "");
      if (!compressible(contentType, stat.size)) {
        res.removeHeader("Content-Type");
        return next();
      }
      const body = await fsp.readFile(file);
      const out = await compressed(`${file}:${stat.mtimeMs}:${stat.size}`, encoding, body).catch(() => null);
      if (!out) return next();
      res.setHeader("Content-Encoding", encoding);
      res.vary("Accept-Encoding");
      res.setHeader("Cache-Control", cacheControlFor(`/${relative.replace(/^\/+/, "")}`));
      res.send(out);
    } catch (error) {
      next(error);
    }
  };
}

/** The binary's embedded web bundle, served from memory (unknown paths get index.html, the single-page app's shell). */
export function embeddedHandler(embedded: Map<string, EmbeddedWebFile>): RequestHandler {
  return async (req, res, next) => {
    try {
      const urlPath = req.path === "/" ? "/index.html" : req.path;
      const file = embedded.get(urlPath) ?? embedded.get("/index.html");
      if (!file) {
        res.status(404).end();
        return;
      }
      res.setHeader("Cache-Control", cacheControlFor(embedded.has(urlPath) ? urlPath : "/index.html"));
      res.setHeader("Content-Type", file.contentType);
      const body = typeof file.text === "string" ? Buffer.from(file.text) : file.text;
      const encoding = compressible(file.contentType, body.length) ? negotiate(req.headers["accept-encoding"]) : null;
      res.vary("Accept-Encoding");
      if (encoding) {
        const out = await compressed(urlPath, encoding, body).catch(() => null);
        if (out) {
          res.setHeader("Content-Encoding", encoding);
          res.send(out);
          return;
        }
      }
      res.send(file.text);
    } catch (error) {
      next(error);
    }
  };
}
