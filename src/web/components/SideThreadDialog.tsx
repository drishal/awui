// The sheet that asks a question about one block of a chat: the block and the question
// go to a chat of their own (the server's side route), which opens beside this one, so the
// main conversation is never written to. It collects the question and nothing else.
import { useState } from "react";
import { errorText } from "../api.js";
import { Dialog } from "./Dialog.js";

export function SideThreadDialog({ turn, onSubmit, onClose }: { turn: number; onSubmit: (question: string) => Promise<void>; onClose: () => void }) {
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    setSending(true);
    setError(null);
    try {
      await onSubmit(question.trim());
    } catch (e) {
      setError(errorText(e));
      setSending(false);
    }
  };
  return (
    <Dialog title={`Ask about turn ${turn}`} onClose={onClose}>
      <div className="second-opinion-form">
        <p className="muted">
          The turn goes with your question to a chat of its own beside this one, and nothing is added to this conversation. It reads and answers; it changes nothing.
        </p>
        <label className="form-row">
          <span>Question</span>
          <textarea
            className="input"
            aria-label="Question about this turn"
            rows={3}
            maxLength={2000}
            autoFocus
            placeholder="Why did it choose that approach?"
            value={question}
            disabled={sending}
            onChange={(e) => setQuestion(e.target.value)}
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
          <button type="button" className="btn btn-small btn-primary" disabled={sending || question.trim().length === 0} onClick={() => void send()}>
            {sending ? "Asking…" : "Ask"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
