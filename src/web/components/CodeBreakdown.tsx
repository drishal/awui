// The chip on a worktree or race card that splits its changed lines into the
// project's own code, its tests, and generated output: a 1 200-line lockfile reads
// as generated, not as work. The rule and the numbers are shared/breakdown.ts;
// this only draws them, and says nothing when everything is one pile.
import { useMemo } from "react";
import { breakdown, breakdownText, breakdownTitle, type BreakdownFile, type BreakdownRules } from "../../shared/breakdown.js";

export function CodeBreakdown({ files, rules }: { files: ReadonlyArray<BreakdownFile> | undefined; rules: BreakdownRules }) {
  const counts = useMemo(() => breakdown(files ?? [], rules), [files, rules]);
  const text = breakdownText(counts);
  if (text === null) return null;
  return (
    <span className="race-breakdown" data-testid="code-breakdown" title={breakdownTitle(counts, rules)}>
      {text}
    </span>
  );
}
