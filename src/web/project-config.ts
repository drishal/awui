// The worktree picker's view of a project's own `awui.yml`: what it asks for, whether
// this exact version is trusted, and the one button that runs its setup command. Pure
// wording and state helpers (the picker draws them), so the rules are testable: an
// untrusted file never offers to run anything, and a changed file asks again.
import type { ProjectConfigStatus as Status } from "../shared/protocol.js";

/** What the file asks for, in one line; null when it asks for nothing awui can act on. */
export function projectConfigWants(status: Status): string | null {
  const parts: string[] = [];
  if (status.config.base) parts.push(`starts from ${status.config.base}`);
  if (status.config.shared?.length) parts.push(`shares ${status.config.shared.join(", ")}`);
  if (status.config.setup) parts.push("has a setup command");
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Whether its setup command may be offered: the file parsed, names one, and this version is trusted. */
export function canRunSetup(status: Status | null | undefined): boolean {
  return status !== null && status !== undefined && status.problem === undefined && status.config.setup !== undefined && status.trusted;
}

/** The trust button's words: trust the version, or say the file changed under the dialog. */
export function trustLabel(status: Status): string {
  return status.trusted ? `Trusted (${status.hash.slice(0, 8)})` : `Trust this ${status.file} (${status.hash.slice(0, 8)})`;
}

/** The base a create form starts on: the project's own default, else HEAD. */
export const defaultBase = (status: Status | null | undefined): string => status?.config.base ?? "HEAD";
