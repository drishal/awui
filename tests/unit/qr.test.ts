// QR invite codes: the byte-mode capacity boundaries choose a version, the
// standard's format and version bits come out as published, Reed-Solomon
// matches a known vector, and both renderers keep their shape. A full decoder
// is out of scope: the encoder is pure and its pieces are checked separately.
import { describe, expect, it } from "vitest";
import { encodeQr, formatBits, qrToSvg, qrToTerminal, reedSolomon, versionBits } from "../../src/shared/qr.js";

const versionOf = (matrix: boolean[][]): number => (matrix.length - 17) / 4;
const filler = (bytes: number): string => "a".repeat(bytes);

/** The 15 format bits for level M, masks 0-7, from ISO/IEC 18004 annex C. */
const M_FORMAT_BITS = [
  0b101010000010010, 0b101000100100101, 0b101111001111100, 0b101101101001011, 0b100010111111001, 0b100000011001110,
  0b100111110010111, 0b100101010100000,
];

/** The 18 version bits for versions 7-15, from ISO/IEC 18004 annex D. */
const VERSION_BITS: Record<number, number> = {
  7: 0x07c94,
  8: 0x085bc,
  9: 0x09a99,
  10: 0x0a4d3,
  11: 0x0bbf6,
  12: 0x0c762,
  13: 0x0d847,
  14: 0x0e60d,
  15: 0x0f928,
};

function readFormat(matrix: boolean[][], copy: 1 | 2): number {
  const size = matrix.length;
  let bits = 0;
  const add = (i: number, dark: boolean | undefined): void => {
    if (dark === true) bits |= 1 << i;
  };
  if (copy === 1) {
    for (let i = 0; i <= 5; i++) add(i, matrix[i]?.[8]);
    add(6, matrix[7]?.[8]);
    add(7, matrix[8]?.[8]);
    add(8, matrix[8]?.[7]);
    for (let i = 9; i < 15; i++) add(i, matrix[8]?.[14 - i]);
  } else {
    for (let i = 0; i < 8; i++) add(i, matrix[8]?.[size - 1 - i]);
    for (let i = 8; i < 15; i++) add(i, matrix[size - 15 + i]?.[8]);
  }
  return bits;
}

function readVersionInfo(matrix: boolean[][]): number {
  const size = matrix.length;
  let bits = 0;
  for (let i = 0; i < 18; i++) {
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    expect(matrix[b]?.[a]).toBe(matrix[a]?.[b]);
    if (matrix[b]?.[a] === true) bits |= 1 << i;
  }
  return bits;
}

function finderAt(matrix: boolean[][], left: number, top: number): boolean {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const edge = dx === 0 || dx === 6 || dy === 0 || dy === 6;
      const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
      if (matrix[top + dy]?.[left + dx] !== (edge || core)) return false;
    }
  }
  return true;
}

describe("version selection", () => {
  it("grows by one version exactly past each level M byte boundary", () => {
    // Capacities from the standard's table 7: v1 14, v2 26, v3 42, v4 62,
    // v5 84, v6 106, v7 122, v8 152, v9 180, v10 213, v11 251, v12 287,
    // v13 331, v14 362, v15 412. (The task's "v7 152" is v8's capacity.)
    const boundaries: Array<[bytes: number, version: number]> = [
      [0, 1],
      [14, 1],
      [15, 2],
      [26, 2],
      [27, 3],
      [42, 3],
      [43, 4],
      [62, 4],
      [63, 5],
      [84, 5],
      [85, 6],
      [106, 6],
      [107, 7],
      [122, 7],
      [123, 8],
      [152, 8],
      [153, 9],
      [180, 9],
      [181, 10],
      [213, 10],
      [214, 11],
      [251, 11],
      [252, 12],
      [287, 12],
      [288, 13],
      [331, 13],
      [332, 14],
      [362, 14],
      [363, 15],
      [412, 15],
    ];
    for (const [bytes, version] of boundaries) {
      const matrix = encodeQr(filler(bytes));
      expect(matrix).toHaveLength(17 + 4 * version);
      expect(versionOf(matrix)).toBe(version);
    }
  });

  it("refuses data past version 15 with the real limit in the message", () => {
    expect(() => encodeQr(filler(413))).toThrow(/413 bytes do not fit version 15 level M \(412 bytes max\)/);
    expect(() => encodeQr(filler(520), { ecc: "L" })).not.toThrow();
    expect(() => encodeQr(filler(521), { ecc: "L" })).toThrow(/version 15 level L \(520 bytes max\)/);
  });

  it("counts the UTF-8 bytes, not the characters", () => {
    expect(versionOf(encodeQr("é".repeat(7)))).toBe(1); // 14 bytes
    expect(versionOf(encodeQr("é".repeat(8)))).toBe(2); // 16 bytes
    expect(versionOf(encodeQr("日".repeat(4)))).toBe(1); // 12 bytes
    expect(versionOf(encodeQr("日".repeat(5)))).toBe(2); // 15 bytes
  });

  it("holds level 1's capacity at each level", () => {
    expect(versionOf(encodeQr(filler(17), { ecc: "L" }))).toBe(1);
    expect(versionOf(encodeQr(filler(18), { ecc: "L" }))).toBe(2);
    expect(versionOf(encodeQr(filler(11), { ecc: "Q" }))).toBe(1);
    expect(versionOf(encodeQr(filler(12), { ecc: "Q" }))).toBe(2);
    expect(versionOf(encodeQr(filler(7), { ecc: "H" }))).toBe(1);
    expect(versionOf(encodeQr(filler(8), { ecc: "H" }))).toBe(2);
  });
});

