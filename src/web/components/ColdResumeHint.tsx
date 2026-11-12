// The cold-resume hint above the composer: this chat has sat idle past its prompt cache's expiry,
// so its next prompt rebuilds a big prefix. It offers a compaction and nothing else; the words and
// the decision are cold-resume.ts's, the compaction is the chat's own route (the same one the
// palette's Compact context calls).
import { coldResumeText, type ColdResumeHint as Hint } from "../cold-resume.js";

export function ColdResumeHint({ hint, busy, onCompact, onDismiss }: { hint: Hint; busy: boolean; onCompact: () => void; onDismiss: () => void }) {
  return (
    <div className="cold-resume" role="status">
      <p className="cold-resume-text">{coldResumeText(hint)}</p>
      <button type="button" className="pill-btn" disabled={busy} title="Compacts this conversation before your next prompt" onClick={onCompact}>
        Compact first
      </button>
      <button type="button" className="link-btn" onClick={onDismiss} title="Stop offering this on this device">
        Don't ask again
      </button>
    </div>
  );
}
