// The web UI's one list of theme choices: built-ins first, theme.yml and the
// library after, a broken file left out, and the key for what config.yml holds.
import { describe, expect, it } from "vitest";
import type { ThemeEntry, ThemeList } from "../../src/shared/protocol.js";
import { currentThemeKey, entryInfo, optionLook, schemeKey, themeFileName, themeOptions } from "../../src/web/themes.js";

const entry = (over: Partial<ThemeEntry>): ThemeEntry => ({ id: "gruvbox-dark", name: "Gruvbox Dark", polarity: "dark", palette: { base00: "#282828" }, vars: { "--bg": "#282828" }, themeColor: "#282828", fonts: {}, readOnly: false, ...over });
const list = (themes: ThemeEntry[]): ThemeList => ({ themes, selected: null, writable: true, max: 100 });

describe("themeOptions", () => {
  it("offers the built-ins alone with no library", () => {
    expect(themeOptions(null).map((o) => o.key)).toEqual(["system", "light", "dark"]);
  });

  it("puts theme.yml and the library after the built-ins, and leaves out a file that cannot be used", () => {
    const options = themeOptions(list([entry({ id: null, name: "Stylix", readOnly: true }), entry({}), entry({ id: "linked", name: "Linked", readOnly: true }), entry({ id: "broken", name: "Broken", problem: "no palette" })]));
    expect(options.map((o) => o.key)).toEqual(["system", "light", "dark", "scheme:", "scheme:gruvbox-dark", "scheme:linked"]);
    expect(options[3]).toMatchObject({ theme: "base16", themeScheme: null, note: "theme.yml" });
    expect(options[4]?.note).toBeUndefined();
    expect(options[5]?.note).toBe("read-only");
  });
});

describe("currentThemeKey", () => {
  it("names the library pick for a scheme, theme.yml without one, and the bare mode otherwise", () => {
    expect(currentThemeKey({ theme: "base16", themeScheme: "gruvbox-dark" }, "scheme")).toBe("scheme:gruvbox-dark");
    expect(currentThemeKey({ theme: "base16", themeScheme: null }, "scheme")).toBe(schemeKey(null));
    expect(currentThemeKey({ theme: "dark", themeScheme: "gruvbox-dark" }, "dark")).toBe("dark");
    expect(currentThemeKey(null, "system")).toBe("system");
  });
});

describe("optionLook", () => {
  it("paints a scheme with its own variables and a built-in by its mode", () => {
    const [system, light, , scheme] = themeOptions(list([entry({})]));
    expect(optionLook(system!)).toEqual({ mode: "system", info: null });
    expect(optionLook(light!)).toEqual({ mode: "light", info: null });
    expect(optionLook(scheme!)).toEqual({ mode: "scheme", info: entryInfo(entry({})) });
    expect(entryInfo(entry({})).scheme).toBe("gruvbox-dark");
    expect(entryInfo(entry({ id: null })).scheme).toBeUndefined();
  });
});

describe("themeFileName", () => {
  it("uses the id, else a slug of the name", () => {
    expect(themeFileName({ id: "nord", name: "Nord" })).toBe("nord.yml");
    expect(themeFileName({ id: null, name: "Stylix: My Scheme!" })).toBe("stylix-my-scheme.yml");
    expect(themeFileName({ id: null, name: "!!!" })).toBe("theme.yml");
  });
});
