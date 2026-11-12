// One top-level room turn: the selected direct responders, each serial, and at
// most one bounded round of consultations under a responder. This module only
// coordinates; the parser, context builder, budget, and session pool are pure or
// narrow, so every routing decision stays server-side and reviewable here.
import { randomUUID } from "node:crypto";
import type { ChatItem, InteractionRequest, RoomEvent, RoomPendingRequest, RoomRecord, RoomTurnState, WorkspaceInfo } from "../../shared/protocol.js";
import { errorMessage } from "../chats/chat.js";
import { authorizeConsultRequests, normalizeHandle, parseControlDocument } from "./consult.js";
import { buildInvocationPrompt, type BuiltPrompt, type ContextConsultResult } from "./context.js";
import { duplicateKey, noteConsultRequests, noteInvocation, invocationAllowed, remainingConsultRequests, wallClockExpired, type TurnBudget } from "./budget.js";
import type { ActiveTurn } from "./scheduler.js";
import type { BotEventSink, BotInvokeRequest, BotRunHandle, BotRunResult, ConsultAsk, StoredBot, StoredMembership, StoredRoom } from "./types.js";
import type { ChatOwner } from "./types.js";

/** A record as the runner writes it: the host mints `seq` (one per room, persisted with the record). */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type RecordDraft = DistributiveOmit<RoomRecord, "seq">;

/** Everything the runner needs from the manager; deliberately narrow so this file has no I/O of its own. */
export interface TurnRunnerHost {
  readonly room: StoredRoom;
  readonly active: ActiveTurn;
  readonly budget: TurnBudget;
  /** False once the turn was stopped (its generation bumped): late work is dropped. */
  isCurrent(): boolean;
  member(id: string): StoredMembership | undefined;
  bot(member: StoredMembership): StoredBot | undefined;
  workspace(): WorkspaceInfo;
  /** Room records after `seq`, oldest first (the context builder bounds them). */
  historyAfter(seq: number): Promise<RoomRecord[]>;
  append(drafts: Array<RecordDraft & { seq?: number }>): Promise<RoomRecord[]>;
  emit(event: RoomEvent): void;
  updateTurn(state: RoomTurnState, stopReason?: string): Promise<void>;
  persistNative(memberId: string, native: { harnessId: string; nativeId: string }): Promise<void>;
  advanceDelivered(memberId: string, seq: number): Promise<void>;
  invoke(req: BotInvokeRequest, sink: BotEventSink): Promise<BotRunHandle>;
  /** A run's place in the room's order, taken before its opening record so the settled one keeps it. */
  reserveSeq(): Promise<number>;
  /** Show the running run now (a live `record`); the settled record replaces it by id. */
  startLiveRun(record: RoomRecord): void;
  endLiveRun(recordId: string): void;
  notify(kind: "done" | "error" | "ask", title: string, body: string, request?: InteractionRequest): void;
  addPending(request: RoomPendingRequest): void;
  removePending(requestId: string, outcome: string, denialReason?: string): void;
  pendingCount(): number;
  /** The room's pending requests as [id, request] pairs: a settled run's are pruned by its invocation. */
  pendingEntries(): Array<[string, RoomPendingRequest]>;
}

function answerText(result: BotRunResult): string {
  return result.finalText.trim().length > 0 ? result.finalText : (result.error ?? "");
}

export class TurnRunner {
  constructor(private readonly host: TurnRunnerHost) {}

  async run(): Promise<RoomTurnState> {
    const { host } = this;
    await host.updateTurn("running");
    for (const memberId of host.active.directMemberIds) {
      if (!host.isCurrent()) return "stopped";
      if (wallClockExpired(host.budget, Date.now())) {
        await this.notice("warning", `The turn stopped at its wall-clock limit; later bots did not run.`);
        return "stopped";
      }
      await this.runDirect(memberId);
    }
    if (!host.isCurrent()) return "stopped";
    if (host.budget.expired || wallClockExpired(host.budget, Date.now())) return "stopped";
    return "done";
  }

