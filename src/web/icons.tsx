// Small inline stroke icons (no icon font, no CDN). 16px grid, currentColor.
import type { ToolCategory } from "../shared/protocol.js";

type IconProps = { size?: number; className?: string };

function Svg({ size = 16, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconFile = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 1.75h5l3 3v9.5H4z" />
    <path d="M9 1.75v3h3M6 8h4M6 10.5h4" />
  </Svg>
);
export const IconEdit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.5 2.5l3 3-7.75 7.75H2.75v-3z" />
    <path d="M9 4l3 3" />
  </Svg>
);
export const IconFilePlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 1.75h5l3 3v9.5H4z" />
    <path d="M8 7v4.5M5.75 9.25h4.5" />
  </Svg>
);
export const IconTerminal = (p: IconProps) => (
  <Svg {...p}>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
    <path d="M4.5 6.25l2 1.75-2 1.75M8 10.25h3.25" />
  </Svg>
);
/** A test run: a flask with its liquid line. */
export const IconFlask = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.25 1.75h3.5M6.75 1.75v4.5L2.9 12.4a1.2 1.2 0 001.05 1.85h8.1a1.2 1.2 0 001.05-1.85L9.25 6.25v-4.5" />
    <path d="M4.6 10h6.8" />
  </Svg>
);
export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="M10.25 10.25l3.5 3.5" />
  </Svg>
);
export const IconGlobe = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M1.75 8h12.5M8 1.75c1.75 1.9 2.5 3.9 2.5 6.25S9.75 12.35 8 14.25C6.25 12.35 5.5 10.35 5.5 8S6.25 3.65 8 1.75z" />
  </Svg>
);
export const IconTool = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.75 2.25a3.25 3.25 0 00-3.4 4.4L2.25 10.75v3h3l4.1-4.1a3.25 3.25 0 004.4-3.4l-2 2-2-.5-.5-2z" />
  </Svg>
);
/** A lead and a helper: delegation to subagents. */
export const IconAgents = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6" cy="5" r="2.25" />
    <path d="M1.75 13.5c.4-2.4 2.1-3.75 4.25-3.75s3.85 1.35 4.25 3.75" />
    <circle cx="11.25" cy="5.75" r="1.75" />
    <path d="M11.5 9.6c1.6.2 2.5 1.3 2.75 3" />
  </Svg>
);
export const IconSpark = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 1.75v3M8 11.25v3M1.75 8h3M11.25 8h3M3.6 3.6l2 2M10.4 10.4l2 2M12.4 3.6l-2 2M5.6 10.4l-2 2" />
  </Svg>
);
export const IconChevronUp = (p: IconProps) => (
  <Svg {...p}>
    <path d="m4 10 4-4 4 4" />
  </Svg>
);
export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6l4 4 4-4" />
  </Svg>
);
export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 4l4 4-4 4" />
  </Svg>
);
export const IconChevronLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 4l-4 4 4 4" />
  </Svg>
);
/** `draw` makes the stroke draw itself in (motion.css, .check-draw); set it only for a check that appears in place, never on first paint. */
export const IconCheck = ({ draw, className, ...p }: IconProps & { draw?: boolean }) => (
  <Svg {...p} className={draw ? `check-draw${className ? ` ${className}` : ""}` : className}>
    <path d="M3 8.5l3 3 7-7" pathLength={1} />
  </Svg>
);
export const IconX = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);
export const IconArrowUp = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 13V3M3.75 7.25L8 3l4.25 4.25" />
  </Svg>
);
export const IconStop = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1.5" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.75" />
    <path d="M10.75 5.25V3.75a1.5 1.5 0 00-1.5-1.5h-5a1.5 1.5 0 00-1.5 1.5v5a1.5 1.5 0 001.5 1.5h1.5" />
  </Svg>
);
export const IconFork = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.25 4.5v7" />
    <circle cx="4.25" cy="12.5" r="1.75" />
    <circle cx="11.75" cy="4.5" r="1.75" />
    <path d="M11.75 6.25a6.25 6.25 0 0 1-6.25 6.25" />
  </Svg>
);
export const IconPin = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 2h4M6.75 2v4.25L4.5 9h7L9.25 6.25V2M8 9v5" />
  </Svg>
);
export const IconArchive = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="2.75" width="12" height="3" rx="0.75" />
    <path d="M3 5.75v6.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-6.5M6.5 8.5h3" />
  </Svg>
);
export const IconUndo = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.5 3.25 2.75 6l2.75 2.75" />
    <path d="M2.75 6h6.5a4 4 0 0 1 0 8h-2.5" />
  </Svg>
);
export const IconBranch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="4.5" cy="3.5" r="1.5" />
    <circle cx="4.5" cy="12.5" r="1.5" />
    <circle cx="11.5" cy="5" r="1.5" />
    <path d="M4.5 5v6M11.5 6.5c0 3-7 2-7 4.5" />
  </Svg>
);
export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 4.75V8l2.25 1.5" />
  </Svg>
);
export const IconMenu = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
  </Svg>
);
export const IconMore = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="3.5" cy="8" r="0.9" fill="currentColor" />
    <circle cx="8" cy="8" r="0.9" fill="currentColor" />
    <circle cx="12.5" cy="8" r="0.9" fill="currentColor" />
  </Svg>
);
export const IconWarning = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2l6.25 11H1.75z" />
    <path d="M8 6.5v3M8 11.5v.01" />
  </Svg>
);
export const IconShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 1.75l5.25 2v4.1c0 3-2.2 5.3-5.25 6.4-3.05-1.1-5.25-3.4-5.25-6.4v-4.1z" />
  </Svg>
);
export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 7.25v4M8 4.75v.01" />
  </Svg>
);
export const IconFolder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.75 4.25a1.5 1.5 0 011.5-1.5h3l1.5 1.75h5a1.5 1.5 0 011.5 1.5v6.25a1.5 1.5 0 01-1.5 1.5h-9.5a1.5 1.5 0 01-1.5-1.5z" />
  </Svg>
);
export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.25 8a5.25 5.25 0 11-1.6-3.77" />
    <path d="M13.25 2.75v3h-3" />
  </Svg>
);
/** A window with its left panel marked: collapse / expand the sidebar. */
export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.1" />
    <path d="M8 1.6v1.6M8 12.8v1.6M14.4 8h-1.6M3.2 8H1.6M12.53 3.47l-1.13 1.13M4.6 11.4l-1.13 1.13M12.53 12.53l-1.13-1.13M4.6 4.6 3.47 3.47" />
    <circle cx="8" cy="8" r="4.6" />
  </Svg>
);

