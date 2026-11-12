// OpenCode (v2)'s stored shapes in awui's terms, pure so they can be tested
// against recorded replies. A session's messages become the Pi-family message
// list historyToItems already draws (user, assistant with thinking, text, and
// tool calls, a toolResult per finished call, a compaction marker); a model
// becomes a ModelInfo (its variants are the thinking levels); a form becomes
// one request per field; an assistant message's tokens become a usage entry.
// OpenCode's model entries carry provider settings, which can hold an API key:
// only the fields named here are ever read from them.
import type { InteractionRequest, ModelInfo, TodoItem } from "../../shared/protocol.js";
import { isObj, type Obj } from "./agent-events.js";
import { isHtmlRenderCall, splitRenderMarker } from "./render-token.js";
import { isAgentTool } from "./subagents.js";
import type { UsageEntry } from "./types.js";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

/** `provider/model`, the key awui's model picker sends back. */
export function modelKey(ref: unknown): string | null {
  if (!isObj(ref) || !str(ref.providerID) || !str(ref.id)) return null;
  return `${str(ref.providerID)}/${str(ref.id)}`;
}

/** A model's variant as a thinking level: OpenCode's `default` is no choice made, and `none` is thinking off. */
export function levelOf(ref: unknown): string | null {
  const variant = isObj(ref) ? str(ref.variant) : "";
  return variant && variant !== "default" ? variant : null;
}

/** Variant ids that are thinking levels, weakest first as OpenCode lists them ("none" is off, not a level). */
function levels(model: Obj): string[] {
  return list(model.variants)
    .map((v) => str(v.id))
    .filter((id) => id && id !== "none" && id !== "default");
}

export function toModelInfo(model: unknown): ModelInfo | null {
  if (!isObj(model) || model.enabled === false) return null;
  const key = modelKey(model);
  if (!key) return null;
  const input = isObj(model.capabilities) && Array.isArray(model.capabilities.input) ? model.capabilities.input : null;
  const ladder = levels(model);
  return {
    key,
    provider: str(model.providerID),
    id: str(model.id),
    name: str(model.name) || str(model.id),
    ...(ladder.length > 0 ? { reasoning: true, levels: ladder } : {}),
    ...(input ? { vision: input.includes("image") } : {}),
  };
}

/** The model's context window, for the context meter. */
export function contextWindow(model: unknown): number {
  return isObj(model) && isObj(model.limit) ? num(model.limit.context) : 0;
}

/** A tool result's text: OpenCode's content parts, or its error. */
function toolText(state: Obj): string {
  if (state.status === "error") return str(isObj(state.error) ? state.error.message : state.error) || "Tool failed";
  return list(state.content)
    .map((c) => (c.type === "text" ? str(c.text) : c.type === "file" ? `[file ${str(c.uri) || str(c.name)}]` : ""))
    .filter(Boolean)
    .join("\n");
}

/** The child session a delegation call ran (OpenCode says `sessionID`; older versions `sessionId`). */
export function childSession(metadata: unknown): string | null {
  if (!isObj(metadata)) return null;
  const id = str(metadata.sessionID) || str(metadata.sessionId);
  return /^ses_[A-Za-z0-9]+$/.test(id) ? id : null;
}

/** The agent a delegation call names: oh-my-opencode-slim's `agent`, OpenCode's own `subagent_type`. */
export function delegateAgent(input: unknown): string {
  return isObj(input) ? str(input.agent) || str(input.subagent_type) || "agent" : "agent";
}

/** A finished delegation as the result row subagents.ts folds in: its child session is the run. */
export function delegationResult(input: unknown, metadata: unknown, output: string, failed: boolean): Obj | null {
  const child = childSession(metadata);
  if (!child) return null;
  const meta = isObj(metadata) ? metadata : {};
  const model = isObj(meta.model) && str(meta.model.providerID) && (str(meta.model.modelID) || str(meta.model.id)) ? `${str(meta.model.providerID)}/${str(meta.model.modelID) || str(meta.model.id)}` : undefined;
  const state = str(meta.status);
  const status = failed ? "failed" : state && !/complete/.test(state) ? state : "done";
  return { id: child, index: 0, agent: delegateAgent(input), status, ...(model ? { model } : {}), ...(output.trim() ? { output } : {}) };
}

/** A finished call's structured side: an edit's patches as one unified diff (resultDiff reads `diff`). */
export function toolDetails(metadata: unknown): Obj | undefined {
  if (!isObj(metadata)) return undefined;
  const patches = list(metadata.files)
    .map((f) => str(f.patch))
    .filter(Boolean);
  return patches.length > 0 ? { ...metadata, diff: patches.join("\n") } : metadata;
}

