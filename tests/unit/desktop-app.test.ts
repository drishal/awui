// `awui desktop` and `awui install desktop`: which file the command runs, and
// which artifact it links — the decisions, without spawning anything.
import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chooseArtifact, desktopEntry, desktopIconPaths, desktopLaunches, desktopLink, desktopName, execArg, findDesktop, menuCommand, onPath, runDesktop, sameFile } from "../../src/server/desktop-app.js";

/** A world where exactly these files exist. */
const world = (...files: string[]) => {
  const set = new Set(files);
  return { exists: (file: string) => set.has(file), files };
};

const home = "/home/me";
const root = "/repo";

describe("the desktop command", () => {
  it("names the command and the link it installs", () => {
    expect(desktopName("linux")).toBe("awui-desktop");
    expect(desktopName("win32")).toBe("awui-desktop.exe");
    expect(desktopLink(home, "linux")).toBe("/home/me/.local/bin/awui-desktop");
  });

  it("finds a name on the PATH, and nothing when the PATH has it not", () => {
    const env = { PATH: ["/usr/bin", "/opt/bin"].join(path.delimiter) };
    expect(onPath("awui-desktop", env, world("/opt/bin/awui-desktop").exists)).toBe("/opt/bin/awui-desktop");
    expect(onPath("awui-desktop", env, world().exists)).toBeNull();
    expect(onPath("awui-desktop", {}, world("/usr/bin/awui-desktop").exists)).toBeNull();
  });

  it("tries the explicit binary, the installed link, the PATH, then a checkout's electron", () => {
    const launches = desktopLaunches({
      root,
      home,
      platform: "linux",
      env: { AWUI_DESKTOP_BIN: "/opt/awui-desktop", PATH: "/usr/bin" },
      ...world("/opt/awui-desktop", "/home/me/.local/bin/awui-desktop", "/usr/bin/awui-desktop", "/repo/apps/desktop/node_modules/.bin/electron", "/repo/apps/desktop/package.json"),
    });
    expect(launches.map((l) => l.how)).toEqual(["AWUI_DESKTOP_BIN", "installed", "on the PATH", "this checkout (electron .)"]);
    expect(launches[3]).toEqual({ command: "/repo/apps/desktop/node_modules/.bin/electron", args: ["/repo/apps/desktop"], how: "this checkout (electron .)" });
  });

  it("lets an explicit binary win over the one the build carries", () => {
    const launches = desktopLaunches({
      root: null,
      home,
      bundled: "/state/desktop/0.0.1/awui-desktop",
      platform: "linux",
      env: { AWUI_DESKTOP_BIN: "/opt/awui-desktop", PATH: "" },
      ...world("/opt/awui-desktop", "/state/desktop/0.0.1/awui-desktop"),
    });
    expect(launches.map((l) => l.how)).toEqual(["AWUI_DESKTOP_BIN", "bundled with this awui"]);
  });

  it("returns only what exists, and nothing at all when nothing does", () => {
    expect(findDesktop({ root, home, platform: "linux", env: { PATH: "/usr/bin" }, ...world() })).toBeNull();
    // A compiled binary has no checkout to look in.
    const onlyLink = findDesktop({ root: null, home, platform: "linux", env: { PATH: "/usr/bin" }, ...world("/home/me/.local/bin/awui-desktop") });
    expect(onlyLink).toEqual({ command: "/home/me/.local/bin/awui-desktop", args: [], how: "installed" });
  });

  it("does not name the same file twice when the link is also on the PATH", () => {
    const launches = desktopLaunches({
      root: null,
      home,
      platform: "linux",
      env: { PATH: "/home/me/.local/bin" },
      ...world("/home/me/.local/bin/awui-desktop"),
    });
    expect(launches).toHaveLength(1);
    expect(launches[0]?.how).toBe("installed");
  });
});

describe("what `install desktop` links", () => {
  it("prefers the AppImage, then the unpacked build", () => {
    expect(chooseArtifact(["builder-debug.yml", "awui-0.0.1.AppImage", "linux-unpacked"], "linux")).toBe("awui-0.0.1.AppImage");
    expect(chooseArtifact(["linux-unpacked"], "linux")).toBe(path.join("linux-unpacked", "awui-desktop"));
    expect(chooseArtifact(["builder-debug.yml"], "linux")).toBeNull();
  });

  it("knows where a mac app and a Windows build keep their executable", () => {
    // readdir lists the directory, never a path inside it.
    expect(chooseArtifact(["mac-arm64", "builder-debug.yml"], "darwin")).toBe(path.join("mac-arm64", "awui.app", "Contents", "MacOS", "awui"));
    expect(chooseArtifact(["awui.app"], "darwin")).toBe(path.join("awui.app", "Contents", "MacOS", "awui"));
    expect(chooseArtifact(["win-unpacked"], "win32")).toBe(path.join("win-unpacked", "awui-desktop.exe"));
    expect(chooseArtifact(["builder-debug.yml"], "darwin")).toBeNull();
    // Both architectures present: the one for this arch, not whichever readdir listed first.
    expect(chooseArtifact(["mac", "mac-arm64"], "darwin", "arm64")).toBe(path.join("mac-arm64", "awui.app", "Contents", "MacOS", "awui"));
    expect(chooseArtifact(["mac-arm64", "mac"], "darwin", "x64")).toBe(path.join("mac", "awui.app", "Contents", "MacOS", "awui"));
    expect(chooseArtifact(["mac-x64", "mac-arm64"], "darwin", "x64")).toBe(path.join("mac-x64", "awui.app", "Contents", "MacOS", "awui"));
  });
});

