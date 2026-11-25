// How the server hands out the web app itself: the built folder on disk (express.static plus compressed text
// assets) or the copy a compiled binary carries in memory. Both share one caching rule (index.html and the
// worker are never cached; Vite's content-hashed /assets files are immutable) and one compression path
// (compress.ts), so the two cannot drift. It also carries the theme a signed-in page boots with: the shell's
// <html> says which scheme to paint, and /theme.css holds that scheme's variables, so the first frame is the
// stored theme instead of the built-in one the script has not yet replaced (theme.ts is still the live editor).
// Kept out of app.ts, which is routes.
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import express, { type RequestHandler, type Response } from "express";
import type { ThemeChoice, ThemeInfo } from "../shared/protocol.js";
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

/** The theme the first frame paints, before the page's script has read anything: the same answer theme.ts's `themeModeOf` gives. */
export interface BootTheme {
  /** `data-theme` on `<html>`, "dark" or "light": null when the device follows its own scheme, so nothing is injected. */
  polarity: "dark" | "light" | null;
  /** A stored base16/base24 scheme's variables as a stylesheet; null when the page uses the built-in colours. */
  css: string | null;
}

/** The boot attributes and stylesheet of the scheme in use, or nothing to say when the device follows the system. */
export function bootThemeOf(choice: ThemeChoice | null, info: ThemeInfo): BootTheme {
  const stored = info.source === "file" ? info : null;
  // config.yml's theme, then theme.yml itself when there is one: a device with no preference follows the system.
  const mode = choice === "base16" || choice === null ? (stored ? "scheme" : "system") : choice;
  if (mode === "scheme" && stored) return { polarity: stored.polarity ?? "dark", css: cssOf(stored) };
  if (mode === "dark" || mode === "light") return { polarity: mode, css: null };
  return { polarity: null, css: null };
}

/** A scheme's custom properties as a stylesheet body: the fonts too, so the first frame sets the same type. */
function cssOf(info: ThemeInfo): string {
  const lines = Object.entries(info.vars).map(([name, value]) => `  ${name}: ${value};`);
  if (info.fonts.sans) lines.push(`  --font-sans: "${info.fonts.sans}", system-ui, -apple-system, "Segoe UI", sans-serif;`);
  if (info.fonts.mono) lines.push(`  --font-mono: "${info.fonts.mono}", ui-monospace, "SFMono-Regular", Menlo, monospace;`);
  return `:root {\n${lines.join("\n")}\n}\n`;
}

/** The stylesheet's own name, so a page never paints one scheme while fetching another (and the file may be cached for good). */
export function themeCssHash(css: string): string {
  return createHash("sha256").update(css).digest("hex").slice(0, 12);
}

/**
 * The shell with its theme written in. The attributes are markup and the scheme is a stylesheet, never an inline
 * style: the CSP refuses inline style and script, and a base16 palette is data, not policy.
 */
export function bootHtml(html: string, theme: BootTheme): string {
  if (theme.polarity === null) return html;
  const attrs = ` data-theme="${theme.polarity}"${theme.css ? ' data-scheme="1"' : ""}`;
  // Named, so theme.ts can retire it once the page has painted with its own copy of the same variables.
  const link = theme.css ? `    <link rel="stylesheet" id="theme-boot" href="/theme.css?h=${themeCssHash(theme.css)}" />\n` : "";
  return html.replace(/<html(\s[^>]*)?>/, (tag) => tag.replace(/>$/, `${attrs}>`)).replace("</head>", `${link}  </head>`);
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
