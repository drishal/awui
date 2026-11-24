// Agent presets (src/atui/presets.ts): the saved list is read leniently, names are unique,
// the list is capped, and a preset round-trips through atui.json.
import { describe, expect, it } from "vitest";
import { MAX_PRESETS, parsePresets, presetName, presetWords, withPreset, withoutPreset } from "../../src/atui/presets.js";
import { prefsFile, readPrefs, writePrefs } from "../../src/atui/prefs.js";
import { tempDir } from "../helpers/app.js";

describe("atui presets", () => {
  it("reads a saved list leniently: malformed entries and repeated names are dropped", () => {
    const list = parsePresets([
      { name: "  Explore ", harnessId: "pi", model: "m1", thinkingLevel: "low" },
      { name: "explore", harnessId: "omp" },
      { name: "", harnessId: "pi" },
      { name: "No harness" },
      "text",
      { name: "Plain", harnessId: "claude", model: 7 },
    ]);
    expect(list).toEqual([{ name: "Explore", harnessId: "pi", model: "m1", thinkingLevel: "low" }, { name: "Plain", harnessId: "claude" }]);
    expect(parsePresets("nope")).toEqual([]);
  });
  it("replaces a preset of the same name in place, caps the list, and removes by name in any case", () => {
    const a = { name: "A", harnessId: "pi" };
    const list = withPreset(withPreset([], a), { name: "B", harnessId: "omp" });
    expect(withPreset(list, { name: "a", harnessId: "claude", model: "x" })).toEqual([{ name: "a", harnessId: "claude", model: "x" }, { name: "B", harnessId: "omp" }]);
    const many = Array.from({ length: MAX_PRESETS + 3 }, (_, i) => ({ name: `p${i}`, harnessId: "pi" })).reduce(withPreset, [] as ReturnType<typeof parsePresets>);
    expect(many).toHaveLength(MAX_PRESETS);
    expect(many[0]?.name).toBe("p3");
    expect(withoutPreset(list, "b")).toEqual([a]);
  });
  it("words a name to one line and a preset as harness, model and level", () => {
    expect(presetName("  Deep\n  work  ")).toBe("Deep work");
    expect(presetName("x".repeat(80))).toHaveLength(32);
    expect(presetWords({ name: "n", harnessId: "pi", model: "opus", thinkingLevel: "high" }, "Pi")).toBe("Pi · opus · high");
    expect(presetWords({ name: "n", harnessId: "pi" }, "Pi")).toBe("Pi");
  });
  it("is remembered between runs", () => {
    const file = prefsFile({ HOME: tempDir("awui-atui-presets-") });
    writePrefs({ presets: [{ name: "Explore", harnessId: "pi", thinkingLevel: "low" }] }, file);
    expect(readPrefs(file).presets).toEqual([{ name: "Explore", harnessId: "pi", thinkingLevel: "low" }]);
    writePrefs({ presets: [] }, file);
    expect(readPrefs(file).presets).toEqual([]);
  });
});
