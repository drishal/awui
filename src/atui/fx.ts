// atui's motion and small graphics, worked out apart from the drawing so they
// can be tested: colour mixing for the "Working" shimmer and for ramps (the
// context going from green to amber to red), the pace streamed
// text is revealed at and the rate it arrives at, sparklines, meters, and diff stat bars drawn with
// block characters, eased scrolling, a fold unrolling, a one-off flash, the ghost thread a
// session opens behind, a slow breath for what waits on you, and each
// harness's spinner.

/** `#rrggbb` → [r, g, b]; anything else is black. */
function rgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? Number.parseInt(m[1] as string, 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The colour `t` of the way from `a` to `b` (0 is a, 1 is b). */
export function mix(a: string, b: string, t: number): string {
  const k = Math.min(1, Math.max(0, t));
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  const c = (x: number, y: number) => Math.round(x + (y - x) * k).toString(16).padStart(2, "0");
  return `#${c(ar, br)}${c(ag, bg)}${c(ab, bb)}`;
}

/**
 * The colour at `value` along a ramp of stops (`[at, colour]`, in order of
 * `at`): the nearest stops mixed, the ends held beyond them.
 */
export function ramp(value: number, stops: Array<[number, string]>): string {
  const first = stops[0];
  if (!first) return "#000000";
  if (value <= first[0]) return first[1];
  for (let i = 1; i < stops.length; i++) {
    const [at, color] = stops[i] as [number, string];
    const [from, base] = stops[i - 1] as [number, string];
    if (value <= at) return mix(base, color, at === from ? 1 : (value - from) / (at - from));
  }
  return (stops[stops.length - 1] as [number, string])[1];
}

/**
 * One colour per character of a shimmering label: a soft band of `glow`
 * sweeping left to right over `base`, one step per frame, with a pause past
 * the end so the sweep reads as a pulse rather than a scroll.
 */
export function shimmer(length: number, frame: number, base: string, glow: string, band = 4): string[] {
  const period = length + band * 3;
  const head = (frame % period) - band;
  return Array.from({ length }, (_, i) => mix(base, glow, Math.max(0, 1 - Math.abs(i - head) / band)));
}

/**
 * How many characters of a streaming text to show after `ms` more: at least
 * a steady typing pace, faster the further behind it is (so a big chunk
 * catches up within a few frames instead of lagging for seconds).
 */
export function revealStep(shown: number, target: number, ms: number): number {
  if (shown >= target) return target;
  const behind = target - shown;
  const perSecond = Math.max(90, behind * 6);
  return Math.min(target, shown + Math.max(1, Math.ceil((perSecond * ms) / 1000)));
}

/**
 * Tokens a second over `samples` (`[ms, characters so far]`, oldest first),
 * at about four characters a token, as the harnesses' own estimates go. Null
 * until the samples span half a second, too little to tell.
 */
export function streamRate(samples: Array<[number, number]>): number | null {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last || last[0] - first[0] < 500) return null;
  return Math.max(0, (last[1] - first[1]) / 4 / ((last[0] - first[0]) / 1000));
}

/** Where to cut `text` near `n` characters so a word or Markdown token is not shown half-made. */
export function revealCut(text: string, n: number): string {
  if (n >= text.length) return text;
  const space = text.lastIndexOf(" ", n);
  const newline = text.lastIndexOf("\n", n);
  const at = Math.max(space, newline);
  return text.slice(0, at > n - 12 ? at : n);
}

const BLOCKS = "▁▂▃▄▅▆▇█";

/** `▁▃▅█`: one block per value, scaled from 0 to `max` (the largest value when absent). */
export function sparkline(values: number[], max = Math.max(0, ...values)): string {
  if (values.length === 0) return "";
  return values.map((v) => (max <= 0 ? BLOCKS[0] : BLOCKS[Math.min(7, Math.max(0, Math.round((v / max) * 7)))])).join("");
}

const EIGHTHS = " ▏▎▍▌▋▊▉";

