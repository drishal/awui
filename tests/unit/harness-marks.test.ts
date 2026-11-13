// Custom harness marks: only config.yml ACP agents may install them, bytes are
// validated, and a saved mark's life (bootstrap -> PNG -> delete) is one flow.
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import path from "node:path";
import request from "supertest";
import { makeTestApp, PASS, USER, tempDir, type TestApp } from "../helpers/app.js";
import { FakeAdapter } from "../../src/server/harness/fake.js";

/** A real shipped PNG; malformed headers below are refusal test inputs, not an image fixture. */
const PNG64 = readFileSync(path.join(process.cwd(), "src/web/public/harness-marks/pi.png"));
function png(width: number): Buffer {
  const data = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data, 0);
  data.writeUInt32BE(13, 8);
  data.write("IHDR", 12, "latin1");
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(width, 20);
  Buffer.from([8, 6, 0, 0, 0, 0, 0, 0, 0]).copy(data, 24);
  return data;
}

/** The share of a 64x64 RGBA PNG's pixels that are not fully transparent (decodes every PNG filter type). */
function opaqueShare(file: Buffer): number {
  const width = file.readUInt32BE(16);
  const height = file.readUInt32BE(20);
  const idat: Buffer[] = [];
  for (let at = 8; at < file.length; ) {
    const size = file.readUInt32BE(at);
    if (file.toString("latin1", at + 4, at + 8) === "IDAT") idat.push(file.subarray(at + 8, at + 8 + size));
    at += 12 + size;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const row = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    const up = y > 0 ? (rows[y - 1] as Buffer) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? (row[x - 4] as number) : 0;
      const upLeft = x >= 4 ? (up[x - 4] as number) : 0;
      const above = up[x] as number;
      const p = left + above - upLeft;
      const paeth = Math.abs(p - left) <= Math.abs(p - above) && Math.abs(p - left) <= Math.abs(p - upLeft) ? left : Math.abs(p - above) <= Math.abs(p - upLeft) ? above : upLeft;
      const add = filter === 1 ? left : filter === 2 ? above : filter === 3 ? (left + above) >> 1 : filter === 4 ? paeth : 0;
      row[x] = ((row[x] as number) + add) & 0xff;
    }
    rows.push(row);
  }
  let opaque = 0;
  for (const row of rows) for (let x = 3; x < stride; x += 4) if ((row[x] as number) > 16) opaque++;
  return opaque / (width * height);
}

let t: TestApp;
let configDir: string;

beforeEach(async () => {
  configDir = path.join(tempDir(), "settings");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, "config.yml"), "harnesses:\n  acp:\n    - id: custom\n      name: Custom\n      command: fake\n");
  const custom = new FakeAdapter({ id: "custom" });
  t = await makeTestApp({ withSettings: true, configDir, extraHarnesses: [custom] });

});
afterEach(async () => { await t.close(); });

