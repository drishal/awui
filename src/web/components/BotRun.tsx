// One bot's run inside a room, drawn the way a chat draws a turn: a quiet
// speaker line (who spoke, through which harness and model, how it went), then
// the run itself as a chat turn without its prompt (its thinking and calls
// folded into one "Worked for …" line, the reply as prose), with its usage
// where a chat answer keeps its timing. A consultant's run draws the same,
// nested under the consultation that asked for it.
//
// A bot that consults answers in two invocations (the request, then the answer
// once the consultant replied). They are one speaker's turn, so they draw under
// one speaker line: the first run's work, the consultation folds, the answer.
import { memo, type CSSProperties, type ReactNode } from "react";
import type { RoomMemberView, RoomRecord } from "../../shared/protocol.js";
import { IconAlertCircle, IconCheck, IconStop, Spinner } from "../icons.js";
import { formatSpan } from "../turn-time.js";
import { dollars, shortTokens, tokensOf } from "../usage.js";
import { RunTranscript } from "./Conversation.js";

export type BotRunRecord = Extract<RoomRecord, { kind: "bot_run" }>;

/** How a run's status reads on the card. */
export const RUN_STATUS_LABEL: Record<BotRunRecord["status"], string> = {
  running: "Working",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

/** "12.4k tokens · $0.04", or "cost unavailable" when the harness priced nothing (null is not zero). */
export function usageLine(usage: BotRunRecord["usage"]): string | null {
  if (!usage) return null;
  const tokens = tokensOf(usage);
  const priced = usage.cost !== null && usage.cost !== undefined && usage.unpriced === 0;
  const cost = usage.cost !== null && usage.cost !== undefined ? dollars(usage.cost, true) : null;
  const parts = usage.turns > 1 ? [`${usage.turns} calls`] : [];
  parts.push(`${shortTokens(tokens)} tokens`);
  if (usage.unpriced > 0) parts.push(usage.cost !== null && usage.cost !== undefined ? `${cost} + ${usage.unpriced} unpriced` : "cost unavailable");
  else if (priced) parts.push(cost as string);
  return parts.join(" · ");
}

/** Two runs' usage as one, for a speaker line that covers both. */
function addUsage(a: BotRunRecord["usage"], b: BotRunRecord["usage"]): BotRunRecord["usage"] {
  if (!a || !b) return a ?? b;
  return {
    turns: a.turns + b.turns,
    steps: a.steps + b.steps,
    input: a.input + b.input,
    cachedInput: a.cachedInput + b.cachedInput,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    cost: a.cost === null || b.cost === null ? (a.cost ?? b.cost) : a.cost + b.cost,
    unpriced: a.unpriced + b.unpriced,
  };
}

/** What a speaker's turn holds, in order: runs (their transcripts) and the consultation folds between them. */
export type RunSegment = { run: BotRunRecord } | { key: string; node: ReactNode };

export const BotRun = memo(function BotRun({
  record,
  member,
  harnessName,
  workspace,
  nested = false,
  segments,
  waiting = false,
}: {
  /** The run whose speaker line this is: the latest of the turn's runs (its model, its status). */
  record: BotRunRecord;
  /** The membership that ran, when it is still in the room. */
  member: RoomMemberView | null;
  harnessName: (harnessId: string) => string;
  /** The room's workspace path, for tool bodies' relative paths. */
  workspace: string;
  nested?: boolean;
  /** The turn's runs and folds in order; absent, just `record`. */
  segments?: RunSegment[];
  /** A consultation it asked for is still going: the speaker is still working, whatever its first run says. */
  waiting?: boolean;
}) {
  const name = member?.name ?? "A removed member";
  // The members sheet's dot: the bot's own accent, else its harness's colour, so a speaker reads the same in both places.
  const accent = member ? ({ "--bot-accent": member.accent ? `var(--${member.accent}, var(--accent))` : `var(--harness-${member.harnessId}, var(--muted))` } as CSSProperties) : {};
  const parts = segments ?? [{ run: record }];
  const runs = parts.flatMap((part) => ("run" in part ? [part.run] : []));
  const state = waiting && record.status === "done" ? "running" : record.status;
  const status = RUN_STATUS_LABEL[state];
  const usage = usageLine(runs.reduce<BotRunRecord["usage"]>((sum, run) => addUsage(sum, run.usage), null));
  const latency = runs.some((run) => run.latencyMs !== null) ? runs.reduce((sum, run) => sum + (run.latencyMs ?? 0), 0) : null;
  const meta = [usage, latency !== null ? formatSpan(latency) : null].filter(Boolean).join(" · ") || null;
  // The usage rides the answer's action row, as a chat answer's timing does; a run that ends without a reply keeps it as a footnote.
  const last = runs[runs.length - 1] ?? record;
  const reply = [...last.items].reverse().find((item) => item.kind === "assistant");
  const metaInRow = Boolean(reply && reply.kind === "assistant" && reply.text && !reply.streaming && !reply.error) && last.status !== "running";
  // Name, role and handle are often one word three times ("lead", "lead", "@lead"): each says only what the name does not.
  const same = (word: string | undefined) => !word || word.replace(/^@/, "").toLowerCase() === name.toLowerCase();
  const details = [
    member?.role && !same(member.role) ? member.role : null,
    member && !same(member.handle) ? `@${member.handle}` : null,
  ].filter(Boolean);
  // The provider prefix ("opencode-go/") is the harness's routing, not the model's name; the whole id stays on hover.
  const model = record.model ? (record.model.split("/").pop() ?? record.model) : null;
  return (
    <article className={`bot-run is-${state}${nested ? " is-nested" : ""}`} style={accent} aria-label={`${name}'s run`} data-testid="bot-run" data-member={name}>
      <header className="bot-run-head">
        <span className="bot-dot" aria-hidden="true" />
        <span className="bot-name">{name}</span>
        {details.length > 0 ? <span className="bot-detail">{details.join(" · ")}</span> : null}
        <span className="bot-settings">
          {member ? (
            <span className="bot-harness">{harnessName(member.harnessId)}</span>
          ) : null}
          {model ? (
            <span className="bot-setting" title={`The model this invocation ran with: ${record.model}`}>
              {model}
            </span>
          ) : null}
          {member?.thinkingLevel ? (
            <span className="bot-setting" title="Configured thinking level (the wire carries the run's model, not its effective effort)">
              {member.thinkingLevel}
            </span>
          ) : null}
        </span>
        <span className={`bot-status is-${state}`} data-testid="bot-run-status">
          {state === "running" ? <Spinner size={12} /> : state === "done" ? <IconCheck size={13} /> : state === "stopped" ? <IconStop size={13} /> : <IconAlertCircle size={13} />}
          {status}
        </span>
      </header>
      {parts.map((part) =>
        "run" in part ? (
          <RunPart key={part.run.id} run={part.run} workspace={workspace} meta={part.run === last && metaInRow ? meta : null} />
        ) : (
          <div key={part.key} className="bot-run-fold">
            {part.node}
          </div>
        ),
      )}
      {meta && !metaInRow ? <footer className="bot-run-foot">{meta}</footer> : null}
    </article>
  );
});

/** One invocation's share of a speaker's turn: its transcript, or a note while it has none, and its error. */
function RunPart({ run, workspace, meta }: { run: BotRunRecord; workspace: string; meta: string | null }) {
  return (
    <>
      {run.items.length > 0 ? (
        <div className="bot-run-body">
          <RunTranscript items={run.items} live={run.status === "running"} workspace={workspace} {...(meta ? { meta } : {})} />
        </div>
      ) : run.status === "running" ? (
        <p className="bot-run-waiting">Waiting for the first output…</p>
      ) : null}
      {run.error ? (
        <p className="bot-run-error" role="alert">
          {run.error}
        </p>
      ) : null}
    </>
  );
}
