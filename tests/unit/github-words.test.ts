import { describe, expect, it } from "vitest";
import { checkFailed, checkTally, checkWords, layerWord, mergeable, mergeNotes, prNumberOf, upstreamWords } from "../../src/shared/github-words.js";

import type { PrStackLayer } from "../../src/shared/protocol.js";

const check = (name: string, state: string) => ({ name, state, link: null });
const layer = (state: string): PrStackLayer => ({ pr: 1, url: "", title: "", state, baseBranch: "main", headBranch: "t", checks: [] });

describe("github words", () => {
  it("counts what passed and names what failed", () => {
    const tally = checkTally([check("build", "pass"), check("lint", "fail"), check("deploy", "failure"), check("e2e", "cancel"), check("docs", "pending")]);
    expect(tally).toEqual({ pass: 1, fail: 3, total: 5, failing: ["lint", "deploy", "e2e"] });
    expect(checkWords([check("build", "pass"), check("lint", "fail")])).toBe("1/2 checks passing · failing: lint");
    expect(checkWords([check("build", "pass")])).toBe("1/1 checks passing");
    expect(checkWords([])).toBe("No reported checks are available for the current PR.");
    expect(checkFailed("pending")).toBe(false);
  });

  it("reads a PR number from its URL", () => {
    expect(prNumberOf("https://github.com/acme/repo/pull/42")).toBe(42);
    expect(prNumberOf("https://github.com/acme/repo/pull/42/files")).toBeNull();
    expect(prNumberOf("")).toBeNull();
  });

  it("words the branch's distance from its upstream", () => {
    expect(upstreamWords({ upstream: null, ahead: 0 })).toContain("No upstream yet");
    expect(upstreamWords({ upstream: "origin/main", ahead: 0 })).toBe("Everything recorded on the upstream branch.");
    expect(upstreamWords({ upstream: "origin/main", ahead: 1 })).toBe("1 local commit not on upstream.");
    expect(upstreamWords({ upstream: "origin/main", ahead: 3 })).toBe("3 local commits not on upstream.");
  });

  it("words a layer's state and whether a stack can still merge", () => {
    expect(layerWord("OPEN")).toBe("open");
    expect(layerWord("MERGED")).toBe("merged");
    expect(layerWord("UNKNOWN")).toBe("unknown");
    expect(mergeable({ id: "s", workspaceId: "w", workspaceName: "w", createdAt: 0, base: "main", layers: [] })).toBe(false);
    expect(mergeable({ id: "s", workspaceId: "w", workspaceName: "w", createdAt: 0, base: "main", layers: [layer("MERGED")] })).toBe(false);
    expect(mergeable({ id: "s", workspaceId: "w", workspaceName: "w", createdAt: 0, base: "main", layers: [layer("OPEN")] })).toBe(true);
    expect(mergeNotes({ refusal: { pr: 7, message: "not mergeable" }, archiveRefusals: [{ pr: 8, message: "dirty tree" }] })).toBe(
      "#7 could not be merged: not mergeable · #8's checkout could not be archived: dirty tree",
    );
    expect(mergeNotes({ refusal: null, archiveRefusals: [] })).toBe("");
  });
});
