// The three orchestration skills: council, advisor, handoff. Each is a plain markdown file
// under skills/ at the repo root, written so an agent in any harness can read it and follow it
// with nothing but the orchestration tools. The same text is what the MCP bridge offers as a
// prompt (extensions/orchestrate-mcp.mjs fetches GET /api/orchestration/prompts), so the file
// and the prompt cannot drift — this module is the one place that reads them. The binary has
// no skills/ folder on disk, so its build embeds the same three files (embedded.ts), and the
// read falls through to that map.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { embeddedSkillSource } from "../embedded.js";

/** The skills awui serves, by the directory that holds each SKILL.md; the prompt name too. */
export const ORCH_SKILL_NAMES = ["council", "advisor", "handoff"] as const;

export type OrchestrationSkillName = (typeof ORCH_SKILL_NAMES)[number];

/** One skill as the bridge and the MCP prompt need it: a name, what it is for, and its words. */
export interface OrchestrationSkill {
  /** The prompt name, also the skill's directory: `council`. */
  name: OrchestrationSkillName;
  /** The frontmatter description, shown as the prompt's description. */
  description: string;
  /** The instructions, frontmatter stripped: the text the agent is given. */
  text: string;
}

let cached: OrchestrationSkill[] | null = null;

/**
 * The three skills, read once per process. A missing or malformed file rejects rather than
 * answering an empty prompt list: a binary that silently dropped its skills would look like a
 * client that does not show prompts, and that is exactly the failure to not have.
 */
export async function orchestrationSkills(): Promise<OrchestrationSkill[]> {
  if (cached) return cached;
  const skills = await Promise.all(ORCH_SKILL_NAMES.map(readSkill));
  cached = skills;
  return skills;
}

async function readSkill(name: OrchestrationSkillName): Promise<OrchestrationSkill> {
  const source = embeddedSkillSource(name) ?? (await readSkillFile(name));
  const { meta, body } = splitFrontmatter(source);
  if (meta.name !== name) throw new Error(`skills/${name}/SKILL.md names itself ${JSON.stringify(meta.name)}; the directory is the name`);
  const description = typeof meta.description === "string" ? meta.description.trim() : "";
  if (description === "") throw new Error(`skills/${name}/SKILL.md has no description in its frontmatter`);
  if (body === "") throw new Error(`skills/${name}/SKILL.md has no instructions below its frontmatter`);
  return { name, description, text: body };
}

/** The skill file from the repo, walking up from this module: dist/server/... has no skills/ beside it. */
async function readSkillFile(name: string): Promise<string> {
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    const file = path.join(dir, "skills", name, "SKILL.md");
    const source = await readFile(file, "utf8").catch(() => null);
    if (source !== null) return source;
    if (path.dirname(dir) === dir) throw new Error(`skills/${name}/SKILL.md was not found, and this build carries no embedded copy`);
  }
}

/** The frontmatter block and the instructions below it: a skill file must open with one. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function splitFrontmatter(source: string): { meta: Record<string, unknown>; body: string } {
  const match = FRONTMATTER.exec(source);
  if (!match) throw new Error("a skill file must open with a --- frontmatter block");
  const parsed: unknown = parse(match[1] ?? "");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("a skill's frontmatter must be a mapping");
  return { meta: parsed as Record<string, unknown>, body: source.slice(match[0].length).trim() };
}
