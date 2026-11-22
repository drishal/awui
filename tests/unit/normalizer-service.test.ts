import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatSnapshot, ToolItem } from "../../src/shared/protocol.js";
import { normalizerConfigOf, type NormalizerConfig } from "../../src/server/normalizer/config.js";
import { backendPlan, eligibleForDecision, NormalizerService, questionsFor, unusableReason, type NormalizerFetch } from "../../src/server/normalizer/service.js";
import { makeTestApp, signedIn, type TestApp } from "../helpers/app.js";

const HOME = "/home/dev";
const WHERE = { chatId: "chat-1", harness: "claude", workspace: "/home/dev/proj", runStartedAt: 1 };

function config(patch: Partial<NormalizerConfig> = {}): NormalizerConfig {
  return {
    enabled: true,
    backend: "command-code-jev",
    endpoint: "",
    jevBaseUrl: "https://api.typesafe.ai/v1/systemone",
    jevModel: "jev-latest",
    cloudflareAccountId: "",
    minChoice: 0.7,
    minNoul: 0.7,
    cache: false,
    timeoutMs: null,
    allowFreeText: false,
    keys: { jev: null, commandCode: "cmd-test-key", cloudflare: null },
    ...patch,
  };
}

function item(patch: Partial<ToolItem> = {}): ToolItem {
  return {
    kind: "tool",
    id: "t:1",
    name: "Bash",
    args: "",
    status: "error",
    output: "Running 2 tests using 1 worker\n  1) [chromium] › e2e/checkout.spec.ts:42:5 › checkout › pays with a saved card\n     Error: expect(received).toBe(expected)",
    truncated: false,
    category: "command",
    toolKind: "command",
    summary: "npx playwright test e2e/checkout.spec.ts",
    paths: [],
    ...patch,
  };
}

function body(answers: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "typesafe/jev-1.14.0",
    answers: {
      show_test_card: { type: "noul", noul: 0.9 },
      kind: { type: "choice", choice: "test", confidence: 0.91, probabilities: { test: 0.94, command: 0.04, other: 0.02 } },
      ...answers,
    },
    usage: { input_tokens: 900, output_tokens: 10 },
  };
}

/** A fetch that answers with `json` and counts its calls. */
function stubFetch(json: unknown, status = 200): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

