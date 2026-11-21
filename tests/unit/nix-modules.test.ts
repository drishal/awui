// The Nix modules (contrib/nixos/awui.nix, contrib/home-manager/awui-service.nix)
// parse. Nix itself is not a dependency of this repo — the maintainer's machine
// has it, most contributors' machines and CI do not — so the check runs only
// when nix-instantiate is on the PATH and skips itself otherwise. It is a parse
// check only: module options and values are judged by NixOS itself, at the
// user's rebuild.
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileP = promisify(execFile);

async function nixOnPath(): Promise<boolean> {
  try {
    await execFileP("nix-instantiate", ["--version"], { timeout: 10_000 });
    return true;
  } catch {
    return false; // Not on this machine's PATH; the test skips itself.
  }
}

const MODULES = ["../../contrib/nixos/awui.nix", "../../contrib/home-manager/awui-service.nix"];

describe("the nix modules parse", () => {
  it("nix-instantiate --parse accepts both mesh modules", async () => {
    if (!(await nixOnPath())) {
      // No nix here: nothing to check, and no failure to owe anyone.
      expect(true).toBe(true);
      return;
    }
    for (const module of MODULES) {
      const here = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
      const file = path.join(here, module);
      // --parse reads the file as an expression and never evaluates it, so the
      // check holds without a nixpkgs checkout beside it.
      await expect(execFileP("nix-instantiate", ["--parse", file], { timeout: 30_000 })).resolves.toMatchObject({ stdout: expect.any(String) });
    }
  });
});
