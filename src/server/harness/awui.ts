// The `awui` harness: a chat-style surface (web search, read-only tools, MCP, a
// scratch-dir Python eval, rendered pages) that never touches the project,
// built by driving a locked-down `pi` child. It reuses the Pi adapter wholesale
// and differs only in containment:
//
//   - its own agent dir (models/auth/MCP) and per-workspace session dir, both
//     under awui's state folder, so it never reads or writes the real pi's
//     `~/.pi/agent` (the user's pi config stays the user's) — save the one
//     opt-in in Settings that links its auth.json to the user's pi login,
//     chosen by the user (see awui-settings.ts), never by default;
//   - a tool DENYLIST on spawn (`--exclude-tools bash,edit,write,powershell`),
//     pi's four writing/executing builtins. A denylist, not an allowlist: it
//     cannot accidentally under-specify, and it reaches extension and MCP
//     tools too. Read tools (read, grep, find, ls) and read-only MCP stay on;
//   - two extensions that compute and display without editing the project:
//     render_html publishes a page to awui's own render store (a chart or
//     mockup belongs in a chat surface), and eval_python runs a snippet in a
//     scratch tmp dir (a calc is fine; it is not given the workspace);
//   - no rewind: in-place Edit needs the rewind extension, which stays off.
//
// The containment is honest in the capabilities the UI reads: `webOnly` makes
// atui omit it, and `supportsProjectFolders: false` keeps it off the project
// start screen and its folder picker.
import { promises as fs } from "node:fs";
import path from "node:path";
import { asHarnessId, type HarnessCapabilities } from "../../shared/protocol.js";
import { renderHtmlExtension, renderHtmlExtensionArgs, evalPythonExtension, evalPythonExtensionArgs } from "./render-extension.js";
import { PiAdapter } from "./pi.js";

/** pi builtins that write or execute; read tools, read-only MCP, and render_html stay on. */
const WRITE_TOOLS = ["bash", "edit", "write", "powershell"] as const;

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

export class AwuiAdapter extends PiAdapter {
  override readonly id = asHarnessId("awui");
  override readonly displayName = "Awui";
  // Its providers live in its own agent dir (awui-settings.ts), not in what `pi` logs in to.
  override readonly setupCommand = undefined;
  // Not only render_html: eval_python lets the chat compute without touching
  // the project (its Python runs in a throwaway tmp dir, output-bounded).
  // Both extensions write only outside the workspace.
  protected override capabilitySet: HarnessCapabilities = {
    supportsSteer: true,
    supportsFollowUp: true,
    supportsThinkingLevel: true,
    supportsCompact: true,
    // The render + eval extensions load, so extension affordances show.
    supportsExtensions: true,
    supportsInteractiveRequests: true,
    supportsRename: true,
    supportsModelSelection: true,
    // Fork/handoff would copy a session the user expects to stay chat-shaped; keep it linear.
    supportsFork: false,
    supportsHandoff: false,
    // No in-place edit: rewind is off for this child.
    supportsRewind: false,
    // Artifacts belong in a chat surface; render_html publishes display-only pages.
    supportsHtmlRender: renderHtmlExtension() !== null,
    supportsQueueEdit: true,
    supportsPermissionMode: false,
    supportsResumeCommand: false,
    jobsSurviveRestart: false,
    // A machine-wide chat surface: no project folder, and only the web UI lists it.
    supportsProjectFolders: false,
    webOnly: true,
    // The containment is the point: a delegated child would be handed the write and exec tools this chat denies.
    readOnlyHarness: true,
  };
  // A distinct accent so the harness menu tells it apart from Pi.
  protected override accentToken = "thinking";

  /** Pi's command from config.yml, but never its extra arguments: those could loosen this child's read-only lock. */
  constructor(
    private readonly stateDir: string,
    piCommand?: string,
  ) {
    super(piCommand ? { command: piCommand } : {});
  }

  protected override launchArgs(): string[] {
    return [];
  }

  /** The isolated agent dir: awui's own, under its state folder. */
  override async resolveAgentDir(): Promise<string> {
    const dir = path.join(this.stateDir, "awui-agent");
    await this.mirrorLitellm(dir);
    return dir;
  }

  /**
   * Mirror the user's `~/.pi/agent/models.json` litellm provider into the
   * isolated agent dir so the child can call the same proxy without reading
   * the user's config. Copied whole (baseUrl, api, apiKey, modelOverrides);
   * only the `litellm` entry is taken, and only when one is found. Runs once
   * per agent dir; a user edit is picked up on the next chat, not mid-run.
   */
  private async mirrorLitellm(agentDir: string): Promise<void> {
    const home = process.env.HOME ?? "";
    const source = path.join(home, ".pi", "agent", "models.json");
    let litellm: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(source, "utf8"));
      const providers = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).providers : undefined;
      const entry = typeof providers === "object" && providers !== null ? (providers as Record<string, unknown>).litellm : undefined;
      if (typeof entry === "object" && entry !== null && typeof (entry as Record<string, unknown>).baseUrl === "string") {
        litellm = entry as Record<string, unknown>;
      }
    } catch {
      return; // no pi models.json, or no litellm provider: nothing to mirror
    }
    if (!litellm) return;
    await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
    const target = path.join(agentDir, "models.json");
    // Autodiscovery seeds a fresh agent dir from the user's pi config; once the
    // settings UI has written a models.json, that is the harness's own config and
    // is never clobbered by a mirror.
    if (await fs.access(target).then(() => true, () => false)) return;
    await fs.writeFile(`${target}.${process.pid}.tmp`, `${JSON.stringify({ providers: { litellm } }, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(`${target}.${process.pid}.tmp`, target);
  }

  /** Sessions under the isolated store; the agent dir never defers to the user's pi env. */
  protected override sessionDirFor(cwd: string, agentDir: string): string {
    return path.join(agentDir, "sessions", `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  }

  /** The child denies the writing tools; it never defers to the user's PI_CODING_AGENT_DIR. */
  protected override spawnEnv(cwd: string, toolEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = super.spawnEnv(cwd, toolEnv);
    delete env[AGENT_DIR_ENV]; // the flag/env seam knows the isolated agent dir; don't leak the user's
    env[AGENT_DIR_ENV] = path.join(this.stateDir, "awui-agent");
    return env;
  }

  /** render_html and eval_python load (rewind stays off); the denylist does the write/exec lockdown. */
  protected override extensionArgs(): string[] {
    return [...renderHtmlExtensionArgs(), ...evalPythonExtensionArgs()];
  }

  protected override toolArgs(): string[] {
    return ["--exclude-tools", WRITE_TOOLS.join(",")];
  }
}
