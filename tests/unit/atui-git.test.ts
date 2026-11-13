import { describe, expect, it } from "vitest";
import type { GitFile, GitStatus } from "../../src/shared/protocol.js";
import { countsWords, firstStop, gitRows, moveCursor, moveGroup, rowWords, stageAction } from "../../src/atui/git.js";
import { branchWords, commitWords, countsLine, stateTone, syncWordsOf } from "../../src/shared/git-words.js";

const file = (path: string, over: Partial<GitFile> = {}): GitFile => ({ path, staged: null, unstaged: null, added: null, removed: null, ...over });

const status = (files: GitFile[], over: Partial<GitStatus> = {}): GitStatus => ({
  root: "/p",
  branch: "main",
  head: "abc1234",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  operation: null,
  lastCommit: null,
  stashes: 0,
  files,
  more: 0,
  counts: { staged: 0, changed: 0, untracked: 0, conflicts: 0 },
  added: 0,
  removed: 0,
  ...over,
});

const kinds = (rows: ReturnType<typeof gitRows>) => rows.map((r) => (r.kind === "group" ? `g:${r.group}:${r.count}` : `f:${r.entry.file.path}@${r.entry.side}`));
const files = (rows: ReturnType<typeof gitRows>) => rows.filter((r): r is Extract<typeof r, { kind: "file" }> => r.kind === "file");

describe("the git panel's rows", () => {
  it("lays the groups out with their headings, a file under each side it is changed on", () => {
    const rows = gitRows(
      status([
        file("conflict.ts", { staged: "conflict", unstaged: "conflict" }),
        file("a.ts", { staged: "modified", unstaged: "modified", stagedLines: { added: 2, removed: 1 }, unstagedLines: { added: 1, removed: 0 } }),
        file("new.ts", { unstaged: "untracked" }),
      ]),
    );
    expect(kinds(rows)).toEqual([
      "g:conflicts:1",
      "f:conflict.ts@unstaged",
      "g:staged:1",
      "f:a.ts@staged",
      "g:changed:1",
      "f:a.ts@unstaged",
      "g:untracked:1",
      "f:new.ts@untracked",
    ]);
    expect(gitRows(status([]))).toEqual([]);
  });

  it("moves the cursor over files only, and a group at a time", () => {
    const rows = gitRows(
      status([
        file("a.ts", { staged: "modified" }),
        file("b.ts", { unstaged: "modified" }),
        file("c.ts", { unstaged: "untracked" }),
      ]),
    );
    expect(firstStop(rows)).toBe(1);
    expect(moveCursor(rows, 1, 1)).toBe(3);
    expect(moveCursor(rows, 5, 1)).toBe(5);
    expect(moveCursor(rows, 1, -1)).toBe(1);
    // Groups: staged → changed → untracked, and back.
    expect(moveGroup(rows, 1, 1)).toBe(3);
    expect(moveGroup(rows, 3, 1)).toBe(5);
    expect(moveGroup(rows, 5, 1)).toBe(5);
    expect(moveGroup(rows, 5, -1)).toBe(3);
    expect(moveGroup(rows, 1, -1)).toBe(1);
  });

  it("words the header: sync, counts", () => {
    expect(syncWordsOf(status([]))).toBe("even");
    expect(syncWordsOf(status([], { ahead: 2 }))).toBe("↑2");
    expect(syncWordsOf(status([], { behind: 1 }))).toBe("↓1");
    expect(syncWordsOf(status([], { ahead: 2, behind: 1 }))).toBe("↑2 ↓1");
    expect(syncWordsOf(status([], { upstream: null }))).toBe("not pushed");
    expect(countsWords(status([], { counts: { staged: 2, changed: 1, untracked: 1, conflicts: 0 } }))).toEqual(["2 staged", "1 changed", "1 untracked"]);
    expect(countsWords(status([], { counts: { staged: 0, changed: 0, untracked: 0, conflicts: 3 } }))).toEqual(["3 conflicted"]);
  });

  it("words a file row: letter, path with a rename's source, lines, and the note when there are none", () => {
    const rows = gitRows(
      status([
        file("new.ts", { from: "old.ts", staged: "renamed", stagedLines: { added: 0, removed: 0 } }),
        file("a.ts", { unstaged: "modified", unstagedLines: { added: 3, removed: 1 } }),
        file("blob.png", { unstaged: "modified", unstagedLines: { added: null, removed: null } }),
        file("added.ts", { unstaged: "untracked" }),
      ]),
    );
    expect(rowWords(files(rows)[0]!)).toEqual({ letter: "R", path: "old.ts → new.ts", added: "+0", removed: "−0", note: "" });
    expect(rowWords(files(rows)[1]!)).toEqual({ letter: "M", path: "a.ts", added: "+3", removed: "−1", note: "" });
    expect(rowWords(files(rows)[2]!)).toEqual({ letter: "M", path: "blob.png", added: "", removed: "", note: "binary" });
    expect(rowWords(files(rows)[3]!)).toEqual({ letter: "U", path: "added.ts", added: "", removed: "", note: "new" });
  });

  it("stages what the index does not have and unstages what it does", () => {
    const rows = gitRows(
      status([
        file("a.ts", { staged: "modified" }),
        file("b.ts", { unstaged: "modified" }),
        file("c.ts", { unstaged: "untracked" }),
      ]),
    );
    expect(stageAction(files(rows)[0]!)).toBe("unstage");
    expect(stageAction(files(rows)[1]!)).toBe("stage");
    expect(stageAction(files(rows)[2]!)).toBe("stage");
  });
});

describe("the shared git words", () => {
  it("tones every file state: work the index lacks warn, new ok, deletes danger, renames info", () => {
    expect(stateTone("modified")).toBe("warn");
    expect(stateTone("typechange")).toBe("warn");
    expect(stateTone("added")).toBe("ok");
    expect(stateTone("copied")).toBe("ok");
    expect(stateTone("untracked")).toBe("ok");
    expect(stateTone("deleted")).toBe("danger");
    expect(stateTone("conflict")).toBe("danger");
    expect(stateTone("renamed")).toBe("info");
  });

  it("words the branch, its sync, the counts, and the last commit alike on every surface", () => {
    expect(branchWords({ branch: "main", head: "abc1234" })).toBe("main");
    expect(branchWords({ branch: null, head: "abc1234" })).toBe("detached at abc1234");
    expect(countsLine({ files: [], counts: { staged: 0, changed: 0, untracked: 0, conflicts: 0 } })).toBe("clean");
    expect(countsLine({ files: [{} as GitFile], counts: { staged: 1, changed: 4, untracked: 2, conflicts: 0 } })).toBe("1 staged · 4 changed · 2 new");
    expect(countsLine({ files: [{} as GitFile], counts: { staged: 0, changed: 1, untracked: 0, conflicts: 1 } })).toBe("1 conflict · 1 changed");
    const at = Date.now() - 4 * 60_000;
    expect(commitWords({ subject: "init", author: "t", at }, Date.now())).toBe("init · by t · 4m ago");
  });
});
