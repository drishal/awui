// platform-win.ts's pure pieces: cmd quoting and the win32 spawn resolution.
// These run on any host (they take no process.platform branch of their own),
// so they pin the Windows behaviour without needing a Windows runner.
import { describe, expect, it } from "vitest";
import { cmdWord, resolveWin } from "../../src/server/platform-win.js";

describe("cmdWord", () => {
  it("leaves plain words bare", () => {
    expect(cmdWord("pi")).toBe("pi");
    expect(cmdWord("--mode")).toBe("--mode");
  });
  it("quotes words with spaces or cmd metacharacters", () => {
    expect(cmdWord("C:\\Program Files\\pi\\pi.cmd")).toBe('"C:\\Program Files\\pi\\pi.cmd"');
    expect(cmdWord("a&b")).toBe('"a&b"');
    expect(cmdWord("")).toBe('""');
  });
  it("escapes embedded double quotes", () => {
    expect(cmdWord('say "hi"')).toBe('"say \\"hi\\""');
  });
});

describe("resolveWin", () => {
  it("wraps an explicit .cmd path in cmd /d /s /c", () => {
    const [argv0, prefix] = resolveWin("C:\\tools\\pi.cmd", ["--mode", "rpc"]);
    expect(argv0.toLowerCase()).toContain("cmd");
    expect(prefix.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(prefix[3]).toContain("pi.cmd");
    expect(prefix[3]).toContain("--mode");
  });
  it("leaves an explicit .exe path alone", () => {
    expect(resolveWin("C:\\tools\\omp.exe", ["--mode", "rpc-ui"])).toEqual(["C:\\tools\\omp.exe", []]);
  });
  it("leaves a native .exe bare name to the caller (no shim search hit)", () => {
    // With no .cmd on this host's PATH, the bare name passes through unchanged.
    const [argv0, prefix] = resolveWin("definitely-not-a-real-cmd-xyz", ["--version"]);
    expect(prefix).toEqual([]);
    expect(argv0).toBe("definitely-not-a-real-cmd-xyz");
  });
});
