// The ordinary terminal client's remembered display preferences, not Vim's.
import { describe, expect, it } from "vitest";
import { prefsFile, readPrefs, writePrefs } from "../../src/atui/prefs.js";
import { writeFileSync } from "node:fs";
import { tempDir } from "../helpers/app.js";

describe("atui preferences", () => {
  it("remembers the icon set and ignores a value that is not one", () => {
    const file = prefsFile({ HOME: tempDir("awui-atui-icons-") });
    writePrefs({ icons: "nerd" }, file);
    expect(readPrefs(file).icons).toBe("nerd");
    writeFileSync(file, JSON.stringify({ icons: "emoji" }));
    expect(readPrefs(file).icons).toBeUndefined();
  });
  it("starts with reasoning visible and preserves that reversible choice with vim/glass", () => {
    const file = prefsFile({ HOME: tempDir("awui-atui-thought-") });
    writePrefs({ vim: true, glass: true }, file);
    expect(readPrefs(file).showThoughts).toBeUndefined();
    writePrefs({ showThoughts: false }, file);
    expect(readPrefs(file)).toEqual({ vim: true, keybinds: "vim", glass: true, showThoughts: false });
    writePrefs({ showThoughts: true }, file);
    expect(readPrefs(file)).toEqual({ vim: true, keybinds: "vim", glass: true, showThoughts: true });
  });
});
