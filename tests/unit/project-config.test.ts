// A project's own awui.yml: what it may declare, how the hash makes trust exact, and
// that nothing runs without a recorded version plus an explicit request. The routes are
// driven through a real app over a real (tiny) git repository.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROJECT_CONFIG_FILE, ProjectConfigTrust, projectConfigStatus, readProjectConfig } from "../../src/server/project-config.js";
import { canRunSetup, defaultBase, projectConfigWants, trustLabel } from "../../src/web/project-config.js";
import { makeTestApp, signedIn, tempDir, type TestApp } from "../helpers/app.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

let apps: TestApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.close();
  apps = [];
});

/** A project folder that is a git repository with one commit, and its workspace id. */
async function project(): Promise<{ t: TestApp; ws: string; agent: Awaited<ReturnType<typeof signedIn>>; root: string }> {
  const t = await makeTestApp();
  apps.push(t);
  const root = t.project;
  git(root, "init", "-q");
  writeFileSync(path.join(root, "app.ts"), "const a = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  const agent = await signedIn(t);
  const ws = (await agent.post("/api/workspaces/open").send({ path: root })).body.id as string;
  return { t, ws, agent, root };
}

const config = (root: string, text: string) => writeFileSync(path.join(root, PROJECT_CONFIG_FILE), text);

describe("reading awui.yml", () => {
  const dir = () => mkdtempSync(path.join(tmpdir(), "awui-cfg-"));

  it("reads a base ref, shared entries, and a setup command, and names the version by hash", async () => {
    const root = dir();
    config(root, "base: main\nshared:\n  - node_modules\n  - .env\nsetup: npm ci\n");
    const read = await readProjectConfig(root);
    expect(read?.problem).toBeUndefined();
    expect(read?.config).toEqual({ base: "main", shared: ["node_modules", ".env"], setup: "npm ci" });
    expect(read?.hash).toMatch(/^[0-9a-f]{16}$/);
    const again = await readProjectConfig(root);
    expect(again?.hash).toBe(read?.hash);
    // One character changes the version trust is keyed on.
    config(root, "base: main\nshared:\n  - node_modules\n  - .env\nsetup: npm ci  \n");
    expect((await readProjectConfig(root))?.hash).not.toBe(read?.hash);
  });

  it("has nothing to say about a project without the file, and refuses what it cannot honour", async () => {
    const root = dir();
    expect(await readProjectConfig(root)).toBeNull();
    for (const [text, wanted] of [
      ["wat: true\n", /wat/],
      ["base: [unclosed\n", /not valid YAML/],
      ["shared:\n  - ../escape\n", /inside the project/],
      ["shared:\n  - /etc/passwd\n", /inside the project/],
      ["- just\n- a list\n", /expected object|not allowed/],
    ] as const) {
      config(root, text);
      const read = await readProjectConfig(root);
      expect(read?.problem).toMatch(wanted);
      expect(read?.config).toEqual({});
      expect(read?.hash).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("gives an empty file no settings and no problem", async () => {
    const root = dir();
    config(root, "");
    const read = await readProjectConfig(root);
    expect(read?.problem).toBeUndefined();
    expect(read?.config).toEqual({});
  });
});

describe("trust", () => {
  it("trusts one hash of one project, and remembers it across a restart", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "awui-trust-")), "project-config-trust.json");
    const trust = await ProjectConfigTrust.open(file);
    expect(trust.isTrusted("/proj", "abc")).toBe(false);
    await trust.trust("/proj", "abc");
    expect(trust.isTrusted("/proj", "abc")).toBe(true);
    // Another version of the same file, or the same hash elsewhere, is not trusted.
    expect(trust.isTrusted("/proj", "def")).toBe(false);
    expect(trust.isTrusted("/other", "abc")).toBe(false);
    const reopened = await ProjectConfigTrust.open(file);
    expect(reopened.isTrusted("/proj", "abc")).toBe(true);
  });

  it("reports the status the picker draws, trusted or not", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "awui-cfg-"));
    config(root, "base: main\nsetup: make\n");
    const trust = ProjectConfigTrust.inMemory();
    const before = await projectConfigStatus(root, trust);
    expect(before).toMatchObject({ file: PROJECT_CONFIG_FILE, trusted: false, config: { base: "main", setup: "make" } });
    await trust.trust(root, before?.hash ?? "");
    expect((await projectConfigStatus(root, trust))?.trusted).toBe(true);
    // A repository that edits the file loses the trust; that is what makes the hash matter.
    config(root, "setup: rm -rf /\n");
    expect((await projectConfigStatus(root, trust))?.trusted).toBe(false);
  });

  it("says in words what the picker offers", () => {
    const base = { file: PROJECT_CONFIG_FILE, hash: "0123456789abcdef", trusted: false, config: { base: "main", shared: ["node_modules"], setup: "npm ci" } };
    expect(projectConfigWants(base)).toBe("starts from main · shares node_modules · has a setup command");
    expect(canRunSetup(base)).toBe(false);
    expect(canRunSetup({ ...base, trusted: true })).toBe(true);
    expect(canRunSetup({ ...base, trusted: true, problem: "awui.yml is not valid YAML" })).toBe(false);
    expect(canRunSetup(null)).toBe(false);
    expect(trustLabel(base)).toBe("Trust this awui.yml (01234567)");
    expect(trustLabel({ ...base, trusted: true })).toBe("Trusted (01234567)");
    expect(defaultBase(base)).toBe("main");
    expect(defaultBase(null)).toBe("HEAD");
  });
});

