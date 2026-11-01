import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

// A real HOST=0.0.0.0 server reached through this machine's LAN address, so
// the browser is "another device": it must sign in with username/password.
// The suite's own port plus one and two: a second checkout or a shard moves the whole block with
// AWUI_E2E_PORT, so these servers never land on another run's port.
const PORT = (Number(process.env.AWUI_E2E_PORT) || 4791) + 1;
const ENV_PORT = PORT + 1;
const lanIp = Object.values(networkInterfaces())
  .flat()
  .find((a) => a && a.family === "IPv4" && !a.internal)?.address;

/** A temp dir with one project, plus the env that keeps the server inside it. */
function sandbox(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(path.join(tmpdir(), "awui-remote-"));
  const root = path.join(dir, "workspaces");
  mkdirSync(path.join(root, "proj"), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AWUI_CONFIG_DIR: "",
    AWUI_HARNESSES: "fake",
    WORKSPACE_ROOTS: root,
    XDG_STATE_HOME: path.join(dir, "state"),
    THEME_FILE: path.join(dir, "none.yaml"),
  };
  for (const key of ["HOST", "PORT", "AUTH_USERNAME", "AUTH_PASSWORD", "AUTH_CREDENTIALS_FILE", "ALLOWED_HOSTS"]) delete env[key];
  return { dir, env };
}

async function startServer(env: NodeJS.ProcessEnv, port: number): Promise<ChildProcess> {
  const server = spawn(process.execPath, ["dist/server/server/index.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20_000);
    const onData = (c: Buffer) => {
      out += c.toString();
      if (out.includes(`LAN:   http://${lanIp}:${port}/`)) {
        clearTimeout(timer);
        resolve();
      }
    };
    server.stdout?.on("data", onData);
    server.stderr?.on("data", onData);
    server.once("exit", (code) => reject(new Error(`server exited (${code}):\n${out}`)));
  });
  return server;
}

async function stopServer(server: ChildProcess | null): Promise<void> {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((r) => server.once("exit", r));
  server.kill("SIGTERM");
  await exited;
}

test.describe("other devices (HOST=0.0.0.0)", () => {
  test.skip(!lanIp, "no LAN IPv4 address on this machine");
  let server: ChildProcess | null = null;
  const base = `http://${lanIp}:${PORT}`;

  test.beforeAll(async () => {
    const { dir, env } = sandbox();
    const creds = path.join(dir, "credentials.json");
    execFileSync(process.execPath, ["scripts/set-password.mjs", "alice", "--stdin"], {
      input: "lan-password-123\n",
      env: { ...process.env, AUTH_CREDENTIALS_FILE: creds },
    });
    server = await startServer({ ...env, HOST: "0.0.0.0", PORT: String(PORT), AUTH_CREDENTIALS_FILE: creds }, PORT);
  });

  test.afterAll(async () => {
    await stopServer(server);
  });

  test("sign in with username and password, then sign out", async ({ page }) => {
    await page.goto(`${base}/`);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expect((await page.request.get(`${base}/api/bootstrap`)).status()).toBe(401);
    await page.getByLabel("Username").fill("alice");
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toHaveText("Wrong username or password");
    await page.getByLabel("Password").fill("lan-password-123");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await page.getByRole("button", { name: "Pair phone" }).click();
    // Pairing opens in place of Settings; closing it returns to the app.
    const pair = page.getByRole("dialog", { name: "Pair a phone" });
    await expect(pair).toContainText(`http://${lanIp}:${PORT}/`);
    await page.keyboard.press("Escape");
    await expect(pair).toBeHidden();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("this machine's own localhost still needs no sign-in", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  });
});

test.describe("settings and login from config.yml", () => {
  test.skip(!lanIp, "no LAN IPv4 address on this machine");
  let server: ChildProcess | null = null;
  const base = `http://${lanIp}:${ENV_PORT}`;

  test.afterAll(async () => {
    await stopServer(server);
  });

  test("port, host and the login come from config.yml, and a restart keeps devices signed in", async ({ page }) => {
    const { dir, env } = sandbox();
    const configDir = path.join(dir, "awui");
    mkdirSync(configDir);
    const configFile = path.join(configDir, "config.yml");
    const settings = (password: string) =>
      `# test settings\nport: ${ENV_PORT}\nhost: 0.0.0.0\nauth:\n  username: bob\n  password: "${password}"\n`;
    writeFileSync(configFile, settings("env password 123"), { mode: 0o644 });
    const withFile = { ...env, AWUI_CONFIG_DIR: configDir };
    server = await startServer(withFile, ENV_PORT);
    // It holds a password, so the server narrowed it to the owner.
    expect(statSync(configFile).mode & 0o777).toBe(0o600);

    await page.goto(`${base}/`);
    await page.getByLabel("Username").fill("bob");
    await page.getByLabel("Password").fill("env password 123");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();

    await stopServer(server);
    server = await startServer(withFile, ENV_PORT);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();

    // A changed password signs that device out.
    await stopServer(server);
    writeFileSync(configFile, settings("another-password"));
    server = await startServer(withFile, ENV_PORT);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });
});
