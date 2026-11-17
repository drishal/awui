// The theme library: schemes kept as ~/.config/awui/themes/<id>.yml, chosen by
// config.yml's theme_scheme, and served to every client through /api/theme.
// Uploads and the editor's schemes are checked like theme.yml and written
// normalized; a symlinked (home-manager) file is never changed from here.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import request from "supertest";
import { makeTestApp, tempDir, type TestApp } from "../helpers/app.js";
import { themeSlug } from "../../src/server/theme-library.js";

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, "..", "fixtures", "themes", name), "utf8");
const PALETTE = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`base0${i.toString(16).toUpperCase()}`, i < 8 ? `#${(i * 0x111111 + 0x101010).toString(16).padStart(6, "0")}` : "#cc6666"]));

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function withLibrary(themeFile?: string): Promise<{ t: TestApp; configDir: string; themes: string }> {
  const configDir = path.join(tempDir(), "settings");
  mkdirSync(configDir, { recursive: true });
  t = await makeTestApp({ withSettings: true, configDir, ...(themeFile ? { themeFile } : {}) });
  return { t, configDir, themes: path.join(configDir, "themes") };
}

describe("theme slugs", () => {
  it("makes a file name from a scheme name, unique among the taken ones", () => {
    expect(themeSlug("Gruvbox Dark (Hard)", new Set())).toBe("gruvbox-dark-hard");
    expect(themeSlug("Gruvbox Dark (Hard)", new Set(["gruvbox-dark-hard", "gruvbox-dark-hard-2"]))).toBe("gruvbox-dark-hard-3");
    expect(themeSlug("日本", new Set())).toBe("theme");
  });
});

