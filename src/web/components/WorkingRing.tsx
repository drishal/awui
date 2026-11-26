// Hermes-style spinning ring for a session whose run is in progress: in the
// sidebar's rows and project heads, and on session tabs.
import { harnessColor } from "../harness-colors.js";

/**
 * `still` holds the ring without spinning it: the Working section's own mark sits above the rows it
 * counts, and three rings spinning in one column said "three runs" for one run. Motion is the row's cue.
 */
export function WorkingRing({ harnessId, colored, still = false }: { harnessId?: string | undefined; colored: boolean; still?: boolean }) {
  return <span className={`working-ring${colored ? " is-harness" : ""}${still ? " is-still" : ""}`} style={colored ? harnessColor(harnessId) : undefined} role="img" aria-label="Working" title="Working" />;
}
