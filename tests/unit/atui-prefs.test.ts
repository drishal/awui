// The ordinary terminal client's remembered display preferences, not Vim's.
import { describe, expect, it } from "vitest";
import { prefsFile, readPrefs, writePrefs } from "../../src/atui/prefs.js";
import { tempDir } from "../helpers/app.js";

describe("atui preferences", () => {
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