/**
 * A result's text and details, with an awui render tool's page taken off its last line. An
 * MCP result carries only content, so awui's render bridge marks the page on that line
 * (render-token.ts); only a render call may hand it over, never a tool's own imitating text.
 */
function withRenderMarker(name: string, output: string, details: Obj | undefined): { output: string; details?: Obj } {
  if (!isHtmlRenderCall(name, undefined)) return { output, ...(details ? { details } : {}) };
  const marked = splitRenderMarker(output);
  const merged = marked.details ? { ...(details ?? {}), ...marked.details } : details;
  return { output: marked.text, ...(merged ? { details: merged } : {}) };
}

/** A tool result's text and failure from a live event (`session.tool.success` / `session.tool.failed`). */
export function toolResult(data: Obj, failed: boolean, name: string): { output: string; isError: boolean; details?: Obj } {
  if (failed) return { output: str(isObj(data.error) ? data.error.message : data.error) || "Tool failed", isError: true };
  const marked = withRenderMarker(name, toolText({ status: "completed", content: data.content }), toolDetails(data.metadata));
  const exit = isObj(data.metadata) ? data.metadata.exit : undefined;
  return { output: marked.output, isError: typeof exit === "number" && exit !== 0, ...(marked.details ? { details: marked.details } : {}) };
}

/**
 * A session's messages (oldest first) as the Pi-family list historyToItems
 * reads. Interrupted steps keep what they wrote, marked stopped.
 */
