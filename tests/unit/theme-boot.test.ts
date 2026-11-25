// The theme a page boots with (static-web.ts): the shell names the scheme and links its stylesheet, so the
// first frame is the stored theme instead of the built-in one the script has not yet replaced. The rule is
// the client's themeModeOf; a scheme's stylesheet takes the same gate as /api/theme, so an unauthenticated
// visitor is told no more than that route already tells them.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type { ThemeInfo } from "../../src/shared/protocol.js";
import { bootHtml, bootThemeOf, themeCssHash } from "../../src/server/static-web.js";
import { makeTestApp, PASS, USER, type TestApp } from "../helpers/app.js";

const SHELL = '<!doctype html>\n<html lang="en">\n  <head>\n    <title>awui</title>\n  </head>\n  <body></body>\n</html>\n';
const REMOTE = "box.tail.ts.net";
const fixture = readFileSync(path.join(import.meta.dirname, "..", "fixtures", "themes", "stylix.yaml"), "utf8");

const scheme: ThemeInfo = { source: "file", name: "Stylix", polarity: "dark", vars: { "--bg": "#1d2021", "--text": "#d4be98" }, themeColor: "#1d2021", fonts: { sans: "Google Sans", mono: "CommitMonoFixed Nerd Font" } };
const painted: ThemeInfo = { source: "none", name: null, polarity: null, vars: {}, themeColor: null, fonts: {} };

describe("bootThemeOf", () => {
  it("boots a stored scheme with the variables its first frame paints", () => {
    const boot = bootThemeOf(null, scheme);
    expect(boot.polarity).toBe("dark");
    expect(boot.css).toContain("  --bg: #1d2021;");
    expect(boot.css).toContain('  --font-sans: "Google Sans", system-ui');
    // config.yml's `theme: base16` is the same answer, and so is a scheme with no choice at all.
    expect(bootThemeOf("base16", scheme)).toEqual(boot);
  });

  it("follows the system when nothing asks for a file, and names a fixed mode without one", () => {
    expect(bootThemeOf(null, painted)).toEqual({ polarity: null, css: null });
    expect(bootThemeOf("system", scheme)).toEqual({ polarity: null, css: null });
    expect(bootThemeOf("base16", painted)).toEqual({ polarity: null, css: null });
    expect(bootThemeOf("light", scheme)).toEqual({ polarity: "light", css: null });
    expect(bootThemeOf("dark", painted)).toEqual({ polarity: "dark", css: null });
  });
});

describe("bootHtml", () => {
  it("writes the scheme into the shell's html element and links its stylesheet before the head ends", () => {
    const boot = bootThemeOf(null, scheme);
    const html = bootHtml(SHELL, boot);
    expect(html).toContain('<html lang="en" data-theme="dark" data-scheme="1">');
    expect(html).toContain(`<link rel="stylesheet" id="theme-boot" href="/theme.css?h=${themeCssHash(boot.css ?? "")}" />`);
    expect(html.indexOf("theme.css")).toBeLessThan(html.indexOf("</head>"));
  });

  it("names a fixed mode alone, and leaves a page that follows the system exactly as it was", () => {
    const light = bootHtml(SHELL, { polarity: "light", css: null });
    expect(light).toContain('<html lang="en" data-theme="light">');
    expect(light).not.toContain("theme.css");
    expect(bootHtml(SHELL, { polarity: null, css: null })).toBe(SHELL);
  });

  it("moves the stylesheet's own name with its contents, so a page never paints one scheme and fetches another", () => {
    expect(themeCssHash("a")).not.toBe(themeCssHash("b"));
    expect(themeCssHash("a")).toBe(themeCssHash("a"));
  });
});

describe("the shell over HTTP", () => {
  let t: TestApp | null = null;
  let dir = "";

  /** A server whose web folder is a stand-in shell, over a config folder holding `config.yml`'s text. */
  async function serve(config: string, options: { themeFile?: string; withPassword?: boolean } = {}): Promise<void> {
    dir = mkdtempSync(path.join(os.tmpdir(), "awui-boot-"));
    const web = path.join(dir, "web");
    const configDir = path.join(dir, "config");
    mkdirSync(web);
    mkdirSync(configDir);
    writeFileSync(path.join(web, "index.html"), SHELL);
    writeFileSync(path.join(configDir, "config.yml"), config);
    t = await makeTestApp({
      webDir: web,
      configDir,
      ...(options.themeFile ? { themeFile: options.themeFile } : {}),
      ...(options.withPassword ? { withPassword: true, allowedHosts: [REMOTE] } : {}),
    });
  }

  afterEach(async () => {
    await t?.close();
    t = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("carries the stored scheme, and serves the stylesheet it links", async () => {
    const themeFile = path.join(os.tmpdir(), `awui-boot-theme-${process.pid}.yml`);
    writeFileSync(themeFile, fixture);
    try {
      await serve("theme: base16\n", { themeFile });
      const shell = await request(t!.server).get("/");
      expect(shell.status).toBe(200);
      expect(shell.headers["cache-control"]).toBe("no-store");
      expect(shell.text).toContain('data-theme="dark" data-scheme="1"');
      const hash = /\/theme\.css\?h=([0-9a-f]{12})/.exec(shell.text)?.[1];
      expect(hash).toBeTruthy();
      const css = await request(t!.server).get(`/theme.css?h=${hash}`);
      expect(css.status).toBe(200);
      expect(css.headers["content-type"]).toMatch(/text\/css/);
      expect(css.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
      expect(css.text).toContain("  --bg: #1d2021;");
      // The page's own name for the stylesheet is the one the route answers with.
      expect(themeCssHash(css.text)).toBe(hash);
    } finally {
      rmSync(themeFile, { force: true });
    }
  });

  it("names a fixed mode with no stylesheet, and answers 404 where there is none to serve", async () => {
    await serve("theme: light\n");
    const shell = await request(t!.server).get("/");
    expect(shell.text).toContain('data-theme="light"');
    expect(shell.text).not.toContain("theme.css");
    expect((await request(t!.server).get("/theme.css")).status).toBe(404);
  });

  it("tells a device with no session no more than /api/theme tells it", async () => {
    await serve("theme: light\n", { withPassword: true });
    const anon = await request(t!.server).get("/").set("Host", REMOTE);
    expect(anon.status).toBe(200);
    expect(anon.text).not.toContain("data-theme");
    expect((await request(t!.server).get("/theme.css").set("Host", REMOTE)).status).toBe(401);
    // The same page, signed in, carries it.
    const login = await request(t!.server).post("/api/login").set("Host", REMOTE).send({ username: USER, password: PASS });
    const cookie = String((login.headers["set-cookie"] as unknown as string[])[0]);
    const signed = await request(t!.server).get("/").set("Host", REMOTE).set("Cookie", cookie);
    expect(signed.text).toContain('data-theme="light"');
  });
});