export const IconSidebar = (p: IconProps) => (
  <Svg {...p}>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75" />
    <path d="M6 2.75v10.5M3.5 5.5h1M3.5 7.5h1" />
  </Svg>
);
export const IconImage = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="2.75" width="12" height="10.5" rx="1.75" />
    <circle cx="5.75" cy="6.25" r="1.1" />
    <path d="M2.5 11.5l3.25-3 2.5 2.25 2-1.75 3.25 2.75" />
  </Svg>
);
export const IconScreen = (p: IconProps) => (
  <Svg {...p}>
    <rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1.5" />
    <path d="M6 14h4M8 11v3" />
  </Svg>
);
export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);
/** The prompt stash: a tray with an arrow into it. */
export const IconStash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 9.5h3l1 1.5h3l1-1.5h3M2.5 9.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3M8 2.5v5M5.75 5.25 8 7.5l2.25-2.25" />
  </Svg>
);
/** A link: two chain loops. */
export const IconLink = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.75 9.25a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-.75.75M9.25 6.75a2.5 2.5 0 0 0-3.5 0l-2 2a2.5 2.5 0 0 0 3.5 3.5l.75-.75" />
  </Svg>
);
/** A plan: a checklist. */
export const IconPlan = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.75 4.25 3.75 5.25l1.75-2M2.75 8.75l1 1 1.75-2M7.5 4.25h6M7.5 8.75h6M7.5 12.75h6M3 12.75h1.5" />
  </Svg>
);
/** A usage limit: a gauge at its end. */
export const IconGauge = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.75 11.5a5.25 5.25 0 1 1 10.5 0M8 11.5l3-3.5" />
  </Svg>
);
/** Open in a new tab: a box with an arrow out of its corner. */
export const IconNewTab = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 2.5h4v4M13.5 2.5 8 8M12 9.5v4H2.5V4h4" />
  </Svg>
);
export const IconQueue = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 4.5h11M2.5 8h7M2.5 11.5h5" />
  </Svg>
);
export const IconSteer = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 13c0-5 3-7.5 8.5-7.5" />
    <path d="M9 3l2.75 2.5L9 8" />
  </Svg>
);
export const IconCircle = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="4.75" strokeDasharray="2 2.2" />
  </Svg>
);
/** Two panes side by side: a chat beside the main one. */
export const IconSplit = (p: IconProps) => (
  <Svg {...p}>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75" />
    <path d="M8 2.75v10.5" />
  </Svg>
);

/** Two arrows passing: swap the two panes. */
export const IconSwap = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13" />
  </Svg>
);

export const IconDot = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none" />
  </Svg>
);

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg className="spinner" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M8 2a6 6 0 016 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** The working spinner: eight rays that fade one after another, so it turns without rotating (the stylesheet times each ray). */
export function RaySpinner({ size = 14 }: { size?: number }) {
  return (
    <svg className="rays" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M8 1.5v3" />
      <path d="M12.6 3.4l-2.1 2.1" />
      <path d="M14.5 8h-3" />
      <path d="M12.6 12.6l-2.1-2.1" />
      <path d="M8 14.5v-3" />
      <path d="M3.4 12.6l2.1-2.1" />
      <path d="M1.5 8h3" />
      <path d="M3.4 3.4l2.1 2.1" />
    </svg>
  );
}

export function ToolIcon({ category, size, test = false, plan = false }: { category: ToolCategory; size?: number; test?: boolean; plan?: boolean }) {
  const props = size ? { size } : {};
  if (test) return <IconFlask {...props} />;
  if (plan) return <IconPlan {...props} />;
  switch (category) {
    case "read":
      return <IconFile {...props} />;
    case "edit":
      return <IconEdit {...props} />;
    case "write":
      return <IconFilePlus {...props} />;
    case "command":
      return <IconTerminal {...props} />;
    case "search":
      return <IconSearch {...props} />;
    case "web":
      return <IconGlobe {...props} />;
    case "agent":
      return <IconAgents {...props} />;
    default:
      return <IconTool {...props} />;
  }
}

/** A failed call's mark: a ring with an exclamation point. */
export const IconAlertCircle = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 4.75v4M8 11.2v.05" />
  </Svg>
);
