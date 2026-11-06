import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../../src/server/run-command.js";
import { runnable } from "../../src/web/code-blocks.js";
import { makeTestApp, signedIn, tempDir } from "../helpers/app.js";

describe("running a shell code block", () => {
  it("takes one-line blocks in a shell it knows, without a leading $", () => {
    expect(runnable("bash", "$ npm test\n")).toEqual({ shell: "bash", command: "npm test" });
    expect(runnable("console", "ls -la")).toEqual({ shell: "sh", command: "ls -la" });
    expect(runnable("fish", "set -x A 1")).toEqual({ shell: "fish", command: "set -x A 1" });
    expect(runnable("bash", "cd a\nmake")).toBeNull();
    expect(runnable("python", "print(1)")).toBeNull();
    expect(runnable(null, "ls")).toBeNull();
    expect(runnable("bash", "   ")).toBeNull();
  });

  it("runs in the folder it is given and reports the exit code and output", async () => {
    const dir = tempDir("awui-run-");
    const ok = await runCommand("pwd; echo out; echo err >&2", "sh", dir);
    expect(ok.exitCode).toBe(0);
    expect(ok.output.split("\n").filter(Boolean)).toEqual([realpathSync(dir), "out", "err"]);
    const failed = await runCommand("exit 3", "sh", dir);
    expect(failed.exitCode).toBe(3);
    const long = await runCommand("head -c 200000 /dev/zero | tr '\\0' a", "sh", dir);
    expect(long.truncated).toBe(true);
    expect(long.output.length).toBe(100_000);
    // A character split across two writes comes out whole.
    const split = await runCommand("printf '\\342\\202'; sleep 0.05; printf '\\254 ok'", "sh", dir);
    expect(split.output).toBe("€ ok");
  });

  it("runs with its project's full direnv environment", async () => {
    const dir = tempDir("awui-run-direnv-");
    const tools = path.join(dir, "tools");
    mkdirSync(tools);
    writeFileSync(path.join(tools, "cargo"), "#!/bin/sh\nprintf 'nightly cargo\\n'\n", { mode: 0o755 });
    writeFileSync(path.join(dir, ".envrc"), `export PATH=${JSON.stringify(tools)}:$PATH\nexport DEVENV_ROOT=${JSON.stringify(dir)}\n`);
    execFileSync("direnv", ["allow"], { cwd: dir });
    const result = await runCommand('printf \'%s\\n\' "$DEVENV_ROOT"; cargo', "sh", dir);
    expect(result.output.trimEnd().split("\n")).toEqual([dir, "nightly cargo"]);
  });

  it("runs over HTTP in the chat's project, one line only", async () => {
    const t = await makeTestApp();
    try {
      const agent = await signedIn(t);
      const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
      const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as { chatId: string };
      const res = (await agent.post(`/api/chats/${chat.chatId}/run`).send({ command: 'basename "$PWD"', shell: "bash" }).expect(200)).body;
      expect(res).toMatchObject({ exitCode: 0, output: "proj\n", timedOut: false });
      await agent.post(`/api/chats/${chat.chatId}/run`).send({ command: "echo a\necho b" }).expect(400);
    } finally {
      await t.close();
    }
  });
});
