import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSettings, type SettingsContext } from "../../src/server/settings.js";
import { makeTestApp, signedIn, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;

// This machine may well have a Command Code key exported for the eval; a settings test must not read it.
beforeEach(() => {
  vi.stubEnv("CMD_API_KEY", "");
  vi.stubEnv("TYPESAFE_API_KEY", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await t?.close();
  t = null;
});

/** config.yml in the test server's settings folder (the folder exists, the file does not). */
function writeConfig(root: string, yaml: string): string {
  const dir = path.join(root, "settings");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "config.yml");
  writeFileSync(file, yaml);
  return file;
}

describe("the tool-card normalizer's settings", () => {
  it("is off by default, with the local backend selected and nothing to send to", async () => {
    t = await makeTestApp({ withSettings: true });
    const agent = await signedIn(t);
    const values = (await agent.get("/api/settings")).body.values;
    expect(values.normalizerEnabled).toBe(false);
    expect(values.normalizerBackend).toBe("local-clef-flash");
    expect(values.normalizerEndpoint).toBe("");
    expect(values.normalizerMinChoiceProbability).toBe(0.7);
    expect(values.normalizerMinNoul).toBe(0.7);
    expect(values.normalizerCache).toBe(true);
    expect(values.normalizerTimeoutMs).toBeNull();
    expect(values.hasJevKey).toBe(false);
    expect(values.hasCommandCodeKey).toBe(false);
    expect(values.hasCloudflareToken).toBe(false);
  });

  it("reports that a key is set without ever returning one", async () => {
    t = await makeTestApp({ withSettings: true });
    writeConfig(
      t.root,
      ["normalizer:", "  enabled: true", "  backend: command-code-jev", "  command_code_api_key: cmd-secret-value", "  jev_api_key: jev-secret-value", "  cloudflare_api_token: cf-secret-value", "  min_noul: 0.8"].join("\n"),
    );
    const agent = await signedIn(t);
    const settings = await agent.get("/api/settings");
    expect(settings.body.values.hasCommandCodeKey).toBe(true);
    expect(settings.body.values.hasJevKey).toBe(true);
    expect(settings.body.values.hasCloudflareToken).toBe(true);
    expect(settings.body.values.normalizerMinNoul).toBe(0.8);
    const raw = JSON.stringify(settings.body);
    for (const secret of ["cmd-secret-value", "jev-secret-value", "cf-secret-value"]) expect(raw).not.toContain(secret);
  });

  it("keeps a stored key when the save leaves it blank, and clears it when the save says -", async () => {
    t = await makeTestApp({ withSettings: true });
    const file = writeConfig(t.root, ["normalizer:", "  backend: command-code-jev", "  command_code_api_key: stored-key"].join("\n"));
    const agent = await signedIn(t);

    const kept = await agent.put("/api/settings").send({ normalizerCommandCodeApiKey: "", normalizerMinChoiceProbability: 0.75 }).expect(200);
    expect(kept.body.values.hasCommandCodeKey).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("command_code_api_key: stored-key");
    expect(kept.body.values.normalizerMinChoiceProbability).toBe(0.75);

    const cleared = await agent.put("/api/settings").send({ normalizerCommandCodeApiKey: "-" }).expect(200);
    expect(cleared.body.values.hasCommandCodeKey).toBe(false);
    expect(readFileSync(file, "utf8")).not.toContain("stored-key");
  });

  it("refuses to turn on the local backend with no endpoint, with the reason in the answer", async () => {
    t = await makeTestApp({ withSettings: true });
    const file = writeConfig(t.root, "normalizer:\n  backend: local-clef-flash\n");
    const agent = await signedIn(t);
    const res = await agent.put("/api/settings").send({ normalizerEnabled: true }).expect(422);
    expect(res.body.code).toBe("invalid_settings");
    expect(res.body.error).toContain("endpoint");
    // Nothing was written: the file still says nothing about being on.
    expect(readFileSync(file, "utf8")).not.toContain("enabled: true");

    // The same save with an endpoint is taken, and so is turning it on for a remote backend.
    const ok = await agent.put("/api/settings").send({ normalizerEnabled: true, normalizerEndpoint: "http://127.0.0.1:8000/v1/systemone" }).expect(200);
    expect(ok.body.values.normalizerEnabled).toBe(true);
    expect(ok.body.values.normalizerEndpoint).toBe("http://127.0.0.1:8000/v1/systemone");
    const remote = await agent.put("/api/settings").send({ normalizerBackend: "command-code-jev", normalizerEndpoint: "" }).expect(200);
    expect(remote.body.values.normalizerBackend).toBe("command-code-jev");
    expect(remote.body.values.normalizerEnabled).toBe(true);
  });

  it("writes config.yml at 0600 when it holds a normalizer key", async () => {
    t = await makeTestApp({ withSettings: true });
    const file = writeConfig(t.root, "normalizer:\n  backend: command-code-jev\n");
    const agent = await signedIn(t);
    await agent.put("/api/settings").send({ normalizerCommandCodeApiKey: "cmd-secret-value" }).expect(200);
    expect(statSync(file).mode & 0o077).toBe(0);
    expect(readFileSync(file, "utf8")).toContain("command_code_api_key: cmd-secret-value");
  });

  it("says when an environment variable sets a key, so a saved one would have no effect", async () => {
    t = await makeTestApp({ withSettings: true });
    writeConfig(t.root, "normalizer:\n  backend: command-code-jev\n");
    vi.stubEnv("CMD_API_KEY", "env-only-key");
    const ctx: SettingsContext = {
      configDir: path.join(t.root, "settings"),
      running: { port: 4783, host: "127.0.0.1", username: "", password: null, workspaceRoots: [t.root], allowedHosts: [], allowedTailscaleUsers: [], acpAgents: "[]" },
      envSet: new Set(["CMD_API_KEY", "TYPESAFE_API_KEY"]),
      credentialsFile: path.join(t.root, "credentials.json"),
      canRestart: false,
      home: t.root,
    };
    const settings = readSettings(ctx, true);
    expect(settings.envOverrides).toContain("hasCommandCodeKey");
    expect(settings.envOverrides).toContain("hasJevKey");
    // The flag reads the resolved config, which the environment's key satisfies with nothing in the file.
    expect(settings.values.hasCommandCodeKey).toBe(true);
    expect(JSON.stringify(settings)).not.toContain("env-only-key");
  });

  it("probes the saved settings through the route, and says why when there is nothing to call", async () => {
    t = await makeTestApp({ withSettings: true });
    const agent = await signedIn(t);
    const off = await agent.post("/api/settings/normalizer/test").expect(200);
    expect(off.body.ok).toBe(false);
    expect(off.body.backend).toBe("disabled");
    expect(off.body.status.backend).toBe("disabled");

    writeConfig(t.root, "normalizer:\n  enabled: true\n  backend: local-clef-flash\n");
    const unusable = await agent.post("/api/settings/normalizer/test").expect(200);
    expect(unusable.body.ok).toBe(false);
    expect(unusable.body.error).toContain("endpoint");
    expect(unusable.body.status.backend).toBe("unusable");
  });
});
