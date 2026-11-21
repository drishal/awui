// A dependency-free QR encoder for the mesh invite codes (SPEC-P2 §3). Byte
// mode, UTF-8, ECC level M by default, versions 1-15 chosen by the data's
// length, and the mask the standard's four-rule penalty likes best. The result
// is a plain boolean matrix (true = dark) that the server, the web UI, and the
// terminal clients can render without a DOM or a package.
//
// Invite codes are short, so versions beyond 15 (where alignment and version
// blocks get denser) are out of scope; that keeps the block table small and
// still holds a 412-byte payload at level M.

export type QrEcc = "L" | "M" | "Q" | "H";

/** The two bits each level contributes to the format information. */
const ECC_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };

/**
 * Per version and level: [EC codewords per block, first group blocks, first
 * group data codewords, second group blocks, second group data codewords]
 * (ISO/IEC 18004 table 9). Version 1 is index 0.
 */
type BlockSpec = readonly [ec: number, blocks1: number, data1: number, blocks2: number, data2: number];

const BLOCKS: readonly Record<QrEcc, BlockSpec>[] = [
  { L: [7, 1, 19, 0, 0], M: [10, 1, 16, 0, 0], Q: [13, 1, 13, 0, 0], H: [17, 1, 9, 0, 0] },
  { L: [10, 1, 34, 0, 0], M: [16, 1, 28, 0, 0], Q: [22, 1, 22, 0, 0], H: [28, 1, 16, 0, 0] },
  { L: [15, 1, 55, 0, 0], M: [26, 1, 44, 0, 0], Q: [18, 2, 17, 0, 0], H: [22, 2, 13, 0, 0] },
  { L: [20, 1, 80, 0, 0], M: [18, 2, 32, 0, 0], Q: [26, 2, 24, 0, 0], H: [16, 4, 9, 0, 0] },
  { L: [26, 1, 108, 0, 0], M: [24, 2, 43, 0, 0], Q: [18, 2, 15, 2, 16], H: [22, 2, 11, 2, 12] },
  { L: [18, 2, 68, 0, 0], M: [16, 4, 27, 0, 0], Q: [24, 4, 19, 0, 0], H: [28, 4, 15, 0, 0] },
  { L: [20, 2, 78, 0, 0], M: [18, 4, 31, 0, 0], Q: [18, 2, 14, 4, 15], H: [26, 4, 13, 1, 14] },
  { L: [24, 2, 97, 0, 0], M: [22, 2, 38, 2, 39], Q: [22, 4, 18, 2, 19], H: [26, 4, 14, 2, 15] },
  { L: [30, 2, 116, 0, 0], M: [22, 3, 36, 2, 37], Q: [20, 4, 16, 4, 17], H: [24, 4, 12, 4, 13] },
  { L: [18, 2, 68, 2, 69], M: [26, 4, 43, 1, 44], Q: [24, 6, 19, 2, 20], H: [28, 6, 15, 2, 16] },
  { L: [20, 4, 81, 0, 0], M: [30, 1, 50, 4, 51], Q: [28, 4, 22, 4, 23], H: [24, 3, 12, 8, 13] },
  { L: [24, 2, 92, 2, 93], M: [22, 6, 36, 2, 37], Q: [26, 4, 20, 6, 21], H: [28, 7, 14, 4, 15] },
  { L: [26, 4, 107, 0, 0], M: [22, 8, 37, 1, 38], Q: [24, 8, 20, 4, 21], H: [22, 12, 11, 4, 12] },
  { L: [30, 3, 115, 1, 116], M: [24, 4, 40, 5, 41], Q: [20, 11, 16, 5, 17], H: [24, 11, 12, 5, 13] },
  { L: [22, 5, 87, 1, 88], M: [24, 5, 41, 5, 42], Q: [30, 5, 24, 7, 25], H: [24, 11, 12, 7, 13] },
];

/** Alignment pattern centres per version, index 0 = version 1. */
const ALIGNMENT: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
];

const MIN_VERSION = 1;
const MAX_VERSION = 15;

// GF(256) with QR's primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D).
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  // Doubling the exponent table lets multiplication skip the modulo.
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

