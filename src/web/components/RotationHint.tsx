// The rotation offer above the composer: this session's context is nearly full, and a
// fresh session seeded from the transcript (rotation.ts holds the threshold and the
// words, the server's rotate route does the work) is cheaper than carrying it on.
// Nothing rotates by itself; "Don't ask again" is remembered per device.
import { rotationText } from "../rotation.js";

export function RotationHint({ hint, busy, onRotate, onDismiss }: { hint: { percent: number; ageMs: number | null }; busy: boolean; onRotate: () => void; onDismiss: () => void }) {
  return (
    <div className="rotation-hint" role="status">
      <p className="rotation-text">{rotationText(hint)}</p>
      <button type="button" className="pill-btn" disabled={busy} title="Start a fresh session from this chat's transcript; this one stays open" onClick={onRotate}>
        Start fresh session
      </button>
      <button type="button" className="link-btn" onClick={onDismiss} title="Stop offering this on this device">
        Don't ask again
      </button>
    </div>
  );
}
