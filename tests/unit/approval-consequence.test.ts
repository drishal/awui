// The approval card's consequence line (approval-consequence.ts): what a harness's title says it is about to do.
import { describe, expect, it } from "vitest";
import { approvalConsequence } from "../../src/web/approval-consequence.js";

describe("what approving does", () => {
  it("reads the tool a harness names in its own title", () => {
    expect(approvalConsequence("Allow tool: read")).toBe("Reads files in this project");
    expect(approvalConsequence("Allow tool: bash")).toBe("Runs a command in this project");
    expect(approvalConsequence("Allow Bash?")).toBe("Runs a command in this project");
    expect(approvalConsequence("Allow Edit?")).toBe("Changes files in this project");
    expect(approvalConsequence("Allow WebFetch?")).toBe("Reaches the network from this machine");
    expect(approvalConsequence("Allow Open?")).toBe("Reads files in this project");
    expect(approvalConsequence("Run this command?")).toBe("Runs a command in this project");
    expect(approvalConsequence("Apply these file changes?")).toBe("Changes files in this project");
  });

  it("reads a compound tool name by its first word", () => {
    expect(approvalConsequence("Allow web_fetch?")).toBe("Reaches the network from this machine");
    expect(approvalConsequence("Allow read_file?")).toBe("Reads files in this project");
    expect(approvalConsequence("Allow write_file?")).toBe("Changes files in this project");
  });

  it("says nothing when the title names no kind of action", () => {
    // An agent's own wording, or a tool this cannot place: a guessed consequence is worse than none.
    expect(approvalConsequence("Allow this?")).toBeNull();
    expect(approvalConsequence("")).toBeNull();
    expect(approvalConsequence("Check the deploy status")).toBeNull();
    expect(approvalConsequence("Allow Tracker?")).toBeNull();
    // A word that merely starts with a known one is not that action.
    expect(approvalConsequence("Allow Ready?")).toBeNull();
    expect(approvalConsequence("Allow rmdir?")).toBeNull();
  });
});
