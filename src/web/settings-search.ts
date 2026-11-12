// Settings' search: which sections, and which of their rows, still match what
// was typed. The rows' words come from the dialog's own page (every row carries
// data-settings-row), so this index cannot drift from what is on screen; this
// module only decides what matches. Pure, so the rules are unit-tested
// (tests/unit/settings-search.test.ts).
export interface SettingsRowText {
  /** The row's key in the dialog (data-settings-row). */
  key: string;
  /** The row's words: its label and its description. */
  text: string;
}

export interface SettingsSectionText {
  id: string;
  /** The section's name, as the rail and the pane's heading read it. */
  label: string;
  rows: readonly SettingsRowText[];
}

export interface SettingsMatches {
  /** The sections to keep in the rail, in the order they were given. */
  sections: string[];
  /** Per section, the rows to keep: all of them when the section's own name matched. */
  rows: Record<string, string[]>;
}

/** Lowercased, with runs of whitespace folded, so a query compares against words. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * What a search keeps: the sections with a row that still says what was typed,
 * and those rows. A row's words are its own and its section's name, so
 * "appearance" keeps that whole section, and "network port" the one row that
 * says both. Every word typed must appear, so more words only narrow. `null`
 * when nothing was typed (everything shows).
 */
export function matchSettings(sections: readonly SettingsSectionText[], query: string): SettingsMatches | null {
  const terms = normalize(query).split(" ").filter(Boolean);
  if (terms.length === 0) return null;
  // A word starts a word: "port" finds Port and portable but not report, and "yml" still finds config.yml.
  const starts = terms.map((term) => new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const says = (text: string) => {
    const words = normalize(text);
    return starts.every((term) => term.test(words));
  };
  const matches: SettingsMatches = { sections: [], rows: {} };
  for (const section of sections) {
    const keys = section.rows.filter((row) => says(`${section.label} ${row.text}`)).map((row) => row.key);
    if (keys.length === 0) continue;
    matches.sections.push(section.id);
    matches.rows[section.id] = keys;
  }
  return matches;
}
