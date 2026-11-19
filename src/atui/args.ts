// atui's command line.
import { imageModeFrom } from "./images.js";
import type { AtuiOptions } from "./state.js";

export const USAGE = `atui: awui in the terminal

Usage: atui [options]

  --url <url>         the awui server (default $AWUI_URL or http://127.0.0.1:4783)
  --harness <id>      the harness for new chats (pi, omp, hermes, claude, …)
  --resume [id]       resume a session: the given one, or this project's newest
  --chat <id>         attach to a chat that is open on the server
  --keybinds <style>  the keybind style: emacs (the C-x chords, default) or
                      vim (NORMAL keys: j/k, :, Space actions, i to type);
                      remembered; --vim/--no-vim are its old names
                      (default: as last set, or $ATUI_KEYBINDS, or $ATUI_VIM)
  --images <mode>     how prompt images are drawn: auto (ask the terminal), kitty
                      (kitty, Ghostty), sixel, blocks, or off (default $ATUI_IMAGES, auto)
  --no-herdr          in a herdr pane, do not report the chats' state to herdr
                      (the server's herdr setting turns it off for every atui)
  -h, --help          this help

Starts in the current folder's project. In the Emacs style, keys are written
the Emacs way (C- is Ctrl, M- is Alt): C-k commands, C-x then a letter for the
rest (C-x lists them), Enter sends, S-Enter or C-j adds a line, C-v pastes an
image (or drop image files on the terminal), Esc Esc stops the agent, C-c C-c
quits. --keybinds vim lives in NORMAL instead: j/k scroll, : commands, Space
actions, i types; C-x v switches styles.`;

export const DEFAULT_URL = "http://127.0.0.1:4783";

export function parseArgs(argv: string[], env: Record<string, string | undefined>): (AtuiOptions & { url: string }) | { help: true } | { error: string } {
  const out: AtuiOptions & { url: string } = { cwd: process.cwd(), url: env.AWUI_URL || DEFAULT_URL };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) return null;
      i += 1;
      return next;
    };
    if (arg === "-h" || arg === "--help") return { help: true };
    else if (arg === "--url") {
      const v = value();
      if (!v) return { error: "--url needs a value" };
      out.url = v;
    } else if (arg === "--harness") {
      const v = value();
      if (!v) return { error: "--harness needs a value" };
      out.harness = v;
    } else if (arg === "--chat") {
      const v = value();
      if (!v) return { error: "--chat needs a value" };
      out.chatId = v;
    } else if (arg === "--resume") out.resume = value() ?? true;
    else if (arg === "--images") {
      const mode = imageModeFrom(value() ?? "", {});
      if (!mode) return { error: "--images takes auto, kitty, sixel, blocks, or off" };
      out.images = mode;
    } else if (arg === "--keybinds") {
      const v = value();
      if (v !== "emacs" && v !== "vim") return { error: "--keybinds takes emacs or vim" };
      out.keybinds = v;
    } else if (arg === "--vim") out.keybinds = "vim";
    else if (arg === "--no-vim") out.keybinds = "emacs";
    else if (arg === "--no-herdr") out.herdr = false;
    else return { error: `Unknown option ${arg}` };
  }
  out.url = out.url.replace(/\/+$/, "");
  return out;
}
