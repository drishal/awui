// A folder's path in the sidebar's project menu: home-relative, and cut in the middle so the root and the
// folder's own name both survive.
import { describe, expect, it } from "vitest";
import { homePath, middlePath, shortPath } from "../../src/web/project-path.js";

const HOME = "/home/drisha";

describe("homePath", () => {
  it("replaces the home folder with ~ and leaves a path outside it alone", () => {
    expect(homePath(`${HOME}/projects/dotfiles`, HOME)).toBe("~/projects/dotfiles");
    expect(homePath(HOME, HOME)).toBe("~");
    expect(homePath("/srv/projects/dotfiles", HOME)).toBe("/srv/projects/dotfiles");
    // A sibling that merely starts with the same letters is not under home.
    expect(homePath("/home/drishal-other/x", HOME)).toBe("/home/drishal-other/x");
  });
});

describe("middlePath", () => {
  it("keeps a short path as it is", () => {
    expect(middlePath("~/projects/dotfiles", 30)).toBe("~/projects/dotfiles");
  });

  it("cuts the middle and keeps the home root and the folder's own name", () => {
    expect(middlePath("~/projects/awui/.awui/worktrees/branch-very-long", 24)).toBe("~/…/branch-very-long");
  });

  it("keeps the first folder of a path outside home", () => {
    const cut = middlePath("/srv/projects/awui/.awui/worktrees/branch", 20);
    expect(cut.startsWith("/srv/…/")).toBe(true);
    expect(cut.endsWith("branch")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(20);
  });

  it("keeps the end of one very long folder name", () => {
    const cut = middlePath("~/projects/a-folder-name-that-goes-on-and-on", 18);
    expect(cut.startsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(18);
    expect(cut.endsWith("and-on")).toBe(true);
  });
});

describe("shortPath", () => {
  it("reads a workspace root the way the menu prints it", () => {
    // The e2e sandbox's projects sit under /tmp; the menu shows where they live and what they are.
    const text = shortPath("/tmp/awui-sand-9f2c/projects/alpha", HOME);
    expect(text).toBe("/tmp/…/projects/alpha");
    expect(text.length).toBeLessThan("/tmp/awui-sand-9f2c/projects/alpha".length);
    expect(shortPath(`${HOME}/dotfiles`, HOME)).toBe("~/dotfiles");
  });
});
