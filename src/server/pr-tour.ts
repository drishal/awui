// A bounded reading guide assembled from the repository's own pull-request diff.
// GitHub credentials stay inside gh on the server. These are reading suggestions:
// they never approve a change or substitute for a human review of its full change.
import { createHash } from "node:crypto";
import path from "node:path";
import type { Tour, TourFile, WorkspaceInfo } from "../shared/protocol.js";
import { bucketOf } from "../shared/breakdown.js";
import { parseUnified } from "../shared/unified-diff.js";
import { runGh } from "./github.js";
import { ChatError } from "./chats/chat.js";

type Guide = { tour: Tour; stale: boolean };

const MAX_FILES = 80;
const MAX_PATCH_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 768 * 1024;
const MAX_FILE_BYTES = 96 * 1024;
const OMITTED = "[awui: large diff omitted; inspect the rest before approval]";
export const MAX_TOURS = 16;

/** Diff paths are display-only: never let GitHub text become a local operation. */
export function safeTourPath(raw: string): string | null {
  const normalized = path.posix.normalize(raw.replaceAll("\\", "/"));
  if (!normalized || normalized === "." || normalized.startsWith("/") || normalized.startsWith("../") || normalized.includes("\0") || normalized.includes("\n")) return null;
  return normalized;
}

/** A normalized name used only for tile labels and categorization. Unsupported C-style quoting is refused. */
function headerName(raw: string): string | null {
  if (raw.startsWith('"')) {
    const match = /^"((?:\\["\\abfnrtv]|[0-7]{3})*)"$/i.exec(raw);
    if (!match) return null;
        const contents = match[1]!;
    return contents.replace(/\\(?:([0-7]{3})|(["\\abfnrtv]))/g, (_whole, octal: string | undefined, char: string | undefined): string => octal ? String.fromCharCode(parseInt(octal, 8)) : ({ "\\": "\\", '"': '"', a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" }[char ?? ""] ?? char ?? ""));
  }
  // Git marks the timestamp with a tab; names may contain literal spaces.
  return raw.split("\t", 1)[0] ?? null;
}

const heading = /^diff --git (?:a\/(.+?) b\/(.+)|a\/(.+?) b\/(.+))$/;
const newHeader = /^\+\+\+\s+/;
const oldHeader = /^---\s+/;

