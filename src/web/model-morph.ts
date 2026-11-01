// The model picker's measured morph (A8): the panel uncovers from the chip's rect,
// not just its corner. Pure: the component measures both rects and animates between them.
export interface Box {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

/** The clip the panel starts under: each side's distance from the panel's edge to the chip's, clamped at the edge. */
export function morphClip(chip: Box, panel: Box): string {
  const top = Math.max(0, chip.top - panel.top);
  const right = Math.max(0, panel.right - chip.right);
  const bottom = Math.max(0, panel.bottom - chip.bottom);
  const left = Math.max(0, chip.left - panel.left);
  return `inset(${top}px ${right}px ${bottom}px ${left}px)`;
}