/** A meter `width` cells wide, filled to `fraction` with eighth blocks: `████▌   `. */
export function meter(fraction: number, width: number): string {
  const f = Math.min(1, Math.max(0, fraction));
  const eighths = Math.round(f * width * 8);
  const full = Math.floor(eighths / 8);
  const part = eighths % 8;
  return ("█".repeat(full) + (part > 0 ? EIGHTHS[part] : "")).padEnd(width, " ").slice(0, width);
}

/**
 * A diff stat bar, `git --stat` style: a file's added and removed lines as
 * cells of a bar `width` wide, scaled to the largest change in the list
 * (`max`), so files compare at a glance. A side that changed gets a cell even
 * when it is small beside the other.
 */
export function statBar(added: number, removed: number, max: number, width: number): { add: number; del: number; rest: number } {
  const total = added + removed;
  if (total <= 0 || width <= 0) return { add: 0, del: 0, rest: Math.max(0, width) };
  const cells = Math.min(width, Math.max(1, Math.round((total / Math.max(total, max)) * width)));
  let add = Math.round((cells * added) / total);
  if (added > 0 && add === 0) add = 1;
  if (removed > 0 && add === cells && cells > 1) add = cells - 1;
  const del = removed > 0 ? cells - add : 0;
  return { add, del, rest: width - add - del };
}

/** Ease-out cubic: fast at first, settling at the end. */
export const easeOut = (t: number): number => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

/** The scroll positions an eased move from `from` to `to` passes through, one per frame, ending exactly at `to`. */
export function scrollPath(from: number, to: number, frames: number): number[] {
  const n = Math.max(1, Math.round(frames));
  const out: number[] = [];
  for (let i = 1; i <= n; i++) out.push(Math.round(from + (to - from) * easeOut(i / n)));
  return out;
}

/** How many of a fold's `n` rows show on each of the `frames` it takes to open: most at once, all by the last. */
export function unrollCounts(n: number, frames: number): number[] {
  const k = Math.max(1, Math.round(frames));
  return Array.from({ length: k }, (_, i) => Math.min(n, Math.max(1, Math.ceil(n * easeOut((i + 1) / k)))));
}

/** A one-off flash's strength at `t` (0 to 1 of its length): up quickly, then fading out slowly. */
export function flashAt(t: number): number {
  const k = Math.min(1, Math.max(0, t));
  return k < 0.15 ? k / 0.15 : (1 - (k - 0.15) / 0.85) ** 2;
}

/** A slow breath, 0 to 1 and back, `period` ticks long: what waits on you, without the urgency of a blink. */
export function breathe(tick: number, period: number): number {
  return (1 - Math.cos((2 * Math.PI * tick) / period)) / 2;
}

/** The ghost thread's lines under its prompt card, as fractions of the column: a fold, then an answer's lines (0 is a gap between paragraphs). */
const GHOST = [0.3, 0, 0.94, 0.88, 0.97, 0.62, 0, 0.9, 0.71];

/** The ghost thread for a column `width` wide: the prompt's bar inside its card, then each line's bar, in cells. */
export function ghostLines(width: number): { prompt: number; lines: number[] } {
  const w = Math.max(12, Math.floor(width));
  return { prompt: Math.round((w - 4) * 0.55), lines: GHOST.map((f) => Math.round(w * f)) };
}

const SPINNERS: Record<string, string[]> = {
  pi: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  omp: ["◐", "◓", "◑", "◒"],
  claude: ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"],
  hermes: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
  // OpenCode's square mark, turning.
  opencode: ["▖", "▘", "▝", "▗"],
  // Codex's ring, turning.
  codex: ["▙", "▛", "▜", "▟"],
  // DeepSeek Harness's spark, turning.
  dsh: ["✦", "✧", "✶", "✷"],
};

/** Each harness's own spinner (Claude Code's asterisks for Claude, omp's moon for omp); braille dots otherwise. */
export function spinnerFor(harnessId: string | null | undefined): string[] {
  return SPINNERS[harnessId ?? ""] ?? (SPINNERS.pi as string[]);
}
