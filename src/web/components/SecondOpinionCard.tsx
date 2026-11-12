// A turn's second opinion, drawn under the answer it reviews: which harness produced
// the turn, which one was asked, the question, and the opening of the reply. The whole
// reply lives in its own chat (the card's Open chat goes there); nothing here is a copy
// of a harness transcript, only the bounded record awui keeps of what was asked.
import type { SecondOpinion } from "../../shared/protocol.js";
import { IconSpark } from "../icons.js";

export function SecondOpinionCard({ opinion, nameOf, onOpen }: { opinion: SecondOpinion; nameOf: (harnessId: string) => string; onOpen: () => void }) {
  return (
    <div className="second-opinion" data-testid="second-opinion">
      <div className="second-opinion-head">
        <IconSpark size={13} />
        <span className="second-opinion-title">Second opinion</span>
        <span className="second-opinion-route muted">
          {nameOf(opinion.from)} → {nameOf(opinion.to)}
        </span>
        <button type="button" className="link-btn" onClick={onOpen}>
          Open chat
        </button>
      </div>
      {opinion.ask ? <p className="second-opinion-ask">{opinion.ask}</p> : null}
      {opinion.report ? (
        <p className="second-opinion-report">{opinion.report}</p>
      ) : (
        <p className="muted second-opinion-waiting">Waiting for its reply…</p>
      )}
    </div>
  );
}
