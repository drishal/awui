// platform-win.ts's pure pieces: cmd quoting and the win32 spawn resolution.
// These run on any host (they take no process.platform branch of their own),
// so they pin the Windows behaviour without needing a Windows runner.
import { describe, expect, it } from "vitest";
import { applyPerChatToolEnv, cmdArg, cmdCommand, PER_CHAT_ENV_KEYS, resolveWin } from "../../src/server/platform-win.js";

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

describe("applyPerChatToolEnv", () => {
  const ambient = {
    AWUI_RENDER_URL: "http://127.0.0.1:4783/api/render",
    AWUI_RENDER_TOKEN: "ambient-render",
    AWUI_ORCH_URL: "http://127.0.0.1:4783/api/orchestration",
    AWUI_ORCH_TOKEN: "ambient-orch",
    PATH: "/usr/bin",
  };

  it("names exactly the four per-chat credentials", () => {
    expect([...PER_CHAT_ENV_KEYS]).toEqual(["AWUI_RENDER_TOKEN", "AWUI_RENDER_URL", "AWUI_ORCH_TOKEN", "AWUI_ORCH_URL"]);
  });

  it("keeps the chat's own values and removes every inherited one it was not given", () => {
    const env = applyPerChatToolEnv({ ...ambient }, { AWUI_ORCH_URL: "http://127.0.0.1:4796/api/orchestration", AWUI_ORCH_TOKEN: "chat-orch" });
    expect(env).toMatchObject({ PATH: "/usr/bin", AWUI_ORCH_URL: "http://127.0.0.1:4796/api/orchestration", AWUI_ORCH_TOKEN: "chat-orch" });
    // The render pair the chat did not get is gone, not inherited from the server's shell.
    expect(env).not.toHaveProperty("AWUI_RENDER_URL");
    expect(env).not.toHaveProperty("AWUI_RENDER_TOKEN");
  });

  it("removes all four when a chat has no tools, and mutates the environment it is given", () => {
    const env = { ...ambient };
    expect(applyPerChatToolEnv(env)).toBe(env);
    for (const key of PER_CHAT_ENV_KEYS) expect(env).not.toHaveProperty(key);
    expect(env.PATH).toBe("/usr/bin");
  });
});
