// What "run a heartbeat" means, kept out of index.ts so it can be tested: for each due
// heartbeat, find the chat session that scheduled it by its immutable identity
// (harness id plus native session id) and send it the prompt through ChatManager — an
// open target is reused (ChatManager.resume returns the live chat), a closed one is
// revived the way a user's resume reopens it, and a session the harness no longer lists
// is a logged skip, never a respawned scheduler. The workspace is the heartbeat's own
// binding, spelled when the schedule was created from the validated token; a run never
// opens another project.
//
// A run is quiet like a routine's: the target chat is the owner's (it is listed and
// openable by whoever could open it anyway), and the heartbeat's own outcome is kept in
// the store (launched, or the skip's reason) so the Routines dialog can say why a slot
// did not beat.
import type { ChatManager } from "./chats/manager.js";
import type { HarnessRegistry } from "./harness/registry.js";
import { errorMessage } from "./chats/chat.js";
import type { Heartbeats, StoredHeartbeat } from "./heartbeats.js";
import type { Notifier } from "./notify.js";

/** What one due beat came to: the chat it prompted, or why it skipped. */
export interface HeartbeatRunResult {
  outcome: "launched" | "skipped" | "failed";
  detail: string | null;
  chatId: string | null;
}

/**
 * The heartbeat's target, as the store keys it: the chat whose harness child called
 * schedule_heartbeat. Resolved through the adapter's own session list so a resumed
 * chat is found by its native id and a vanished one is an honest skip.
 */
export async function heartbeatTarget(
  heartbeat: StoredHeartbeat,
  registry: HarnessRegistry,
  manager: ChatManager,
): Promise<{ chatId: string | null; error: string | null }> {
  const adapter = registry.get(heartbeat.ownerHarnessId);
  if (!adapter) return { chatId: null, error: `no ${heartbeat.ownerHarnessId} adapter` };
  // An open target is reused: two live instances must never write one session file.
  const live = manager.liveChatFor(heartbeat.ownerHarnessId, heartbeat.ownerNativeId);
  if (live && live.status !== "disposed") return { chatId: live.chatId, error: null };
  // The harness says whether it still has the session; a file it cannot list is gone.
  const known = await adapter.listSessions(heartbeat.workspacePath).catch(() => null);
  if (known === null) return { chatId: null, error: `${adapter.displayName} could not list this workspace's sessions` };
  if (!known.some((session) => session.nativeId === heartbeat.ownerNativeId)) {
    return { chatId: null, error: `the ${adapter.displayName} session that scheduled this no longer exists` };
  }
  return { chatId: null, error: null };
}

/**
 * Start every heartbeat due at `now`, one send per beat. A beat whose target is absent is
 * logged and recorded skipped (its slot is spent either way, so a vanished session does not
 * spin); a beat whose chat refused the prompt is recorded failed. The store is claimed
 * before the work, like the routines timer claims a slot, so overlapping ticks cannot beat
 * one twice.
 */
export async function startDueHeartbeats(
  heartbeats: Heartbeats,
  registry: HarnessRegistry,
  manager: ChatManager,
  now = Date.now(),
  log: (line: string) => void = () => undefined,
  notifier?: Notifier,
): Promise<string[]> {
  const started: string[] = [];
  for (const heartbeat of heartbeats.due(now)) {
    // Claimed before the work: a throw must not leave it due for the next tick.
    const claimed = await heartbeats.markRan(heartbeat.id, now);
    if (!claimed) continue;
    const target = await heartbeatTarget(heartbeat, registry, manager);
    if (target.error !== null) {
      await heartbeats.markOutcome(heartbeat.id, "skipped", target.error);
      log(`heartbeat "${heartbeat.name}" skipped: ${target.error}`);
      continue;
    }
    const chatId = target.chatId ?? manager.liveChatFor(heartbeat.ownerHarnessId, heartbeat.ownerNativeId)?.chatId ?? null;
    if (chatId === null) {
      await heartbeats.markOutcome(heartbeat.id, "skipped", "its chat is not open and resuming one here is not allowed");
      log(`heartbeat "${heartbeat.name}" skipped: its chat is not open`);
      continue;
    }
    const chat = manager.list().find((candidate) => candidate.chatId === chatId);
    if (!chat) {
      await heartbeats.markOutcome(heartbeat.id, "skipped", "its chat closed while the beat was being sent");
      continue;
    }
    try {
      await chat.send(heartbeat.prompt, "normal", [], { origin: "agent" });
    } catch (error) {
      await heartbeats.markOutcome(heartbeat.id, "failed", errorMessage(error));
      log(`heartbeat "${heartbeat.name}" did not start: ${errorMessage(error)}`);
      continue;
    }
    await heartbeats.markOutcome(heartbeat.id, "launched", null);
    if (notifier) {
      notifier.notify({ kind: "done", chatId, sessionId: chat.sessionId, title: `Heartbeat: ${heartbeat.name}`, body: heartbeat.prompt.slice(0, 200) });
    }
    started.push(heartbeat.id);
  }
  return started;
}