  private async notice(level: "info" | "warning" | "error", text: string): Promise<void> {
    await this.host.append([{ kind: "notice", id: randomUUID(), at: Date.now(), turnId: this.host.active.view.id, level, text }]);
  }

  private async runDirect(memberId: string): Promise<void> {
    const { host } = this;
    const member = host.member(memberId);
    if (!member || !member.enabled) {
      await this.notice("warning", `@${member?.handle ?? memberId} is no longer enabled, so it was skipped.`);
      return;
    }
    const bot = host.bot(member);
    if (!bot) {
      await this.notice("error", `@${member.handle} has no bot profile, so it was skipped.`);
      return;
    }
    const decision = invocationAllowed(host.budget, member.id, Date.now());
    if (!decision.ok) {
      await this.notice("warning", `@${member.handle} did not run: ${decision.reason}.`);
      return;
    }
    const consultants = member.consultants
      .map((id) => host.member(id))
      .filter((candidate): candidate is StoredMembership => candidate !== undefined && candidate.enabled && candidate.consultable)
      .map((candidate) => ({ handle: candidate.handle, role: host.bot(candidate)?.role ?? "" }));
    const history = await host.historyAfter(member.deliveredSeq);
    // The user's message is the current request, not history: sending it twice invites duplication.
    const current = history.find((record) => record.kind === "user" && record.turnId === host.active.view.id);
    const built = buildInvocationPrompt({
      room: host.room,
      bot,
      member,
      consultants,
      history: history.filter((record) => record !== current),
      task: { kind: "message", text: host.active.stored.text },
      depth: 0,
    });
    if (current && current.seq > built.throughSeq) built.throughSeq = current.seq;
    if (!host.isCurrent()) return;
    const ran = await this.invokeOnce({ member, bot, built, bufferText: true, depth: 0 });
    const parsed = parseControlDocument(ran.result.finalText);
    if (parsed.kind === "consult" && ran.draft.kind === "bot_run") {
      // The control document is not an answer: it is recorded without its text, and never shown.
      await host.append([{ ...ran.draft, seq: ran.seq, items: ran.draft.items.filter((item) => item.kind !== "assistant") }]);
      await this.runConsultations(member, bot, parsed.requests, ran.invocationId);
      return;
    }
    await host.append([{ ...ran.draft, seq: ran.seq }]);
    this.emitAssistantItems(ran.result.items, ran.invocationId);
    if (parsed.kind === "invalid") await this.notice("warning", `@${member.handle}'s consultation request was not run: ${parsed.reason}`);
  }

  /** A control document never becomes a visible answer; a plain one is shown when classification is done. */
  private emitAssistantItems(items: ChatItem[], invocationId: string): void {
    for (const item of items) {
      if (item.kind === "assistant") this.host.emit({ type: "item", invocationId, item });
    }
  }

