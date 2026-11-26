// A project's folder carries a monogram instead of a generic folder icon: its
// first letter, in one of four theme colours taken from the name. Derived, so it
// looks the same on every device and needs nothing stored; a custom icon could sit
// on top later. A slot, not a hue angle: rotating the accent goes grey in a
// low-saturation theme, while the four tokens (--badge-1..4) are real theme roles.
export interface ProjectMonogram {
  letter: string;
  /** 1..4: which of tokens.css's --badge-N colours the badge wears. */
  slot: 1 | 2 | 3 | 4;
}

export function projectMonogram(name: string): ProjectMonogram {
  const trimmed = name.trim();
  const letter = (trimmed.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
  let hash = 0;
  for (const ch of trimmed) hash = (Math.imul(hash, 31) + (ch.codePointAt(0) ?? 0)) >>> 0;
  return { letter, slot: ((hash % 4) + 1) as ProjectMonogram["slot"] };
}

/**
 * The slot each of a set of projects wears (the sidebar's projects, in one list): its own hue from its name,
 * stepped on where the project before it in name order drew the same one. Four hues over three folders left
 * two of them the same colour by chance — `awui` and `dotfiles` both wore the teal — and a column of badges
 * that repeat says nothing. Name order, not drawn order, so a project keeps its hue from the folder heads to
 * the switch menu to the flat list's rows; past four projects the step only keeps neighbours apart.
 */
export function projectSlots(names: readonly string[]): Map<string, ProjectMonogram["slot"]> {
  const slots = new Map<string, ProjectMonogram["slot"]>();
  let previous: ProjectMonogram["slot"] | null = null;
  for (const name of [...new Set(names)].sort((a, b) => a.localeCompare(b))) {
    const own = projectMonogram(name).slot;
    const slot: ProjectMonogram["slot"] = previous !== null && own === previous ? ((own % 4) + 1) as ProjectMonogram["slot"] : own;
    slots.set(name, slot);
    previous = slot;
  }
  return slots;
}
