// Drag handle on the sidebar's right edge (wide screens only). Pointer drag,
// arrow keys (Shift for bigger steps), Home/End, and double-click to reset.
import { useRef } from "react";

export const SIDEBAR_DEFAULT = 292;
export const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 560;

export function sidebarMax(): number {
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(window.innerWidth * 0.5)));
}

export function clampSidebar(width: number): number {
  return Math.round(Math.min(Math.max(width, SIDEBAR_MIN), sidebarMax()));
}

export function SidebarResizer({
  width,
  onResize,
  onCommit,
}: {
  width: number;
  onResize: (width: number) => void;
  /** Called once a drag or key press settles, to persist the width. */
  onCommit: (width: number) => void;
}) {
  const drag = useRef<{ startX: number; startW: number; last: number } | null>(null);

  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.classList.remove("is-resizing");
    onCommit(d.last);
  };

  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={sidebarMax()}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { startX: e.clientX, startW: width, last: width };
        document.body.classList.add("is-resizing");
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.last = clampSidebar(d.startW + e.clientX - d.startX);
        onResize(d.last);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => {
        onResize(SIDEBAR_DEFAULT);
        onCommit(SIDEBAR_DEFAULT);
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        let next: number | null = null;
        if (e.key === "ArrowLeft") next = width - step;
        else if (e.key === "ArrowRight") next = width + step;
        else if (e.key === "Home") next = SIDEBAR_MIN;
        else if (e.key === "End") next = sidebarMax();
        else if (e.key === "Enter") next = SIDEBAR_DEFAULT;
        if (next === null) return;
        e.preventDefault();
        const clamped = clampSidebar(next);
        onResize(clamped);
        onCommit(clamped);
      }}
    />
  );
}
