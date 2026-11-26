// A folder's path as a person reads it in the sidebar's project menu: relative to the home folder, and cut in
// the middle so both ends survive — where it lives (`~`) and what it is (`~/…/dotfiles`). The old menu let the
// browser ellipsise the left of a full path, which kept the tail but lost the root, so two folders under
// different roots read alike. Pure, and unit-tested.

/** `~` for the home folder, and `/` after it: "/home/me/projects/dotfiles" -> "~/projects/dotfiles". */
export function homePath(full: string, home: string): string {
  if (!home) return full;
  const base = home.endsWith("/") ? home.slice(0, -1) : home;
  if (full === base) return "~";
  return full.startsWith(`${base}/`) ? `~${full.slice(base.length)}` : full;
}

/**
 * A path with its middle taken out when it is longer than `max`: the root stays (home, or the first folder of
 * an absolute path) and the tail stays whole, so "~/projects/awui/.awui/worktrees/x" reads "~/…/worktrees/x".
 */
export function middlePath(text: string, max: number): string {
  if (text.length <= max) return text;
  const parts = text.split("/").filter(Boolean);
  const root = text.startsWith("~/") ? "~" : text.startsWith("/") ? `/${parts[0] ?? ""}` : "";
  const rest = root === "~" ? parts : parts.slice(root ? 1 : 0);
  const tail = rest.at(-1) ?? text;
  const prefix = root ? `${root}/…/` : "…/";
  // One last segment longer than the room there is: keep its own end, which is the name that matters.
  if (prefix.length + tail.length > max) return `…${tail.slice(Math.max(0, tail.length - (max - 1)))}`;
  let kept = tail;
  for (let i = rest.length - 2; i >= 1; i--) {
    const next = `${rest[i]}/${kept}`;
    if (prefix.length + next.length > max) break;
    kept = next;
  }
  return `${prefix}${kept}`;
}

/** The menu's one line for a folder: home-relative when it is under home, middle-cut when it is long. */
export function shortPath(full: string, home: string, max = 30): string {
  return middlePath(homePath(full, home), max);
}
