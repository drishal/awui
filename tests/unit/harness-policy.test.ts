// The client's capability-driven policy (src/web/harness-policy.ts): a
// projectless surface, read from what the adapter declares.
import { describe, expect, it } from "vitest";
import { projectScoped } from "../../src/web/harness-policy.js";

const h = (id: string, supportsProjectFolders: boolean) => ({ id, capabilities: { supportsProjectFolders, webOnly: false } });

describe("projectScoped", () => {
  it("reads what the harness declares", () => {
    expect(projectScoped([h("pi", true)], "pi")).toBe(true);
    expect(projectScoped([h("awui", false)], "awui")).toBe(false);
  });
  it("treats an unknown harness as project-scoped", () => {
    expect(projectScoped([], "pi")).toBe(true);
    expect(projectScoped([h("pi", true)], "awui")).toBe(true);
  });
});
