// The awui harness's provider settings: read from and written to its isolated
// agent dir's models.json, with the apiKey never returned to the browser —
// plus the opt-in that links the user's pi login into that dir and copies
// Pi's providers in once, when sharing is turned on.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HarnessRegistry } from "../../src/server/harness/registry.js";
import { AwuiAdapter } from "../../src/server/harness/awui.js";
import { readAwuiConfig, writeAwuiConfig } from "../../src/server/awui-settings.js";

function registryWith(): { registry: HarnessRegistry; agentDir: string } {
  const stateDir = mkdtempSync(path.join(tmpdir(), "awui-cfg-"));
  const registry = new HarnessRegistry();
  registry.register(new AwuiAdapter(stateDir));
  return { registry, agentDir: path.join(stateDir, "awui-agent") };
}

/** A fake $HOME whose ~/.pi/agent holds the given auth.json text and providers. */
function piHomeWith(auth: string | null, providers?: Record<string, unknown>): string {
  const home = mkdtempSync(path.join(tmpdir(), "awui-pihome-"));
  const piAgent = path.join(home, ".pi", "agent");
  mkdirSync(piAgent, { recursive: true });
  if (auth !== null) writeFileSync(path.join(piAgent, "auth.json"), auth);
  if (providers !== undefined) writeFileSync(path.join(piAgent, "models.json"), JSON.stringify({ providers }));
  return home;
}

/** Run with $HOME pointed at a fake pi setup, restored afterwards (the adapter tests do the same). */
async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

describe("awui harness settings", () => {
  it("reads providers with the apiKey redacted to a flag", async () => {
    const { registry } = registryWith();
    await writeAwuiConfig(registry, { providers: { litellm: { baseUrl: "http://h:1/v1", api: "openai-completions", apiKey: "sk-secret" } } });
    const read = await readAwuiConfig(registry);
    expect(read.providers.litellm).toMatchObject({ baseUrl: "http://h:1/v1", api: "openai-completions", hasApiKey: true });
    expect(JSON.stringify(read)).not.toContain("sk-secret");
  });

  it("keeps the stored key when the form leaves it blank, and clears it on an empty string", async () => {
    const { registry } = registryWith();
    await writeAwuiConfig(registry, { providers: { local: { baseUrl: "http://h:2/v1", api: "openai-completions", apiKey: "sk-first" } } });
    // Blank (omitted): keep.
    const kept = await writeAwuiConfig(registry, { providers: { local: { baseUrl: "http://h:2/v1", api: "openai-completions" } } });
    expect(kept.providers.local?.hasApiKey).toBe(true);
    // Empty string: clear.
    const cleared = await writeAwuiConfig(registry, { providers: { local: { baseUrl: "http://h:2/v1", api: "openai-completions", apiKey: "" } } });
    expect(cleared.providers.local?.hasApiKey).toBe(false);
  });

  it("keeps a provider's modelOverrides when a save leaves them out (the dialog has no field for them)", async () => {
    const { registry, agentDir } = registryWith();
    const overrides = { "gpt-x": { contextWindow: 128000 } };
    await writeAwuiConfig(registry, { providers: { local: { baseUrl: "http://h:4/v1", api: "openai-completions", modelOverrides: overrides } } });
    await writeAwuiConfig(registry, { providers: { local: { baseUrl: "http://h:4/v2", api: "openai-completions" } } });
    const raw = JSON.parse(await readFile(path.join(agentDir, "models.json"), "utf8")) as { providers: Record<string, { baseUrl: string; modelOverrides?: unknown }> };
    expect(raw.providers.local).toMatchObject({ baseUrl: "http://h:4/v2", modelOverrides: overrides });
  });

  it("writes the isolated agent dir's models.json with the key on disk", async () => {
    const { registry, agentDir } = registryWith();
    await writeAwuiConfig(registry, { providers: { litellm: { baseUrl: "http://h:3/v1", api: "openai-completions", apiKey: "sk-x" } } });
    const raw = JSON.parse(await readFile(path.join(agentDir, "models.json"), "utf8")) as { providers: Record<string, { apiKey?: string }> };
    expect(raw.providers.litellm?.apiKey).toBe("sk-x");
  });

  it("rejects a provider without an http(s) baseUrl", async () => {
    const { registry } = registryWith();
    await expect(writeAwuiConfig(registry, { providers: { bad: { baseUrl: "notaurl", api: "x" } } })).rejects.toThrow();
  });

  it("404s when the awui harness is not registered", async () => {
    const registry = new HarnessRegistry();
    await expect(readAwuiConfig(registry)).rejects.toMatchObject({ code: "no_awui_harness" });
  });
});