/** The generator polynomial for `degree` EC codewords, highest power first. */
function generatorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const factor = GF_EXP[i]!;
    const next = new Array<number>(poly.length + 1).fill(0);
    next[0] = poly[0]!;
    for (let j = 1; j < poly.length; j++) next[j] = poly[j]! ^ gfMul(poly[j - 1]!, factor);
    next[poly.length] = gfMul(poly[poly.length - 1]!, factor);
    poly = next;
  }
  return poly;
}

/**
 * The Reed-Solomon codewords for one block: `data` divided by the generator
 * polynomial for `ecCount` codewords. Exported so tests can pin a known vector.
 */
export function reedSolomon(data: readonly number[], ecCount: number): number[] {
  if (ecCount <= 0) return [];
  const gen = generatorPoly(ecCount);
  const rem = new Array<number>(ecCount).fill(0);
  for (const value of data) {
    const factor = value ^ rem[0]!;
    rem.shift();
    rem.push(0);
    if (factor !== 0) {
      for (let i = 0; i < ecCount; i++) rem[i] = rem[i]! ^ gfMul(gen[i + 1]!, factor);
    }
  }
  return rem;
}

/** The 15-bit format information for a level and mask (ISO/IEC 18004 annex C). */
export function formatBits(ecc: QrEcc, mask: number): number {
  const data = (ECC_BITS[ecc] << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

/** The 18-bit version information for versions 7 and up (annex D). */
export function versionBits(version: number): number {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) {
    if ((rem >>> i) & 1) rem ^= 0x1f25 << (i - 12);
  }
  return (version << 12) | rem;
}

function dataCodewords(version: number, ecc: QrEcc): number {
  const [, blocks1, data1, blocks2, data2] = BLOCKS[version - 1]![ecc];
  return blocks1 * data1 + blocks2 * data2;
}

function byteCapacity(version: number, ecc: QrEcc): number {
  const countBits = version <= 9 ? 8 : 16;
  return Math.floor((dataCodewords(version, ecc) * 8 - 4 - countBits) / 8);
}

function pickVersion(byteLength: number, ecc: QrEcc): number {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
    if (byteLength <= byteCapacity(version, ecc)) return version;
  }
  const max = byteCapacity(MAX_VERSION, ecc);
  throw new Error(`QR code too long: ${byteLength} bytes do not fit version 15 level ${ecc} (${max} bytes max)`);
}

function dataBytes(bytes: Uint8Array, version: number, ecc: QrEcc): number[] {
  const total = dataCodewords(version, ecc);
  const countBits = version <= 9 ? 8 : 16;
  const bits: number[] = [];
  const push = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, countBits);
  for (const byte of bytes) push(byte, 8);
  const capacity = total * 8;
  for (let i = Math.min(4, capacity - bits.length); i > 0; i--) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!;
    out.push(byte);
  }
  for (let i = 0; out.length < total; i++) out.push(i % 2 === 0 ? 0xec : 0x11);
  return out;
}

function interleave(data: number[], version: number, ecc: QrEcc): number[] {
  const [ecLen, blocks1, data1, blocks2, data2] = BLOCKS[version - 1]![ecc];
  const blocks: { data: number[]; ec: number[] }[] = [];
  let offset = 0;
  for (const [count, size] of [
    [blocks1, data1],
    [blocks2, data2],
  ] as const) {
    for (let b = 0; b < count; b++) {
      const chunk = data.slice(offset, offset + size);
      offset += size;
      blocks.push({ data: chunk, ec: reedSolomon(chunk, ecLen) });
    }
  }
  const out: number[] = [];
  const longest = Math.max(data1, data2);
  for (let i = 0; i < longest; i++) {
    for (const block of blocks) if (i < block.data.length) out.push(block.data[i]!);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const block of blocks) out.push(block.ec[i]!);
  }
  return out;
}

interface Canvas {
  size: number;
  dark: boolean[][];
  reserved: boolean[][];
}

