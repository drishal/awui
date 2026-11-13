// The folder row's badge: the project's icon on this device when one is set, else
// its monogram (one letter, in one of four theme colours from the name).
import { projectMonogram } from "../project-badge.js";
import { useProjectIcons } from "../project-icons.js";

export function ProjectBadge({ id, name, size = 18 }: { id?: string; name: string; size?: number }) {
  const icons = useProjectIcons();
  const icon = id === undefined ? undefined : icons[id];
  const { letter, slot } = projectMonogram(name);
  return (
    <span className="project-badge" aria-hidden="true" data-slot={slot} style={{ width: size, height: size }}>
      {icon ?? letter}
    </span>
  );
}
