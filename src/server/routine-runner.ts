// What "run a routine" means, kept out of index.ts so it can be tested: check the
// routine's precheck first (a non-zero exit, a timeout, or no shell skips this slot
// — with the reason for the list), then open a chat for the routine's project and
// harness and send its prompt. The timer claims the routine before calling this
// (routines-timer.ts), so a failure here is reported once, and the routine's next
// slot is its retry, whether it launched or skipped.
import type { Routine, WorkspaceInfo } from "../shared/protocol.js";
import type { Chat } from "./chats/chat.js";
import type { ChatManager } from "./chats/manager.js";
import type { HarnessAdapter } from "./harness/types.js";
import { runPrecheck } from "./routine-precheck.js";

/** A routine's slot: the chat it opened, or why it skipped (null only when it launched). */
export interface RoutineRun {
  chat: Chat | null;
  detail: string | null;
}

export async function runRoutine(routine: Routine, workspace: WorkspaceInfo, adapter: HarnessAdapter, manager: ChatManager): Promise<RoutineRun> {
  // An empty precheck (the usual case, and every routine saved before the field
  // existed) runs the routine as it always did.
  if (routine.precheck) {
    const check = await runPrecheck(routine.precheck, workspace.path);
    if (!check.ok) return { chat: null, detail: check.detail };
  }
  const chat = await manager.create(adapter, workspace);
  await chat.send(routine.prompt, "normal");
  return { chat, detail: null };
}
