// A todo call's checklist, read from the call's own arguments: Claude Code's and
// Hermes's whole list (`todos`), or the operations omp and Pi write (`ops`, or a
// single `op` a model may leave out), or rpiv-todo's one `action`. Shared so the
// web card and the terminal's row draw the same entries. Pure.

export interface TodoEntry {
  text: string;
  status: "done" | "active" | "pending" | "cancelled";
  phase?: string;
}

type Args = Record<string, unknown>;

const todoStatus = (raw: unknown): TodoEntry["status"] => {
  const s = String(raw ?? "");
  return /done|complete/.test(s) ? "done" : /progress|active|doing/.test(s) ? "active" : /cancel|abandon|skip/.test(s) ? "cancelled" : "pending";
};

/**
 * A todo call as a checklist: the whole list it carries, or what its operations
 * planned and ticked off. Null when the arguments are not a todo call's.
 */
export function todoEntries(args: Args | null): TodoEntry[] | null {
  if (!args) return null;
  const obj = (v: unknown): v is Args => typeof v === "object" && v !== null && !Array.isArray(v);
  if (Array.isArray(args.todos)) {
    return args.todos.filter(obj).map((t) => ({ text: String(t.content ?? t.text ?? t.title ?? ""), status: todoStatus(t.status) }));
  }
  // Pi lets a model leave `op` out of a `list` or `items` call.
  const single = typeof args.op === "string" || Array.isArray(args.list) || Array.isArray(args.items);
  const ops = Array.isArray(args.ops) ? args.ops.filter(obj) : single ? [args] : null;
  if (!ops) return null;
  const out: TodoEntry[] = [];
  const planned = (items: unknown, phase: unknown) => {
    for (const task of Array.isArray(items) ? items : []) {
      out.push({ text: String(task), status: "pending", ...(typeof phase === "string" ? { phase } : {}) });
    }
  };
  for (const op of ops) {
    const kind = String(op.op ?? "");
    if (Array.isArray(op.list)) {
      for (const phase of op.list.filter(obj)) planned(phase.items, phase.phase);
    } else if (Array.isArray(op.items)) {
      planned(op.items, op.phase);
    } else if (typeof op.task === "string" || typeof op.text === "string") {
      const status: TodoEntry["status"] = /done|complete/.test(kind) ? "done" : /start|progress/.test(kind) ? "active" : /drop|remove|cancel/.test(kind) ? "cancelled" : "pending";
      out.push({ text: String(op.task ?? op.text), status });
    }
  }
  return out.length > 0 ? out : null;
}
