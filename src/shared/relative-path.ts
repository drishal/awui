// A path as a row shows it: workspace-relative when the file is inside the
// project, as given when it is not. Pure and shared (src/shared) so the server
// and every client shorten a path the same way; the web's turns.ts re-exports
// it for the components that have always imported it from there.

/** Show workspace-relative paths when the file is inside the project. */
export function relativePath(path: string, workspace: string): string {
  const base = workspace.endsWith("/") ? workspace : `${workspace}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}
