// One bot's run inside a room, drawn the way a chat draws a turn: a quiet
// speaker line (who spoke, through which harness and model, how it went), then
// the run itself as a chat turn without its prompt (its thinking and calls
// folded into one "Worked for …" line, the reply as prose), then its usage as
// a muted footnote. A consultant's run draws the same, nested under the
// consultation that asked for it.
import { memo, type CSSProperties } from "react";
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

export const BotRun = memo(function BotRun({
  record,
  member,
  harnessName,
  workspace,
  nested = false,
}: {
  record: BotRunRecord;
  /** The membership that ran, when it is still in the room. */
  member: RoomMemberView | null;
  harnessName: (harnessId: string) => string;
  /** The room's workspace path, for tool bodies' relative paths. */
  workspace: string;
  nested?: boolean;
}) {
  const name = member?.name ?? "A removed member";
  // The members sheet's dot: the bot's own accent, else its harness's colour, so a speaker reads the same in both places.
  const accent = member ? ({ "--bot-accent": member.accent ? `var(--${member.accent}, var(--accent))` : `var(--harness-${member.harnessId}, var(--muted))` } as CSSProperties) : {};
  const status = RUN_STATUS_LABEL[record.status];
  const usage = usageLine(record.usage);
  // Name, role and handle are often one word three times ("lead", "lead", "@lead"): each says only what the name does not.
  const same = (word: string | undefined) => !word || word.replace(/^@/, "").toLowerCase() === name.toLowerCase();
  const details = [
    member?.role && !same(member.role) ? member.role : null,
    member && !same(member.handle) ? `@${member.handle}` : null,
  ].filter(Boolean);
  // The provider prefix ("opencode-go/") is the harness's routing, not the model's name; the whole id stays on hover.
  const model = record.model ? (record.model.split("/").pop() ?? record.model) : null;
  return (
    <article className={`bot-run is-${record.status}${nested ? " is-nested" : ""}`} style={accent} aria-label={`${name}'s run`} data-testid="bot-run" data-member={name}>
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
        <span className={`bot-status is-${record.status}`} data-testid="bot-run-status">
          {record.status === "running" ? <Spinner size={12} /> : record.status === "done" ? <IconCheck size={13} /> : record.status === "stopped" ? <IconStop size={13} /> : <IconAlertCircle size={13} />}
          {status}
        </span>
      </header>
      {record.items.length > 0 ? (
        <div className="bot-run-body">
          <RunTranscript items={record.items} live={record.status === "running"} workspace={workspace} />
        </div>
      ) : record.status === "running" ? (
        <p className="bot-run-waiting">Waiting for the first output…</p>
      ) : null}
      {record.error ? (
        <p className="bot-run-error" role="alert">
          {record.error}
        </p>
      ) : null}
      {usage || record.latencyMs !== null ? (
        <footer className="bot-run-foot">
          {[usage, record.latencyMs !== null ? formatSpan(record.latencyMs) : null].filter(Boolean).join(" · ")}
        </footer>
      ) : null}
    </article>
  );
});
