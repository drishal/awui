// The start screen's pure decisions (src/web/start-screen.ts).
import { describe, expect, it } from "vitest";
import { recentForChip, startAction, startExamples, startHeading, startSendBlocked, type StartSetup } from "../../src/web/start-screen.js";

const FAKE = { id: "fake", displayName: "Fake", available: true, reason: null };
const FAKE_B = { id: "fake-b", displayName: "Fake B", available: false, reason: "fake-b is not installed." };
const AWUI = { id: "awui", displayName: "Awui", available: true, reason: null, capabilities: { supportsProjectFolders: false, webOnly: true } };

const setup = (over: Partial<StartSetup> = {}): StartSetup => ({
  harnesses: [FAKE, FAKE_B],
  harnessId: "fake",
  workspaceName: "alpha",
  draft: "hello",
  images: 0,
  busy: false,
  ...over,
});

describe("startHeading", () => {
  it("names the harness and the folder", () => {
    const h = startHeading(setup());
    expect(h.title).toBe("What should Fake do in alpha?");
    expect(h.before).toBe("What should Fake do in ");
    expect(h.project).toBe("alpha");
    expect(h.after).toBe("?");
  });
  it("asks what to work on when no folder is chosen", () => {
    const h = startHeading(setup({ workspaceName: null }));
    expect(h.title).toBe("What should Fake work on?");
    expect(h.project).toBeNull();
  });
  it("asks anything on the Awui harness, with no folder", () => {
    const h = startHeading(setup({ harnesses: [AWUI], harnessId: "awui", workspaceName: "home" }));
    expect(h.title).toBe("Ask anything");
    expect(h.project).toBeNull();
  });
});

describe("startSendBlocked", () => {
  it("lets a draft through when all is set", () => {
    expect(startSendBlocked(setup())).toBeNull();
  });
  it("lets images through with an empty draft", () => {
    expect(startSendBlocked(setup({ draft: "  ", images: 2 }))).toBeNull();
  });
  it("says what is missing", () => {
    expect(startSendBlocked(setup({ draft: "" }))).toBe("Type a message first");
    expect(startSendBlocked(setup({ harnesses: [FAKE_B], harnessId: "fake-b" }))).toBe("fake-b is not installed.");
    expect(startSendBlocked(setup({ harnesses: [], harnessId: null }))).toBe("No harness is available.");
    expect(startSendBlocked(setup({ busy: true }))).toBe("Starting the chat…");
  });
});

describe("startAction", () => {
  it("sends when the setup is complete", () => {
    expect(startAction(setup())).toEqual({ kind: "send" });
  });
  it("asks for a folder before sending, keeping the draft", () => {
    expect(startAction(setup({ workspaceName: null }))).toEqual({ kind: "pick-folder" });
  });
  it("does not need a folder on the Awui harness", () => {
    expect(startAction(setup({ harnesses: [AWUI], harnessId: "awui", workspaceName: null }))).toEqual({ kind: "send" });
  });
  it("sends attached images with the first message", () => {
    expect(startAction(setup({ draft: "", images: 1 }))).toEqual({ kind: "send" });
    expect(startAction(setup({ draft: "with pictures", images: 1 }))).toEqual({ kind: "send" });
  });
  it("reports a block", () => {
    expect(startAction(setup({ draft: "" }))).toEqual({ kind: "blocked", reason: "Type a message first" });
  });
});

describe("recentForChip", () => {
  const recent = ["/a/one", "/a/two", "/a/three", "/a/four", "/a/five", "/a/six", "/a/seven", "/a/eight"];
  it("is newest first, at most six, without the chosen folder", () => {
    expect(recentForChip(recent, "/a/three")).toEqual(["/a/one", "/a/two", "/a/four", "/a/five", "/a/six", "/a/seven"]);
  });
  it("is empty for an empty list", () => {
    expect(recentForChip([], "/a/one")).toEqual([]);
  });

describe("startExamples", () => {
  it("suggests three things the chosen agent can do", () => {
    const coding = startExamples("pi");
    expect(coding).toHaveLength(3);
    expect(coding.every((line) => line.length > 10)).toBe(true);
    // The read-only harness is not told to edit anything.
    expect(startExamples("awui").join(" ")).not.toMatch(/edit|fix|test/i);
    expect(startExamples("awui")).not.toEqual(coding);
  });
});
});
