// The orchestration tools for harnesses without an extension API (Claude Code,
// Codex, DeepSeek Harness): the same seven tools as extensions/orchestrate.ts,
// served over MCP (JSON-RPC 2.0, one message per line on stdio), with no
// dependencies. awui starts it per chat through the harness's MCP config, with
// the chat's orchestration endpoint in its environment:
//
//   AWUI_ORCH_URL    base, e.g. http://127.0.0.1:4783/api/orchestration
//   AWUI_ORCH_TOKEN  the chat's orchestration token, sent as X-Awui-Orch-Token
//
// Without both it serves no tools and no prompts. Names, descriptions, and
// parameter schemas are not repeated here: the catalogue is fetched once from
// GET <url>/tools, where orchestration/tools.ts is the one definition. The three
// skills (council, advisor, handoff) come the same way from GET <url>/prompts,
// which serves skills/<name>/SKILL.md itself, so a prompt and the file an agent
// could read cannot drift. A call is forwarded to POST <url>/call and the
// answer's `text` is the tool's result; the server's `{ ok: false, code,
// message }` becomes an error result reading `code: message`. The token only
// ever travels in the header, never in a message or a log.

import { createInterface } from "node:readline";

const URL_ENV = process.env.AWUI_ORCH_URL;
const TOKEN = process.env.AWUI_ORCH_TOKEN;
// Above the server's longest wait (thread_wait caps at 110 s), below a client's patience.
const TIMEOUT_MS = 115_000;
// The catalogue and the prompt list are small documents a starting child asks for.
const LIST_TIMEOUT_MS = 10_000;

const text = (value) => ({ type: "text", text: value });
// A denial is a result the model reads; the typed code rides in `structuredContent`
// so an agent can test the code instead of parsing the sentence.
const failure = (message, structured) => ({ content: [text(message)], isError: true, ...(structured ? { structuredContent: structured } : {}) });
/** An error's own message, for an error answer that names what went wrong without the token. */
const describe = (error) => (error instanceof Error ? error.message : String(error));

/**
 * A document the endpoint serves at `suffix`, fetched once and kept: the descriptions and
 * schemas exist on the server only. A failed fetch rejects and is retried by the next request
 * instead of being cached.
 */
const documents = new Map();
const inflight = new Map();

function load(suffix, pick) {
  const known = documents.get(suffix);
  if (known) return Promise.resolve(known);
  let pending = inflight.get(suffix);
  if (!pending) {
    pending = fetch(`${URL_ENV}${suffix}`, { headers: { "X-Awui-Orch-Token": TOKEN }, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        const value = pick(body);
        documents.set(suffix, value);
        return value;
      })
      .finally(() => inflight.delete(suffix));
    inflight.set(suffix, pending);
  }
  return pending;
}

/**
 * The catalogue as MCP tools. REST names the parameter schema `parameters` (the Pi/omp extension's
 * registerTool reads it); an MCP client validates `tools/list` against the protocol, where the
 * schema must be `inputSchema`, and Claude Code and Codex drop a tool that lacks it.
 */
const toolsBody = () => load("/tools", (body) => body);

const catalogue = () =>
  toolsBody().then((body) => {
    if (!Array.isArray(body?.tools)) throw new Error("the catalogue is not a tool list");
    return body.tools.map(({ name, description, parameters }) => ({ name, description, inputSchema: parameters }));
  });

/** What the server tells the model on connect, from the same document as the tools (absent from an older server). */
const instructions = () => toolsBody().then((body) => (typeof body?.instructions === "string" ? body.instructions : ""));

/** The three skills with their words, the route having read skills/<name>/SKILL.md. */
const skills = () =>
  load("/prompts", (body) => {
    if (!Array.isArray(body?.prompts)) throw new Error("the skills answer is not a prompt list");
    return body.prompts;
  });

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
  return failure(`${code}: ${message}`, typeof body?.code === "string" ? { ok: false, code, message } : undefined);
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

async function handle(message) {
  const { id, method, params } = message;
  // A notification (no id) needs no answer.
  if (id === undefined || id === null) return;
  if (method === "initialize") {
    // Only with the endpoint: a bridge with nothing behind it serves no tools, so it claims none.
    // bounded: a slow endpoint costs the model its guidance, never the client its handshake
    const guidance = URL_ENV && TOKEN ? await Promise.race([instructions().catch(() => ""), new Promise((resolve) => setTimeout(resolve, 3000, ""))]) : "";
    return send({
      id,
      // The prompts capability rides with the tools: without the endpoint there is nothing to
      // prompt with either. Whether a client shows MCP prompts as commands is the client's
      // business; Claude Code does, Codex and DSH are unverified.
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: URL_ENV && TOKEN ? { tools: {}, prompts: {} } : { tools: {} },
        serverInfo: { name: "awui-orchestrate", title: "awui orchestration", version: "1" },
        ...(guidance ? { instructions: guidance } : {}),
      },
    });
  }
  if (method === "ping") return send({ id, result: {} });
  if (method === "tools/list") {
    if (!URL_ENV || !TOKEN) return send({ id, result: { tools: [] } });
    try {
      return send({ id, result: { tools: await catalogue() } });
    } catch (error) {
      return send({ id, error: { code: -32603, message: `could not read the orchestration tool catalogue: ${describe(error)}` } });
    }
  }
  // The orchestration skills as prompts: the client offers them as commands and hands the
  // text over as a user message, so the agent reads the same file an agent without prompts
  // would read. Arguments are none: each skill is one fixed instruction.
  if (method === "prompts/list") {
    if (!URL_ENV || !TOKEN) return send({ id, result: { prompts: [] } });
    try {
      const served = await skills();
      return send({ id, result: { prompts: served.map(({ name, description }) => ({ name, description })) } });
    } catch (error) {
      return send({ id, error: { code: -32603, message: `could not read the orchestration skills: ${describe(error)}` } });
    }
  }
  if (method === "prompts/get") {
    const name = params?.name;
    if (!URL_ENV || !TOKEN) return send({ id, error: { code: -32602, message: `Unknown prompt: ${name}` } });
    const served = await skills().catch(() => null);
    const prompt = served?.find((entry) => entry.name === name);
    if (!prompt) return send({ id, error: { code: -32602, message: `Unknown prompt: ${name}` } });
    return send({ id, result: { description: prompt.description, messages: [{ role: "user", content: text(prompt.text) }] } });
  }
  if (method === "tools/call") {
    const name = params?.name;
    if (!URL_ENV || !TOKEN) return send({ id, error: { code: -32602, message: `Unknown tool: ${name}` } });
    const tools = await catalogue().catch(() => null);
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
