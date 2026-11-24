// A delegated worker's row on the Agents board, as the parts it is drawn from: its role, host and model, then its title, and how it
// stands. The row is measured here (not left to the renderer's truncation, which cuts a line in its middle with "..." and ate the
// role): the facts that name the seat (role, host, model) come first and stay whole, the title takes what is left and clips at its
// end with "…" (or leaves when only a few cells remain), and when even the facts do not fit the model goes first, then the host,
// then the role.
import { clip } from "./format.js";

export interface WorkerRowParts {
  title: string;
  role: string;
  host: string;
  model: string;
  /** How it stands, with its leading space: " needs you", " working" or "" (a finished worker shows its ✓ instead). */
  state: string;
}

/** Fewest cells a title is worth drawing in. */
const MIN_TITLE = 5;

/** `avail` is the cells the row has after its `└ ● ` lead; `state` (or the two-cell " ✓") is always kept. */
export function workerRow(input: { title: string; role?: string | null; host?: string | null; model?: string | null; state: string }, avail: number): WorkerRowParts {
  const state = input.state;
  const extras = { role: input.role ?? "", host: input.host ?? "", model: input.model ?? "" };
  const fixed = Math.max(state.length, 2);
  const used = () => (extras.role ? extras.role.length + 1 : 0) + (extras.host ? extras.host.length + 1 : 0) + (extras.model ? extras.model.length + 1 : 0) + fixed;
  for (const key of ["model", "host", "role"] as const) {
    if (used() <= avail) break;
    extras[key] = "";
  }
  const room = avail - used() - 1;
  return { title: room >= MIN_TITLE ? clip(input.title, room) : "", role: extras.role, host: extras.host, model: extras.model, state };
}
