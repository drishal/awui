// The pure core of a backend render preview (render-preview.ts): the theme
// variables a preview injects as one `:root` rule. No harness, no browser.
import { describe, expect, it } from "vitest";
import { themeVariableCss } from "../../src/server/render-preview.js";

describe("a preview's theme rule", () => {
  it("injects the appearance and each known variable", () => {
    expect(themeVariableCss({ "--bg": "#1e1e2e", "--text": "#cdd6f4" }, "dark")).toBe(
      ":root{color-scheme:dark;--bg:#1e1e2e;--text:#cdd6f4;}",
    );
    expect(themeVariableCss({ "--bg": "#ffffff" }, "light")).toBe(":root{color-scheme:light;--bg:#ffffff;}");
  });

  it("drops unknown keys: a preview reads only the variables a live frame does", () => {
    expect(themeVariableCss({ "--evil-key": "x", "--bg": "#000" }, "dark")).toBe(":root{color-scheme:dark;--bg:#000;}");
  });

  it("strips the CSS structure a value could smuggle, as the page bootstrap does", () => {
    expect(themeVariableCss({ "--text": "a;b{c}d<e>" }, "dark")).toBe(":root{color-scheme:dark;--text:abcde;}");
  });

  it("skips non-strings, blanks, and values over the cap", () => {
    const long = "x".repeat(1001);
    expect(themeVariableCss({ "--bg": 5 as unknown as string, "--text": "  ", "--muted": long }, "dark")).toBe(
      ":root{color-scheme:dark;}",
    );
  });

  it("takes junk for the theme without throwing", () => {
    expect(themeVariableCss(null as unknown as Record<string, string>, "dark")).toBe(":root{color-scheme:dark;}");
    expect(themeVariableCss([["--bg", "#000"]] as unknown as Record<string, string>, "dark")).toBe(
      ":root{color-scheme:dark;}",
    );
  });
});
