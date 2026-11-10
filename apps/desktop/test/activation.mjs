// Drive the real CLI spawn functions against an executable fixture. It verifies
// concurrent first launches and subsequent hotkeys cannot create a second child.
// Electron's own main-renderer contract stays in the existing real smoke suite.
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, symlink, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDesktop } from "../../../dist/server/server/desktop-app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "first-desktop.mjs");

if (process.platform === "linux") {
  test("a real launcher serializes cold starts and repeat invocations reuse the original process", { timeout: 30000 }, async (t) => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "awui-launcher-"));
    const profile = path.join(stateDir, "desktop");
    const appLink = path.join(stateDir, "test-electron");
    const originalPath = process.env.AWUI_DESKTOP_BIN;
    const originalDelay = process.env.AWUI_TEST_DESKTOP_DELAY;
    const oldProfile = process.env.AWUI_TEST_DESKTOP_PROFILE;
    let childPid = null;
    t.after(async () => {
      if (childPid) { try { process.kill(childPid, "SIGTERM"); } catch {} }
      if (originalPath) process.env.AWUI_DESKTOP_BIN = originalPath; else delete process.env.AWUI_DESKTOP_BIN;
      if (originalDelay) process.env.AWUI_TEST_DESKTOP_DELAY = originalDelay; else delete process.env.AWUI_TEST_DESKTOP_DELAY;
      if (oldProfile) process.env.AWUI_TEST_DESKTOP_PROFILE = oldProfile; else delete process.env.AWUI_TEST_DESKTOP_PROFILE;
      await rm(stateDir, { recursive: true, force: true });
    });
    // A named helper makes behavior visible from its exact spawned argv. It is a
    // process at the same point an AppImage launch would occupy, not HTTP/wiring.
    await chmod(fixture, 0o755);
    await symlink(fixture, appLink);
    process.env.AWUI_DESKTOP_BIN = appLink;
    process.env.AWUI_TEST_DESKTOP_PROFILE = profile;
    process.env.AWUI_TEST_DESKTOP_DELAY = "800";
    await Promise.all([
      runDesktop({ args: [], stateDir }),
      runDesktop({ args: [], stateDir }),
      runDesktop({ args: [], stateDir }),
    ]);
    const spawns = (await readFile(path.join(profile, "spawns"), "utf8")).trim().split("\n");
    assert.equal(spawns.length, 1, "exactly one native child was spawned during three repeated invokes");
    childPid = Number(spawns[0]);
    await runDesktop({ args: ["awui://new"], stateDir });
    const owners = JSON.parse(await readFile(path.join(profile, "owner.json"), "utf8"));
    assert.equal(owners.pid, childPid, "the original focused child remains owner");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const activations = (await readFile(path.join(profile, "focus.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(activations.filter((row) => row.pid === childPid).length >= 3, "repeat startup requests reach the same child");
    assert.equal(await stat(path.join(profile, "launch.lock")).catch(() => null), null, "launch mutex released after success");
    const requests = await import("node:fs/promises").then(async ({ readdir }) => readdir(path.join(profile, "activation-requests")));
    assert.ok(requests.some((name) => name.endsWith(".json")), "request queue contains only an activation/link record");
    process.kill(childPid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await runDesktop({ args: [], stateDir });
    const newChild = (await readFile(path.join(profile, "spawns"), "utf8")).trim().split("\n");
    assert.equal(newChild.length, 2, "only a fresh child starts after the first was actually killed");
    childPid = Number(newChild[1]);
  });

}