describe("the theme library", () => {
  it("uploads a .yml, lists it, and serves it once config.yml selects it", async () => {
    const { t, configDir, themes } = await withLibrary();
    const made = await request(t.server).post("/api/themes").send({ yaml: fixture("legacy.yaml") });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ id: "legacy-ocean", name: "Legacy Ocean", polarity: "dark", readOnly: false });
    expect(made.body.palette.base00).toBe("#001122");
    expect(made.body.vars["--bg"]).toBe("#001122");
    expect(made.body).not.toHaveProperty("scheme");
    const file = path.join(themes, "legacy-ocean.yml");
    // Written normalized: the upload's `author` and flat layout do not reach the disk.
    const text = readFileSync(file, "utf8");
    expect(text).toContain('system: "base16"');
    expect(text).toContain('  base00: "#001122"');
    expect(text).not.toContain("author");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(themes).mode & 0o777).toBe(0o700);

    const list = await request(t.server).get("/api/themes");
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ selected: null, writable: true, max: 100 });
    expect(list.body.themes.map((e: { id: string }) => e.id)).toEqual(["legacy-ocean"]);

    // Nothing selected: /api/theme is still the built-in look.
    expect((await request(t.server).get("/api/theme")).body.source).toBe("none");
    const saved = await request(t.server).put("/api/settings").send({ theme: "base16", themeScheme: "legacy-ocean" });
    expect(saved.status).toBe(200);
    expect(readFileSync(path.join(configDir, "config.yml"), "utf8")).toContain("theme_scheme: legacy-ocean");
    const active = await request(t.server).get("/api/theme");
    expect(active.body).toMatchObject({ source: "file", scheme: "legacy-ocean", name: "Legacy Ocean" });
    expect((await request(t.server).get("/api/bootstrap")).body.ui).toMatchObject({ theme: "base16", themeScheme: "legacy-ocean" });
    expect((await request(t.server).get("/api/themes")).body.selected).toBe("legacy-ocean");
    // Back to theme.yml: the key is removed.
    await request(t.server).put("/api/settings").send({ themeScheme: null });
    expect(readFileSync(path.join(configDir, "config.yml"), "utf8")).not.toContain("theme_scheme");
  });

  it("creates from the editor, edits in place, and deletes with an undo that restores the same id", async () => {
    const { t, themes } = await withLibrary();
    const first = await request(t.server).post("/api/themes").send({ name: "My Theme", variant: "dark", palette: PALETTE, fonts: { mono: "Iosevka" } });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ id: "my-theme", fonts: { mono: "Iosevka" } });
    const second = await request(t.server).post("/api/themes").send({ name: "My Theme", variant: "dark", palette: PALETTE });
    expect(second.body.id).toBe("my-theme-2");

    const renamed = await request(t.server).put("/api/themes/my-theme").send({ name: "Renamed", variant: "light", palette: { ...PALETTE, base00: "#fafafa" } });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ id: "my-theme", name: "Renamed", polarity: "light" });
    expect(renamed.body.palette.base00).toBe("#fafafa");
    expect(readFileSync(path.join(themes, "my-theme.yml"), "utf8")).toContain('name: "Renamed"');

    const removed = await request(t.server).delete("/api/themes/my-theme");
    expect(removed.status).toBe(200);
    expect(removed.body.id).toBe("my-theme");
    expect(existsSync(path.join(themes, "my-theme.yml"))).toBe(false);
    const undone = await request(t.server).post("/api/themes").send({ yaml: removed.body.yaml, id: "my-theme" });
    expect(undone.status).toBe(201);
    expect(undone.body).toMatchObject({ id: "my-theme", name: "Renamed" });
    // A taken id is refused rather than replaced.
    expect((await request(t.server).post("/api/themes").send({ yaml: removed.body.yaml, id: "my-theme" })).status).toBe(409);
  });

  it("exports the normalized file as a download", async () => {
    const { t } = await withLibrary();
    await request(t.server).post("/api/themes").send({ yaml: fixture("tinted-base24.yaml") });
    const id = (await request(t.server).get("/api/themes")).body.themes[0].id as string;
    const file = await request(t.server).get(`/api/themes/${id}/file`);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toContain("text/yaml");
    expect(file.headers["content-disposition"]).toBe(`attachment; filename="${id}.yml"`);
    expect(file.headers["x-content-type-options"]).toBe("nosniff");
    expect(file.text).toContain('system: "base24"');
    expect(file.text).toContain("base17");
  });

  it("refuses injection, bad YAML, bad ids, and unknown themes", async () => {
    const { t, themes } = await withLibrary();
    expect((await request(t.server).post("/api/themes").send({ yaml: fixture("injection.yaml") })).status).toBe(400);
    expect((await request(t.server).post("/api/themes").send({ yaml: "a: [unclosed" })).status).toBe(400);
    expect((await request(t.server).post("/api/themes").send({ name: "x", variant: "dark", palette: { ...PALETTE, base08: "red;}" } })).status).toBe(400);
    expect((await request(t.server).post("/api/themes").send({ yaml: fixture("legacy.yaml"), id: "../evil" })).status).toBe(400);
    expect((await request(t.server).put("/api/themes/%2E%2E").send({ name: "x", variant: "dark", palette: PALETTE })).status).toBe(404);
    expect((await request(t.server).delete("/api/themes/nope")).status).toBe(404);
    expect((await request(t.server).get("/api/themes/nope/file")).status).toBe(404);
    expect(existsSync(themes)).toBe(false);
  });

  it("lists a broken file with its problem, and falls back when the selected theme is gone", async () => {
    const { t, configDir, themes } = await withLibrary();
    mkdirSync(themes, { recursive: true });
    writeFileSync(path.join(themes, "broken.yml"), "palette:\n  base00: '000000'\n");
    writeFileSync(path.join(themes, "Not A Slug.yml"), fixture("legacy.yaml"));
    const list = await request(t.server).get("/api/themes");
    expect(list.body.themes).toHaveLength(1);
    expect(list.body.themes[0]).toMatchObject({ id: "broken" });
    expect(list.body.themes[0].problem).toMatch(/missing base01/);
    writeFileSync(path.join(configDir, "config.yml"), "theme: base16\ntheme_scheme: gone\n");
    const active = await request(t.server).get("/api/theme");
    expect(active.body.source).toBe("none");
    expect(active.body.problem).toMatch(/"gone" is not in the theme library/);
    // The broken file can still be removed.
    expect((await request(t.server).delete("/api/themes/broken")).status).toBe(200);
  });

  it("uses a symlinked (home-manager) theme but never edits or deletes it", async () => {
    const { t, themes } = await withLibrary();
    mkdirSync(themes, { recursive: true });
    const outside = path.join(tempDir(), "store-theme.yaml");
    writeFileSync(outside, fixture("stylix.yaml"));
    symlinkSync(outside, path.join(themes, "stylix.yml"));
    const list = await request(t.server).get("/api/themes");
    expect(list.body.themes[0]).toMatchObject({ id: "stylix", readOnly: true });
    expect((await request(t.server).put("/api/themes/stylix").send({ name: "x", variant: "dark", palette: PALETTE })).status).toBe(409);
    expect((await request(t.server).delete("/api/themes/stylix")).status).toBe(409);
    expect(readFileSync(outside, "utf8")).toBe(fixture("stylix.yaml"));
  });

  it("lists theme.yml first, read-only, with id null", async () => {
    const dir = tempDir();
    const themeFile = path.join(dir, "theme.yml");
    writeFileSync(themeFile, fixture("stylix.yaml"));
    const { t } = await withLibrary(themeFile);
    await request(t.server).post("/api/themes").send({ yaml: fixture("legacy.yaml") });
    const list = await request(t.server).get("/api/themes");
    expect(list.body.themes.map((e: { id: string | null }) => e.id)).toEqual([null, "legacy-ocean"]);
    expect(list.body.themes[0]).toMatchObject({ name: "stylix", readOnly: true });
    expect(list.body.themes[0].palette.base00).toBe("#1d2021");
    // With no pick, theme.yml is what /api/theme serves.
    expect((await request(t.server).get("/api/theme")).body).toMatchObject({ source: "file", name: "stylix" });
    expect((await request(t.server).get("/api/theme")).body).not.toHaveProperty("scheme");
  });

  it("keeps no themes without a config folder", async () => {
    t = await makeTestApp({});
    const list = await request(t.server).get("/api/themes");
    expect(list.body).toMatchObject({ themes: [], writable: false });
    expect((await request(t.server).post("/api/themes").send({ yaml: fixture("legacy.yaml") })).status).toBe(409);
  });
});
