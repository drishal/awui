// platform-win.ts's pure pieces: cmd quoting and the win32 spawn resolution.
// These run on any host (they take no process.platform branch of their own),
// so they pin the Windows behaviour without needing a Windows runner.
import { describe, expect, it } from "vitest";
import { cmdArg, cmdCommand, resolveWin } from "../../src/server/platform-win.js";

describe("cmd escaping", () => {
  it("caret-escapes the shim's path, spaces included, without quoting it", () => {
    expect(cmdCommand("C:\\Users\\Jo Doe\\npm\\pi.cmd")).toBe("C:\\Users\\Jo^ Doe\\npm\\pi.cmd");
    expect(cmdCommand("C:\\a&b (x)\\pi.cmd")).toBe("C:\\a^&b^ ^(x^)\\pi.cmd");
  });
  it("quotes each argument for node.exe, then escapes it twice for cmd (the line, and the shim's %*)", () => {
    expect(cmdArg("--mode")).toBe('^^^"--mode^^^"');
    // An inner quote is \" for the C runtime; cmd sees every character escaped.
    expect(cmdArg('say "hi"')).toBe('^^^"say^^^ \\^^^"hi\\^^^"^^^"');
    // %VAR% expands inside quotes in cmd, so it is escaped like any other metacharacter.
    expect(cmdArg("%PATH%&calc")).toBe('^^^"^^^%PATH^^^%^^^&calc^^^"');
    // Backslashes before the closing quote are doubled, or they would escape it.
    expect(cmdArg("C:\\dir\\")).toBe('^^^"C:\\dir\\\\^^^"');
    expect(cmdArg("")).toBe('^^^"^^^"');
  });
});

describe("resolveWin", () => {
  it("wraps an explicit .cmd path in cmd /d /s /c", () => {
    const [argv0, prefix] = resolveWin("C:\\tools\\pi.cmd", ["--mode", "rpc"]);
    expect(argv0.toLowerCase()).toContain("cmd");
    // /s strips the outer quotes and runs the escaped line inside as it is.
    expect(prefix).toEqual(["/d", "/s", "/c", '"C:\\tools\\pi.cmd ^^^"--mode^^^" ^^^"rpc^^^""']);
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
