// The awui harness is a pi child with no way to write or execute. These tests
// pin what the rest of the app can observe — its id, its colour, the capabilities
// the UI reads, and that its config and sessions live under awui's state folder
// instead of the user's pi config. The spawn-time lockdown (the denied tool set,
// no extensions) is wired in awui.ts and proven by typecheck + the pi adapter's
// own tests; it is not part of the public shape, so it is not asserted here.
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../helpers/app.js";
import { AwuiAdapter } from "../../src/server/harness/awui.js";

describe("AwuiAdapter", () => {
  const stateDir = tempDir("awui-state-");
  const adapter = new AwuiAdapter(stateDir);

  it("is its own harness id and colour, not pi's", () => {
    expect(adapter.id).toBe("awui");
    expect(adapter.displayName).toBe("Awui");
    expect(adapter.accent).not.toBe("link");
  });

  it("declares no write or exec capability, but does render pages", () => {
    const c = adapter.capabilities;
    // The read-only chat surface: message and ask, never change anything.
    expect(c.supportsFork).toBe(false);
    expect(c.supportsHandoff).toBe(false);
    expect(c.supportsRewind).toBe(false);
    // Artifacts belong in a chat surface: render_html publishes display-only pages (display, not a project write).
    expect(c.supportsHtmlRender).toBe(true);
    expect(c.supportsExtensions).toBe(true);
    // It still talks, steers, and shows thinking and usage like pi.
    expect(c.supportsSteer).toBe(true);
    expect(c.supportsModelSelection).toBe(true);
    expect(c.supportsInteractiveRequests).toBe(true);
  });

  it("keeps its agent dir and session dir inside awui's state folder, off the user's pi config", async () => {
    const agentDir = await adapter.resolveAgentDir();
    const sessionDir = await adapter.resolveSessionDir(path.join(path.sep, "some", "project"));
    expect(agentDir).toBe(path.join(stateDir, "awui-agent"));
    expect(sessionDir.startsWith(path.join(stateDir, "awui-agent", "sessions"))).toBe(true);
    expect(agentDir).not.toContain(path.join(".pi", "agent"));
  });

  it("mirrors the user's ~/.pi litellm provider into the isolated agent dir", async () => {
    const home = tempDir("awui-home-");
    const piAgent = path.join(home, ".pi", "agent");
    mkdirSync(piAgent, { recursive: true });
    writeFileSync(
      path.join(piAgent, "models.json"),
      JSON.stringify({
        providers: {
          litellm: { baseUrl: "http://192.0.2.10:8085/v1", api: "openai-completions", apiKey: "sk-test", modelOverrides: {} },
          anthropic: { apiKey: "sk-should-not-copy" },
        },
      }),
    );
    const stateDir2 = tempDir("awui-state-");
    const ad = new AwuiAdapter(stateDir2);
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const agentDir = await ad.resolveAgentDir();
      const written = JSON.parse(readFileSync(path.join(agentDir, "models.json"), "utf8")) as { providers: Record<string, { baseUrl?: string }> };
      expect(written.providers.litellm?.baseUrl).toBe("http://192.0.2.10:8085/v1");
      expect(written.providers.anthropic).toBeUndefined();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  it("writes no models.json when the user has no litellm provider", async () => {
    const home = tempDir("awui-home-");
    const stateDir2 = tempDir("awui-state-");
    const ad = new AwuiAdapter(stateDir2);
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const agentDir = await ad.resolveAgentDir();
      expect(existsSync(path.join(agentDir, "models.json"))).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  it("never links the user's pi login by itself; that is the Settings opt-in (awui-settings.ts)", async () => {
    const home = tempDir("awui-home-");
    const piAgent = path.join(home, ".pi", "agent");
    mkdirSync(piAgent, { recursive: true });
    writeFileSync(path.join(piAgent, "auth.json"), JSON.stringify({ xai: { access: "t" } }));
    const stateDir2 = tempDir("awui-state-");
    const ad = new AwuiAdapter(stateDir2);
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const agentDir = await ad.resolveAgentDir();
      const auth = path.join(agentDir, "auth.json");
      expect(existsSync(auth) ? lstatSync(auth).isSymbolicLink() : false).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });
});