  private async invokeOnce(args: {
    member: StoredMembership;
    bot: StoredBot;
    built: BuiltPrompt;
    bufferText: boolean;
    depth: number;
    consultOf?: string;
  }): Promise<{ result: BotRunResult; invocationId: string; draft: RecordDraft; seq: number }> {
    const { host } = this;
    const invocationId = randomUUID();
    const recordId = invocationId;
    const seq = await host.reserveSeq();
    noteInvocation(host.budget, args.member.id);
    await host.updateTurn(host.active.view.state);
    // The opening record carries no model yet (the chat applies it while starting);
    // it exists so a room can draw "Working" per bot before any item arrives.
    host.startLiveRun({
      kind: "bot_run",
      id: recordId,
      seq,
      at: Date.now(),
      turnId: host.active.view.id,
      memberId: args.member.id,
      invocationId,
      ...(args.consultOf ? { consultOf: args.consultOf } : {}),
      status: "running",
      model: args.bot.model,
      thinkingLevel: args.bot.thinkingLevel,
      items: [],
      usage: null,
      latencyMs: null,
    });
    const sink: BotEventSink = {
      onItem: (item) => host.emit({ type: "item", invocationId, item }),
      onDelta: (itemId, field, append) => host.emit({ type: "delta", invocationId, itemId, field, append }),
      onStatus: () => undefined,
      onRequest: (request) => {
        host.addPending({ id: request.id, turnId: host.active.view.id, memberId: args.member.id, invocationId, request });
        void host.updateTurn("waiting_for_user");
        host.notify("ask", host.room.name, `@${args.member.handle} asks: ${request.title}`, request);
      },
      onRequestResolved: (requestId, outcome, denialReason) => {
        host.removePending(requestId, outcome, denialReason);
        if (host.pendingCount() === 0) void host.updateTurn("running");
      },
      onNativeSession: (native) => host.persistNative(args.member.id, native),
    };
    let result: BotRunResult;
    try {
      const owner: ChatOwner = { kind: "room", roomId: host.room.id, membershipId: args.member.id };
      const handle = await host.invoke(
        {
          invocationId,
          room: host.room,
          member: args.member,
          bot: args.bot,
          workspace: host.workspace(),
          prompt: args.built.prompt,
          owner,
          bufferText: args.bufferText,
        },
        sink,
      );
      result = await handle.done;
    } catch (error) {
      // The invocation never started (a missing harness, a refused setting, a
      // session that cannot resume): record it so the failure is visible.
      result = { status: "failed", accepted: false, items: [], usage: null, latencyMs: null, model: args.bot.model, thinkingLevel: args.bot.thinkingLevel, finalText: "", error: errorMessage(error) };
    }
    // A settled run cannot answer its requests any more: a harness may raise one and then
    // finish anyway, leaving a card the user could never satisfy.
    for (const [requestId, pending] of host.pendingEntries()) {
      if (pending.invocationId === invocationId) host.removePending(requestId, "The run ended");
    }
    const draft: RecordDraft = {
      kind: "bot_run",
      id: recordId,
      at: Date.now(),
      turnId: host.active.view.id,
      memberId: args.member.id,
      invocationId,
      ...(args.consultOf ? { consultOf: args.consultOf } : {}),
      status: host.isCurrent() ? result.status : "stopped",
      model: result.model,
      thinkingLevel: result.thinkingLevel,
      items: result.items,
      usage: result.usage,
      latencyMs: result.latencyMs,
      ...(result.error ? { error: result.error } : {}),
    };
    if (result.accepted && args.built.throughSeq > args.member.deliveredSeq) {
      await host.advanceDelivered(args.member.id, args.built.throughSeq).catch((error: unknown) => {
        // Losing the cursor costs a repeated history next time; it must not hide the answer.
        host.notify("error", host.room.name, `Could not record delivered history: ${errorMessage(error)}`);
      });
    }
    await host.updateTurn(host.active.view.state);
    return { result, invocationId, draft, seq };
  }