function blankCanvas(version: number): Canvas {
  const size = version * 4 + 17;
  return {
    size,
    dark: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    reserved: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
}

function setFunction(canvas: Canvas, x: number, y: number, dark: boolean): void {
  canvas.dark[y]![x] = dark;
  canvas.reserved[y]![x] = true;
}

function drawTiming(canvas: Canvas): void {
  for (let i = 0; i < canvas.size; i++) {
    const dark = i % 2 === 0;
    setFunction(canvas, 6, i, dark);
    setFunction(canvas, i, 6, dark);
  }
}

function drawFinder(canvas: Canvas, left: number, top: number): void {
  // The eighth row and column are the finder's separator, which stays light.
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const x = left + dx;
      const y = top + dy;
      if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) continue;
      const inside = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
      const dark = inside && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
      setFunction(canvas, x, y, dark);
    }
  }
}

function drawAlignment(canvas: Canvas, version: number): void {
  const centres = ALIGNMENT[version - 1]!;
  const last = centres.length - 1;
  for (let i = 0; i < centres.length; i++) {
    for (let j = 0; j < centres.length; j++) {
      // The three corners already hold finder patterns.
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      const cx = centres[i]!;
      const cy = centres[j]!;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunction(canvas, cx + dx, cy + dy, Math.abs(dx) === 2 || Math.abs(dy) === 2 || (dx === 0 && dy === 0));
        }
      }
    }
  }
}

function drawVersionInfo(canvas: Canvas, version: number): void {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = canvas.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunction(canvas, a, b, dark);
    setFunction(canvas, b, a, dark);
  }
}

function drawFormat(canvas: Canvas, ecc: QrEcc, mask: number): void {
  const bits = formatBits(ecc, mask);
  const bit = (i: number): boolean => ((bits >>> i) & 1) === 1;
  const { size } = canvas;
  // Copy one runs beside the top-left finder, then down its left side.
  for (let i = 0; i <= 5; i++) setFunction(canvas, 8, i, bit(i));
  setFunction(canvas, 8, 7, bit(6));
  setFunction(canvas, 8, 8, bit(7));
  setFunction(canvas, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) setFunction(canvas, 14 - i, 8, bit(i));
  // Copy two: along row 8 from the right, then up column 8 from the bottom.
  for (let i = 0; i < 8; i++) setFunction(canvas, size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setFunction(canvas, 8, size - 15 + i, bit(i));
  setFunction(canvas, 8, size - 8, true); // the always-dark module
}

function drawFunctionPatterns(canvas: Canvas, version: number, ecc: QrEcc): void {
  drawTiming(canvas);
  drawFinder(canvas, 0, 0);
  drawFinder(canvas, canvas.size - 7, 0);
  drawFinder(canvas, 0, canvas.size - 7);
  drawAlignment(canvas, version);
  drawVersionInfo(canvas, version);
  // Reserve the format areas (drawn per mask later) and the dark module.
  drawFormat(canvas, ecc, 0);
}

function placeData(canvas: Canvas, codewords: number[]): void {
  const { size } = canvas;
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing pattern
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (canvas.reserved[y]![x]) continue;
        const dark = bitIndex < codewords.length * 8 && ((codewords[bitIndex >>> 3]! >>> (7 - (bitIndex & 7))) & 1) === 1;
        canvas.dark[y]![x] = dark;
        bitIndex++;
      }
    }
  }
  // The leftovers are the version's remainder bits, already light. A block
  // table that disagrees with the symbol's geometry would show up here.
  const remainder = bitIndex - codewords.length * 8;
  if (remainder < 0 || remainder > 7) {
    throw new Error(`QR data placement mismatch: ${bitIndex} modules for ${codewords.length} codewords`);
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(canvas: Canvas, mask: number): void {
  for (let y = 0; y < canvas.size; y++) {
    for (let x = 0; x < canvas.size; x++) {
      if (!canvas.reserved[y]![x] && maskBit(mask, x, y)) canvas.dark[y]![x] = !canvas.dark[y]![x];
    }
  }
}

const FINDER_LIKE = [
  [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0],
  [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1],
];

/** ISO/IEC 18004's four penalty rules, in units (lower is better). */
function penaltyScore(dark: boolean[][]): number {
  const size = dark.length;
  let score = 0;
  const line = (get: (i: number) => boolean): void => {
    let run = 1;
    for (let i = 1; i < size; i++) {
      if (get(i) === get(i - 1)) {
        run++;
      } else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  };
  for (let y = 0; y < size; y++) line((x) => dark[y]![x]!);
  for (let x = 0; x < size; x++) line((y) => dark[y]![x]!);
  // Rule 2: every 2x2 block of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const colour = dark[y]![x]!;
      if (colour === dark[y]![x + 1] && colour === dark[y + 1]![x] && colour === dark[y + 1]![x + 1]) score += 3;
    }
  }
  // Rule 3: finder-like 1:0:1:1:1:0:1 runs with four light modules beside them.
  // The quiet zone is a light area, so each line is padded before scanning.
  const scan = (get: (i: number) => boolean): void => {
    const line = [false, false, false, false];
    for (let i = 0; i < size; i++) line.push(get(i));
    line.push(false, false, false, false);
    for (let i = 0; i + 11 <= line.length; i++) {
      for (const pattern of FINDER_LIKE) {
        let matches = true;
        for (let k = 0; k < 11 && matches; k++) matches = line[i + k] === (pattern[k] === 1);
        if (matches) score += 40;
      }
    }
  };
  for (let y = 0; y < size; y++) scan((x) => dark[y]![x]!);
  for (let x = 0; x < size; x++) scan((y) => dark[y]![x]!);
  // Rule 4: how far the dark share is from half, in 5% steps.
  let darkCount = 0;
  for (const row of dark) for (const module of row) if (module) darkCount++;
  const total = size * size;
  score += Math.floor(Math.abs(darkCount * 20 - total * 10) / total) * 10;
  return score;
}