describe("function patterns", () => {
  const matrix = encodeQr("awui-invite:1:pair-me");

  it("puts a finder pattern in three corners, with light separators", () => {
    const size = matrix.length;
    expect(finderAt(matrix, 0, 0)).toBe(true);
    expect(finderAt(matrix, size - 7, 0)).toBe(true);
    expect(finderAt(matrix, 0, size - 7)).toBe(true);
    // The fourth corner holds data, not a finder.
    expect(finderAt(matrix, size - 7, size - 7)).toBe(false);
    for (let i = 0; i < 8; i++) {
      expect(matrix[7]?.[i]).toBe(false);
      expect(matrix[i]?.[7]).toBe(false);
      expect(matrix[7]?.[size - 1 - i]).toBe(false);
      expect(matrix[i]?.[size - 8]).toBe(false);
      expect(matrix[size - 8]?.[i]).toBe(false);
      expect(matrix[size - 1 - i]?.[7]).toBe(false);
    }
  });

  it("alternates the timing patterns between the finders", () => {
    for (let i = 8; i < matrix.length - 8; i++) {
      expect(matrix[6]?.[i]).toBe(i % 2 === 0);
      expect(matrix[i]?.[6]).toBe(i % 2 === 0);
    }
  });

  it("always darkens the module above the bottom-left finder", () => {
    expect(matrix[matrix.length - 8]?.[8]).toBe(true);
  });
});

describe("format information", () => {
  it("matches the published 15 bits for level M and every mask", () => {
    for (let mask = 0; mask < 8; mask++) expect(formatBits("M", mask)).toBe(M_FORMAT_BITS[mask]);
  });

  it("writes the same bits in both places, for the mask it chose", () => {
    const matrix = encodeQr("awui-invite:1:format-copy");
    const first = readFormat(matrix, 1);
    const second = readFormat(matrix, 2);
    expect(second).toBe(first);
    const mask = [...Array(8).keys()].find((candidate) => formatBits("M", candidate) === first);
    expect(mask).toBeDefined();
  });
});

describe("version information", () => {
  it("matches the published 18 bits for versions 7 to 15", () => {
    for (const [version, bits] of Object.entries(VERSION_BITS)) expect(versionBits(Number(version))).toBe(bits);
  });

  it("is written twice in a version 7 symbol", () => {
    expect(readVersionInfo(encodeQr(filler(122)))).toBe(0x07c94);
    expect(versionBits(7)).toBe(0x07c94);
  });
});

describe("Reed-Solomon", () => {
  it("produces the classic HELLO WORLD version 1-M EC codewords", () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(reedSolomon(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it("returns nothing when asked for no EC codewords", () => {
    expect(reedSolomon([1, 2, 3], 0)).toEqual([]);
  });
});

describe("a whole matrix", () => {
  it("is deterministic and square", () => {
    const first = encodeQr("awui-invite:1:determinism");
    const second = encodeQr("awui-invite:1:determinism");
    expect(second).toEqual(first);
    expect(first).toHaveLength(first.length);
    for (const row of first) {
      expect(row).toHaveLength(first.length);
      expect(row.every((module) => typeof module === "boolean")).toBe(true);
    }
    expect(encodeQr("awui-invite:1:something-else")).not.toEqual(first);
  });
});

describe("renderers", () => {
  const matrix = encodeQr("awui-invite:1:render");

  it("draws one path in a square viewBox", () => {
    const svg = qrToSvg(matrix);
    const dimension = matrix.length + 8;
    expect(svg).toContain(`viewBox="0 0 ${dimension} ${dimension}"`);
    expect(svg).toContain(`width="${dimension * 4}"`);
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).not.toContain("<script");
    expect(svg.match(/<path /g)).toHaveLength(1);
    const path = /<path d="([^"]*)"/.exec(svg)?.[1] ?? "";
    expect(path).toMatch(/^(?:M\d+ \d+h\d+v1h-\d+z)+$/);
  });

  it("takes its scale and quiet zone from the options", () => {
    const svg = qrToSvg(matrix, { scale: 2, quiet: 1 });
    const dimension = matrix.length + 2;
    expect(svg).toContain(`viewBox="0 0 ${dimension} ${dimension}"`);
    expect(svg).toContain(`width="${dimension * 2}"`);
  });

  it("pairs two module rows per terminal line and includes the quiet zone", () => {
    const lines = qrToTerminal(matrix).split("\n");
    expect(lines).toHaveLength(Math.ceil((matrix.length + 4) / 2));
    for (const line of lines) {
      expect(line).toHaveLength(matrix.length + 4);
      expect(line).toMatch(/^[▀▄█ ]+$/);
    }
    // The two-module quiet zone along the top is blank.
    expect(lines[0]).toBe(" ".repeat(matrix.length + 4));
    const tight = qrToTerminal(matrix, { quiet: 0 }).split("\n");
    expect(tight).toHaveLength(Math.ceil(matrix.length / 2));
    expect(tight[0]).toHaveLength(matrix.length);
    const roomy = qrToTerminal(matrix, { quiet: 5 }).split("\n");
    expect(roomy).toHaveLength(Math.ceil((matrix.length + 10) / 2));
  });
});
