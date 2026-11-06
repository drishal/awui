import { mkdtempSync, mkdirSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { builtBinaryPath, selfToInstall } from "../../src/server/install-service.js";
import { atuiTarget, linkAtui } from "../../src/server/install-tui.js";

describe("install service picks the file to put on the PATH", () => {
  it("installs itself as the binary, without looking for a checkout", () => {
    const self = selfToInstall("/home/me/.local/bin/awui", true, () => {
      throw new Error("the binary must not look for a built copy");
    });
    expect(self).toBe("/home/me/.local/bin/awui");
  });

  it("installs the built binary when the process is node, as bin/awui runs it", () => {
    // Any existing file stands in for the built binary; the check is existence.
    const built = import.meta.filename;
    expect(selfToInstall("/nix/store/xxx-nodejs-slim-22.23.3/bin/node", false, () => built)).toBe(built);
  });

  it("says what to build when no binary exists yet", () => {
    const call = () => selfToInstall("/usr/bin/node", false, () => "/checkout/dist/bin/linux-x64/awui");
    expect(call).toThrow(/build-binary\.ts/);
    try {
      call();
    } catch (error) {
      // A plain Error would exit as a crash; this one is reported, then exits 1.
      expect(error).toMatchObject({ status: 500, code: "no_binary" });
    }
  });

  it("names the binary where scripts/build-binary.ts writes it", () => {
    expect(builtBinaryPath("/checkout", "linux", "x64")).toBe("/checkout/dist/bin/linux-x64/awui");
    expect(builtBinaryPath("/checkout", "darwin", "arm64")).toBe("/checkout/dist/bin/darwin-arm64/awui");
    expect(builtBinaryPath("/checkout", "win32", "x64")).toBe("/checkout/dist/bin/win32-x64/awui.exe");
  });
});

describe("install tui's atui link", () => {
  it("links the checkout's bin/atui from source, the binary otherwise", () => {
    // A source run is node, not awui: the link is the checkout's Bun script.
    expect(atuiTarget("/home/me/.local/bin", "/usr/bin/node", false, () => "/checkout")).toBe("/checkout/bin/atui");
    // The binary, with no awui beside it: link the binary where it is.
    const lone = mkdtempSync(path.join(tmpdir(), "awui-link-"));
    expect(atuiTarget(lone, "/opt/awui/awui", true, () => "/checkout")).toBe("/opt/awui/awui");
    // An awui beside it that is this very binary: the link is the name `awui`, so a
    // reinstalled awui is the new atui too.
    const bin = mkdtempSync(path.join(tmpdir(), "awui-link2-"));
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "awui"), "#!/bin/sh\n");
    expect(atuiTarget(bin, path.join(bin, "awui"), true, () => "/checkout")).toBe("awui");
    // An awui beside it that is a different binary (an old install): link this binary itself.
    expect(atuiTarget(bin, "/opt/awui-new/awui", true, () => "/checkout")).toBe("/opt/awui-new/awui");
  });

  it("makes bin/atui a symlink, replacing what was there", async () => {
    const bin = mkdtempSync(path.join(tmpdir(), "awui-link3-"));
    // The old Bun wrapper script stands in for what a previous install put there.
    writeFileSync(path.join(bin, "atui"), "#!/bin/sh\nexec bun ...\n");
    const file = await linkAtui(bin, "/opt/awui/awui");
    expect(file).toBe(path.join(bin, "atui"));
    // A second install replaces the link in one rename.
    await linkAtui(bin, "/opt/awui-new/awui");
    expect(readlinkSync(path.join(bin, "atui"))).toBe("/opt/awui-new/awui");
  });
});
