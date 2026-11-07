// The desktop app a binary can carry: the payload footer, and the one-time
// extraction into the state folder.
import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DESKTOP_MAGIC, bundledDesktop, embeddedDesktopPayload, extractDesktopPayload } from "../../src/server/desktop-embed.js";

/** A stand-in executable: some bytes, then the payload, then its footer. */
async function executable(dir: string, payload: Buffer | null, magic = DESKTOP_MAGIC): Promise<string> {
  const file = path.join(dir, "awui");
  const head = Buffer.from("ELF-not-really");
  const parts: Uint8Array[] = [head];
  if (payload) {
    const footer = Buffer.alloc(8 + DESKTOP_MAGIC.length);
    footer.writeBigUInt64LE(BigInt(payload.length), 0);
    footer.write(magic, 8, "utf8");
    parts.push(payload, footer);
  }
  await writeFile(file, Buffer.concat(parts));
  await chmod(file, 0o755);
  return file;
}

describe("a binary that carries the desktop app", () => {
  it("finds the payload where the footer says it is", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "awui-embed-"));
    const payload = Buffer.from("this stands in for a 170 MB AppImage");
    const file = await executable(dir, payload);
    expect(await embeddedDesktopPayload(file)).toEqual({ offset: Buffer.byteLength("ELF-not-really"), length: payload.length });

    const found = await embeddedDesktopPayload(file);
    const bytes = await readFile(file);
    expect(bytes.subarray(found!.offset, found!.offset + found!.length).toString()).toBe(payload.toString());
  });

  it("carries nothing when the footer is missing, wrong, or truncated", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "awui-embed-"));
    expect(await embeddedDesktopPayload(await executable(dir, null))).toBeNull();
    expect(await embeddedDesktopPayload(await executable(dir, Buffer.from("x"), "AWUIDESK99"))).toBeNull();
    const tiny = path.join(dir, "tiny");
    await writeFile(tiny, "hi");
    expect(await embeddedDesktopPayload(tiny)).toBeNull();
    expect(await embeddedDesktopPayload(path.join(dir, "absent"))).toBeNull();
  });

  it("extracts it once, executable, and reuses that copy", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "awui-embed-"));
    const payload = Buffer.alloc(1024, 7);
    const file = await executable(dir, payload);
    const state = path.join(dir, "state");

    const extracted = await bundledDesktop(file, state, "0.0.1");
    expect(extracted).toBe(path.join(state, "desktop", "0.0.1", "awui-desktop"));
    expect((await stat(extracted!)).mode & 0o111).not.toBe(0);
    expect((await readFile(extracted!)).equals(payload)).toBe(true);

    // A second call does not rewrite it: the mtime stays.
    const before = (await stat(extracted!)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await bundledDesktop(file, state, "0.0.1")).toBe(extracted);
    expect((await stat(extracted!)).mtimeMs).toBe(before);
  });

  it("extracts straight out of the executable's bytes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "awui-embed-"));
    const payload = Buffer.from("0123456789");
    const file = await executable(dir, payload);
    const found = await embeddedDesktopPayload(file);
    const target = path.join(dir, "out", "app");
    await extractDesktopPayload(file, found!, target);
    expect(await readFile(target, "utf8")).toBe("0123456789");
  });

  it("says nothing when the binary carries no app at all", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "awui-embed-"));
    expect(await bundledDesktop(await executable(dir, null), path.join(dir, "state"), "0.0.1")).toBeNull();
  });
});
