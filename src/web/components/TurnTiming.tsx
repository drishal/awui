// The Timing view for one turn, opened from the answer's action row: the rows
// and the axis are TimingView's, which the context chip's full view draws too.
import type { Turn } from "../turns.js";
import { Dialog } from "./Dialog.js";
import { TimingView } from "./TimingView.js";

export function TurnTiming({ turn, workspace, onClose }: { turn: Turn; workspace: string; onClose: () => void }) {
  return (
    <Dialog title="Timing" onClose={onClose} className="timing-dialog">
      <TimingView turn={turn} workspace={workspace} />
    </Dialog>
  );
}