/** Old/new headers name a file even when their mate is /dev/null. */
function chunkPath(chunk: string): string | undefined {
  let next: string | null = null;
  let old: string | null = null;
  let rename: string | null = null;
  let fallback: string | null = null;
  for (const line of chunk.split("\n")) {
    if (newHeader.test(line)) next = headerName(line.slice(4));
    else if (oldHeader.test(line)) old = headerName(line.slice(4));
    else if (line.startsWith("rename to ")) rename = headerName(line.slice(10));
    else if (line.startsWith("diff --git ")) {
      // Used by additions/deletions and by Git's sparse binary patch headers.
      const pair = /^diff --git (?:a\/(.+?) b\/(.+)|a\/(.+?) b\/(.+))$/.exec(line);
      if (pair) fallback = pair[2] ?? pair[4] ?? pair[3] ?? pair[1] ?? null;
    }
  }
  if (next && next !== "/dev/null") return next.replace(/^[ab]\//, "");
  if (old && old !== "/dev/null") return old.replace(/^[ab]\//, "");
  const raw = rename ?? fallback;
  if (raw !== null && raw !== "/dev/null") return raw.replace(/^[ab]\//, "");
  return undefined;
}

/** Cut on whole git headers; each bounded chunk becomes normalized ToolDiff data for the web. */
export function patchFiles(patch: string, fileCap = MAX_FILES, totalCap = MAX_TOTAL_BYTES): { files: TourFile[]; truncated: boolean } {
  if (Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES) throw new ChatError(413, "tour_too_large", "This PR diff exceeds the 512 KiB review-tour bound; inspect the rest on GitHub before approving it");
  const chunks = patch.split(/\r?\n(?=diff --git )/);
  const files: TourFile[] = [];
  let truncated = false;
  let bytes = 0;
  for (const chunk of chunks) {
    if (chunk.trim() === "") continue;
    if (files.length >= fileCap) { truncated = true; continue; }
    const match = heading.exec(chunk.split("\n", 1)[0] ?? "");
    if (!match) {
      // A gh preamble is not a file and cannot be allowed to fabricate tour diff lines.
      continue;
    }
    const filePath = chunkPath(chunk);
    if (!filePath || !safeTourPath(filePath)) continue;
    const data = chunk.length > MAX_FILE_BYTES ? `${chunk.slice(0, MAX_FILE_BYTES)}\n${OMITTED}\n` : chunk;
    if (bytes + Buffer.byteLength(data, "utf8") > totalCap) { truncated = true; break; }
    const binary = /^(?:Binary files .*differ|GIT binary path)/m.test(chunk);
    const diff = binary ? null : parseUnified(data);
    bytes += Buffer.byteLength(data, "utf8");
    files.push({
      path: filePath,
      bucket: bucketOf(filePath),
      diff,
      ...(binary ? { note: "Binary diff omitted; inspect it on GitHub" } : {}),
      ...(!binary && !diff ? { note: "No line changes (metadata only); inspect this file on GitHub" } : {}),
    });
    truncated ||= data.length !== chunk.length;
  }
  return { files, truncated };
}

const MECHANICAL = /(?:lock|license|package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$|\.min\.\w+|\.bundle\.(?:js|map)$)/i;
const CONFIGURATION = /(?:^|\/)(?:tsconfig.*|vite\.config\.\w+|jest\.config\.\w+|eslint\.config\.\w+|prettier\.config\.\w+)$|\.github\//i;

export function orderedTourFiles(files: readonly TourFile[]): TourFile[] {
  const order = { source: 0, tests: 1, generated: 2 };
  const rank = (file: TourFile) => MECHANICAL.test(file.path) || CONFIGURATION.test(file.path) ? 100 : order[file.bucket];
  return [...files].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
}

async function headOf(ws: WorkspaceInfo, pr: number): Promise<string> {
  const raw = await runGh(["pr", "view", String(pr), "--json", "headRefOid"], ws.path);
  const data = JSON.parse(raw) as { headRefOid?: unknown };
  if (typeof data.headRefOid !== "string" || !/^[a-f0-9]{7,64}$/i.test(data.headRefOid)) throw new ChatError(502, "github_failed", `GitHub did not return a readable head OID for pull request #${pr}`);
  return createHash("sha256").update(`${pr}:${data.headRefOid}`).digest("hex").slice(0, 16);
}

export async function createTour(ws: WorkspaceInfo, pr: number): Promise<Tour> {
  if (!Number.isSafeInteger(pr) || pr < 1 || pr > 99_999) throw new ChatError(400, "bad_pr", "Choose a PR number for this repository");
  const data = JSON.parse(await runGh(["pr", "view", String(pr), "--json", "title,url,headRefOid"], ws.path)) as { title?: unknown; url?: unknown; headRefOid?: unknown };
  if (typeof data.title !== "string" || typeof data.url !== "string" || !/^https:\/\//.test(data.url) || typeof data.headRefOid !== "string" || !/^[a-f0-9]{7,64}$/i.test(data.headRefOid)) {
    throw new ChatError(502, "github_failed", `GitHub did not return a readable pull request #${pr}`);
  }
  const patch = await runGh(["pr", "diff", String(pr)], ws.path);
  const { files, truncated } = patchFiles(patch);
  return { pr, title: data.title.slice(0, 200), files: orderedTourFiles(files), head: createHash("sha256").update(`${pr}:${data.headRefOid}`).digest("hex").slice(0, 16), truncated };
}

// In-process only: this bounded memory cache is deliberately not a durable review transcript.
const saved = new Map<string, { tour: Tour; stale: boolean }>();

/** Navigation checks the live OID; only an explicit rebuild asks gh for a replacement diff. */
export async function readTour(ws: WorkspaceInfo, pr: number, regenerate: boolean): Promise<Guide> {
  if (!/^[A-Za-z0-9_-]{22}$/.test(ws.id)) throw new Error("Workspace ID must be a validated application path key");
  const key = `${ws.id}:${pr}`;
  const prior = saved.get(key);
  if (prior && !regenerate) {
    const current = await headOf(ws, pr);
    if (prior.stale) return prior;
    return { tour: prior.tour, stale: prior.tour.head !== current };
  }
  const tour = await createTour(ws, pr);
  const result = { tour, stale: false };
  saved.set(key, result);
  if (saved.size > MAX_TOURS) saved.delete(saved.keys().next().value as string);
  return result;
}

export function tourCacheReset(): void {
  saved.clear();
}
