// Client-side fold of the chat event stream, reconciled by item id.
import { type ChatEvent, type ChatItem, type ChatSnapshot, type ContextPoint, type ContextUsage, MAX_CONTEXT_HISTORY, MAX_DELEGATED_TASKS } from "../shared/protocol.js";

export type ChatState = ChatSnapshot & { gone?: string };

export function applyEvents(state: ChatState | null, events: ChatEvent[]): ChatState | null {
  const index = new Map<string, number>();
  if (state) indexItems(index, state.items);
  let next = state;
  for (const event of events) next = apply(next, event, index);
  return next;
}

/** id → position, first occurrence wins (the old `findIndex` semantics). */
function indexItems(index: Map<string, number>, items: ChatItem[]): void {
  index.clear();
  items.forEach((item, i) => {
    if (!index.has(item.id)) index.set(item.id, i);
  });
}

function replaceItem(items: ChatItem[], item: ChatItem, index: Map<string, number>): ChatItem[] {
  const at = index.get(item.id);
  if (at === undefined) {
    index.set(item.id, items.length);
    return [...items, item];
  }
  const copy = items.slice();
  copy[at] = item;
  return copy;
}

/** The same rule as the server's: a reading with a number in it is kept, the newest MAX_CONTEXT_HISTORY. */
function pushContextPoint(history: ContextPoint[], context: ContextUsage | null): ContextPoint[] {
  if (!context || (context.percent === null && context.tokens === null)) return history;
  return [...history, { percent: context.percent, tokens: context.tokens }].slice(-MAX_CONTEXT_HISTORY);
}

function apply(state: ChatState | null, event: ChatEvent, index: Map<string, number>): ChatState | null {
  if (event.type === "snapshot") {
    indexItems(index, event.snapshot.items);
    return { ...event.snapshot };
  }
  if (!state) return state;
  switch (event.type) {
    case "item":
      return { ...state, items: replaceItem(state.items, event.item, index) };
    case "delta": {
      const at = index.get(event.itemId);
      if (at === undefined) return state;
      const item = state.items[at] as ChatItem;
      let updated: ChatItem = item;
      if (item.kind === "assistant" && (event.field === "text" || event.field === "thinking")) {
        updated = { ...item, [event.field]: item[event.field] + event.append };
      } else if (item.kind === "tool" && event.field === "output") {
        updated = { ...item, output: item.output + event.append };
      }
      const items = state.items.slice();
      items[at] = updated;
      return { ...state, items };
    }
    case "status":
      return { ...state, status: event.status };
    case "queue":
      return { ...state, queue: event.queue };
    case "config":
      return { ...state, config: event.config };
    case "title":
      return { ...state, title: event.title, sessionId: event.sessionId };
    case "request":
      return state.pending.some((p) => p.id === event.request.id)
        ? state
        : { ...state, pending: [...state.pending, event.request] };
    case "request_resolved":
      return { ...state, pending: state.pending.filter((p) => p.id !== event.requestId) };
    case "extension_status": {
      const extensionStatus = { ...state.extensionStatus };
      if (event.text === null) delete extensionStatus[event.key];
      else extensionStatus[event.key] = event.text;
      return { ...state, extensionStatus };
    }
    case "context":
      return { ...state, context: event.context, contextHistory: pushContextPoint(state.contextHistory, event.context) };
    case "viewers":
      return { ...state, viewers: event.viewers };
    case "usage":
      return { ...state, usage: event.usage };
    case "todos":
      return { ...state, todos: event.todos };
    case "checkpoints":
      return { ...state, checkpoints: event.turns };
    case "chain":
      return { ...state, chain: event.chain, chainPaused: event.paused };
    // One coordinated worker proposal changed: the latest snapshot replaces its own row.
    case "plan":
      return { ...state, plan: event.plan ?? undefined };
    // One delegated task changed: its panel row is replaced in place, or added in front when it
    // is new (the server lists them newest first, and the panel shows them so).
    case "task": {
      const tasks = state.delegated ?? [];
      const at = tasks.findIndex((task) => task.id === event.task.id);
      const next = at < 0 ? [event.task, ...tasks] : tasks.map((task, i) => (i === at ? event.task : task));
      return { ...state, delegated: next.slice(0, MAX_DELEGATED_TASKS) };
    }
    case "disposed":
      return { ...state, status: "disposed", gone: event.reason };
    default:
      return state;
  }
}
