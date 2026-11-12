// Policy the client draws from a harness's declared capabilities, so no
// component names a harness id: a machine-wide chat surface (the awui
// harness) takes no project folder, runs on the home workspace, and keeps a
// flat history. Unknown harnesses read as project-scoped, so a status that
// has not loaded yet behaves like an ordinary coding harness.

export interface PolicyHarness {
  id: string;
  capabilities?: { supportsProjectFolders: boolean; webOnly: boolean };
}

/** Whether a harness's chats are scoped to a project folder (true when the harness is unknown). */
export function projectScoped(harnesses: PolicyHarness[], id: string): boolean {
  return harnesses.find((h) => h.id === id)?.capabilities?.supportsProjectFolders ?? true;
}