describe("the picker's routes", () => {
  it("serves the file, trusts a version it was shown, and refuses a hash that has changed", async () => {
    const { ws, agent, root } = await project();
    expect((await agent.get(`/api/workspaces/${ws}/project-config`).expect(200)).body).toEqual({ config: null });
    config(root, "base: main\nsetup: echo hi > setup.txt\n");
    const shown = (await agent.get(`/api/workspaces/${ws}/project-config`).expect(200)).body.config as { hash: string; trusted: boolean };
    expect(shown.trusted).toBe(false);
    await agent.post(`/api/workspaces/${ws}/project-config/trust`).send({ hash: "0".repeat(16) }).expect(409);
    await agent.post(`/api/workspaces/${ws}/project-config/trust`).send({ hash: shown.hash }).expect(200);
    expect((await agent.get(`/api/workspaces/${ws}/project-config`).expect(200)).body.config.trusted).toBe(true);
    // A file that changed since the dialog was shown asks again.
    config(root, "setup: echo changed > setup.txt\n");
    await agent.post(`/api/workspaces/${ws}/project-config/trust`).send({ hash: shown.hash }).expect(409);
    // A refused file cannot be trusted at all.
    config(root, "wat: 1\n");
    const bad = (await agent.get(`/api/workspaces/${ws}/project-config`).expect(200)).body.config as { hash: string; problem: string };
    expect(bad.problem).toContain("wat");
    await agent.post(`/api/workspaces/${ws}/project-config/trust`).send({ hash: bad.hash }).expect(422);
  });

  it("seeds a new worktree with the shared entries, and runs setup only once trusted and asked", async () => {
    const { ws, agent, root } = await project();
    writeFileSync(path.join(root, "package-lock.json"), "{}\n");
    config(root, "shared:\n  - node_modules\nsetup: echo ran > setup.txt\n");
    // The shared entry must exist in the project, or it is reported as skipped.
    execFileSync("mkdir", ["-p", path.join(root, "node_modules")]);
    writeFileSync(path.join(root, "node_modules", "x.js"), "1\n");

    // Untrusted: a create asking for setup is refused before anything is made.
    await agent.post(`/api/workspaces/${ws}/worktrees`).send({ name: "first", base: "HEAD", setup: true }).expect(409);
    expect((await agent.get(`/api/workspaces/${ws}/worktrees`).expect(200)).body.worktrees).toHaveLength(0);

    // A plain create still seeds the shared entries (they are confined symlinks, not commands).
    const created = (await agent.post(`/api/workspaces/${ws}/worktrees`).send({ name: "first", base: "HEAD" }).expect(201)).body as { path: string; id: string; seeded: { linked: string[] } };
    expect(created.seeded.linked).toContain("node_modules");
    expect(existsSync(path.join(created.path, "node_modules"))).toBe(true);

    // Its setup command waits for the trust.
    await agent.post(`/api/workspaces/${ws}/worktrees/${created.id}/setup`).expect(409);
    const shown = (await agent.get(`/api/workspaces/${ws}/project-config`).expect(200)).body.config as { hash: string };
    await agent.post(`/api/workspaces/${ws}/project-config/trust`).send({ hash: shown.hash }).expect(200);
    const ran = (await agent.post(`/api/workspaces/${ws}/worktrees/${created.id}/setup`).expect(200)).body as { exitCode: number; output: string };
    expect(ran.exitCode).toBe(0);
    expect(readFileSync(path.join(created.path, "setup.txt"), "utf8")).toBe("ran\n");

    // A second create that asks for it runs it there too.
    const second = (await agent.post(`/api/workspaces/${ws}/worktrees`).send({ name: "second", base: "HEAD", setup: true }).expect(201)).body as { path: string; setup?: { exitCode: number } };
    expect(second.setup?.exitCode).toBe(0);
    expect(existsSync(path.join(second.path, "setup.txt"))).toBe(true);
  });

  it("has no setup to run for a project without one, and keeps the route to this project's trees", async () => {
    const { ws, agent, root } = await project();
    const created = (await agent.post(`/api/workspaces/${ws}/worktrees`).send({ name: "plain", base: "HEAD" }).expect(201)).body as { id: string };
    await agent.post(`/api/workspaces/${ws}/worktrees/${created.id}/setup`).expect(404);
    config(root, "setup: true\n");
    const shown = (await agent.get(`/api/workspaces/${ws}/project-config`).expect(200)).body.config as { hash: string };
    await agent.post(`/api/workspaces/${ws}/project-config/trust`).send({ hash: shown.hash }).expect(422);
    config(root, "setup: echo ok\n");
    await agent.post(`/api/workspaces/${ws}/worktrees/ffffffff/setup`).expect(409);
  });

  it("serves prompt skills only once the exact version is trusted, and refuses an invalid file", async () => {
    const { ws, agent, root } = await project();
    // No file, no skills.
    await agent.get(`/api/workspaces/${ws}/project-skills`).expect(404);
    config(root, "skills:\n  run-tests: Run the tests and report what fails\n  fix-lint: Fix every lint warning in src/\n");
    // Untrusted: the skills are not served, the same hash the setup command's trust uses.
    await agent.get(`/api/workspaces/${ws}/project-skills`).expect(409);
    const shown = (await agent.get(`/api/workspaces/${ws}/project-config`).expect(200)).body.config as { hash: string };
    await agent.post(`/api/workspaces/${ws}/project-config/trust`).send({ hash: shown.hash }).expect(200);
    const served = (await agent.get(`/api/workspaces/${ws}/project-skills`).expect(200)).body as { hash: string; skills: Record<string, string> };
    expect(served.hash).toBe(shown.hash);
    expect(served.skills).toEqual({ "run-tests": "Run the tests and report what fails", "fix-lint": "Fix every lint warning in src/" });
    // A commit that edits the file makes the skills untrusted again, and a bad key refuses the file.
    config(root, "skills:\n  run-tests: Changed prompt\n");
    await agent.get(`/api/workspaces/${ws}/project-skills`).expect(409);
    config(root, "skills:\n  Not_Kebab: bad name shape\n");
    const bad = await agent.get(`/api/workspaces/${ws}/project-skills`).expect(422);
    expect(bad.body.error).toContain("skills");
  });
});