describe("sharing the user's pi login", () => {
  // A pi setup shaped like a real one: an OAuth login in auth.json, and a provider whose key and `models` catalog live in models.json.
  const piProviders = { local2: { baseUrl: "http://192.0.2.20:8085/v1", api: "openai-completions", apiKey: "sk-pi", models: [{ id: "GLM5", name: "GLM 5.2" }] } };
  const piAuth = JSON.stringify({ xai: { access: "t", refresh: "r" } });

  it("links auth.json to the user's and seeds Pi's providers verbatim when turned on", async () => {
    const home = piHomeWith(piAuth, piProviders);
    await withHome(home, async () => {
      const { registry, agentDir } = registryWith();
      const next = await writeAwuiConfig(registry, { shareAuth: true });
      expect(next.shareAuth).toBe(true);
      expect(next.providers.local2).toMatchObject({ baseUrl: "http://192.0.2.20:8085/v1", api: "openai-completions", hasApiKey: true });
      expect(lstatSync(path.join(agentDir, "auth.json")).isSymbolicLink()).toBe(true);
      // Through the link, the child reads the user's login — one file, both sides.
      expect(JSON.parse(await readFile(path.join(agentDir, "auth.json"), "utf8"))).toEqual(JSON.parse(piAuth));
      // Verbatim: the `models` catalog rides along with the key.
      const raw = JSON.parse(await readFile(path.join(agentDir, "models.json"), "utf8")) as { providers: unknown };
      expect(raw.providers).toEqual(piProviders);
    });
  });

  it("is refused without a pi login, and nothing is written", async () => {
    const home = piHomeWith(null, piProviders);
    await withHome(home, async () => {
      const { registry, agentDir } = registryWith();
      await expect(writeAwuiConfig(registry, { shareAuth: true })).rejects.toMatchObject({ code: "no_pi_login" });
      expect(existsSync(path.join(agentDir, "auth.json"))).toBe(false);
      expect(existsSync(path.join(agentDir, "models.json"))).toBe(false);
    });
  });

  it("is refused when the harness has its own login, and that login is untouched", async () => {
    const home = piHomeWith(piAuth);
    await withHome(home, async () => {
      const { registry, agentDir } = registryWith();
      const own = path.join(agentDir, "auth.json");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(own, JSON.stringify({ "opencode-go": { key: "k" } }));
      await expect(writeAwuiConfig(registry, { shareAuth: true })).rejects.toMatchObject({ code: "awui_login_conflict" });
      expect(JSON.parse(readFileSync(own, "utf8"))).toEqual({ "opencode-go": { key: "k" } });
      expect(lstatSync(own).isSymbolicLink()).toBe(false);
    });
  });

  it("replaces an empty isolated login", async () => {
    const home = piHomeWith(piAuth);
    await withHome(home, async () => {
      const { registry, agentDir } = registryWith();
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(path.join(agentDir, "auth.json"), "{}");
      const next = await writeAwuiConfig(registry, { shareAuth: true });
      expect(next.shareAuth).toBe(true);
      expect(lstatSync(path.join(agentDir, "auth.json")).isSymbolicLink()).toBe(true);
    });
  });

  it("turning it off restores an isolated login and keeps the seeded providers", async () => {
    const home = piHomeWith(piAuth, piProviders);
    await withHome(home, async () => {
      const { registry, agentDir } = registryWith();
      await writeAwuiConfig(registry, { shareAuth: true });
      const next = await writeAwuiConfig(registry, { shareAuth: false });
      expect(next.shareAuth).toBe(false);
      expect(lstatSync(path.join(agentDir, "auth.json")).isSymbolicLink()).toBe(false);
      expect(JSON.parse(await readFile(path.join(agentDir, "auth.json"), "utf8"))).toEqual({});
      expect(next.providers.local2).toBeDefined();
    });
  });

  it("the seed adds only what the harness's own list lacks, and an edited provider keeps its edits", async () => {
    const home = piHomeWith(piAuth, { ...piProviders, other: { baseUrl: "http://192.0.2.30:1/v1", api: "openai-completions" } });
    await withHome(home, async () => {
      const { registry, agentDir } = registryWith();
      await writeAwuiConfig(registry, {
        providers: {
          mine: { baseUrl: "http://h:5/v1", api: "openai-completions", apiKey: "sk-mine" },
          // The same name as pi's, with an endpoint and key set here.
          local2: { baseUrl: "http://h:6/v1", api: "openai-completions", apiKey: "sk-edited" },
        },
      });
      const next = await writeAwuiConfig(registry, { shareAuth: true });
      expect(next.shareAuth).toBe(true);
      expect(Object.keys(next.providers).sort()).toEqual(["local2", "mine", "other"]);
      const raw = JSON.parse(await readFile(path.join(agentDir, "models.json"), "utf8")) as { providers: Record<string, { baseUrl: string; apiKey?: string }> };
      // The user's own list wins over the copy.
      expect(raw.providers.local2).toMatchObject({ baseUrl: "http://h:6/v1", apiKey: "sk-edited" });
      expect(raw.providers.mine?.apiKey).toBe("sk-mine");
    });
  });

  it("a providers-only save does not re-seed Pi's list", async () => {
    const home = piHomeWith(piAuth, piProviders);
    await withHome(home, async () => {
      const { registry } = registryWith();
      await writeAwuiConfig(registry, { shareAuth: true });
      const emptied = await writeAwuiConfig(registry, { providers: {} });
      expect(emptied.shareAuth).toBe(true);
      expect(emptied.providers).toEqual({});
    });
  });

  it("pi-shaped fields survive a providers save after the seed", async () => {
    const home = piHomeWith(piAuth, piProviders);
    await withHome(home, async () => {
      const { registry, agentDir } = registryWith();
      await writeAwuiConfig(registry, { shareAuth: true });
      // The dialog edits only name, URL, api kind, and key.
      await writeAwuiConfig(registry, { providers: { local2: { baseUrl: "http://h:9/v1", api: "openai-completions" } } });
      const raw = JSON.parse(await readFile(path.join(agentDir, "models.json"), "utf8")) as { providers: Record<string, { baseUrl?: string; apiKey?: string; models?: unknown[] }> };
      expect(raw.providers.local2).toMatchObject({ baseUrl: "http://h:9/v1", apiKey: "sk-pi" });
      expect(raw.providers.local2?.models).toEqual([{ id: "GLM5", name: "GLM 5.2" }]);
    });
  });

  it("reports sharing state and whether a pi login exists", async () => {
    const home = piHomeWith(piAuth);
    await withHome(home, async () => {
      const { registry } = registryWith();
      const read = await readAwuiConfig(registry);
      expect(read.piLogin).toBe(true);
      expect(read.shareAuth).toBe(false);
      expect(read.providers).toEqual({});
    });
  });
});
