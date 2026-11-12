// The sheet that asks another harness about one turn: which harness, and what to ask
// (the default question is the server's when the box is left empty). It only collects
// the two answers; the route creates the chat that answers and the card that records it.
import { useState } from "react";
import type { HarnessStatus } from "../../shared/protocol.js";
import { errorText } from "../api.js";
import { Dialog } from "./Dialog.js";

export function SecondOpinionDialog({
  turn,
  from,
  harnesses,
  onSubmit,
  onClose,
}: {
  /** The turn being asked about, for the title. */
  turn: number;
  /** The harness that produced the turn: not offered as the one to ask. */
  from: string;
  harnesses: HarnessStatus[];
  /** Ask; throws when the server refuses, and the dialog shows why. */
  onSubmit: (harness: string, ask: string) => Promise<void>;
  onClose: () => void;
}) {
  const others = harnesses.filter((h) => h.available && h.id !== from);
  const [harness, setHarness] = useState(others[0]?.id ?? from);
  const [ask, setAsk] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    setSending(true);
    setError(null);
    try {
      await onSubmit(harness, ask.trim());
    } catch (e) {
      setError(errorText(e));
      setSending(false);
    }
  };
  return (
    <Dialog title={`Second opinion · turn ${turn}`} onClose={onClose}>
      <div className="second-opinion-form">
        <p className="muted">
          The turn goes to another harness as the first prompt of an ordinary chat in this project, which opens beside this one. It reviews and changes nothing.
        </p>
        <label className="form-row">
          <span>Ask</span>
          <select aria-label="Harness to ask" value={harness} disabled={others.length === 0 || sending} onChange={(e) => setHarness(e.target.value)}>
            {others.length === 0 ? <option value={from}>No other harness is available</option> : null}
            {others.map((h) => (
              <option key={h.id} value={h.id}>
                {h.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="form-row">
          <span>Question</span>
          <textarea
            className="input"
            aria-label="What to ask"
            rows={3}
            maxLength={2000}
            placeholder="Leave empty for what it gets right, what it misses, and what it would do differently."
            value={ask}
            disabled={sending}
            onChange={(e) => setAsk(e.target.value)}
          />
        </label>
        {error ? (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="btn btn-small" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-small btn-primary" disabled={sending || others.length === 0} onClick={() => void send()}>
            {sending ? "Asking…" : "Ask"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
