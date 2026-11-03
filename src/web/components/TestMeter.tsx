// A test run's progress as a bar: how many of how many, the failures as their
// own red stretch at the end of the fill, and the test running now. Drawn under
// a running command's row and in a background job's card, from testProgress
// (tool-facts.ts), which only answers for runners that announce a total.
import type { CSSProperties } from "react";
import type { TestProgress } from "../tool-facts.js";

export function TestMeter({ progress, live = true }: { progress: TestProgress; live?: boolean }) {
  const { done, total, failed, current } = progress;
  const share = total > 0 ? done / total : 0;
  const failShare = total > 0 ? Math.min(failed, done) / total : 0;
  const text = `${done} of ${total} tests${failed > 0 ? `, ${failed} failed` : ""}`;
  return (
    <div className={`test-meter${live ? " is-live" : ""}${failed > 0 ? " has-failed" : ""}`} data-testid="test-meter">
      <div className="test-meter-top">
        <span className="test-meter-count">
          <strong>{done}</strong>/{total} tests
        </span>
        {failed > 0 ? <span className="test-meter-failed">{failed} failed</span> : null}
        <span className="test-meter-pct">{Math.round(share * 100)}%</span>
      </div>
      <div
        className="test-meter-track"
        role="progressbar"
        aria-label="Tests"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={text}
        style={{ "--done": share, "--failed": failShare } as CSSProperties}
      >
        <span className="test-meter-fill" />
        <span className="test-meter-fail" />
      </div>
      {current ? (
        <div className="test-meter-now" title={current}>
          {current}
        </div>
      ) : null}
    </div>
  );
}
