// The source / tests / generated split of a set of changed files, for a worktree
// or race card: how much of the change is the project's own code, how much is its
// tests, and how much is lockfiles and build output nobody reads in review. Pure,
// so the rule and the numbers are one function with a unit test; the globs are
// config.yml's `breakdown:` block (defaults below), and a path that matches none
// of them is the project's code.

/** Which pile a changed path falls in. */
export type CodeBucket = "source" | "tests" | "generated";

/** The globs that sort paths into the two piles that are not the project's own code, in the other buckets' precedence order. */
export interface BreakdownRules {
  tests: string[];
  generated: string[];
}

/** What a project gets when config.yml says nothing: a file is its tests or generated output only when it says so in its path. */
export const DEFAULT_BREAKDOWN_RULES: BreakdownRules = {
  tests: ["**/*.test.*", "**/*.spec.*", "**/*_test.*", "**/__tests__/**", "**/test/**", "**/tests/**", "**/spec/**", "**/*.snap"],
  generated: [
    "**/*.min.*",
    "**/*.gen.*",
    "**/*.generated.*",
    "**/dist/**",
    "**/build/**",
    "**/out/**",
    "**/vendor/**",
    "**/node_modules/**",
    "**/*-lock.json",
    "**/*.lock",
    "**/package-lock.json",
    "**/pnpm-lock.yaml",
    "**/yarn.lock",
    "**/Cargo.lock",
    "**/go.sum",
  ],
};

/** Every bucket, in the order a card lists them. */
export const CODE_BUCKETS: readonly CodeBucket[] = ["source", "tests", "generated"];

const WORDS: Record<CodeBucket, string> = { source: "Source", tests: "Tests", generated: "Generated" };

const compiled = new Map<string, RegExp>();

/**
 * One glob as a regular expression: a double star crosses folders (and, right before
 * a slash, may stand for none at all, so a lockfile pattern reaches the top level),
 * a single star and `?` stay inside one segment, and a trailing slash means everything
 * under that folder. Compiled once per pattern, since a card matches every changed
 * path of every file.
 */
function globToRegex(glob: string): RegExp {
  let pattern = glob.trim().replace(/^\.\//, "");
  if (pattern.endsWith("/")) pattern += "**";
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i] as string;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/** Whether a project-relative path matches one rule glob. */
export function matchesGlob(path: string, glob: string): boolean {
  const key = glob.trim();
  let regex = compiled.get(key);
  if (!regex) {
    regex = globToRegex(key);
    if (compiled.size > 500) compiled.clear();
    compiled.set(key, regex);
  }
  return regex.test(path);
}

const anyMatch = (path: string, globs: readonly string[]): boolean => globs.some((glob) => matchesGlob(path, glob));

/**
 * The bucket a changed path belongs to: generated first (a generated test file is
 * generated), then tests, then the project's own code.
 */
export function bucketOf(path: string, rules: BreakdownRules = DEFAULT_BREAKDOWN_RULES): CodeBucket {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (anyMatch(normalized, rules.generated)) return "generated";
  if (anyMatch(normalized, rules.tests)) return "tests";
  return "source";
}

/** One changed file as a card reports it: its path, and the lines it gained and lost. */
export interface BreakdownFile {
  path: string;
  added: number;
  removed: number;
  binary?: boolean;
}

/** The lines one bucket holds, and how many files put them there. */
export interface BucketCount {
  bucket: CodeBucket;
  /** Lines added. */
  added: number;
  /** Lines removed. */
  removed: number;
  /** Lines changed either way: what the chip counts. */
  lines: number;
  files: number;
}

/** The split over a card's files, in `CODE_BUCKETS` order, leaving out a bucket with no file in it. */
export function breakdown(files: readonly BreakdownFile[], rules: BreakdownRules = DEFAULT_BREAKDOWN_RULES): BucketCount[] {
  const counts = new Map<CodeBucket, BucketCount>();
  for (const file of files) {
    const bucket = bucketOf(file.path, rules);
    const row = counts.get(bucket) ?? { bucket, added: 0, removed: 0, lines: 0, files: 0 };
    row.added += Math.max(0, file.added);
    row.removed += Math.max(0, file.removed);
    row.lines = row.added + row.removed;
    row.files += 1;
    counts.set(bucket, row);
  }
  return CODE_BUCKETS.flatMap((bucket) => {
    const row = counts.get(bucket);
    return row ? [row] : [];
  });
}

/** The bucket's name in a card: "Source", "Tests", "Generated". */
export const bucketName = (bucket: CodeBucket): string => WORDS[bucket];

/** A count in a card's words: "1,204" — the same figure whatever the locale of the device. */
const figure = (n: number): string => n.toLocaleString("en-US");

/** The chip's text: one "Source 320 · Tests 80" part per bucket that has lines, nothing when there is one pile only. */
export function breakdownText(counts: readonly BucketCount[]): string | null {
  const withLines = counts.filter((row) => row.lines > 0);
  if (withLines.length < 2) return null;
  return withLines.map((row) => `${bucketName(row.bucket)} ${figure(row.lines)}`).join(" · ");
}

/** The chip's hover text: each bucket's files and both directions, so a card says where its numbers came from. */
export function breakdownTitle(counts: readonly BucketCount[], rules: BreakdownRules = DEFAULT_BREAKDOWN_RULES): string {
  const rows = counts
    .filter((row) => row.lines > 0 || row.files > 0)
    .map((row) => {
      const globs = row.bucket === "source" ? "everything else" : rules[row.bucket].join(", ");
      return `${bucketName(row.bucket)}: ${figure(row.files)} file${row.files === 1 ? "" : "s"}, +${figure(row.added)} −${figure(row.removed)} (${globs})`;
    });
  return `Lines changed against the fork point, by kind:\n${rows.join("\n")}`;
}
