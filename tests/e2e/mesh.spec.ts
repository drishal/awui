import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { openSettings } from "./helpers.js";

// The mesh's browser surfaces (Settings → Peers): the shared suite server runs
// with the mesh off, which is exactly the honest disabled view the first
// describe checks; a second server of our own — config.yml with `mesh:` on and
// a config peer — drives the enabled view, whose rows, add/remove, invite, and
// the tasks and terms lists all come from a real `GET /api/mesh`.
const PORT = Number(process.env.AWUI_E2E_PORT ?? 4791) + 4;

async function startServer(withMesh: boolean): Promise<{ server: ChildProcess; configFile: string; base: string; dir: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), "awui-mesh-"));
  const root = path.join(dir, "workspaces");
  mkdirSync(path.join(root, "proj"), { recursive: true });
  const configDir = path.join(dir, "awui");
  mkdirSync(configDir, { recursive: true });
  const configFile = path.join(configDir, "config.yml");
  if (withMesh) {
    writeFileSync(configFile, `mesh:\n  enabled: true\n  name: mesh-e2e-box\n  peers:\n    - name: lab-from-yaml\n      tls: lab.internal:4784\n`);
  }
  const env: NodeJS.ProcessEnv = { ...process.env, AWUI_CONFIG_DIR: configDir, AWUI_HARNESSES: "fake,fake-b", WORKSPACE_ROOTS: root };
  for (const key of ["HOST", "PORT", "AUTH_USERNAME", "AUTH_PASSWORD", "AUTH_CREDENTIALS_FILE", "ALLOWED_HOSTS"]) delete env[key];
  env.PORT = String(PORT);
  env.XDG_STATE_HOME = path.join(dir, "state");
  env.THEME_FILE = path.join(dir, "none.yaml");
  const server = spawn(process.execPath, ["dist/server/server/index.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20_000);
    const onData = (c: Buffer) => {
      out += c.toString();
      if (out.includes(`Local: http://127.0.0.1:${PORT}/`)) {
        clearTimeout(timer);
        resolve();
      }
    };
    server.stdout?.on("data", onData);
    server.stderr?.on("data", onData);
    server.once("exit", (code) => reject(new Error(`server exited (${code}):\n${out}`)));
  });
  return { server, configFile, base: `http://127.0.0.1:${PORT}`, dir };
}

test.describe("Settings → Peers with the mesh off (shared server)", () => {
  // The suite's own server: AWUI_CONFIG_DIR is empty, so mesh.enabled is
  // false and the panel must say so honestly rather than pretend.

  test("renders the honest disabled view, and a mutating route answers 409 mesh_off", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    await openSettings(page);
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("tab", { name: "Peers", exact: true }).click();
    const panel = settings.locator("#settings-panel-peers");
    await expect(panel).toBeVisible();
    await expect(panel.getByText(/mesh is off/i)).toBeVisible();
    await expect(panel.locator('[data-settings-row="node"]')).toContainText(/node id/);
    // Add refuses while the mesh is off, through the same route the UI uses.
    const add = await page.request.post("/api/mesh/peers", { data: { name: "lab", tls: "lab.internal:4784" } });
    expect(add.status()).toBe(409);
    expect((await add.json()).code).toBe("mesh_off");
  });
});

test.describe("Settings → Peers with the mesh on", () => {
  let ctx: { server: ChildProcess; configFile: string; base: string; dir: string } | null = null;

  test.beforeAll(async () => {
    ctx = await startServer(true);
  });

  test.afterAll(async () => {
    if (!ctx || ctx.server.exitCode !== null) return;
    const exited = new Promise((r) => ctx?.server.once("exit", r));
    ctx.server.kill("SIGTERM");
    await exited;
    // Best-effort: the state folder may still be flushing its last write.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(ctx.dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  test("renders peers from GET /api/mesh, adds and removes one from the dialog, and reads the tasks and terms lists", async ({ page }) => {
    const { base } = ctx as NonNullable<typeof ctx>;
    await page.goto(`${base}/`);
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    await openSettings(page);
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("tab", { name: "Peers", exact: true }).click();
    const panel = settings.locator("#settings-panel-peers");
    await expect(panel).toBeVisible();

    // The config.yml peer renders with its transport and address, from the
    // same GET the panel polls — the cross-module contract unit tests with
    // hand-crafted payloads cannot see.
    const peers = panel.locator('[data-settings-row="peer-list"]');
    await expect(peers.getByText("lab-from-yaml")).toBeVisible();
    await expect(peers.getByText(/TLS · lab\.internal:4784/)).toBeVisible();
    await expect(peers.getByText("config.yml", { exact: true })).toBeVisible();

    // Add one from the dialog: it lands in peers.json and renders as saved here.
    await panel.getByLabel("Peer name").fill("lab-from-ui");
    await panel.getByLabel("Peer address").fill("lab-two.internal:4784");
    await panel.getByRole("button", { name: "Add" }).click();
    await expect(peers.getByText("lab-from-ui")).toBeVisible();
    await expect(peers.getByText("saved here").first()).toBeVisible();
    // Remove is revocation: the row goes and the pins with it.
    await panel.getByRole("button", { name: "Remove lab-from-ui" }).click();
    await expect(peers.getByText("lab-from-ui")).toHaveCount(0);

    // An invite mints a code with a QR, in the dialog itself.
    await panel.getByRole("button", { name: "Create invite" }).click();
    await expect(panel.getByRole("textbox", { name: "Invite code", exact: true })).toHaveValue(/^awui-invite:1:/);
    await expect(panel.getByRole("img", { name: "Invite QR code" })).toBeVisible();

    // The target's own lists read honestly: no peer task, no peer terminal.
    await expect(panel.locator('[data-settings-row="tasks"]')).toContainText("No peer task is running on this node.");
    await expect(panel.locator('[data-settings-row="terms"]')).toContainText("No peer terminal is open on this node.");

    // The kill route is audited and refuses what is not open.
    const kill = await page.request.post(`${base}/api/mesh/terms/no-such-term/close`, { data: {} });
    expect(kill.status()).toBe(404);
  });
});
