// The orchestration tools for harnesses without an extension API (Claude Code,
// Codex, DeepSeek Harness): the same seven tools as extensions/orchestrate.ts,
// served over MCP (JSON-RPC 2.0, one message per line on stdio), with no
// dependencies. awui starts it per chat through the harness's MCP config, with
// the chat's orchestration endpoint in its environment:
//
//   AWUI_ORCH_URL    base, e.g. http://127.0.0.1:4783/api/orchestration
//   AWUI_ORCH_TOKEN  the chat's orchestration token, sent as X-Awui-Orch-Token
//
// Without both it serves no tools. Names, descriptions, and parameter schemas
// are not repeated here: the catalogue is fetched once from GET <url>/tools,
// where orchestration/tools.ts is the one definition. A call is forwarded to
// POST <url>/call and the answer's `text` is the tool's result; the server's
// `{ ok: false, code, message }` becomes an error result reading `code: message`.
// The token only ever travels in the header, never in a message or a log.

import { createInterface } from "node:readline";

const URL_ENV = process.env.AWUI_ORCH_URL;
const TOKEN = process.env.AWUI_ORCH_TOKEN;
// Above the server's longest wait (thread_wait caps at 110 s), below a client's patience.
const TIMEOUT_MS = 115_000;
const CATALOGUE_TIMEOUT_MS = 10_000;

const text = (value) => ({ type: "text", text: value });
const failure = (message) => ({ content: [text(message)], isError: true });

/** The tool catalogue, fetched once; a failure is retried by the next request rather than cached. */
let catalogue = null;
let fetching = null;

function loadCatalogue() {
  if (catalogue) return Promise.resolve(catalogue);
  fetching ??= fetch(`${URL_ENV}/tools`, { headers: { "X-Awui-Orch-Token": TOKEN }, signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS) })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body?.tools)) throw new Error("the catalogue is not a tool list");
      catalogue = body.tools;
      fetching = null;
      return catalogue;
    })
    .catch((error) => {
      fetching = null;
      throw error;
    });
  return fetching;
}

async function forward(name, args) {
  let response;
  try {
    response = await fetch(`${URL_ENV}/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Awui-Orch-Token": TOKEN },
      body: JSON.stringify({ tool: name, args }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return failure(`could not reach the chat's orchestration endpoint: ${error instanceof Error ? error.message : String(error)}`);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return failure(`the chat's orchestration endpoint answered nothing readable (HTTP ${response.status})`);
  }
  if (body?.ok === true) return { content: [text(typeof body.text === "string" ? body.text : "")] };
  const code = typeof body?.code === "string" ? body.code : `HTTP ${response.status}`;
  const message = typeof body?.message === "string" ? body.message : "the call failed";
  return failure(`${code}: ${message}`);
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

async function handle(message) {
  const { id, method, params } = message;
  // A notification (no id) needs no answer.
  if (id === undefined || id === null) return;
  if (method === "initialize") {
    return send({
      id,
      result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "awui-orchestrate", version: "1" } },
    });
  }
  if (method === "ping") return send({ id, result: {} });
  if (method === "tools/list") {
    if (!URL_ENV || !TOKEN) return send({ id, result: { tools: [] } });
    try {
      return send({ id, result: { tools: await loadCatalogue() } });
    } catch (error) {
      return send({ id, error: { code: -32603, message: `could not read the orchestration tool catalogue: ${error instanceof Error ? error.message : String(error)}` } });
    }
  }
  if (method === "tools/call") {
    const name = params?.name;
    if (!URL_ENV || !TOKEN) return send({ id, error: { code: -32602, message: `Unknown tool: ${name}` } });
    const tools = await loadCatalogue().catch(() => null);
    if (!tools || !tools.some((tool) => tool.name === name)) return send({ id, error: { code: -32602, message: `Unknown tool: ${name}` } });
    return send({ id, result: await forward(name, params?.arguments ?? {}) });
  }
  send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: "Parse error" } });
  }
  void handle(message);
});
