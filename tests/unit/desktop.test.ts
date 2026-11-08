// The desktop shell's decisions, which must hold without a window: what
// /api/health means, whether to attach to a running server or start one, and
// the page a menu item or an awui:// link opens.
import { describe, expect, it } from "vitest";
import { expandHome, healthUrl, parseEndpoint, parseHealth, planLaunch, portsFrom, targetFromLink, targetUrl, titleCount, type Probe } from "../../src/shared/desktop.js";

const probe = (port: number, state: Probe["state"]): Probe => ({ port, state });

describe("the desktop shell's view of the server", () => {
  it("reads health only from awui's own answer", () => {
    expect(parseHealth('{"ok":true,"build":"2c0210d6a6"}')).toEqual({ ok: true, build: "2c0210d6a6" });
    // Another program on the port answers 200 with something else: not ours.
    expect(parseHealth('{"status":"ok"}')).toBeNull();
    expect(parseHealth('{"ok":false,"build":"x"}')).toBeNull();
    expect(parseHealth('{"ok":true}')).toBeNull();
    expect(parseHealth("<html>hello</html>")).toBeNull();
    expect(parseHealth("")).toBeNull();
    expect(healthUrl(4783)).toBe("http://127.0.0.1:4783/api/health");
  });

  it("attaches to a running server even when a free port comes first", () => {
    // Two servers over one state folder would both open the same session files.
    expect(planLaunch([probe(4783, "free"), probe(4784, "awui")])).toEqual({ action: "attach", port: 4784 });
    expect(planLaunch([probe(4783, "other"), probe(4784, "awui")])).toEqual({ action: "attach", port: 4784 });
  });

  it("starts a server on the first free port when none is running", () => {
    expect(planLaunch([probe(4783, "other"), probe(4784, "free"), probe(4785, "free")])).toEqual({ action: "spawn", port: 4784 });
    expect(planLaunch(portsFrom(4783).map((port) => probe(port, "free")))).toEqual({ action: "spawn", port: 4783 });
  });

  it("gives up when every port belongs to something else", () => {
    expect(planLaunch([probe(4783, "other"), probe(4784, "other")])).toEqual({ action: "none", port: 0 });
    expect(portsFrom(5000, 3)).toEqual([5000, 5001, 5002]);
  });

  it("opens the pages the web app already knows", () => {
    const base = "http://127.0.0.1:4783";
    expect(targetUrl(base, { kind: "home" })).toBe("http://127.0.0.1:4783/");
    expect(targetUrl(base, { kind: "new" })).toBe("http://127.0.0.1:4783/?new=1");
    expect(targetUrl(base, { kind: "sessions" })).toBe("http://127.0.0.1:4783/?sessions=1");
    expect(targetUrl(base, { kind: "prompt", text: "read src/app.ts & say hi" })).toBe("http://127.0.0.1:4783/?prompt=read%20src%2Fapp.ts%20%26%20say%20hi");
  });

  it("maps awui:// links onto those pages, and refuses the rest", () => {
    expect(targetFromLink("awui://new")).toEqual({ kind: "new" });
    expect(targetFromLink("awui://sessions")).toEqual({ kind: "sessions" });
    expect(targetFromLink("awui://prompt?text=hello%20there")).toEqual({ kind: "prompt", text: "hello there" });
    expect(targetFromLink("awui:///prompt?prompt=hi")).toEqual({ kind: "prompt", text: "hi" });
    expect(targetFromLink("awui://")).toEqual({ kind: "home" });
    expect(targetFromLink("awui://prompt")).toBeNull();
    expect(targetFromLink("https://example.com/")).toBeNull();
    expect(targetFromLink("not a url")).toBeNull();
  });

  it("reads the endpoint a running server published", () => {
    expect(parseEndpoint('{"port":5000,"host":"127.0.0.1","pid":42}')).toEqual({ port: 5000, host: "127.0.0.1", pid: 42 });
    // A stale or foreign file names no usable port; the caller probes anyway.
    expect(parseEndpoint('{"port":"5000"}')).toBeNull();
    expect(parseEndpoint('{"port":0}')).toBeNull();
    expect(parseEndpoint('{"port":70000}')).toBeNull();
    expect(parseEndpoint("not json")).toBeNull();
    expect(parseEndpoint('{"port":5000}')).toEqual({ port: 5000, host: "127.0.0.1", pid: 0 });
  });

  it("counts what the title says needs you", () => {
    expect(titleCount("(2) awui")).toBe(2);
    expect(titleCount("(99+) awui")).toBe(99);
    expect(titleCount("awui")).toBe(0);
    expect(titleCount("awui (2)")).toBe(0);
  });

  it("expands a leading tilde the way the server does, and leaves other paths alone", () => {
    expect(expandHome("~", "/home/me")).toBe("/home/me");
    expect(expandHome("~/state", "/home/me")).toBe("/home/me/state");
    expect(expandHome("~/", "/home/me")).toBe("/home/me");
    expect(expandHome("~user/state", "/home/me")).toBe("~user/state");
    expect(expandHome("/tmp/awui", "/home/me")).toBe("/tmp/awui");
    expect(expandHome("~/state", "C:\\Users\\me")).toBe("C:\\Users\\me\\state");
  });
});
