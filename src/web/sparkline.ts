// The context panel's sparkline: the chat's context readings (percent, oldest first) as points in a
// small box. Pure: downsampling to at most 60 points (a drop is kept when it falls between two kept
// readings, so a compaction never disappears), scaling on a fixed 0-100 % axis so the 90 % line sits
// still, and the sentence a screen reader gets. ContextRing.tsx only draws what this returns.
import type { ContextPoint } from "../shared/protocol.js";

export const SPARK_W = 120;
export const SPARK_H = 28;
const PAD = 3;
/** The most points drawn; a longer history is thinned to this many. */
export const SPARK_MAX_POINTS = 60;
/** A fall of this many percentage points between readings is a compaction (the context does not shrink otherwise). */
export const COMPACT_DROP = 5;

export interface SparkPoint {
  x: number;
  y: number;
  /** The context fell here: a compaction. */
  drop: boolean;
}

export interface Spark {
  points: SparkPoint[];
  /** SVG path data of the line. */
  path: string;
  /** The same line closed down to the box's floor, for the soft area the full view fills under it. */
  area: string;
  /** The latest reading, where the full view draws its dot. */
  end: { x: number; y: number };
  /** Where the 90 % line sits. */
  warnY: number;
  label: string;
}

/** The readings that carry a percent, as plain numbers. */
export function percents(history: ContextPoint[]): number[] {
  return history.flatMap((p) => (p.percent === null || !Number.isFinite(p.percent) ? [] : [Math.max(0, Math.min(100, p.percent))]));
}

/** Thin a series to at most `max` readings, always keeping the first and last; `drop` marks where a compaction fell in the stretch a kept reading stands for. */
export function downsample(values: number[], max = SPARK_MAX_POINTS): Array<{ value: number; drop: boolean }> {
  const dropAt = values.map((v, i) => i > 0 && (values[i - 1] as number) - v >= COMPACT_DROP);
  if (values.length <= max) return values.map((value, i) => ({ value, drop: dropAt[i] === true }));
  const out: Array<{ value: number; drop: boolean }> = [];
  let prev = -1;
  for (let k = 0; k < max; k++) {
    const i = Math.round((k * (values.length - 1)) / (max - 1));
    let drop = false;
    for (let j = prev + 1; j <= i; j++) if (dropAt[j]) drop = true;
    out.push({ value: values[i] as number, drop });
    prev = i;
  }
  return out;
}

/** The sparkline for a history, or null while there are fewer than two readings to join. */
export function sparkline(history: ContextPoint[]): Spark | null {
  const thin = downsample(percents(history));
  if (thin.length < 2) return null;
  const inner = SPARK_H - PAD * 2;
  const y = (pct: number) => +(PAD + inner * (1 - pct / 100)).toFixed(2);
  const points = thin.map((p, i): SparkPoint => ({ x: +(PAD + ((SPARK_W - PAD * 2) * i) / (thin.length - 1)).toFixed(2), y: y(p.value), drop: p.drop }));
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");
  const head = points[0] as SparkPoint;
  const end = points[points.length - 1] as SparkPoint;
  const area = `${path} L${end.x} ${SPARK_H - PAD} L${head.x} ${SPARK_H - PAD} Z`;
  const first = Math.round((thin[0] as { value: number }).value);
  const last = Math.round((thin[thin.length - 1] as { value: number }).value);
  const compactions = thin.filter((p) => p.drop).length;
  const label = `Context per turn: ${first}% … ${last}%${compactions > 0 ? `, compacted ${compactions} ${compactions === 1 ? "time" : "times"}` : ""}`;
  return { points, path, area, end: { x: end.x, y: end.y }, warnY: y(90), label };
}
