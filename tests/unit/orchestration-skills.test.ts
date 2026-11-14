// The orchestration skills: three plain markdown files an agent in any harness can follow with
// nothing but the orchestration tools, the route that serves the same words as MCP prompts, and
// the binary's asset list that must carry them so a compiled awui still has prompts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatSnapshot, WorkspaceInfo } from "../../src/shared/protocol.js";
import { ORCH_SKILL_NAMES, orchestrationSkills } from "../../src/server/orchestration/skills.js";
import { ORCH_INSTRUCTIONS } from "../../src/server/orchestration/tools.js";
import { makeTestApp, signedIn, type TestApp } from "../helpers/app.js";

const root = path.join(import.meta.dirname, "..", "..");

/** The skill file's instructions with its frontmatter removed, the way the server serves them. */
function bodyOf(name: string): string {
  return readFileSync(path.join(root, "skills", name, "SKILL.md"), "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "").trim();
}

/** The tools each skill tells an agent to call, spelled as the catalogue spells them. */
const TOOLS: Record<string, string[]> = {
  council: ["list_profiles", "delegate_task", "thread_wait", "task_status", "thread_read", "thread_send", "task_cancel"],
  advisor: ["list_profiles", "delegate_task", "thread_wait", "task_status", "thread_read"],
  handoff: ["task_status", "thread_read", "delegate_task", "list_profiles"],
};

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

describe("the orchestration skills", () => {
  it("opens each file with frontmatter that names it and says what it is for", () => {
    for (const name of ORCH_SKILL_NAMES) {
      const source = readFileSync(path.join(root, "skills", name, "SKILL.md"), "utf8");
      expect(source.startsWith("---\n")).toBe(true);
      expect(source).toContain(`\nname: ${name}\n`);
      expect(source).toMatch(/\ndescription: .{40,}/);
    }
  });

  it("names the tools it tells an agent to call, and reads as instructions", async () => {
    const skills = await orchestrationSkills();
    expect(skills.map((skill) => skill.name)).toEqual([...ORCH_SKILL_NAMES]);
    for (const skill of skills) {
      expect(skill.description.length).toBeGreaterThan(40);
      expect(skill.text.length).toBeGreaterThan(800);
      expect(skill.text.startsWith("---")).toBe(false);
      for (const tool of TOOLS[skill.name] ?? []) expect(skill.text).toContain(`\`${tool}\``);
    }
  });

  it("caps the council at two rounds and holds every reviewer to review-only", async () => {
    const council = (await orchestrationSkills()).find((skill) => skill.name === "council");
    if (!council) throw new Error("no council skill");
    expect(council.text).toContain("never a third round");
    expect(council.text).toContain("Review only: change nothing");
    expect(council.text).toContain("Do not delegate and do not spawn subagents.");
    // All three reviewers start in one turn, and a missing score is reported, never invented.
    expect(council.text).toContain("in the same turn");
    expect(council.text).toContain("no score");
    expect(council.text).toContain("clientRequestId");
    expect(council.text).toContain('role: "review"');
  });

  it("makes the advisor's brief end with the review-only line, and the handoff zero-context", async () => {
    const skills = await orchestrationSkills();
    const advisor = skills.find((skill) => skill.name === "advisor");
    const handoff = skills.find((skill) => skill.name === "handoff");
    if (!advisor || !handoff) throw new Error("a skill is missing");
    expect(advisor.text).toContain("Review only. Change nothing.");
    expect(advisor.text).toContain("task_status");
    expect(handoff.text).toContain("zero-context");
    expect(handoff.text).toContain("**Next steps**");
  });

  it("serves the three prompts, in the file's own words, to a live chat's child only", async () => {
    const app = await makeTestApp({});
    t = app;
    const agent = await signedIn(app);
    const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body as WorkspaceInfo;
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const token = app.manager.list().find((c) => c.chatId === chat.chatId)?.orchestration?.token;
    if (!token) throw new Error("the chat was spawned without an orchestration token");

    const res = await agent.get("/api/orchestration/prompts").set("x-awui-orch-token", token);
    expect(res.status).toBe(200);
    const prompts = res.body.prompts as Array<{ name: string; description: string; text: string }>;
    expect(prompts.map((prompt) => prompt.name)).toEqual([...ORCH_SKILL_NAMES]);
    // The prompt is the file: frontmatter stripped, nothing rewritten in between.
    for (const prompt of prompts) {
      expect(prompt.text).toBe(bodyOf(prompt.name));
      expect(prompt.description.length).toBeGreaterThan(40);
    }

    // `?name=` narrows it to one skill (Pi and omp read theirs with curl); an unknown name says what exists.
    const one = await agent.get("/api/orchestration/prompts?name=council").set("x-awui-orch-token", token);
    expect((one.body.prompts as Array<{ name: string }>).map((prompt) => prompt.name)).toEqual(["council"]);
    const unknown = await agent.get("/api/orchestration/prompts?name=nope").set("x-awui-orch-token", token);
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toContain("council, advisor, handoff");

    // Same rule as the catalogue: no token, no prompts, and never another chat's.
    const absent = await agent.get("/api/orchestration/prompts");
    expect(absent.status).toBe(401);
    expect(absent.body.code).toBe("bad_orch_token");
    expect((await agent.get("/api/orchestration/prompts").set("x-awui-orch-token", "0".repeat(32))).status).toBe(401);
  });

  it("tells every harness about each skill by name, inside Codex's 4,000-byte limit", () => {
    expect(Buffer.byteLength(ORCH_INSTRUCTIONS)).toBeLessThan(4000);
    for (const name of ORCH_SKILL_NAMES) expect(ORCH_INSTRUCTIONS).toContain(`- ${name}: `);
    expect(ORCH_INSTRUCTIONS).toContain("/prompts?name=");
  });

  it("builds every served skill into the binary's assets", () => {
    const build = readFileSync(path.join(root, "scripts", "build-binary.ts"), "utf8");
    const listed = /const SKILLS = (\[[^\]]*\]);/.exec(build);
    if (!listed?.[1]) throw new Error("scripts/build-binary.ts no longer lists its skills");
    // One list, two readers: a skill the server serves but the build skips would be missing
    // from every compiled awui's prompts, and no test would notice until a release.
    expect(JSON.parse(listed[1])).toEqual([...ORCH_SKILL_NAMES]);
    expect(build).toContain('path.join(root, "skills", name, "SKILL.md")');
  });
});