export function transcriptOf(messages: unknown[]): Obj[] {
  const out: Obj[] = [];
  for (const m of messages) {
    if (!isObj(m)) continue;
    const at = isObj(m.time) ? num(m.time.created) : 0;
    const stamp = at ? { timestamp: at } : {};
    switch (m.type) {
      case "user": {
        const images = list(m.files).filter((f) => /^data:image\//.test(str(f.uri)) || /\.(png|jpe?g|gif|webp)$/i.test(str(f.name)));
        out.push({ role: "user", content: [{ type: "text", text: str(m.text) }, ...images.map(() => ({ type: "image" }))], ...stamp });
        break;
      }
      case "assistant": {
        const content: Obj[] = [];
        const results: Obj[] = [];
        for (const part of list(m.content)) {
          if (part.type === "reasoning" && str(part.text)) content.push({ type: "thinking", thinking: str(part.text) });
          else if (part.type === "text" && str(part.text)) content.push({ type: "text", text: str(part.text) });
          else if (part.type === "tool") {
            const state = isObj(part.state) ? part.state : {};
            content.push({ type: "toolCall", id: str(part.id), name: str(part.name) || "tool", arguments: state.input ?? {} });
            if (state.status === "completed" || state.status === "error") {
              const ended = isObj(part.time) ? num(part.time.completed) : 0;
              const result = isAgentTool(str(part.name)) ? delegationResult(state.input, state.metadata, toolText(state), state.status === "error") : null;
              const name = str(part.name) || "tool";
              const shaped = result ? { ...toolDetails(state.metadata), results: [result] } : state.status === "completed" ? toolDetails(state.metadata) : undefined;
              const marked = state.status === "completed" ? withRenderMarker(name, toolText(state), shaped) : { output: toolText(state), details: shaped };
              const exit = isObj(state.metadata) ? state.metadata.exit : undefined;
              results.push({
                role: "toolResult",
                toolCallId: str(part.id),
                toolName: name,
                content: [{ type: "text", text: marked.output }],
                isError: state.status === "error" || (typeof exit === "number" && exit !== 0),
                ...(marked.details ? { details: marked.details } : {}),
                ...(ended ? { timestamp: ended } : {}),
              });
            }
          }
        }
        const error = isObj(m.error) ? m.error : null;
        out.push({
          role: "assistant",
          content,
          ...(modelKey(m.model) ? { model: modelKey(m.model) } : {}),
          ...(error ? (error.type === "aborted" ? { stopReason: "aborted" } : { stopReason: "error", errorMessage: str(error.message) || "Request failed" }) : {}),
          ...stamp,
        });
        out.push(...results);
        break;
      }
      case "compaction":
        if (m.status !== "failed") out.push({ role: "compactionSummary", ...stamp });
        break;
      default:
        // idle, model-switched, agent-switched, system, synthetic: nothing to draw.
        break;
    }
  }
  return out;
}

/** The ids of the session's prompts, oldest first: Edit, Retry, and fork address a turn by them. */
export function promptIds(messages: unknown[]): string[] {
  return messages.filter((m): m is Obj => isObj(m) && m.type === "user").map((m) => str(m.id));
}

/** The session's latest todo list (a todowrite call's `todos`), or none. */
export function latestTodos(messages: unknown[]): TodoItem[] {
  for (const m of [...messages].reverse()) {
    if (!isObj(m) || m.type !== "assistant") continue;
    for (const part of [...list(m.content)].reverse()) {
      if (part.type !== "tool" || !/todo/i.test(str(part.name))) continue;
      const input = isObj(part.state) && isObj(part.state.input) ? part.state.input : {};
      if (Array.isArray(input.todos)) return todosOf(input.todos);
    }
  }
  return [];
}

export function todosOf(todos: unknown): TodoItem[] {
  return list(todos)
    .map((t) => ({ text: str(t.content) || str(t.text) || str(t.title), status: str(t.status) || "pending" }))
    .filter((t) => t.text);
}

/** Every model call the session made, with its tokens and cost. */
export function usageOf(messages: unknown[]): UsageEntry[] {
  const out: UsageEntry[] = [];
  for (const m of messages) {
    if (!isObj(m) || m.type !== "assistant" || !isObj(m.tokens)) continue;
    const t = m.tokens;
    const cache = isObj(t.cache) ? t.cache : {};
    const at = isObj(m.time) ? num(m.time.completed) || num(m.time.created) : 0;
    out.push({
      at,
      model: modelKey(m.model),
      input: num(t.input),
      cachedInput: num(cache.read),
      cacheWrite: num(cache.write),
      output: num(t.output) + num(t.reasoning),
      cost: typeof m.cost === "number" ? m.cost : null,
    });
  }
  return out;
}

export interface FormQuestion {
  key: string;
  request: InteractionRequest;
  /** How the card's answer goes back: as it is, as a list (multiselect), or as a number or a yes/no. */
  shape: "text" | "list" | "number" | "boolean";
}

/** One card per form field, asked in turn, as Claude Code's questions are. */
export function formQuestions(form: Obj, now = Date.now()): FormQuestion[] {
  const fields = Array.isArray(form.fields) ? form.fields : isObj(form.fields) && Array.isArray(form.fields.fields) ? form.fields.fields : [];
  const out: FormQuestion[] = [];
  for (const [i, field] of fields.filter(isObj).entries()) {
    const key = str(field.key) || `q${i}`;
    const options = list(field.options);
    const labels = options.map((o) => str(o.label) || str(o.value)).filter(Boolean);
    const details = options.map((o) => str(o.description));
    const title = str(field.title) || str(form.title) || "OpenCode asks";
    const message = str(field.description) || undefined;
    const base = { id: `${str(form.id)}:${key}`, title, ...(message ? { message } : {}), createdAt: now };
    if (field.type === "boolean") {
      out.push({ key, shape: "boolean", request: { ...base, kind: "confirm" } });
    } else if (labels.length > 0) {
      out.push({
        key,
        shape: field.type === "multiselect" ? "list" : "text",
        request: { ...base, kind: "select", options: labels, ...(details.some(Boolean) ? { optionDetails: details } : {}) },
      });
    } else {
      out.push({ key, shape: field.type === "integer" || field.type === "number" ? "number" : "text", request: { ...base, kind: "input" } });
    }
  }
  return out;
}

/** A card's answer as the form field's value: the option's value for its label, a number, a list. */
export function formValue(question: FormQuestion, form: Obj, answer: string | boolean): unknown {
  if (question.shape === "boolean") return answer === true;
  const fields = Array.isArray(form.fields) ? form.fields : isObj(form.fields) && Array.isArray(form.fields.fields) ? form.fields.fields : [];
  const field = fields.filter(isObj).find((f) => str(f.key) === question.key);
  const option = list(field?.options).find((o) => (str(o.label) || str(o.value)) === answer);
  const value = option ? str(option.value) || str(option.label) : String(answer);
  if (question.shape === "list") return [value];
  if (question.shape === "number") return Number(value);
  return value;
}

/** A permission request as an approval card: what it wants to do, and to what. */
export function permissionCard(p: Obj, now = Date.now()): InteractionRequest {
  const action = str(p.action) || "this";
  const resources = (Array.isArray(p.resources) ? p.resources : []).map(String).filter(Boolean);
  const saves = (Array.isArray(p.save) ? p.save : []).map(String).filter(Boolean);
  return {
    id: str(p.id),
    kind: "select",
    title: `Allow ${action}?`,
    message: [str(p.message), resources.join("\n")].filter(Boolean).join("\n"),
    options: [ALLOW_ONCE, ...(saves.length > 0 ? [`${ALLOW_ALWAYS} (${saves.join(", ")})`] : [ALLOW_ALWAYS]), DENY],
    createdAt: now,
  };
}

export const ALLOW_ONCE = "Allow once";
export const ALLOW_ALWAYS = "Always allow";
export const DENY = "Deny";

/** The card's choice as OpenCode's reply. */
export function permissionReply(value: string | null): "once" | "always" | "reject" {
  if (value === ALLOW_ONCE) return "once";
  if (value?.startsWith(ALLOW_ALWAYS)) return "always";
  return "reject";
}
