import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prefsFile, readPrefs, writePrefs } from "../../src/atui/prefs.js";
import { turnOffset, vimKey, type VimKey } from "../../src/atui/vim.js";
import { tempDir } from "../helpers/app.js";

const key = (sequence: string, over: Partial<VimKey> = {}): VimKey => ({ name: sequence.toLowerCase(), sequence, ctrl: false, shift: sequence !== sequence.toLowerCase(), meta: false, ...over });

/** Feed keys through NORMAL mode, collecting the actions. */
function run(...keys: VimKey[]) {
  let pending = "";
  const actions = [];
  for (const k of keys) {
    const out = vimKey(k, pending);
    pending = out.pending;
    if (out.action) actions.push(out.action);
  }
  return { actions, pending };
}

describe("atui vim mode", () => {
  it("moves by lines with counts, by pages with Ctrl, and to either end", () => {
    expect(run(key("j")).actions).toEqual([{ kind: "scroll", lines: 1 }]);
    expect(run(key("1"), key("2"), key("k")).actions).toEqual([{ kind: "scroll", lines: -12 }]);
    expect(run(key("d", { ctrl: true }), key("b", { ctrl: true })).actions).toEqual([
      { kind: "half", dir: 1 },
      { kind: "page", dir: -1 },
    ]);
    expect(run(key("g"), key("g"), key("G")).actions).toEqual([{ kind: "top" }, { kind: "bottom" }]);
    // A lone g waits; anything but g after it is nothing.
    expect(run(key("g")).pending).toBe("g");
    expect(run(key("g"), key("j"))).toEqual({ actions: [], pending: "" });
  });

  it("jumps between turns, folds, and leaves for typing, the sessions, or the pickers", () => {
    expect(run(key("2"), key("}"), key("{")).actions).toEqual([
      { kind: "turn", count: 2 },
      { kind: "turn", count: -1 },
    ]);
    expect(run(key("z"), key("R"), key("z"), key("M")).actions).toEqual([
      { kind: "folds", open: true },
      { kind: "folds", open: false },
    ]);
    // o is vim's "open below": a new chat, straight into INSERT; the others just type.
    for (const k of ["i", "a", "A"]) expect(run(key(k)).actions).toEqual([{ kind: "insert" }]);
    expect(run(key("o")).actions).toEqual([{ kind: "insert", open: true }]);
    expect(run(key("h"), key("l"), key(":"), key("/"), key("q")).actions.map((a) => a.kind)).toEqual(["sidebar", "leave", "palette", "history", "closeTab"]);
    // Alt and unknown Ctrl keys are not NORMAL's: they fall through to atui's own.
    expect(run(key("j", { meta: true })).actions).toEqual([]);
    expect(run(key("c", { ctrl: true })).actions).toEqual([]);
  });

  it("tabs by vim's gt, quits by ZZ, centres by zz, and leads with Space or ?", () => {
    expect(run(key("g"), key("t")).actions).toEqual([{ kind: "tab", step: 1 }]);
    expect(run(key("g"), key("T")).actions).toEqual([{ kind: "tab", step: -1 }]);
    expect(run(key("2"), key("g"), key("t")).actions).toEqual([{ kind: "tab", to: 1 }]);
    expect(run(key("z"), key("z")).actions).toEqual([{ kind: "view", where: "middle" }]);
    expect(run(key("Z"), key("Z")).actions).toEqual([{ kind: "quit" }]);
    // A lone Z waits; anything but Z after it is nothing, as with g.
    expect(run(key("Z")).pending).toBe("Z");
    expect(run(key("Z"), key("j"))).toEqual({ actions: [], pending: "" });
    for (const space of [key(" ", { name: "space" }), key("?", { name: "?" })]) expect(run(space).actions).toEqual([{ kind: "leader" }]);
  });

  it("walks the jumplist: Ctrl+O back, Ctrl+I (Tab) forward", () => {
    expect(run(key("o", { ctrl: true }), key("i", { ctrl: true }), key("tab")).actions).toEqual([
      { kind: "jump", dir: -1 },
      { kind: "jump", dir: 1 },
      { kind: "jump", dir: 1 },
    ]);
  });
  it("finds the scroll to the next or previous turn's top", () => {
    const tops = [10, 40, 90, 130];
    expect(turnOffset(tops, 50, 1)).toBe(40);
    expect(turnOffset(tops, 50, 2)).toBe(80);
    expect(turnOffset(tops, 50, -1)).toBe(-10);
    expect(turnOffset(tops, 50, -5)).toBe(-40);
    expect(turnOffset(tops, 200, 1)).toBeNull();
  });
});

describe("atui prefs", () => {
  it("remembers vim mode beside the server's config, and survives a bad file", () => {
    const home = tempDir("awui-atui-prefs-");
    expect(prefsFile({ HOME: home })).toBe(path.join(home, ".config", "awui", "atui.json"));
    expect(prefsFile({ XDG_CONFIG_HOME: "/x", HOME: home })).toBe("/x/awui/atui.json");
    const file = prefsFile({ HOME: home });
    expect(readPrefs(file)).toEqual({});
    // The style is remembered on its own, and an old vim choice migrates to it (a later keybinds wins).
    writePrefs({ keybinds: "vim" }, file);
    expect(readPrefs(file)).toEqual({ keybinds: "vim" });
    writePrefs({ vim: true }, file);
    expect(readPrefs(file)).toMatchObject({ vim: true, keybinds: "vim" });
    writePrefs({ vim: false, keybinds: "emacs" }, file);
    expect(readPrefs(file)).toMatchObject({ vim: false, keybinds: "emacs" });
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{not json");
    expect(readPrefs(file)).toEqual({});
  });
});
