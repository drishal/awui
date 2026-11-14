// A resumed chat that shows before its harness is up. The transcript comes
// from the session file (adapter.readTranscript, milliseconds) while the
// harness process starts behind it (0.4–3 s). Reads answer from the file
// until then; anything that needs the harness waits for it; once it is up,
// its events flow through, its config replaces the placeholder, and a
// "settled" moves the chat from Starting to Idle (which also re-reads
// context, usage, and todos) unless the harness is already running a turn
// it started itself, which then settles on its own.
import type {
  ChatConfig,
  ChatItem,
  ConfigPatch,
  ContextUsage,
  ImageAttachment,
  InteractionAnswer,
  SlashCommand,
  TodoItem,
} from "../../shared/protocol.js";
import { EventHub } from "./event-hub.js";
import type { HarnessEventListener, HarnessUsage, LiveChat } from "./types.js";

/** The warning a reopened chat shows when its harness starts working without a prompt from here. */
export const UNPROMPTED =
  "This chat started working on its own when it reopened: nothing was sent from here. Something in the harness (an extension, or a task it was in the middle of) picked it back up. Stop it if you didn't mean it to run.";

const NO_CONFIG: ChatConfig = { model: null, thinkingLevel: null, models: [], thinkingLevels: [] };

export class DeferredLiveChat implements LiveChat {
  /** Chat.open reads this to start in "starting" rather than "idle". */
  readonly starting = true;
  private hub = new EventHub();
  private real: LiveChat | null = null;
  private disposed = false;
  /** A run (prompt, steer, follow-up) was sent from here: its own events settle the chat, and its busy is no surprise. */
  private asked = false;
  /**
   * The harness started a run of its own as it came up, with no prompt from here: an extension's
   * event can (Pi's background-tasks reconciling a job that died with the last process). Its own
   * settle ends that run; a made-up one here would show Idle, without Stop, while the agent works.
   */
  private running = false;
  /** The unprompted run's warning went out: once per reopen. */
  private warned = false;
  private readonly ready: Promise<LiveChat>;

  constructor(
    private readonly id: string,
    private readonly transcript: { items: ChatItem[]; title: string | null },
    start: () => Promise<LiveChat>,
    describe: (error: unknown) => string,
    /** The models and levels shown while the harness starts (the saved catalog's): the harness's own config replaces it. */
    private readonly placeholder: ChatConfig | null = null,
  ) {
    this.ready = start().then(
      async (live) => {
        if (this.disposed) {
          await live.dispose().catch(() => undefined);
          throw new Error("This chat was closed");
        }
        this.real = live;
        live.subscribe((event) => {
          if (event.type === "busy" && !this.asked && !this.running && !this.warned) {
            // Nobody here asked for it: say so where it shows, above the work, so a forgotten task picked back up is noticed and stopped.
            this.warned = true;
            this.hub.emit({ type: "notice", level: "warning", text: UNPROMPTED });
          }
          if (event.type === "busy") this.running = true;
          else if (event.type === "settled") this.running = false;
          this.hub.emit(event);
        });
        const config = await live.getConfig().catch(() => null);
        if (config) this.hub.emit({ type: "config", config });
        if (!this.asked && !this.running) this.hub.emit({ type: "settled" });
        return live;
      },
      (error: unknown) => {
        if (!this.disposed) this.hub.emit({ type: "fatal", message: describe(error) });
        throw error;
      },
    );
    this.ready.catch(() => undefined);
  }

  get nativeId(): string | null {
    return this.real?.nativeId ?? this.id;
  }

  get title(): string | null {
    return this.real?.title ?? this.transcript.title;
  }

  /** The harness, once it is up (a command waits here). `run` marks a prompt, which settles on its own. */
  private async harness(run = false): Promise<LiveChat> {
    // Every prompt from here counts, not only one sent while the harness was starting: one sent after
    // it came up used to leave this unset, so its run's busy read as the harness working on its own,
    // and the first message in every reopened chat raised the "started working on its own" warning.
    if (run) this.asked = true;
    return this.ready;
  }

  subscribe(listener: HarnessEventListener): () => void {
    return this.hub.subscribe(listener);
  }

  async history(): Promise<ChatItem[]> {
    return this.real ? this.real.history() : this.transcript.items;
  }

  async getConfig(): Promise<ChatConfig> {
    return this.real ? this.real.getConfig() : (this.placeholder ?? NO_CONFIG);
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    return this.real ? this.real.getContextUsage() : null;
  }

  async getUsage(): Promise<HarnessUsage | null> {
    return this.real ? this.real.getUsage() : null;
  }

  async getTodos(): Promise<TodoItem[]> {
    return this.real ? this.real.getTodos() : [];
  }

  async listCommands(): Promise<SlashCommand[]> {
    return (await this.harness()).listCommands();
  }

  /** Native account pin exists on the wrapper too: it waits for the child just like every other native operation. */
  /** A resumed harness exposes native provider account pin only after it is ready. */
  async pinAccount(index: number): Promise<void> {
    const child = await this.harness();
    if (!child.pinAccount) return;
    await child.pinAccount(index);
  }

  async prompt(text: string, images?: ImageAttachment[]): Promise<void> {
    return (await this.harness(true)).prompt(text, images);
  }

  async steer(text: string, images?: ImageAttachment[]): Promise<void> {
    return (await this.harness(true)).steer(text, images);
  }

  async rewind(turn: number, text: string, images?: ImageAttachment[]): Promise<void> {
    const harness = await this.harness(true);
    if (!harness.rewind) throw new Error("This harness cannot replace a past message");
    return harness.rewind(turn, text, images);
  }

  async followUp(text: string, images?: ImageAttachment[]): Promise<void> {
    return (await this.harness(true)).followUp(text, images);
  }

  /** Nothing runs before the harness is up, so there is nothing to stop yet. */
  async abort(): Promise<void> {
    if (this.real) await this.real.abort();
  }

  async setConfig(patch: ConfigPatch): Promise<void> {
    return (await this.harness()).setConfig(patch);
  }

  async refreshModels(): Promise<void> {
    return (await this.harness()).refreshModels();
  }

  async rename(name: string): Promise<void> {
    return (await this.harness()).rename(name);
  }

  async compact(instructions?: string): Promise<void> {
    return (await this.harness()).compact(instructions);
  }

  answer(requestId: string, answer: InteractionAnswer): boolean {
    return this.real ? this.real.answer(requestId, answer) : false;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.hub.clear();
    // Still starting: the ready handler disposes the harness when it arrives.
    if (this.real) await this.real.dispose();
  }
}
