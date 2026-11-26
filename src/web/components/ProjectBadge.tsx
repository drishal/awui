// The folder row's badge: the project's icon on this device when one is set, else
// its monogram (one letter, in one of four theme colours from the name).
import { projectMonogram, type ProjectMonogram } from "../project-badge.js";
import { useProjectIcons } from "../project-icons.js";

/**
 * The glyph a badge shows: the icon this device picked for the folder, else its monogram letter. `slot` is
 * the hue the sidebar worked out for the whole set of projects (project-badge.ts's `projectSlots`), so no two
 * folders beside each other wear one; without it the badge takes the hue of its name alone.
 */
export function ProjectBadge({ id, name, size = 16, slot: given }: { id?: string; name: string; size?: number; slot?: ProjectMonogram["slot"] }) {
  const icons = useProjectIcons();
  const icon = id === undefined ? undefined : icons[id];
  const { letter, slot } = projectMonogram(name);
  return (
    // `data-icon` says which it is: an icon is set a touch larger than a letter (sidebar.css).
    <span className="project-badge" aria-hidden="true" data-slot={given ?? slot} data-icon={icon === undefined ? undefined : ""} style={{ width: size, height: size }}>
      {icon ?? letter}
    </span>
  );
}
