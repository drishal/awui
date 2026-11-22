import { describe, expect, it } from "vitest";
import { buildSystemOneRequest, readSystemOneReply, replyErrorOf, SYSTEM_ONE_USER_AGENT, type SystemOneQuestion } from "../../src/server/normalizer/systemone.js";

const questions: Record<string, SystemOneQuestion> = {
  show_test_card: { type: "noul", instructions: "Is this a test run?", criteria: { true: "yes", false: "no" } },
};
const state = { tool: "Bash", output: "2 failed" };

/** A backend's plan, as service.ts's table builds one; this file tests the builder over it. */
const call = (patch: Partial<Parameters<typeof buildSystemOneRequest>[0]> = {}): Parameters<typeof buildSystemOneRequest>[0] => ({
  backend: "command-code-jev",
  url: "https://api.commandcode.ai/provider/v1/systemone",
  model: "typesafe/jev-1.14.0",
  key: "cmd-test-key",
  timeoutMs: 2500,
  remote: true,
  ...patch,
});

describe("the System One request one builder builds", () => {
  it("posts the plan's URL, model and key with a non-browser User-Agent", () => {
    const built = buildSystemOneRequest(call(), state, questions);
    expect(built.url).toBe("https://api.commandcode.ai/provider/v1/systemone");
    expect(built.body.model).toBe("typesafe/jev-1.14.0");
    expect(built.body.state).toEqual(state);
    expect(built.body.questions).toEqual(questions);
    expect(built.headers.authorization).toBe("Bearer cmd-test-key");
    expect(built.headers["user-agent"]).toBe(SYSTEM_ONE_USER_AGENT);
    expect(built.headers["user-agent"]).toBe("awui-normalizer/1");
    expect(built.headers["content-type"]).toBe("application/json");
  });

  it("never sets x-cmd-zdr, and always names itself: the two header rules (see the module header)", () => {
    for (const planned of [
      call({ backend: "local-clef-flash", url: "http://127.0.0.1:8000/v1/systemone", model: "clef-flash", key: null, timeoutMs: 400, remote: false }),
      call(),
      call({ backend: "jev", url: "https://api.typesafe.ai/v1/systemone", model: "jev-latest", key: "jev-key" }),
      call({ backend: "workers-ai-clef-flash", url: "https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/cloudflare/clef-flash", model: "clef-flash", key: "cf-token", timeoutMs: 1000 }),
    ]) {
      const built = buildSystemOneRequest(planned, state, questions);
      expect(Object.keys(built.headers)).not.toContain("x-cmd-zdr");
      expect(built.headers["user-agent"]).toBe("awui-normalizer/1");
    }
  });

  it("sends no Authorization header for a local endpoint that takes no key", () => {
    const built = buildSystemOneRequest(call({ backend: "local-clef-flash", url: "http://127.0.0.1:8000/v1/systemone", model: "clef-flash", key: null, remote: false }), state, questions);
    expect(built.headers.authorization).toBeUndefined();
    expect(built.body.model).toBe("clef-flash");
  });
});

describe("the System One reply reader", () => {
  const bare = {
    model: "jev-1.14.0",
    answers: {
      show_test_card: { type: "noul", noul: 0.88 },
      kind: { type: "choice", choice: "test", confidence: 0.91, probabilities: { test: 0.94, command: 0.04, other: 0.02 } },
    },
    usage: { input_tokens: 1204, output_tokens: 41 },
  };

  it("reads a bare body: a Noul's noul without confidence, a Choice's choice, probabilities and confidence", () => {
    const reply = readSystemOneReply(bare);
    expect(reply?.model).toBe("jev-1.14.0");
    expect(reply?.answers.show_test_card).toEqual({ type: "noul", noul: 0.88 });
    expect(reply?.answers.kind).toEqual({ type: "choice", choice: "test", confidence: 0.91, probabilities: { test: 0.94, command: 0.04, other: 0.02 } });
    expect(reply?.usage).toEqual({ input_tokens: 1204, output_tokens: 41 });
  });

  it("unwraps Workers AI's documented { success, result } envelope, without being told which shape it got", () => {
    const wrapped = { success: true, errors: [], messages: [], result: bare };
    expect(readSystemOneReply(wrapped)?.answers.kind).toEqual(bare.answers.kind);
    expect(readSystemOneReply({ success: false, errors: [{ code: 7000 }], messages: [], result: null })).toBeNull();
  });

  it("is a miss, not a throw, for a reply that carries no answers or a malformed one", () => {
    expect(readSystemOneReply(null)).toBeNull();
    expect(readSystemOneReply("not json")).toBeNull();
    expect(readSystemOneReply({ model: "jev" })).toBeNull();
    // A Choice whose own answer has no probability cannot be gated on.
    expect(readSystemOneReply({ answers: { kind: { type: "choice", choice: "test", probabilities: { command: 0.9 } } } })?.answers.kind).toBeUndefined();
    // A Noul that is not a number is dropped rather than read as 0.
    expect(readSystemOneReply({ answers: { show_test_card: { type: "noul", noul: "yes" } } })?.answers.show_test_card).toBeUndefined();
    // An answer of an unknown type is dropped; the rest of the reply still reads.
    expect(Object.keys(readSystemOneReply({ answers: { other: { type: "number", value: 3 }, kind: bare.answers.kind } })?.answers ?? {})).toEqual(["kind"]);
  });

  it("says what a refusal was without echoing the provider's body", () => {
    expect(replyErrorOf(403, '{"errors":[{"code":1010,"message":"browser_signature_banned"}]}')).toContain("User-Agent");
    expect(replyErrorOf(401, "unauthorized")).toBe("HTTP 401: the provider refused the key");
    expect(replyErrorOf(500, "the tool output quoted back")).toBe("HTTP 500: the provider failed");
    expect(replyErrorOf(418, "x")).toBe("HTTP 418");
  });
});