  private async runConsultations(from: StoredMembership, fromBot: StoredBot, requests: ConsultAsk[], invocationId: string): Promise<void> {
    const { host } = this;
    const candidates = host.room.members
      .filter((member) => member.id !== from.id && member.enabled && member.consultable)
      .map((member) => ({ id: member.id, handle: member.handle, enabled: member.enabled, consultable: member.consultable }));
    const authorization = authorizeConsultRequests({
      requests,
      fromMemberId: from.id,
      members: candidates,
      allowlist: from.consultants,
      remaining: remainingConsultRequests(host.budget, Date.now()),
      seen: host.budget.seen,
    });
    const refusals = [...authorization.refused];
    const accepted: typeof authorization.accepted = [];
    for (const request of authorization.accepted) {
      const key = duplicateKey(from.id, request.to.id, request.question);
      if (host.budget.seen.has(key)) refusals.push({ toHandle: request.to.handle, question: request.question, reason: "That exact question was already asked this turn" });
      else {
        host.budget.seen.add(key);
        accepted.push(request);
      }
    }
    noteConsultRequests(host.budget, accepted.length);
    for (const refusal of refusals) {
      const toMemberId = host.room.members.find((member) => normalizeHandle(member.handle) === normalizeHandle(refusal.toHandle))?.id ?? "unknown";
      await host.append([
        {
          kind: "consultation",
          id: randomUUID(),
          at: Date.now(),
          turnId: host.active.view.id,
          fromMemberId: from.id,
          toMemberId,
          question: refusal.question,
          outcome: "refused",
          reason: refusal.reason,
        },
      ]);
      await this.notice("warning", `@${from.handle} could not consult @${refusal.toHandle}: ${refusal.reason}`);
    }
    await host.updateTurn(host.active.view.state);

    const results: ContextConsultResult[] = [];
    for (const request of accepted) {
      if (!host.isCurrent()) return;
      const target = host.member(request.to.id);
      if (!target) continue;
      const targetBot = host.bot(target);
      if (!targetBot) {
        await this.notice("error", `@${target.handle} has no bot profile, so the consultation was not run.`);
        continue;
      }
      const consultationId = randomUUID();
      const base = {
        kind: "consultation" as const,
        id: consultationId,
        at: Date.now(),
        turnId: host.active.view.id,
        fromMemberId: from.id,
        toMemberId: target.id,
        question: request.question,
      };
      await host.append([{ ...base, outcome: "requested" }]);
      const decision = invocationAllowed(host.budget, target.id, Date.now());
      if (!decision.ok) {
        await host.append([{ ...base, outcome: "refused", reason: decision.reason }]);
        await this.notice("warning", `@${from.handle} could not consult @${target.handle}: ${decision.reason}.`);
        continue;
      }
      const history = await host.historyAfter(target.deliveredSeq);
      const built = buildInvocationPrompt({
        room: host.room,
        bot: targetBot,
        member: target,
        consultants: [],
        history,
        task: { kind: "consult", fromHandle: from.handle, question: request.question },
        depth: 1,
      });
      if (!host.isCurrent()) return;
      const ran = await this.invokeOnce({ member: target, bot: targetBot, built, bufferText: false, depth: 1, consultOf: consultationId });
      await host.append([{ ...ran.draft, seq: ran.seq }]);
      const outcome = ran.result.status === "done" ? "answered" : "failed";
      await host.append([{ ...base, outcome, ...(ran.result.error ? { reason: ran.result.error } : {}) }]);
      results.push({
        consultationId,
        fromHandle: target.handle,
        question: request.question,
        outcome: outcome === "answered" ? "answered" : "failed",
        text: answerText(ran.result),
      });
      await host.updateTurn(host.active.view.state);
    }
    if (results.length === 0) {
      await this.notice("info", `@${from.handle} asked for consultations, but none ran; its request is unchanged.`);
      return;
    }
    if (!host.isCurrent()) return;
    const synthesis = invocationAllowed(host.budget, from.id, Date.now());
    if (!synthesis.ok) {
      await this.notice("warning", `The consultations finished, but @${from.handle} could not synthesise: ${synthesis.reason}.`);
      return;
    }
    const built = buildInvocationPrompt({
      room: host.room,
      bot: fromBot,
      member: from,
      consultants: [],
      history: await host.historyAfter(from.deliveredSeq),
      task: { kind: "synthesis", question: host.active.stored.text, results },
      depth: 1,
    });
    // The requester answers plainly now: its text is the room's answer and streams.
    if (!host.isCurrent()) return;
    const final = await this.invokeOnce({ member: from, bot: fromBot, built, bufferText: false, depth: 1 });
    await host.append([{ ...final.draft, seq: final.seq }]);
    await host.updateTurn(host.active.view.state);
  }

}

