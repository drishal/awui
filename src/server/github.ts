// A bounded GitHub workflow using the machine's own gh authentication. No
// credentials are read, stored, or sent to a client. gh and git may contact the
// configured remote only on explicit user actions (status/checks/push/create).
import { execFile } from "node:child_process";
import type { WorkspaceInfo } from "../shared/protocol.js";
import { git } from "./git.js";
import { ChatError } from "./chats/chat.js";

export interface GitHubStatus {
  available: boolean;
  reason?: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  remoteUrl: string | null;
}

export interface GitHubCheck {
  name: string;
  state: string;
  link: string | null;
}

export async function runGh(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_") && key !== "GIT_TERMINAL_PROMPT") delete env[key];
    execFile("gh", args, { cwd, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      // 8 from `pr checks` means no checks reported, which is a legitimate result not a credential error.
      if (error && (error as { code?: number }).code !== 8) reject(new Error(stderr.trim().split("\n").slice(0, 3).join(" ") || error.message));
      else resolve(stdout);
    });
  });
}

/** The remote branch as git has it, not a guessed URL from a shell host name. */
export async function githubStatus(ws: WorkspaceInfo): Promise<GitHubStatus> {
  const path = ws.path;
  let branch: string | null = null;
  try {
    branch = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: path, timeoutMs: 5000 })).trim() || null;
  } catch { /* detached: gh can decide whether the current HEAD can be pushed */
  }
  const upstream = (await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd: path, timeoutMs: 5000, okExit: [128, 1] })).trim() || null;
  const ahead = upstream ? Number((await git(["rev-list", "--count", "@{upstream}..HEAD"], { cwd: path, timeoutMs: 5000, okExit: [1] })).trim() || "0") : 0;
  // No origin exits 2 ("No such remote"); that is a repo without a remote, not a failure.
  const remoteUrl = (await git(["remote", "get-url", "origin"], { cwd: path, timeoutMs: 5000, okExit: [1, 2] })).trim() || null;
  try {
    await runGh(["auth", "status"], path);
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error), branch, upstream, ahead, remoteUrl };
  }
  return { available: true, branch, upstream, ahead, remoteUrl };
}

/** Push the explicit local branch; never infer or push another repository branch. */
export async function pushBranch(ws: WorkspaceInfo): Promise<GitHubStatus & { remote?: string }> {
  const status = await githubStatus(ws);
  if (!status.available) throw new ChatError(409, "github_unavailable", status.reason ?? "gh is not logged in here");
  if (!status.branch) throw new ChatError(409, "detached_head", "Check out a branch before pushing it");
  if (!status.upstream && !status.remoteUrl) throw new ChatError(409, "no_remote", "This repository has no origin remote to push to");
  const args = status.upstream ? ["push"] : ["push", "--set-upstream", "origin", status.branch];
  await git(args, { cwd: ws.path, timeoutMs: 60_000 });
  const upstream = (await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd: ws.path })).trim() || null;
  return { ...status, upstream, ahead: 0, remote: status.upstream ?? `origin/${status.branch}` };
}

/** Create with gh's own logged-in repo so no account/path heuristic is chosen here. */
export async function createPullRequest(ws: WorkspaceInfo, base: string, title: string, body: string): Promise<{ url: string; title: string; base: string }> {
  if (!base || !title || title.length > 200 || body.length > 20_000) throw new ChatError(400, "invalid_request", "A PR needs a base branch, a title up to 200 characters, and a bounded description");
  const status = await githubStatus(ws);
  if (!status.available) throw new ChatError(409, "github_unavailable", status.reason ?? "gh is not logged in here");
  if (!status.branch) throw new ChatError(409, "detached_head", "Check out a branch before creating a PR");
  const output = (await runGh(["pr", "create", "--base", base, "--title", title, "--body", body, "--head", status.branch], ws.path)).trim().split("\n");
  const url = output.findLast((line) => /^https:\/\//i.test(line)) ?? output.at(-1);
  if (!url || !/^https:\/\//i.test(url)) throw new ChatError(502, "github_failed", "GitHub created no PR URL; inspect the result with gh");
  return { url, title, base };
}

export async function currentPullRequest(ws: WorkspaceInfo): Promise<{ url: string; title: string; state: string; isDraft: boolean } | null> {
  try {
    const result = await runGh(["pr", "view", "--json", "url,title,state,isDraft"], ws.path);
    const doc = JSON.parse(result) as Record<string, unknown>;
    const url = doc.url;
    if (typeof url !== "string" || !/^https:\/\//.test(url)) return null;
    return { url, title: typeof doc.title === "string" ? doc.title : "", state: typeof doc.state === "string" ? doc.state : "UNKNOWN", isDraft: doc.isDraft === true };
  } catch {
    return null;
  }
}

/**
 * One PR's detail by number, as the stack and the checkout flow carry it; null when GitHub
 * has none. `headRefOid` is the commit GitHub calls the head right now: a caller that fetches
 * or merges by it can tell whether what it got is what was read.
 */
export async function pullRequestDetail(ws: WorkspaceInfo, pr: number): Promise<{ url: string; title: string; state: string; isDraft: boolean; baseRefName: string; headRefName: string; headRefOid: string } | null> {
  try {
    const result = await runGh(["pr", "view", String(pr), "--json", "url,title,state,isDraft,baseRefName,headRefName,headRefOid"], ws.path);
    const doc = JSON.parse(result) as Record<string, unknown>;
    const url = doc.url;
    const baseRefName = doc.baseRefName;
    const headRefName = doc.headRefName;
    const headRefOid = doc.headRefOid;
    if (typeof url !== "string" || !/^https:\/\//.test(url)) return null;
    if (typeof baseRefName !== "string" || typeof headRefName !== "string") return null;
    // A PR with no head commit is one GitHub is still creating; there is nothing to name or check.
    if (typeof headRefOid !== "string" || !/^[0-9a-f]{40}$/.test(headRefOid)) return null;
    return {
      url,
      title: typeof doc.title === "string" ? doc.title : "",
      state: typeof doc.state === "string" ? doc.state : "UNKNOWN",
      isDraft: doc.isDraft === true,
      baseRefName,
      headRefName,
      headRefOid,
    };
  } catch {
    return null;
  }
}

/** Merge one PR with gh's own merge, merge commit only; the caller words the refusal. */
export async function mergePullRequest(ws: WorkspaceInfo, pr: number): Promise<void> {
  await runGh(["pr", "merge", String(pr), "--merge"], ws.path);
}

export function pullRequestChecksParse(raw: string): GitHubCheck[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry): GitHubCheck[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name : "";
    const state = typeof e.bucket === "string" ? e.bucket : typeof e.state === "string" ? e.state : "unknown";
    const link = typeof e.link === "string" && /^https:\/\//i.test(e.link) ? e.link : null;
    return name ? [{ name: name.slice(0, 120), state, link }] : [];
  });
}

export async function pullRequestChecks(ws: WorkspaceInfo): Promise<GitHubCheck[]> {
  return pullRequestChecksParse(await runGh(["pr", "checks", "--json", "name,state,link,bucket"], ws.path).catch((error: unknown) => {
    if (error instanceof Error && /no pull requests found|not found/i.test(error.message)) return "[]";
    throw error;
  }));
}
