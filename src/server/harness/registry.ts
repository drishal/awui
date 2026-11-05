// Adding a harness = one adapter file + one entry in `factories`.
import { asHarnessId, HARNESS_ACCENTS, type HarnessId, type HarnessStatus } from "../../shared/protocol.js";
import type { ServerConfig } from "../config.js";
import { ClaudeAdapter } from "./claude.js";
import { DshAdapter } from "./dsh.js";
import { FakeAdapter } from "./fake.js";
import { GrokAdapter } from "./grok.js";
import { HermesAdapter } from "./hermes.js";
import { OmpAdapter } from "./omp.js";
import { OpenCodeAdapter } from "./opencode.js";
import { PiAdapter } from "./pi.js";
import { AwuiAdapter } from "./awui.js";
import type { HarnessAdapter } from "./types.js";

const fakeDelay = () => Number(process.env.AWUI_FAKE_DELAY_MS ?? 15);
const fakeResumeDelay = () => Number(process.env.AWUI_FAKE_RESUME_MS ?? 0);

const factories: Record<string, (config: ServerConfig) => HarnessAdapter> = {
  pi: (config) => new PiAdapter(config.launch.pi),
  omp: (config) => new OmpAdapter({ agentDir: config.ompAgentDir, sessionDir: config.ompSessionDir, home: config.home, ...config.launch.omp }),
  hermes: (config) => new HermesAdapter(config.launch.hermes?.command ? { launcher: config.launch.hermes.command } : {}),
  claude: (config) => new ClaudeAdapter({ home: config.home, ...config.launch.claude }),
  opencode: (config) => new OpenCodeAdapter(config.launch.opencode?.command ? { command: config.launch.opencode.command } : {}),
  grok: (config) => new GrokAdapter({ home: config.home, ...config.launch.grok }),
  dsh: (config) => new DshAdapter({ home: config.home, ...config.launch.dsh }),
  // A locked-down pi child: chat-style, read-only (web search + read tools + read-only MCP), its own agent dir.
  awui: (config) => new AwuiAdapter(config.stateDir, config.launch.pi?.command),
  // Test-only adapters, selected with AWUI_HARNESSES=fake,fake-b.
  fake: () => new FakeAdapter({ chunkDelayMs: fakeDelay(), resumeDelayMs: fakeResumeDelay() }),
  "fake-b": () =>
    new FakeAdapter({ id: "fake-b", displayName: "Fake B", chunkDelayMs: fakeDelay(), capabilities: { supportsSteer: false, supportsRewind: false, supportsPermissionMode: false, supportsResumeCommand: false } }),
};

/**
 * Each adapter's colour: its own when it names one of the theme's accents,
 * else the first accent no other harness has claimed (cycling once all are taken).
 */
export function assignAccents(adapters: HarnessAdapter[]): Map<HarnessId, string> {
  const known = new Set<string>(HARNESS_ACCENTS);
  const out = new Map<HarnessId, string>();
  for (const a of adapters) if (a.accent && known.has(a.accent)) out.set(a.id, a.accent);
  const taken = new Set(out.values());
  let spare = HARNESS_ACCENTS.filter((t) => !taken.has(t));
  let i = 0;
  for (const a of adapters) {
    if (out.has(a.id)) continue;
    if (spare.length === 0) spare = [...HARNESS_ACCENTS];
    out.set(a.id, spare[i % spare.length] as string);
    i += 1;
  }
  return out;
}

export class HarnessRegistry {
  private adapters = new Map<HarnessId, HarnessAdapter>();
  private statuses = new Map<HarnessId, HarnessStatus>();

  register(adapter: HarnessAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  static fromConfig(config: ServerConfig): HarnessRegistry {
    const registry = new HarnessRegistry();
    for (const name of config.harnesses) {
      const factory = factories[name];
      if (!factory) throw new Error(`Unknown harness in AWUI_HARNESSES: ${name}`);
      registry.register(factory(config));
    }
    return registry;
  }

  list(): HarnessAdapter[] {
    return [...this.adapters.values()];
  }

  get(id: string): HarnessAdapter | undefined {
    return this.adapters.get(asHarnessId(id));
  }

  async refreshStatus(): Promise<HarnessStatus[]> {
    const accents = assignAccents(this.list());
    await Promise.all(
      this.list().map(async (adapter) => {
        const d = await adapter.discover().catch((error: unknown) => ({
          available: false,
          reason: `Discovery failed: ${error instanceof Error ? error.message : String(error)}`,
          warnings: [],
          overrides: {},
        }));
        this.statuses.set(adapter.id, {
          id: adapter.id,
          displayName: adapter.displayName,
          available: d.available,
          ...("version" in d && d.version ? { version: d.version } : {}),
          ...("versionDetail" in d && d.versionDetail ? { versionDetail: d.versionDetail } : {}),
          ...(d.reason ? { reason: d.reason } : {}),
          warnings: d.warnings,
          capabilities: adapter.capabilities,
          overrides: d.overrides,
          accent: accents.get(adapter.id) ?? "muted",
          ...(adapter.setupCommand ? { setupCommand: adapter.setupCommand } : {}),
        });
      }),
    );
    return this.status();
  }

  status(): HarnessStatus[] {
    return this.list()
      .map((a) => this.statuses.get(a.id))
      .filter((s): s is HarnessStatus => s !== undefined);
  }

  isAvailable(id: string): boolean {
    return this.statuses.get(asHarnessId(id))?.available === true;
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(this.list().map((a) => a.shutdown()));
  }
}
