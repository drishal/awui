// Compressed static assets: which encoding a client gets, that a text asset is sent compressed and
// decodes to the same bytes, and that anything else (an image, a client that refuses) is untouched.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { compressible, negotiate } from "../../src/server/compress.js";
import { makeTestApp, type TestApp } from "../helpers/app.js";

describe("negotiate", () => {
  it("prefers brotli, then gzip, and honours a refusal", () => {
    expect(negotiate("gzip, deflate, br")).toBe("br");
    expect(negotiate("gzip")).toBe("gzip");
    expect(negotiate("*")).toBe("gzip");
    expect(negotiate("br;q=0, gzip")).toBe("gzip");
    expect(negotiate("identity")).toBeNull();
    expect(negotiate(undefined)).toBeNull();
    expect(negotiate("gzip;q=0")).toBeNull();
  });
  it("compresses only text of some size", () => {
    expect(compressible("text/css; charset=utf-8", 5000)).toBe(true);
    expect(compressible("text/javascript; charset=utf-8", 5000)).toBe(true);
    expect(compressible("application/json; charset=utf-8", 5000)).toBe(true);
    expect(compressible("image/png", 5000)).toBe(false);
    expect(compressible("text/css", 100)).toBe(false);
  });
});

describe("static assets", () => {
  let web: string;
  let t: TestApp;
  const script = `export const x = ${JSON.stringify("awui ".repeat(2000))};\n`;
  beforeEach(async () => {
    web = mkdtempSync(path.join(os.tmpdir(), "awui-web-"));
    mkdirSync(path.join(web, "assets"));
    writeFileSync(path.join(web, "index.html"), "<!doctype html><title>awui</title>");
    writeFileSync(path.join(web, "assets", "main-abc123.js"), script);
    writeFileSync(path.join(web, "assets", "tiny.js"), "x=1");
    writeFileSync(path.join(web, "icon.png"), Buffer.alloc(4000, 7));
    t = await makeTestApp({ webDir: web });
  });
  afterEach(async () => {
    await t.close();
    rmSync(web, { recursive: true, force: true });
  });

  // The HTTP client decodes the body itself, so the encoding shows in the headers and the size on the wire.
  it("sends a hashed script as brotli, immutable, and it decodes to the file", async () => {
    const res = await request(t.server).get("/assets/main-abc123.js").set("Accept-Encoding", "br, gzip");
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
    expect(res.headers["vary"]).toMatch(/Accept-Encoding/i);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(res.headers["content-type"]).toMatch(/javascript/);
    expect(Number(res.headers["content-length"])).toBeLessThan(script.length / 4);
    expect(res.text).toBe(script);
  });

  it("falls back to gzip for a client without brotli", async () => {
    const res = await request(t.server).get("/assets/main-abc123.js").set("Accept-Encoding", "gzip");
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(Number(res.headers["content-length"])).toBeLessThan(script.length / 4);
    expect(res.text).toBe(script);
  });

  it("sends the raw file to a client that accepts no encoding, and leaves small files and images alone", async () => {
    const raw = await request(t.server).get("/assets/main-abc123.js").set("Accept-Encoding", "identity");
    expect(raw.headers["content-encoding"]).toBeUndefined();
    expect(raw.text).toBe(script);
    const tiny = await request(t.server).get("/assets/tiny.js").set("Accept-Encoding", "br");
    expect(tiny.headers["content-encoding"]).toBeUndefined();
    expect(tiny.text).toBe("x=1");
    const png = await request(t.server).get("/icon.png").set("Accept-Encoding", "br");
    expect(png.headers["content-encoding"]).toBeUndefined();
    expect(png.headers["cache-control"]).toBe("public, max-age=3600");
  });

  it("keeps index.html uncached and cannot be steered out of the folder", async () => {
    const index = await request(t.server).get("/");
    expect(index.headers["cache-control"]).toBe("no-store");
    const escape = await request(t.server).get("/assets/..%2f..%2fetc%2fpasswd").set("Accept-Encoding", "br");
    expect(escape.headers["content-encoding"]).toBeUndefined();
    expect(escape.text).not.toMatch(/root:/);
  });
});

describe("the binary's embedded bundle", () => {
  it("is compressed for a client that accepts it, uncached for the shell and immutable for hashed assets", async () => {
    const { embeddedHandler } = await import("../../src/server/static-web.js");
    const { default: express } = await import("express");
    const script = `export const y = ${JSON.stringify("awui ".repeat(2000))};\n`;
    const files = new Map([
      ["/index.html", { text: "<!doctype html><title>awui</title>", contentType: "text/html; charset=utf-8" }],
      ["/assets/main-xyz.js", { text: script, contentType: "text/javascript; charset=utf-8" }],
      ["/icon.png", { text: Buffer.alloc(4000, 3), contentType: "image/png" }],
    ]);
    const app = express();
    app.get(/^\/(?!api\/).*/, embeddedHandler(files));
    const js = await request(app).get("/assets/main-xyz.js").set("Accept-Encoding", "br");
    expect(js.headers["content-encoding"]).toBe("br");
    expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(Number(js.headers["content-length"])).toBeLessThan(script.length / 4);
    expect(js.text).toBe(script);
    const plain = await request(app).get("/assets/main-xyz.js").set("Accept-Encoding", "identity");
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.text).toBe(script);
    const shell = await request(app).get("/some/route");
    expect(shell.headers["cache-control"]).toBe("no-store");
    expect(shell.text).toContain("<title>awui</title>");
    const png = await request(app).get("/icon.png").set("Accept-Encoding", "br");
    expect(png.headers["content-encoding"]).toBeUndefined();
  });
});
