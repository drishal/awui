// The orchestration tools as a streamable-HTTP MCP server: one JSON-RPC message in, one answer
// out. This is what a harness that can mount an HTTP MCP server connects to per chat, instead of
// awui spawning a Node child for it (extensions/orchestrate-mcp.mjs, which stays as the fallback
// for a client that cannot). The two speak the same messages and get the same words back: every
// name, description, and parameter schema still comes from orchestration/tools.ts, and every call
// is still run by orchestrator.ts, so nothing about a delegation changes with the transport.
//
// Only the answering lives here. The route in app.ts owns the chat token and the `{ ok: false,
// code, message }` envelope its sibling routes answer with, and this module has neither: no
// Express, no chat, no token. That keeps it a plain function a unit test can drive.
//
// Streamable HTTP without sessions: we never send a request to the client and never keep state
// between posts, so a POST is answered with `application/json` (or 202 for a notification) and no
// `Mcp-Session-Id`. A client that reconnects therefore starts clean, and `initialize` may be
// repeated without harm.

/** The MCP protocol era this server speaks when a client does not name one. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
/** The name awui's MCP server answers with, the same one the stdio bridge uses. */
export const MCP_SERVER_NAME = "awui-orchestrate";

/** A catalogue entry as REST serves it: the parameter schema is `parameters`, as the Pi/omp extension reads it. */
export interface McpCatalogueEntry {
  name: string;
  description: string;
  parameters: unknown;
}

/** One skill as a prompt: what the client lists, and the words it hands the agent. */
export interface McpPromptEntry {
  name: string;
  description: string;
  text: string;
}

/** What one tool call answered: the line the model reads, and whether that line is a failure. */
export interface McpCallOutcome {
  text: string;
  failed?: boolean;
}

export interface McpDeps {
  /** The tool catalogue, from orchestration/tools.ts: the one definition of every tool. */
  tools: () => McpCatalogueEntry[];
  /** The orchestration skills (council, advisor, handoff), read from skills/<name>/SKILL.md. */
  prompts: () => Promise<McpPromptEntry[]>;
  /** Run one tool call as the calling chat; a refused call answers with its own code and message. */
  call: (name: string, args: unknown) => Promise<McpCallOutcome>;
}

export interface McpAnswer {
  /** 200 for an answer, 202 for a notification (no body). */
  status: 200 | 202;
  /** The JSON-RPC response, or null when the message needed no answer. */
  body: unknown | null;
}

const text = (value: string): { type: "text"; text: string } => ({ type: "text", text: value });

const isObj = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The JSON-RPC method a message names, or "" when it names none (a malformed body). */
export function mcpMethod(message: unknown): string {
  return isObj(message) && typeof message.method === "string" ? message.method : "";
}

/** True when this message runs a tool, the one thing that needs the live chat behind the token. */
export function isToolCall(message: unknown): boolean {
  return mcpMethod(message) === "tools/call";
}

/** An MCP tool as clients require it: the schema travels as `inputSchema`, not the catalogue's own name. */
function mcpTool(entry: McpCatalogueEntry): { name: string; description: string; inputSchema: unknown } {
  return { name: entry.name, description: entry.description, inputSchema: entry.parameters };
}

/** Message ids may be strings or numbers; anything else is answered with a null id. */
function idOf(message: Record<string, unknown>): string | number | null {
  const id = message.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function answer(id: string | number | null, result: unknown): McpAnswer {
  return { status: 200, body: { jsonrpc: "2.0", id, result } };
}

function fail(id: string | number | null, code: number, message: string): McpAnswer {
  return { status: 200, body: { jsonrpc: "2.0", id, error: { code, message } } };
}

/**
 * Answer one JSON-RPC message. A notification (no id) is answered with 202 and nothing else, which
 * is what a client expects for `notifications/initialized`; everything else gets its result or its
 * error, in the same words the stdio bridge uses so a model cannot tell the two apart.
 */
export async function answerMcp(message: unknown, deps: McpDeps): Promise<McpAnswer> {
  if (!isObj(message)) return { status: 200, body: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } } };
  const id = idOf(message);
  if (id === null) return { status: 202, body: null };
  const method = mcpMethod(message);
  const params = isObj(message.params) ? message.params : {};

  switch (method) {
    case "initialize":
      // The prompts capability rides with the tools: the skills are served from the same place.
      return answer(id, {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL_VERSION,
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: "1" },
      });
    case "ping":
      return answer(id, {});
    case "tools/list":
      return answer(id, { tools: deps.tools().map(mcpTool) });
    case "prompts/list": {
      // A skills read that fails stops the message instead of answering an empty list: a server
      // that served no prompts would look like a client that does not show them (skills.ts's rule).
      const served = await deps.prompts();
      return answer(id, { prompts: served.map(({ name, description }) => ({ name, description })) });
    }
    case "prompts/get": {
      const name = typeof params.name === "string" ? params.name : "";
      const served = await deps.prompts().catch(() => null);
      const prompt = served?.find((entry) => entry.name === name);
      if (!prompt) return fail(id, -32602, `Unknown prompt: ${name}`);
      return answer(id, { description: prompt.description, messages: [{ role: "user", content: text(prompt.text) }] });
    }
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      if (!deps.tools().some((tool) => tool.name === name)) return fail(id, -32602, `Unknown tool: ${name}`);
      // The call's own refusal is a result, not an error: the model reads `code: message` and can
      // act on it, exactly as it does through the stdio bridge.
      const outcome = await deps.call(name, params.arguments ?? {});
      return answer(id, { content: [text(outcome.text)], ...(outcome.failed ? { isError: true } : {}) });
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}
