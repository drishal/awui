// Agent presets: a name for a harness, model, thinking level and permission mode together, kept by this
// server for atui and every other client (its own state file, written whole, mode 0600). Names are unique,
// ignoring case; the list is bounded (protocol.ts). The list is replaced whole, so a client's undo is a write.
import path from "node:path";
import { MAX_AGENT_PRESETS, agentPresetsSchema, type AgentPreset } from "../shared/protocol.js";
import { ChatError } from "./chats/chat.js";
import { isObj, readJson, writeJson } from "./state-file.js";

export class AgentPresets {
  private presets: AgentPreset[] = [];

  private constructor(private readonly file: string | null) {}

  static inMemory(): AgentPresets {
    return new AgentPresets(null);
  }

  static async open(stateDir: string): Promise<AgentPresets> {
    const store = new AgentPresets(path.join(stateDir, "agent-presets.json"));
    const raw = await readJson(store.file);
    // Read leniently, as a file edited by hand may hold anything: what does not fit the schema is dropped, the first of a name wins.
    const list = isObj(raw) && Array.isArray(raw.presets) ? raw.presets : [];
    const seen = new Set<string>();
    for (const item of list) {
      const one = agentPresetsSchema.safeParse({ presets: [item] });
      const preset = one.success ? one.data.presets[0] : undefined;
      if (!preset || seen.has(preset.name.toLowerCase())) continue;
      seen.add(preset.name.toLowerCase());
      store.presets.push(preset);
      if (store.presets.length >= MAX_AGENT_PRESETS) break;
    }
    return store;
  }

  list(): AgentPreset[] {
    return [...this.presets];
  }

  /** Replaces the list; a name used twice is refused (409). */
  async replace(list: AgentPreset[]): Promise<AgentPreset[]> {
    const names = new Set<string>();
    for (const p of list) {
      if (names.has(p.name.toLowerCase())) throw new ChatError(409, "name_taken", `Two presets are called “${p.name}”`);
      names.add(p.name.toLowerCase());
    }
    this.presets = [...list];
    await writeJson(this.file, { presets: this.presets });
    return this.list();
  }
}
