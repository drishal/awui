import { describe, expect, it } from "vitest";
import type { ToolItem } from "../../src/shared/protocol.js";
import { buildEgressState, clipForSend, MAX_EGRESS_CHARS, redactForEgress, relativizeForEgress } from "../../src/server/normalizer/redact.js";
import { SECRET_PROBES } from "../evals/normalizer-secrets.js";

const identity = { harness: "claude", workspace: "/home/dev/proj", home: "/home/dev" };

function item(patch: Partial<ToolItem> = {}): ToolItem {
  return {
    kind: "tool",
    id: "t:1",
    name: "Bash",
    args: "",
    status: "error",
    output: "",
    truncated: false,
    category: "command",
    toolKind: "command",
    summary: "npx playwright test e2e/checkout.spec.ts",
    paths: [],
    ...patch,
  };
}

/** The state as it goes on the wire, so an assertion cannot be satisfied by an object the fetch never sends. */
const wire = (state: Record<string, unknown>): string => JSON.stringify({ model: "typesafe/jev-1.14.0", state });

describe("the clip", () => {
  it("leaves a short output whole and clips a long one to 4 KB, keeping the tail over the head", () => {
    expect(clipForSend("two lines\n")).toEqual({ text: "two lines\n", omitted: 0 });

    // 16 KB, the fold's own ceiling: the head's first lines and the tail's summary must survive.
    const head = "HEAD-LINE-ONE\n" + "a".repeat(2_000);
    const middle = "m".repeat(14_000);
    const tail = "Test Files  1 failed (1)\n      Tests  2 failed (2)\n";
    const clipped = clipForSend(head + middle + tail);
    expect(clipped.text.length).toBeLessThanOrEqual(MAX_EGRESS_CHARS + 64);
    expect(clipped.omitted).toBeGreaterThan(0);
    expect(clipped.text.startsWith("HEAD-LINE-ONE")).toBe(true);
    expect(clipped.text.endsWith(tail)).toBe(true);
    expect(clipped.text).toContain("chars omitted");
    // The head is 1 KB and the tail 3 KB: a runner prints its summary last, so the tail is the larger half.
    const headKept = clipped.text.indexOf("chars omitted");
    expect(headKept).toBeLessThanOrEqual(1_100);
    expect(clipped.text.length - headKept).toBeGreaterThan(3_000);
  });
});

describe("the redaction", () => {
  it("strips every secret class the settings copy promises, leaving the line structure", () => {
    const poisoned = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEAy7Vb",
      "-----END RSA PRIVATE KEY-----",
      "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "pat github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
      "Authorization: Bearer abcdef0123456789",
      "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD",
      "aws AKIAIOSFODNN7EXAMPLE",
      "slack xoxb-123456789012-abcdefghijkl",
      "DATABASE_URL=postgres://awui:hunter2@db.internal:5432/awui",
      "GIT_SSH_KEY: /home/dev/.ssh/id_ed25519",
    ].join("\n");
    const clean = redactForEgress(poisoned);
    for (const probe of ["MIIEowIBAAKCAQEAy7Vb", "ghp_abcdefghij", "github_pat_11ABCDEFG", "Bearer abcdef0123456789", "sk-abcdefghijkl", "AKIAIOSFODNN7EXAMPLE", "xoxb-123456789012", "hunter2"]) {
      expect(clean).not.toContain(probe);
    }
    for (const probe of SECRET_PROBES) expect(clean).not.toContain(probe);
    // The names stay, so a model still reads what the line was about.
    expect(clean).toContain("OPENAI_API_KEY=");
    expect(clean).toContain("postgres://awui:[redacted]@");
    expect(clean).toContain("[redacted private key]");
    // Every line outside the PEM block survives as its own line: a model still sees the shape of a report.
    for (const line of ["token: ", "pat ", "OPENAI_API_KEY=", "aws ", "slack ", "DATABASE_URL="]) expect(clean).toContain(line);
    // 11 lines, of which the 3-line PEM block became one marker: 9 lines, none of them joined.
    expect(clean.split("\n").filter((line) => line.trim() !== "")).toHaveLength(9);
  });

  it("rewrites the home folder to ~ and the chat's project folder to .", () => {
    expect(relativizeForEgress("see /home/dev/proj/src/a.ts and /home/dev/notes.md", "/home/dev", "/home/dev/proj")).toBe("see ./src/a.ts and ~/notes.md");
  });
});

describe("the state one request carries", () => {
  it("is the call's own words: tool, one-line command, ended, truncated, clipped output, candidate pairs", () => {
    const { state } = buildEgressState(
      item({
        output: "Running 2 tests using 1 worker",
        candidates: [
          { key: "runner", value: "playwright", source: "sniffer", evidence: "Running 2 tests" },
          { key: "failing_test", value: "checkout › pays with a card", source: "sniffer" },
        ],
      }),
      identity,
      true,
    );
    expect(state).toEqual({
      harness: "claude",
      tool: "Bash",
      command: "npx playwright test e2e/checkout.spec.ts",
      ended: "error",
      truncated: false,
      output: "Running 2 tests using 1 worker",
      sniffer_candidates: [
        { key: "runner", value: "playwright" },
        { key: "failing_test", value: "checkout › pays with a card" },
      ],
    });
  });

  it("says truncated when the clip dropped something, even if the fold said otherwise", () => {
    const { state } = buildEgressState(item({ output: "x".repeat(20_000), truncated: false }), identity, true);
    expect(state.truncated).toBe(true);
    expect(String(state.output).length).toBeLessThan(5_000);
  });

  it("never carries the arguments, an environment, or a sibling path", () => {
    const { state } = buildEgressState(
      item({
        args: '{"command":"npx playwright test","env":{"GITHUB_TOKEN":"ghp_abcdefghijklmnopqrstuvwxyz0123456789"},"cwd":"/home/dev/elsewhere"}',
        output: "Running 1 test using 1 worker",
      }),
      identity,
      true,
    );
    const sent = wire(state);
    expect(sent).not.toContain("GITHUB_TOKEN");
    expect(sent).not.toContain("/home/dev/elsewhere");
    expect(sent).not.toContain("/home/dev");
  });

  it("redacts what leaves the machine and leaves a local server's copy alone, with the same clip", () => {
    const poisoned = item({ output: "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789\n2 failed" });
    const remoteCall = buildEgressState(poisoned, identity, true);
    const localCall = buildEgressState(poisoned, identity, false);
    expect(String(remoteCall.state.output)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    // Nothing leaves the machine on the local backend, so the same text is what it sees.
    expect(String(localCall.state.output)).toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(localCall.sent).toBe(localCall.state.output);
  });

  it("carries no probe secret from a real fixture's poisoned output", () => {
    const fixture = {
      output:
        "Running 9 tests using 2 workers\n  1) [chromium] › e2e/deploy.spec.ts:11:3 › deploy › reaches the staging host\n     Error: connect ECONNREFUSED 10.0.0.4:443\n" +
        "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789\nDATABASE_URL=postgres://awui:hunter2@db.internal:5432/awui\nOPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD\n" +
        "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz\n-----END OPENSSH PRIVATE KEY-----\n",
    };
    const sent = wire(buildEgressState(item(fixture), identity, true).state);
    for (const probe of SECRET_PROBES) expect(sent).not.toContain(probe);
  });
});