function service(overrides: Partial<NormalizerConfig> = {}, options: { fetchImpl?: NormalizerFetch; file?: string | null } = {}): NormalizerService {
  return new NormalizerService({
    config: () => config(overrides),
    home: () => HOME,
    cacheFile: options.file ?? null,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the backend table", () => {
  it("resolves each backend to its own URL, model, key and timeout", () => {
    const commandCode = backendPlan(config());
    expect(commandCode).toMatchObject({ url: "https://api.commandcode.ai/provider/v1/systemone", model: "typesafe/jev-1.14.0", timeoutMs: 2500, remote: true });

    const plainJev = backendPlan(config({ backend: "jev", keys: { jev: "jev-key", commandCode: null, cloudflare: null } }));
    expect(plainJev).toMatchObject({ url: "https://api.typesafe.ai/v1/systemone", model: "jev-latest", timeoutMs: 2500, remote: true });

    // The Jev backend is the configurable one: a proxy's URL and a pinned model.
    const proxy = backendPlan(config({ backend: "jev", jevBaseUrl: "http://proxy.test/v1/systemone", jevModel: "jev-1.14.0", keys: { jev: "jev-key", commandCode: null, cloudflare: null } }));
    expect(proxy).toMatchObject({ url: "http://proxy.test/v1/systemone", model: "jev-1.14.0" });

    const workers = backendPlan(config({ backend: "workers-ai-clef-flash", cloudflareAccountId: "abc123", keys: { jev: null, commandCode: null, cloudflare: "cf-token" } }));
    expect(workers).toMatchObject({ url: "https://api.cloudflare.com/client/v4/accounts/abc123/ai/run/@cf/cloudflare/clef-flash", model: "clef-flash", timeoutMs: 1000, remote: true });

    const local = backendPlan(config({ backend: "local-clef-flash", endpoint: "http://127.0.0.1:8000/v1/systemone", keys: { jev: null, commandCode: null, cloudflare: null } }));
    expect(local).toMatchObject({ url: "http://127.0.0.1:8000/v1/systemone", model: "clef-flash", timeoutMs: 400, remote: false });
    expect(local?.key).toBeNull();

    // timeout_ms overrides each backend's own default.
    expect(backendPlan(config({ timeoutMs: 900 }))?.timeoutMs).toBe(900);
  });

  it("cannot be used without its endpoint, account, or key, and says which is missing", () => {
    const local = backendPlan(config({ backend: "local-clef-flash", endpoint: "" }));
    expect(local).toBeNull();
    expect(unusableReason(config({ backend: "local-clef-flash", endpoint: "" }))).toContain("endpoint");

    const noKey = config({ keys: { jev: null, commandCode: null, cloudflare: null } });
    expect(backendPlan(noKey)).toBeNull();
    expect(unusableReason(noKey)).toContain("CMD_API_KEY");
    expect(unusableReason(config({ backend: "jev", keys: { jev: null, commandCode: null, cloudflare: null } }))).toContain("TYPESAFE_API_KEY");

    expect(backendPlan(config({ backend: "workers-ai-clef-flash", cloudflareAccountId: "", keys: { jev: null, commandCode: null, cloudflare: "t" } }))).toBeNull();
  });
});

describe("when the normalizer is allowed to ask", () => {
  it("is off by default: no config block means no request and no fetch", async () => {
    const fetchSpy = stubFetch(body());
    for (const inert of [null, normalizerConfigOf(undefined, {}), config({ enabled: false })]) {
      const svc = new NormalizerService({ config: () => inert, home: () => HOME });
      expect(await svc.decide(item(), WHERE)).toBeNull();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stays inert when the selected backend has no endpoint or key", async () => {
    const fetchSpy = stubFetch(body());
    const local = service({ backend: "local-clef-flash", endpoint: "" });
    expect(await local.decide(item(), WHERE)).toBeNull();
    const noKey = service({ keys: { jev: null, commandCode: null, cloudflare: null } });
    expect(await noKey.decide(item(), WHERE)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(local.status().backend).toBe("unusable");
    expect(service({ enabled: false }).status().backend).toBe("disabled");
  });

  it("asks only about a settled call the built-in parsers could not place, with output", () => {
    expect(eligibleForDecision(item())).toBe(true);
    expect(eligibleForDecision(item({ toolKind: "other", category: "other" }))).toBe(true);
    // A replayed call with no toolKind still counts when its category is the ambiguous one.
    expect(eligibleForDecision(item({ toolKind: undefined }))).toBe(true);
    for (const kind of ["test", "plan", "todo", "job", "render", "ask", "read", "edit", "write", "search", "web", "agent", "mcp:awui"] as const) {
      expect(eligibleForDecision(item({ toolKind: kind }))).toBe(false);
    }
    expect(eligibleForDecision(item({ toolKind: undefined, category: "edit" }))).toBe(false);
    expect(eligibleForDecision(item({ status: "running" }))).toBe(false);
    expect(eligibleForDecision(item({ output: "  \n " }))).toBe(false);
  });
});

describe("the gate", () => {
  const ask = async (answers: Record<string, unknown>, overrides: Partial<NormalizerConfig> = {}) => {
    stubFetch(body(answers));
    return service(overrides).decide(item(), WHERE);
  };

  it("patches the row only when both the Noul and the chosen option's probability clear their thresholds", async () => {
    const patch = await ask({});
    expect(patch?.toolKind).toBe("test");
    expect(patch?.decided.by).toBe("command-code-jev");
    expect(patch?.decided.probability).toBe(0.94);
    expect(patch?.decided.field).toBe("kind");
    expect(patch?.decided.at).toBeTypeOf("number");
  });

  it("records the Choice's confidence but never gates on it: a 0.52/0.48 split still passes at 0.52", async () => {
    const patch = await ask({ kind: { type: "choice", choice: "test", confidence: 0.04, probabilities: { test: 0.52, command: 0.44, other: 0.04 } } }, { minChoice: 0.5 });
    expect(patch?.decided.probability).toBe(0.52);
    expect(patch?.decided.confidence).toBe(0.04);
  });

  it("draws nothing at all with the Noul in the band, or with the probability under the threshold", async () => {
    expect(await ask({ show_test_card: { type: "noul", noul: 0.55 } })).toBeNull();
    expect(await ask({ show_test_card: { type: "noul", noul: 0.28 } })).toBeNull();
    expect(await ask({ kind: { type: "choice", choice: "test", probabilities: { test: 0.5, command: 0.4, other: 0.1 } } })).toBeNull();
  });

  it("never patches a family outside the three still open, even if the model answers one", async () => {
    expect(await ask({ kind: { type: "choice", choice: "plan", probabilities: { plan: 0.99 } } })).toBeNull();
  });

  it("asks which failing test only when the sniffers named at least two, with those strings as the criteria", async () => {
    const named = item({
      candidates: [
        { key: "failing_test", value: "checkout › pays with a saved card", source: "sniffer", evidence: "1) checkout › pays with a saved card" },
        { key: "failing_test", value: "checkout › retries a declined card", source: "sniffer", evidence: "2) checkout › retries a declined card" },
      ],
    });
    const questions = questionsFor(named);
    expect(Object.keys(questions)).toEqual(["show_test_card", "kind", "failing_test"]);
    const choice = questions.failing_test;
    expect(choice?.type).toBe("choice");
    expect(choice?.type === "choice" ? Object.keys(choice.criteria) : []).toEqual(["checkout › pays with a saved card", "checkout › retries a declined card"]);
    expect(choice?.type === "choice" ? choice.criteria["checkout › pays with a saved card"] : "").toContain("1)");

    // One candidate is no choice at all, and none is no question.
    expect(Object.keys(questionsFor(item({ candidates: [named.candidates![0]!] })))).toEqual(["show_test_card", "kind"]);
    expect(Object.keys(questionsFor(item()))).toEqual(["show_test_card", "kind"]);
  });

  it("names the failing test when its own probability clears the threshold, and stays silent under it", async () => {
    const named = item({
      candidates: [
        { key: "failing_test", value: "checkout › pays with a saved card", source: "sniffer" },
        { key: "failing_test", value: "checkout › retries a declined card", source: "sniffer" },
      ],
    });
    stubFetch(body({ failing_test: { type: "choice", choice: "checkout › pays with a saved card", probabilities: { "checkout › pays with a saved card": 0.81, "checkout › retries a declined card": 0.19 } } }));
    const sure = await service().decide(named, WHERE);
    expect(sure?.decided.picks).toEqual({ failing_test: "checkout › pays with a saved card" });

    stubFetch(body({ failing_test: { type: "choice", choice: "checkout › pays with a saved card", probabilities: { "checkout › pays with a saved card": 0.52, "checkout › retries a declined card": 0.48 } } }));
    const unsure = await service().decide(named, WHERE);
    expect(unsure?.toolKind).toBe("test");
    expect(unsure?.decided.picks).toBeUndefined();
  });
});

describe("cache, budget, timeout", () => {
  it("answers an identical call from the cache, and asks again when a threshold changed", async () => {
    const fetchSpy = stubFetch(body());
    let thresholds = { minChoice: 0.7, minNoul: 0.7 };
    const svc = new NormalizerService({ config: () => config({ ...thresholds, cache: true }), home: () => HOME });
    const first = await svc.decide(item(), WHERE);
    const second = await svc.decide(item(), WHERE);
    expect(first).toEqual(second);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(svc.status().cacheHits).toBe(1);
    expect(svc.status().cacheMisses).toBe(1);

    thresholds = { minChoice: 0.8, minNoul: 0.8 };
    await svc.decide(item(), WHERE);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // A different output is a different call, even with the same candidates and tool.
    await svc.decide(item({ output: `${item().output}\n  2) another failure` }), WHERE);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("gives up inside its timeout and keeps the row, recording one class of failure", async () => {
    const hanging: NormalizerFetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
      });
    const svc = service({ timeoutMs: 100 }, { fetchImpl: hanging });
    const started = Date.now();
    expect(await svc.decide(item(), WHERE)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(svc.status().lastError).toBe("no answer within 100 ms");
    expect(svc.status().decisions).toBe(0);
  });

  it("keeps the row and names the class for a non-2xx answer, without echoing its body", async () => {
    stubFetch({ errors: [{ code: 1010, message: "browser_signature_banned" }] }, 403);
    const svc = service();
    expect(await svc.decide(item(), WHERE)).toBeNull();
    expect(svc.status().lastError).toContain("User-Agent");
  });

  it("asks at most 20 times a minute for one chat, then leaves the row alone", async () => {
    const fetchSpy = stubFetch(body());
    const svc = service();
    for (let i = 0; i < 20; i += 1) expect(await svc.decide(item({ output: `run ${i}: 2 failed` }), WHERE)).not.toBeNull();
    expect(await svc.decide(item({ output: "run 20: 2 failed" }), WHERE)).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(20);
  });
});

describe("the probe", () => {
  it("sends one canned example, never a stored tool output, and reports what the reply said", async () => {
    const fetchSpy = stubFetch(body());
    const probe = await service().probe();
    expect(probe.ok).toBe(true);
    expect(probe.backend).toBe("command-code-jev");
    expect(probe.model).toBe("typesafe/jev-1.14.0");
    expect(probe.inputTokens).toBe(900);
    expect(probe.answersSeen).toEqual(["show_test_card", "kind"]);
    expect(probe.status.spentInputTokens).toBe(900);
    const sent = String(fetchSpy.mock.calls[0]?.[1]?.body ?? "");
    expect(sent).toContain("npm run test");
    expect(sent).not.toContain("playwright");
  });

  it("says the feature is off, or why the backend is unusable, with no request", async () => {
    const fetchSpy = stubFetch(body());
    const off = await new NormalizerService({ config: () => normalizerConfigOf(undefined, {}), home: () => HOME }).probe();
    expect(off.ok).toBe(false);
    expect(off.backend).toBe("disabled");
    const unusable = await service({ backend: "local-clef-flash", endpoint: "" }).probe();
    expect(unusable.ok).toBe(false);
    expect(unusable.error).toContain("endpoint");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the chat's own path", () => {
  let t: TestApp | null = null;

  afterEach(async () => {
    await t?.close();
    t = null;
  });

  /** config.yml in this test's settings folder. */
  function writeConfig(root: string, yaml: string): void {
    mkdirSync(path.join(root, "settings"), { recursive: true });
    writeFileSync(path.join(root, "settings", "config.yml"), yaml);
  }

  /** The first tool row of a chat's snapshot that matches `ready`, polled for through the app itself. */
  async function waitForItem(agent: Awaited<ReturnType<typeof signedIn>>, id: string, ready: (item: ToolItem) => boolean): Promise<ToolItem> {
    const deadline = Date.now() + 8_000;
    for (;;) {
      const snapshot = (await agent.get(`/api/chats/${id}`)).body as ChatSnapshot;
      const found = snapshot.items.find((entry): entry is ToolItem => entry.kind === "tool" && ready(entry));
      if (found) return found;
      if (Date.now() > deadline) throw new Error("timed out waiting for a tool row");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function chatWith(agent: Awaited<ReturnType<typeof signedIn>>, text: string): Promise<ChatSnapshot> {
    const workspace = (await agent.post("/api/workspaces/open").send({ path: t!.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: workspace.id })).body as ChatSnapshot;
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text });
    return chat;
  }

  it("draws the plain row first, then re-puts it with the decision over the real chat path", async () => {
    t = await makeTestApp({ withSettings: true });
    writeConfig(t.root, "normalizer:\n  enabled: true\n  backend: command-code-jev\n  command_code_api_key: cmd-test-key\n  cache: false\n");
    const fetchSpy = stubFetch(body());
    const agent = await signedIn(t);
    const chat = await chatWith(agent, "toolfail");
    const decided = await waitForItem(agent, chat.chatId, (entry) => entry.decided !== undefined);
    expect(decided.toolKind).toBe("test");
    expect(decided.decided?.by).toBe("command-code-jev");
    expect(decided.decided?.probability).toBe(0.94);
    // The row kept everything it had; the decision only added the family and the record of why.
    expect(decided.output).toContain("port 4791");
    expect(decided.status).toBe("error");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const sent = String(fetchSpy.mock.calls[0]?.[1]?.body ?? "");
    expect(sent).toContain('"tool":"bash"');
    expect(sent).not.toContain(t.project);
  });

  it("adds a decision to the row as it is now, not to a stale copy of it", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const chat = await chatWith(agent, "toolfail");
    const row = await waitForItem(agent, chat.chatId, (entry) => entry.status !== "running");
    const live = t.manager.list().find((entry) => entry.chatId === chat.chatId);
    if (!live) throw new Error("chat missing");

    // Another update lands on the row while a decision is in flight.
    live.patchTool(row.id, (current) => ({ ...current, output: "newer output" }));
    const seen: { item: ToolItem | null } = { item: null };
    live.patchTool(row.id, (current) => {
      seen.item = current;
      return null;
    });
    expect(seen.item?.output).toBe("newer output");

    live.patchTool(row.id, (current) => ({ ...current, toolKind: "test", decided: { by: "command-code-jev", probability: 0.91, field: "kind", at: Date.now() } }));
    const after = await waitForItem(agent, chat.chatId, (entry) => entry.decided !== undefined);
    expect(after.output).toBe("newer output");
    expect(after.toolKind).toBe("test");
  });
});