/**
 * Encode `text` as a QR matrix: `matrix[y][x]` is true for a dark module.
 * Byte mode over UTF-8; the smallest version 1-15 that fits; the mask with
 * the lowest standard penalty.
 */
export function encodeQr(text: string, opts: { ecc?: QrEcc } = {}): boolean[][] {
  const ecc = opts.ecc ?? "M";
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length, ecc);
  const codewords = interleave(dataBytes(bytes, version, ecc), version, ecc);

  let best: boolean[][] | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    const canvas = blankCanvas(version);
    drawFunctionPatterns(canvas, version, ecc);
    placeData(canvas, codewords);
    applyMask(canvas, mask);
    drawFormat(canvas, ecc, mask);
    const score = penaltyScore(canvas.dark);
    if (score < bestScore) {
      best = canvas.dark;
      bestScore = score;
    }
  }
  return best!;
}

function isDark(matrix: readonly (readonly boolean[])[], x: number, y: number): boolean {
  const row = matrix[y];
  return row !== undefined && row[x] === true;
}

/**
 * Draw the matrix in a terminal with half blocks: two module rows per text
 * line, dark modules as the foreground. The quiet zone is included as spaces.
 */
export function qrToTerminal(matrix: readonly (readonly boolean[])[], opts: { quiet?: number } = {}): string {
  const quiet = opts.quiet ?? 2;
  const dimension = matrix.length + quiet * 2;
  const lines: string[] = [];
  for (let y = 0; y < dimension; y += 2) {
    let line = "";
    for (let x = 0; x < dimension; x++) {
      const top = isDark(matrix, x - quiet, y - quiet);
      const bottom = isDark(matrix, x - quiet, y + 1 - quiet);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/**
 * Draw the matrix as an SVG image: one run-length path over a white square,
 * so the code stays scannable on any page background. No scripts, no styles.
 */
export function qrToSvg(
  matrix: readonly (readonly boolean[])[],
  opts: { scale?: number; quiet?: number } = {},
): string {
  const scale = opts.scale ?? 4;
  const quiet = opts.quiet ?? 4;
  const size = matrix.length;
  const dimension = size + quiet * 2;
  const runs: string[] = [];
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!isDark(matrix, x, y)) {
        x++;
        continue;
      }
      const start = x;
      while (x < size && isDark(matrix, x, y)) x++;
      const width = x - start;
      runs.push(`M${start + quiet} ${y + quiet}h${width}v1h-${width}z`);
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dimension} ${dimension}" ` +
    `width="${dimension * scale}" height="${dimension * scale}" shape-rendering="crispEdges">` +
    `<rect width="${dimension}" height="${dimension}" fill="#ffffff"/>` +
    `<path d="${runs.join("")}" fill="#000000"/></svg>`
  );
}
