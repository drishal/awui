import { describe, expect, it } from "vitest";
import { matchSettings, type SettingsSectionText } from "../../src/web/settings-search.js";

// The words are the dialog's own rows (SettingsDialog.tsx): a row is its label and its description.
const SECTIONS: SettingsSectionText[] = [
  {
    id: "device",
    label: "This device",
    rows: [
      { key: "pair", text: "Other devices Open awui on a phone by scanning a code. Pair phone Sign out" },
      { key: "notify", text: "Notifications When a run finishes, fails, or asks for an answer." },
    ],
  },
  {
    id: "look",
    label: "Appearance",
    rows: [
      { key: "theme", text: "Theme Follow the system, or pin light or dark." },
      { key: "text-size", text: "Chat text size The conversation and the composer; menus keep their size." },
    ],
  },
  {
    id: "network",
    label: "Network and sign-in",
    rows: [
      { key: "host", text: "Listen on Every network this machine is on (0.0.0.0); other devices sign in." },
      { key: "port", text: "Port" },
      { key: "password", text: "Password Set. Type a new one to change it." },
    ],
  },
];

describe("settings search", () => {
  it("shows everything when nothing is typed", () => {
    expect(matchSettings(SECTIONS, "")).toBeNull();
    expect(matchSettings(SECTIONS, "   ")).toBeNull();
  });

  it("keeps only the sections with a matching row, and only that row", () => {
    const m = matchSettings(SECTIONS, "port");
    expect(m?.sections).toEqual(["network"]);
    expect(m?.rows).toEqual({ network: ["port"] });
  });

  it("keeps a whole section when its own name matches", () => {
    const m = matchSettings(SECTIONS, "appearance");
    expect(m?.sections).toEqual(["look"]);
    expect(m?.rows.look).toEqual(["theme", "text-size"]);
  });

  it("matches a word from the middle of a description, ignoring case", () => {
    const m = matchSettings(SECTIONS, "COMPOSER");
    expect(m?.rows.look).toEqual(["text-size"]);
  });

  it("narrows by every word typed, reading the section's name with each row", () => {
    expect(matchSettings(SECTIONS, "network port")?.rows).toEqual({ network: ["port"] });
    expect(matchSettings(SECTIONS, "port host")?.sections).toEqual([]);
    expect(matchSettings(SECTIONS, "password change")?.rows).toEqual({ network: ["password"] });
  });

  it("finds nothing for a word no row says", () => {
    expect(matchSettings(SECTIONS, "zebra")).toEqual({ sections: [], rows: {} });
  });

  it("matches a word, not a piece of one", () => {
    const sections: SettingsSectionText[] = [{ id: "x", label: "X", rows: [{ key: "report", text: "Report a problem" }, { key: "port", text: "Port" }, { key: "yml", text: "Read config.yml" }] }];
    expect(matchSettings(sections, "port")?.rows.x).toEqual(["port"]);
    expect(matchSettings(sections, "yml")?.rows.x).toEqual(["yml"]);
    expect(matchSettings(sections, "rep")?.rows.x).toEqual(["report"]);
  });
});
