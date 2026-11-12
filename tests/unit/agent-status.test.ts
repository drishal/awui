// The status line an agent sets for itself: bounded text, one line per session, the
// newest few hundred kept, and the words the clients draw.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_STATUS_WORDS, agentStatusText } from "../../src/web/agent-status.js";
import { AgentStatuses, asStatusState, cleanComment, MAX_STATUS_CHARS, MAX_STATUS_ENTRIES } from "../../src/server/agent-status.js";

const tempFile = () => path.join(mkdtempSync(path.join(tmpdir(), "awui-status-")), "agent-status.json");

describe("an agent's status line", () => {
  it("collapses the comment to one line and cuts it at the cap", () => {
    expect(cleanComment("  blocked on\n  the flaky   test ")).toBe("blocked on the flaky test");
    const long = cleanComment("x".repeat(MAX_STATUS_CHARS + 50));
    expect(long).toHaveLength(MAX_STATUS_CHARS);
    expect(long.endsWith("…")).toBe(true);
    expect(cleanComment("")).toBe("");
  });

  it("reads only the states the tool offers", () => {
    expect(asStatusState("blocked")).toBe("blocked");
    expect(asStatusState("waiting")).toBeNull();
    expect(asStatusState(2)).toBeNull();
  });

  it("keeps one line per session, newest write winning, and saves them", async () => {
    const file = tempFile();
    const store = await AgentStatuses.open(file);
    expect(store.get("pi:a")).toBeUndefined();
    const first = await store.set("pi:a", "working", "reading the parser");
    expect(first.state).toBe("working");
    expect(store.get("pi:a")).toEqual(first);
    await store.set("pi:a", "blocked", "waiting on CI");
    expect(store.get("pi:a")?.state).toBe("blocked");
    await new Promise((resolve) => setTimeout(resolve, 10));
    // A new process reads the same lines back.
    const reopened = await AgentStatuses.open(file);
    expect(reopened.get("pi:a")).toEqual({ state: "blocked", comment: "waiting on CI", at: store.get("pi:a")?.at });
    // The file is plain JSON of the same shape, and nothing else lives in it.
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual(["pi:a"]);
  });

  it("drops the oldest lines past the cap, and ignores a malformed file entry", async () => {
    const file = tempFile();
    // A full file, oldest first, with an entry this build cannot read at the front.
    const full: Record<string, unknown> = { "pi:gone": { state: "walking", comment: "", at: 1 } };
    for (let i = 0; i < MAX_STATUS_ENTRIES; i++) full[`pi:s${i}`] = { state: "done", comment: "", at: 2 };
    writeFileSync(file, JSON.stringify(full));
    const store = await AgentStatuses.open(file);
    expect(store.get("pi:gone")).toBeUndefined();
    expect(store.get("pi:s0")?.state).toBe("done");
    // Three new lines push the oldest three out (the malformed entry never counted).
    for (let i = 0; i < 3; i++) await store.set(`pi:new${i}`, "working", "");
    expect(store.get("pi:s0")).toBeUndefined();
    expect(store.get("pi:s3")?.state).toBe("done");
    expect(store.get("pi:new2")?.state).toBe("working");
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)).toHaveLength(MAX_STATUS_ENTRIES);
  });

  it("says the state in words, then the agent's own sentence", () => {
    expect(AGENT_STATUS_WORDS.review).toBe("ready for review");
    expect(agentStatusText({ state: "blocked", comment: "waiting on CI", at: 1 })).toBe("blocked · waiting on CI");
    expect(agentStatusText({ state: "done", comment: "", at: 1 })).toBe("done");
  });
});
