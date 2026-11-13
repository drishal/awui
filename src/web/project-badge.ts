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
