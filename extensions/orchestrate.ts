// The orchestration tools (delegate_task, task_status, task_cancel, thread_send,
// thread_read, thread_wait, list_profiles): hand a self-contained task to another
// agent chat, watch it, talk to it, and read the result back. awui loads this
// into every Pi and omp child with -e (it speaks only the extension API both
// share, and imports nothing) and points it at its own orchestration endpoint
// with two environment variables:
//
//   AWUI_ORCH_URL    base, e.g. http://127.0.0.1:4783/api/orchestration
//   AWUI_ORCH_TOKEN  the chat's orchestration token, sent as X-Awui-Orch-Token
//
// Without both it registers nothing, so a stray copy elsewhere stays inert.
// Names, descriptions, and parameter schemas are not repeated here: the tool
// catalogue is fetched once from GET <url>/tools, where orchestration/tools.ts
// is the one definition, and each tool is registered as it arrives (pi and omp
// both accept a registration after load). A call is forwarded to POST <url>/call
// and the answer's `text` is what the model reads; the server's
// `{ ok: false, code, message }` becomes an error result reading `code: message`.

interface ToolContent {
  type: "text";
  text: string;
}

interface ToolResult {
  content: ToolContent[];
  details: Record<string, unknown>;
  isError?: boolean;
}

interface OrchToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface OrchAnswer {
  ok: boolean;
  text?: string;
  code?: string;
  message?: string;
}

interface Api {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    /** Pi lists a tool in the system prompt's "Available tools" only when it has one; omp ignores both fields. */
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: unknown;
    execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolResult>;
  }): void;
}

// Loaded twice (from a project's extensions folder and again with -e), it registers once.
const LOADED = Symbol.for("awui-orchestrate.loaded");

const text = (value: string): ToolContent => ({ type: "text", text: value });

/** Above the server's longest wait (thread_wait caps at 110 s), below a client's patience. */
const TIMEOUT_MS = 115_000;
const CATALOGUE_TIMEOUT_MS = 10_000;

export default function orchestrate(pi: Api): void {
  const url = process.env.AWUI_ORCH_URL;
  const token = process.env.AWUI_ORCH_TOKEN;
  if (!url || !token) return;
  const registry = globalThis as Record<symbol, unknown>;
  if (registry[LOADED]) return;
  registry[LOADED] = true;

  const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    let answer: OrchAnswer;
    try {
      const response = await fetch(`${url}/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Awui-Orch-Token": token },
        body: JSON.stringify({ tool: name, args }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      answer = (await response.json()) as OrchAnswer;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { content: [text(`could not reach the chat's orchestration endpoint: ${reason}`)], details: {}, isError: true };
    }
    if (answer.ok === true) return { content: [text(answer.text ?? "")], details: {} };
    const code = answer.code ?? "unknown_error";
    // The typed denial code rides in details, so the chat surface can show it without parsing the sentence.
    return { content: [text(`${code}: ${answer.message ?? "the call failed"}`)], details: { denial: code }, isError: true };
  };

  const register = (tools: OrchToolDef[], instructions: string): void => {
    // Without these a Pi chat lists no awui tool in its prompt, and an agent asked "do you have awui's tools?"
    // finds a bare `delegate_task` it cannot place. The server's own instructions (orchestration/tools.ts, the
    // words the MCP servers give too) ride on the first tool, so Pi puts them in its system prompt once.
    const guideline = instructions.trim();
    tools.forEach((tool, index) => {
      pi.registerTool({
        name: tool.name,
        label: `awui · ${tool.name}`,
        description: tool.description,
        promptSnippet: tool.description.split(/(?<=\.)\s/)[0] ?? tool.description,
        ...(index === 0 && guideline ? { promptGuidelines: [guideline] } : {}),
        parameters: tool.parameters,
        execute: (_toolCallId, params) => call(tool.name, params ?? {}),
      });
    });
  };

  void fetch(`${url}/tools`, { headers: { "X-Awui-Orch-Token": token }, signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS) })
    .then(async (response) => (response.ok ? ((await response.json()) as { tools?: OrchToolDef[]; instructions?: string }) : null))
    .then((body) => {
      // A catalogue that cannot be read leaves the child without these tools rather than
      // with a broken one; the run itself is unaffected.
      if (Array.isArray(body?.tools)) register(body.tools, typeof body.instructions === "string" ? body.instructions : "");
    })
    .catch(() => undefined);
}
