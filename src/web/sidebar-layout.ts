// Sidebar geometry and presence: the stored width, the collapse toggle (the
// only thing that animates), the narrow-window auto-fold, and the phone drawer.
import { useEffect, useRef, useState } from "react";
import { clampSidebar, SIDEBAR_DEFAULT } from "./components/SidebarResizer.js";
import { load, save } from "./storage.js";

/** Below this width (and above the phone drawer's 820 px) the sidebar folds away by itself. */
const AUTO_COLLAPSE_BELOW = 1200;
const NARROW_QUERY = `(min-width: 820px) and (max-width: ${AUTO_COLLAPSE_BELOW - 1}px)`;
/** From this width a collapsed sidebar leaves its 44 px rail; narrower, it hides completely. */
const RAIL_QUERY = "(min-width: 1100px)";

export function useSidebarLayout() {
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => clampSidebar(load<number>("sidebarWidth", SIDEBAR_DEFAULT)));
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => load<boolean>("sidebarCollapsed", false));
  // Animate only the toggle; resizing by drag must follow the pointer exactly.
  const [sidebarToggling, setSidebarToggling] = useState(false);
  const toggleTimer = useRef<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Narrow windows (a vertical monitor, a tiled half screen) fold the sidebar away by
  // themselves, unless the user reopens it; crossing the threshold again resets that.
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  const [rail, setRail] = useState(() => window.matchMedia(RAIL_QUERY).matches);
  const [openedWhileNarrow, setOpenedWhileNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY);
    const onChange = () => {
      setNarrow(query.matches);
      setOpenedWhileNarrow(false);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  useEffect(() => {
    const query = window.matchMedia(RAIL_QUERY);
    const onChange = () => setRail(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // Keep the sidebar inside its bounds when the window shrinks.
  useEffect(() => {
    const onResize = () => setSidebarWidth((w) => clampSidebar(w));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /** Fold the sidebar away or back (wide screens); focus follows to the other toggle. */
  const collapseSidebar = (collapsed: boolean) => {
    setSidebarToggling(true);
    if (toggleTimer.current !== null) window.clearTimeout(toggleTimer.current);
    toggleTimer.current = window.setTimeout(() => setSidebarToggling(false), 250);
    // A collapse by hand sticks at every width; reopening in a narrow window lasts until it widens.
    setSidebarCollapsed(collapsed);
    save("sidebarCollapsed", collapsed || null);
    if (!collapsed && narrow) setOpenedWhileNarrow(true);
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>(collapsed ? ".sidebar-expand" : ".sidebar-collapse")?.focus());
  };

  /** Persist a settled drag or key resize; the default width means "unset". */
  const commitSidebarWidth = (w: number): void => save("sidebarWidth", w === SIDEBAR_DEFAULT ? null : w);

  return {
    sidebarWidth,
    setSidebarWidth,
    commitSidebarWidth,
    sidebarCollapsed,
    sidebarToggling,
    collapseSidebar,
    drawerOpen,
    setDrawerOpen,
    narrow,
    openedWhileNarrow,
    rail,
  };
}
