// The room's composer: one prompt box with `@handle` completion, a send that
// carries structured member ids (the server never parses the text), the queue
// of messages waiting behind the active turn, and one obvious Stop.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BoardUsage, RoomInfo, RoomMemberView } from "../../shared/protocol.js";
import { budgetsOf } from "../room-state.js";
import { load, save } from "../storage.js";
import { newClientId } from "../rooms.js";
import { insertMention, matchMembers, mentionRange, resolveMentions } from "../room-mentions.js";
import { dollars, shortTokens, tokensOf } from "../usage.js";
import { IconArrowUp, IconStop, Spinner } from "../icons.js";
import { ChipEditor, type ChipEditorHandle } from "./ChipEditor.js";

/** How many invocation/usage facts fit beside Stop before they stop being facts worth reading. */
function spentLine(usage: BoardUsage, invocations: number): string {
  const parts = [`${invocations} ${invocations === 1 ? "invocation" : "invocations"}`];
  parts.push(`${shortTokens(tokensOf(usage))} tokens`);
  if (usage.cost !== null) parts.push(dollars(usage.cost, true));
  else if (usage.unpriced > 0) parts.push("cost unavailable");
  return parts.join(" · ");
}

export function RoomComposer({
  room,
  members,
  busy,
  stopping,
  queuedCount,
  invocationCount,
  usage,
  onSend,
  onStop,
  onNotice,
}: {
  room: RoomInfo;
  members: RoomMemberView[];
  /** A turn is running or queued. */
  busy: boolean;
  stopping: boolean;
  queuedCount: number;
  invocationCount: number;
  usage: BoardUsage;
  /** `clientId` is the idempotency key for this attempt; retrying a failed send reuses it. */
  onSend: (text: string, mentions: string[], clientId: string) => Promise<boolean>;
  onStop: () => void;
  onNotice: (text: string) => void;
}) {
  const draftKey = `roomDraft.${room.id}`;
  const [text, setText] = useState(() => load<string>(draftKey, ""));
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  // The mention the user dismissed with Escape stays dismissed while the same token is edited.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const box = useRef<ChipEditorHandle>(null);
  const pendingCaret = useRef<number | null>(null);
  // One idempotency key per attempt: a retry of the same text must not post twice,
  // while an edited message is a new message and gets a new key.
  const attempt = useRef<{ id: string; text: string } | null>(null);
  const baseId = useId();

  useEffect(() => {
    save(draftKey, text);
  }, [draftKey, text]);

  // A completed mention puts the caret after itself, once the box has drawn the new value.
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    box.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [text]);

  const range = useMemo(() => mentionRange(text, caret), [text, caret]);
  const matches = range ? matchMembers(members, range.query) : [];
  const open = range !== null && matches.length > 0 && dismissed !== range.start;
  const resolved = useMemo(() => resolveMentions(text, members), [text, members]);
  const lead = members.find((m) => m.id === room.leadMemberId) ?? null;
  const archived = room.archived;
  const budgets = budgetsOf(room);
  const noLead = !archived && lead === null && resolved.ids.length === 0;
  const tooMany = resolved.ids.length > budgets.maxDirectResponders;
  const empty = text.trim().length === 0;
  const disabled = archived || noLead || tooMany || sending;

  const complete = (handle: string) => {
    if (!range) return;
    const next = insertMention(text, range, handle);
    pendingCaret.current = next.caret;
    setText(next.text);
    setCaret(next.caret);
    setActive(0);
    setDismissed(null);
  };

  const send = async () => {
    if (disabled || empty) return;
    if (resolved.unknown.length > 0) onNotice(`No member named @${resolved.unknown[0]}; that word will not address anyone.`);
    const body = text.trim();
    const clientId = attempt.current?.text === body ? attempt.current.id : newClientId();
    attempt.current = { id: clientId, text: body };
    setSending(true);
    try {
      const ok = await onSend(body, resolved.ids, clientId);
      if (ok) {
        attempt.current = null;
        setText("");
        save(draftKey, "");
      }
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive((i) => (i + step + matches.length) % matches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        const pick = matches[active] ?? matches[0];
        // A handle already typed in full is done: Enter sends instead of re-completing it.
        const alreadyComplete = range !== null && matches.length === 1 && matches[0] !== undefined && matches[0].handle.toLowerCase() === range.query.toLowerCase();
        if (pick && !(e.key === "Enter" && alreadyComplete)) {
          e.preventDefault();
          complete(pick.handle);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(range.start);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
      return;
    }
    // Arrows move the caret; the mention under it may change.
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
      window.requestAnimationFrame(() => setCaret(box.current?.selectionStart ?? 0));
    }
  };

  return (
    <div className="room-composer">
      <div className="room-composer-box">
        {open ? (
          <ul className="room-mention-menu" role="listbox" aria-label="Mention a room member" id={`${baseId}-menu`}>
            {matches.map((m, i) => (
              <li
                key={m.id}
                id={`${baseId}-option-${i}`}
                role="option"
                aria-selected={i === active}
                className={`room-mention-option${i === active ? " is-active" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => complete(m.handle)}
              >
                <span className="room-mention-handle">@{m.handle}</span>
                <span className="room-mention-name">{m.name}</span>
                {m.role ? <span className="room-mention-role">{m.role}</span> : null}
                {m.id === room.leadMemberId ? <span className="room-mention-lead">lead</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
        <ChipEditor
          ref={box}
          className="composer-input"
          value={text}
          onChange={(next) => {
            setText(next);
            setActive(0);
            setDismissed(null);
            const at = box.current?.selectionStart ?? next.length;
            setCaret(at);
          }}
          onKeyDown={onKeyDown}
          placeholder={lead ? `Message ${lead.name}, or @mention another bot…` : "Message the room…"}
          disabled={archived}
          aria-label="Message the room"
          aria-autocomplete="list"
          aria-controls={open ? `${baseId}-menu` : undefined}
          aria-activedescendant={open ? `${baseId}-option-${active}` : undefined}
        />
        <div className="room-composer-foot">
          <span className="room-recipients" aria-live="polite">
            {resolved.ids.length > 0 ? (
              <>
                {resolved.ids.map((id) => (
                  <span key={id} className="room-mention-chip">
                    @{members.find((m) => m.id === id)?.handle ?? "?"}
                  </span>
                ))}
              </>
            ) : lead ? (
              <span title="Without an @mention, a message goes to the lead">To {lead.name}</span>
            ) : (
              <span className="room-warning">No lead selected</span>
            )}
          </span>
          <span className="room-composer-actions">
            {busy ? (
              <button type="button" className="round-btn is-stop room-stop" aria-label="Stop the room's work" title={stopping ? "Stopping…" : "Stop, and cancel what is queued"} disabled={stopping} onClick={onStop}>
                {stopping ? <Spinner size={14} /> : <IconStop size={14} />}
              </button>
            ) : null}
            {/* While a turn runs a message still goes: it queues behind it. */}
            <button type="button" className="round-btn room-send" aria-label="Send to the room" title={busy ? "Queue behind the running turn" : "Send"} disabled={disabled || empty} onClick={() => void send()}>
              <IconArrowUp size={16} />
            </button>
          </span>
        </div>
      </div>
      <div className="room-composer-status">
        {archived ? <span className="room-warning">This room is archived. Unarchive it to send messages.</span> : null}
        {noLead ? <span className="room-warning">This room has no lead. Pick one in Members before sending.</span> : null}
        {tooMany ? <span className="room-warning">Address at most {budgets.maxDirectResponders} bots per message.</span> : null}
        {queuedCount > 0 ? (
          <span className="room-queue-note">
            {queuedCount} of {budgets.queueMax} {queuedCount === 1 ? "message" : "messages"} queued behind the active turn
          </span>
        ) : null}
        {busy || invocationCount > 0 ? <span className="room-spend">{spentLine(usage, invocationCount)}</span> : null}
      </div>
    </div>
  );
}