describe("custom harness marks", () => {
  it("saves, publishes, serves, and removes one icon for a saved ACP agent", async () => {
    const upload = await request(t.server).put("/api/settings/harness-marks/custom").set("content-type", "image/png").send(PNG64);
    expect(upload.status).toBe(200);
    expect(upload.body.icon).toMatch(/^\/api\/harness-marks\/custom\.png\?v=[a-f0-9]{12}$/);
    expect(readFileSync(path.join(t.stateDir, "harness-marks", "custom.png"))).toEqual(PNG64);
    const boot = await request(t.server).get("/api/bootstrap");
    expect(boot.body.harnesses.find((h: { id: string }) => h.id === "custom")?.icon).toMatch(/^\/api\/harness-marks\/custom\.png\?v=[a-f0-9]{12}$/);
    expect(boot.body.harnesses.find((h: { id: string }) => h.id === "fake")).not.toHaveProperty("icon");
    const image = await request(t.server).get("/api/harness-marks/custom.png");
    expect(image.status).toBe(200);
    expect(image.headers["content-type"]).toContain("image/png");
    expect(image.headers["cache-control"]).toContain("private");
    expect(image.body).toEqual(PNG64);
    const remove = await request(t.server).delete("/api/settings/harness-marks/custom");
    expect(remove.status).toBe(200);
    expect(remove.body.icon).toBeNull();
    expect((await request(t.server).get("/api/harness-marks/custom.png")).status).toBe(404);
    const after = await request(t.server).get("/api/bootstrap");
    expect(after.body.harnesses.find((h: { id: string }) => h.id === "custom")).not.toHaveProperty("icon");
  });


  it("refuses arbitrary ids, SVG bytes, wrong dimensions, and empty bodies", async () => {
    expect((await request(t.server).put("/api/settings/harness-marks/fake").send(PNG64)).status).toBe(404);
    expect((await request(t.server).put("/api/settings/harness-marks/%2E%2E").send(PNG64)).status).toBe(400);
    expect((await request(t.server).put("/api/settings/harness-marks/custom").send("<svg width='64' height='64'/>")).status).toBe(400);
    expect((await request(t.server).put("/api/settings/harness-marks/custom").send(png(1))).status).toBe(400);
    expect((await request(t.server).put("/api/settings/harness-marks/custom").send("")).status).toBe(400);
    expect((await request(t.server).get("/api/harness-marks/custom.png")).status).toBe(404);
  });

  it("keeps upload/delete for settings.manage, and images readable by chat.read only", async () => {
    await t.close(); // rebased to real remote sessions; the other test cases use local owner access.
    t = await makeTestApp({ withSettings: true, configDir, withPassword: true, lanHosts: ["192.0.2.1"], extraHarnesses: [new FakeAdapter({ id: "custom" })] });
    const host = `192.0.2.1:${t.port}`;
    const sign = async (body: { username?: string; password?: string; invite?: string; inviteSecret?: string }) => {
      const res = await request(t.server).post("/api/login").set("Host", host).send(body);
      expect(res.status).toBe(200);
      const cookie = (res.headers["set-cookie"] as unknown as string[])[0];
      if (cookie === undefined) throw new Error("Login issued no session cookie");
      return cookie.split(";")[0] as string;
    };
    const full = await sign({ username: USER, password: PASS });
    const created = await request(t.server).post("/api/invites").set("Host", host).set("Cookie", full).send({ name: "Reader", grants: ["chat.read"] });
    expect(created.status).toBe(201);
    const limited = await sign({ invite: created.body.invite.id, inviteSecret: created.body.secret });
    const upload = await request(t.server).put("/api/settings/harness-marks/custom").set("Host", host).set("Cookie", full).send(PNG64);
    expect(upload.status).toBe(200);
    expect((await request(t.server).get("/api/harness-marks/custom.png").set("Host", host).set("Cookie", limited)).status).toBe(200);
    expect((await request(t.server).delete("/api/settings/harness-marks/custom").set("Host", host).set("Cookie", limited)).status).toBe(403);
    expect((await request(t.server).delete("/api/settings/harness-marks/custom").set("Host", host).set("Cookie", limited)).body.code).toBe("missing_grant");
    expect((await request(t.server).delete("/api/settings/harness-marks/custom").set("Host", host).set("Cookie", full)).status).toBe(200);
  });
});

describe("the shipped built-in marks", () => {
  // A mark is a CSS mask, so a fully transparent PNG draws nothing and passes every size check:
  // opencode.png shipped that way once. Each must cover a visible part of its 64x64 canvas.
  for (const id of ["pi", "omp", "hermes", "claude", "codex", "opencode", "grok", "dsh"]) {
    it(`${id} draws something`, () => {
      const file = readFileSync(path.join(process.cwd(), `src/web/public/harness-marks/${id}.png`));
      const share = opaqueShare(file);
      expect(share).toBeGreaterThan(0.05);
      expect(share).toBeLessThan(0.95);
    });
  }
});