describe("starting it", () => {
  it("says why when the app cannot be executed, instead of claiming it started", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "awui-run-"));
    const plain = path.join(dir, "not-executable");
    await writeFile(plain, "#!/bin/sh\n");
    await chmod(plain, 0o644);
    const before = process.env.AWUI_DESKTOP_BIN;
    process.env.AWUI_DESKTOP_BIN = plain;
    try {
      await expect(runDesktop({ args: [], stateDir: dir })).rejects.toThrow(/cannot run/);
    } finally {
      if (before === undefined) delete process.env.AWUI_DESKTOP_BIN;
      else process.env.AWUI_DESKTOP_BIN = before;
    }
  });
});

describe("the application-menu entry", () => {
  it("runs the command it was given and names the window class", () => {
    const entry = desktopEntry(["/home/me/.local/bin/awui", "desktop"]);
    expect(entry).toContain("[Desktop Entry]");
    expect(entry).toContain("Type=Application");
    expect(entry).toContain("Exec=/home/me/.local/bin/awui desktop");
    expect(entry).toContain("Icon=awui");
    expect(entry).toContain("Terminal=false");
    expect(entry).toContain("StartupWMClass=awui-desktop");
    expect(entry).toContain("MimeType=x-scheme-handler/awui;");
    expect(entry.endsWith("\n")).toBe(true);
  });

  it("quotes an argument the spec reserves, and leaves the rest bare", () => {
    expect(execArg("/home/me/awui")).toBe("/home/me/awui");
    expect(execArg("--install-icon")).toBe("--install-icon");
    expect(execArg("/home/me/My Apps/awui")).toBe('"/home/me/My Apps/awui"');
    expect(execArg('a"b$c`d\\e')).toBe('"a\\"b\\$c\\`d\\\\e"');
    expect(desktopEntry(["/home/me/My Apps/awui", "desktop"])).toContain('Exec="/home/me/My Apps/awui" desktop');
  });

  it("follows XDG_DATA_HOME, and ~/.local/share without it", () => {
    expect(desktopIconPaths("/home/me", {})).toEqual({
      entry: "/home/me/.local/share/applications/awui.desktop",
      icon: "/home/me/.local/share/icons/hicolor/512x512/apps/awui.png",
    });
    expect(desktopIconPaths("/home/me", { XDG_DATA_HOME: "/data" }).entry).toBe("/data/applications/awui.desktop");
  });
});

describe("the command a menu entry runs", () => {
  const same = () => true;
  const differ = () => false;

  it("uses the bare name when the PATH's awui is this very binary", () => {
    // A desktop entry looks a bare name up in $PATH; this keeps the entry alive
    // when the binary moves.
    expect(menuCommand(["/repo/dist/bin/awui", "desktop"], "/home/me/.local/bin/awui", same)).toEqual(["awui", "desktop"]);
  });

  it("keeps the absolute path when it is another binary, or nothing is on the PATH", () => {
    expect(menuCommand(["/repo/dist/bin/awui", "desktop"], "/home/me/.local/bin/awui", differ)).toEqual(["/repo/dist/bin/awui", "desktop"]);
    expect(menuCommand(["/repo/dist/bin/awui", "desktop"], null, same)).toEqual(["/repo/dist/bin/awui", "desktop"]);
    expect(menuCommand([], "/home/me/.local/bin/awui", same)).toEqual([]);
  });

  it("compares real paths, so a symlink to the same file counts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "awui-same-"));
    const real = path.join(dir, "awui");
    const link = path.join(dir, "awui-link");
    await writeFile(real, "#!/bin/sh\n");
    await chmod(real, 0o755);
    const { symlink } = await import("node:fs/promises");
    await symlink(real, link);
    expect(sameFile(link, real)).toBe(true);
    expect(sameFile(real, path.join(dir, "absent"))).toBe(false);
  });
});
