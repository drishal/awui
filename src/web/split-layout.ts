// Geometry only: main chat beside a second chat. Both React panes keep their
// own stream and draft ownership; the project tool is an adjoining surface.
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type * as React from "react";
import { load, save } from "./storage.js";

export const DEFAULT_SIDE_RATIO = 0.5;
const HANDLE = 9;

export function splitBounds(total: number, tool: boolean): { min: number; max: number } {
  return { min: Math.round((total - HANDLE) * (tool ? 0.30 : 0.25)), max: Math.round((total - HANDLE) * (tool ? 0.50 : 0.75)) };
}

export function splitWidth(total: number, ratio: number, tool = false): number {
  const bounded = Math.max(0.25, Math.min(0.75, ratio));
  const bounds = splitBounds(total, tool);
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, (total - HANDLE) * (1 - bounded))));
}

export function splitKey(key: string, width: number, total: number, tool: boolean, shift = false): number | null {
  const bounds = splitBounds(total, tool);
  if (key === "Home") return bounds.min;
  if (key === "End") return bounds.max;
  if (key === "Enter") return splitWidth(total, DEFAULT_SIDE_RATIO, tool);
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  return Math.max(bounds.min, Math.min(bounds.max, width + (shift ? 64 : 16) * (key === "ArrowLeft" ? -1 : 1)));
}

export function useSplitLayout(ref: RefObject<HTMLElement | null>, hasTool: boolean) {
  const separator = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number; total: number; last: number } | null>(null);
  const [total, setTotal] = useState(() => innerWidth);
  const [ratio, setRatio] = useState(() => load<number>("splitRatio", DEFAULT_SIDE_RATIO));
  const [dragging, setDragging] = useState(false);
  const width = useMemo(() => splitWidth(total, ratio, hasTool), [total, ratio, hasTool]);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(() => {
      const size = ref.current?.clientWidth;
      if (size) setTotal(size);
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref]);
  useEffect(() => () => document.body.classList.remove("is-resizing"), []);

  const end = (event: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    document.body.classList.remove("is-resizing");
    setDragging(false);
    const next = Math.max(0.25, Math.min(0.75, 1 - d.last / d.total));
    setRatio(next);
    save("splitRatio", next);
  };
  return {
    ref: separator,
    style: { "--main-split-width": `${width}px` } as React.CSSProperties,
    value: Math.min(hasTool ? 50 : 75, Math.max(hasTool ? 30 : 25, Math.round(width / Math.max(1, total - HANDLE) * 100))),
    dragging, toggle: () => { setRatio(DEFAULT_SIDE_RATIO); save("splitRatio", DEFAULT_SIDE_RATIO); },
    start: (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const main = ref.current?.firstElementChild;
      drag.current = { x: event.clientX, width: main instanceof HTMLElement ? main.clientWidth : width, total, last: width };
      document.body.classList.add("is-resizing");
      setDragging(true);
    },
    move: (event: React.PointerEvent<HTMLDivElement>) => {
      if (!drag.current || !ref.current) return;
      const bounds = splitBounds(ref.current.clientWidth, hasTool);
      drag.current.last = Math.round(Math.min(bounds.max, Math.max(bounds.min, drag.current.width + event.clientX - drag.current.x)));
      setRatio(1 - drag.current.last / drag.current.total);
    },
    end,
    key: (event: React.KeyboardEvent<HTMLDivElement>) => {
      const next = splitKey(event.key, width, total, hasTool, event.shiftKey);
      if (next === null) return;
      event.preventDefault();
      const nextRatio = Math.max(0.25, Math.min(0.75, 1 - next / (total - HANDLE)));
      setRatio(nextRatio);
      save("splitRatio", nextRatio);
    },
  };
}
