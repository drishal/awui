// direnv's spawn-env plumbing: the .envrc above a chat's project applies to the
// harness envForSpawn returns, the blocked state is reported, and allowEnvrc
// consents it. Real direnv against temp folders (skipped where direnv is absent).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { allowEnvrc, clearDirenvCache, direnvState, envForSpawn, findEnvrc } from "../../src/server/direnv.js";

const HAS_DIRENV = (() => {
  try {
    execFileSync("direnv", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const roots: string[] = [];
function makeProject(withRc = true): string {
  const root = mkdtempSync(path.join(tmpdir(), "awui-direnv-"));
  roots.push(root);
  mkdirSync(path.join(root, "proj"));
  if (withRc) writeFileSync(path.join(root, "proj", ".envrc"), "export AWUI_TEST_ENVRC=from-envrc\nexport DIRENV_LOG_FORMAT=\n");
  return root;
}

afterEach(() => {
  clearDirenvCache();
});

describe.skipIf(!HAS_DIRENV)("direnv spawn env", () => {
  it("finds the nearest .envrc up the tree and none without one", () => {
    const root = makeProject();
    const nested = path.join(root, "proj", "src", "deep");
    mkdirSync(nested, { recursive: true });
    expect(findEnvrc(nested)).toBe(path.join(root, "proj", ".envrc"));
    expect(findEnvrc(root)).toBeNull();
    expect(findEnvrc(tmpdir())).toBeNull();
  });

  it("applies an allowed .envrc to the spawn env", () => {
    const root = makeProject();
    const proj = path.join(root, "proj");
    expect(allowEnvrc(proj)).toBe(true);
    clearDirenvCache();
    const { env, state } = envForSpawn(proj);
    expect(state.blocked).toBe(false);
    expect(env.AWUI_TEST_ENVRC).toBe("from-envrc");
    // direnv's own session bookkeeping never reaches a spawned agent.
    expect(env.DIRENV_DIFF).toBeUndefined();
    expect(env.DIRENV_DIR).toBeUndefined();
    expect(env.DIRENV_WATCHES).toBeUndefined();
  });

  it("reports a fresh .envrc as blocked and leaves the env unchanged", () => {
    const root = makeProject();
    const proj = path.join(root, "proj");
    const first = envForSpawn(proj);
    expect(first.state.blocked).toBe(true);
    expect(first.state.rcPath).toBe(path.join(proj, ".envrc"));
    expect(first.env.AWUI_TEST_ENVRC).toBeUndefined();
    // Allowing clears the block for the next look, without a restart.
    expect(allowEnvrc(proj)).toBe(true);
    const second = envForSpawn(proj);
    expect(second.state.blocked).toBe(false);
    expect(second.env.AWUI_TEST_ENVRC).toBe("from-envrc");
  });

  it("reads the blocked state without evaluating the .envrc", () => {
    const root = makeProject();
    const proj = path.join(root, "proj");
    // An .envrc that would run for ages (and leave a marker) if anything evaluated it.
    writeFileSync(path.join(proj, ".envrc"), `touch ${JSON.stringify(path.join(root, "ran"))}\nsleep 20\n`);
    const started = Date.now();
    expect(direnvState(proj)).toEqual({ blocked: true, rcPath: path.join(proj, ".envrc") });
    expect(allowEnvrc(proj)).toBe(true);
    expect(direnvState(proj).blocked).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(existsSync(path.join(root, "ran"))).toBe(false);
    expect(direnvState(root)).toEqual({ blocked: false, rcPath: null });
  });

  it("re-reads when the .envrc changes on disk", () => {
    const root = makeProject();
    const proj = path.join(root, "proj");
    allowEnvrc(proj);
    expect(envForSpawn(proj).env.AWUI_TEST_ENVRC).toBe("from-envrc");
    // Renaming the variable without touching the file would serve the cache; rewriting it must not.
    writeFileSync(path.join(proj, ".envrc"), "export AWUI_TEST_ENVRC=second\n");
    const next = envForSpawn(proj);
    // A changed .envrc is blocked again until allowed (direnv's own gate), and old values never leak.
    expect(next.state.blocked).toBe(true);
    expect(next.env.AWUI_TEST_ENVRC).toBeUndefined();
    expect(allowEnvrc(proj)).toBe(true);
    expect(envForSpawn(proj).env.AWUI_TEST_ENVRC).toBe("second");
  });

  it("a project without one anywhere is untouched", () => {
    const root = mkdtempSync(path.join(tmpdir(), "awui-direnv-none-"));
    roots.push(root);
    const proj = path.join(root, "proj");
    mkdirSync(proj);
    const { env, state } = envForSpawn(proj);
    expect(state.blocked).toBe(false);
    expect(state.rcPath).toBeNull();
    expect(env.AWUI_TEST_ENVRC).toBeUndefined();
    expect(allowEnvrc(proj)).toBe(false);
  });
});
