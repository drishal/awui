// The mesh wire (rpc.ts): line framing across arbitrary chunk boundaries,
// preamble hunting through shell noise, and the JSON-RPC 2.0 rules that make
// a misbehaving link close rather than answer. Everything runs over
// PassThrough pairs, the shape SSH stdio has on the other side of a spawn.
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { MAX_NOISE_BYTES, MeshErrorCode, MeshRpcError, PREAMBLE, RpcPeer } from "../../src/server/mesh/rpc.js";

/** Lets already-written bytes reach the other end's listeners before an assertion looks at them. */
const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A connected pair whose server answers "echo", and refuses everything else with a policy error. */
function makePair(): { client: RpcPeer; server: RpcPeer } {
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const client = new RpcPeer(s2c, c2s, { role: "client" });
  const server = new RpcPeer(c2s, s2c, { role: "server" });
  server.onRequest(async (method, params) => {
    if (method === "echo") return params;
    if (method === "boom") throw new Error(`a local failure while handling ${method}`);
    throw new MeshRpcError(MeshErrorCode.denied, `the policy refuses "${method}"`, { code: "denied" });
  });
  server.start();
  client.start();
  return { client, server };
}

describe("requests and notifications", () => {
  it("carries a request and its answer in both directions", async () => {
    const { client, server } = makePair();
    const got = await client.request<{ x: number }>("echo", { x: 41 });
    expect(got).toEqual({ x: 41 });
    // The server asks too: its ids are its own integers, and the reply routes back.
    client.onRequest(async (method, params) => ({ method, params }));
    const back = await server.request<{ method: string; params: unknown }>("tell", { hi: true });
    expect(back.method).toBe("tell");
    expect(back.params).toEqual({ hi: true });
  });

  it("delivers notifications both ways without demanding an answer", async () => {
    const { client, server } = makePair();
    const gotServer: { method: string; params: unknown }[] = [];
    const gotClient: { method: string; params: unknown }[] = [];
    server.onNotification((method, params) => gotServer.push({ method, params }));
    client.onNotification((method, params) => gotClient.push({ method, params }));
    client.notify("task.event", { remoteTaskId: "t1", seq: 1, event: { type: "message" } });
    server.notify("wake", { chat: 3 });
    for (let i = 0; i < 50 && (gotServer.length === 0 || gotClient.length === 0); i++) await tick();
    expect(gotServer).toEqual([{ method: "task.event", params: { remoteTaskId: "t1", seq: 1, event: { type: "message" } } }]);
    expect(gotClient).toEqual([{ method: "wake", params: { chat: 3 } }]);
  });

  it("answers an unknown method with -32601 when nothing handles it", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    const client = new RpcPeer(s2c, c2s, { role: "client" });
    const server = new RpcPeer(c2s, s2c, { role: "server" });
    server.start();
    client.start();
    const error = await client.request("peer.info", {}).then(
      () => {
        throw new Error("expected a rejection");
      },
      (e) => e,
    );
    expect(error).toBeInstanceOf(MeshRpcError);
    expect(error.code).toBe(-32601);
    expect(error.data).toEqual({ code: "method_not_found" });
  });

  it("carries a handler's MeshRpcError, and turns any other throw into a generic -32603", async () => {
    const { client } = makePair();
    const denied = await client.request("task.open", {}).then(
      () => {
        throw new Error("expected a rejection");
      },
      (e) => e,
    );
    expect(denied).toBeInstanceOf(MeshRpcError);
    expect(denied.code).toBe(MeshErrorCode.denied);
    expect(denied.data).toEqual({ code: "denied" });
    const boom = await client.request("boom", {}).then(
      () => {
        throw new Error("expected a rejection");
      },
      (e) => e,
    );
    expect(boom.code).toBe(-32603);
    expect(boom.data).toEqual({ code: "internal_error" });
    // A generic reply only: neither the local message nor a stack ever crossed the wire.
    expect(boom.message).not.toContain("a local failure");
    expect(boom.message).not.toContain("Error");
  });

  it("drops a response to an unknown id without closing", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    const client = new RpcPeer(s2c, c2s, { role: "client", log: () => undefined });
    const server = new RpcPeer(c2s, s2c, { role: "server" });
    server.onRequest(async (_method, params) => params);
    server.start();
    client.start();
    let closed = false;
    client.closed.then(() => {
      closed = true;
    });
    // A reply whose request timed out, say, or a peer that misroutes ids.
    s2c.write('{"jsonrpc":"2.0","id":999,"result":{"late":true}}\n');
    await tick(20);
    expect(closed).toBe(false);
    const got = await client.request("echo", { ok: 1 });
    expect(got).toEqual({ ok: 1 });
  });
});

describe("the preamble and the noise before it", () => {
  it("skips any noise before the preamble, including JSON-like lines", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    const client = new RpcPeer(s2c, c2s, { role: "client" });
    const server = new RpcPeer(c2s, s2c, { role: "server" });
    server.onRequest(async (_method, params) => params);
    client.start();
    // A shell MOTD: banners, a line that looks exactly like protocol JSON, and bytes with no newline at all.
    s2c.write("Welcome to lab-vm-3 (Ubuntu 22.04.3 LTS)\nLast login: Mon Jan 1 00:00:00 2026 from 10.0.0.9\n");
    s2c.write('{"jsonrpc":"2.0","method":"peer.hello","params":{"v":1}}\n');
    s2c.write("[not a line the client wants to parse");
    s2c.write(Buffer.alloc(2048, 0x41));
    s2c.write("\n");
    // Only now does the worker speak: the preamble queues behind all the noise.
    server.start();
    let closed = false;
    client.closed.then(() => {
      closed = true;
    });
    const got = await client.request("echo", { past: "the noise" });
    expect(got).toEqual({ past: "the noise" });
    expect(closed).toBe(false);
  });

  it("accepts exactly 64 KiB of noise, and closes the link on one byte more", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    const client = new RpcPeer(s2c, c2s, { role: "client" });
    client.start();
    let closed = false;
    client.closed.then(() => {
      closed = true;
    });
    // Right at the bound, with no newline: still within the allowance.
    s2c.write(Buffer.alloc(MAX_NOISE_BYTES, 0x42));
    await tick(20);
    expect(closed).toBe(false);
    s2c.write("x");
    const reason = await client.closed;
    expect(reason).toMatch(/noise/);
  });
});

describe("framing", () => {
  it("reassembles a line split across many chunks, including a split multi-byte character", async () => {
    const into = new PassThrough();
    const out = new PassThrough();
    const server = new RpcPeer(into, out, { role: "server" });
    const seen = Promise.withResolvers<{ method: string; params: { name: string } }>();
    server.onRequest(async (method, params) => {
      seen.resolve({ method, params: params as { name: string } });
      return {};
    });
    server.start();
    // 3-byte chunks must land inside the two-byte é and the four-byte emoji.
    const bytes = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"peer.hello","params":{"name":"héllo 🎉"}}\n', "utf8");
    for (let at = 0; at < bytes.length; at += 3) into.write(bytes.subarray(at, at + 3));
    const got = await seen.promise;
    expect(got.method).toBe("peer.hello");
    expect(got.params.name).toBe("héllo 🎉");
  });

  it("closes the link on a line over 1 MiB", async () => {
    const into = new PassThrough();
    const out = new PassThrough();
    const server = new RpcPeer(into, out, { role: "server" });
    server.start();
    into.write(Buffer.alloc(1024 * 1024 + 10, 0x41));
    const reason = await server.closed;
    expect(reason).toMatch(/longer/);
  });
});

describe("protocol violations close the link", () => {
  it.each(["{oops\n", '"just a string"\n', "null\n", '{"method":"peer.ping"}\n'])("closes on %j", async (bad) => {
    const into = new PassThrough();
    const out = new PassThrough();
    const server = new RpcPeer(into, out, { role: "server" });
    server.start();
    into.write(bad);
    const reason = await server.closed;
    expect(reason).toMatch(/^protocol:/);
  });
});

describe("closing and timeouts", () => {
  /** A server that answers "echo" and lets "hang" sit forever, so a pending request exists to be rejected. */
  const hangPair = (): { client: RpcPeer; server: RpcPeer } => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    const client = new RpcPeer(s2c, c2s, { role: "client" });
    const server = new RpcPeer(c2s, s2c, { role: "server" });
    server.onRequest((method, params) => (method === "echo" ? Promise.resolve(params) : new Promise<unknown>(() => undefined)));
    server.start();
    client.start();
    return { client, server };
  };

  it("rejects pending requests with link_closed when this side closes", async () => {
    const { client } = hangPair();
    const answer = client.request("hang", {});
    await tick();
    client.close("test done");
    const error = await answer.then(
      () => {
        throw new Error("expected a rejection");
      },
      (e) => e,
    );
    expect(error).toBeInstanceOf(MeshRpcError);
    expect(error.code).toBe(MeshErrorCode.link_closed);
    expect(error.data).toEqual({ code: "link_closed" });
    expect(await client.closed).toBe("test done");
  });

  it("rejects pending requests when the far end hangs up, and the reason is the eof", async () => {
    const { client, server } = hangPair();
    const answer = client.request("hang", {});
    await tick();
    server.close("worker is gone");
    const error = await answer.then(
      () => {
        throw new Error("expected a rejection");
      },
      (e) => e,
    );
    expect(error.code).toBe(MeshErrorCode.link_closed);
    expect(await client.closed).toBe("eof");
  });

  it("times a request out without closing the link", async () => {
    const { client } = hangPair();
    const error = await client.request("hang", {}, 50).then(
      () => {
        throw new Error("expected a rejection");
      },
      (e) => e,
    );
    expect(error).toBeInstanceOf(MeshRpcError);
    expect(error.code).toBe(MeshErrorCode.timeout);
    expect(error.data).toEqual({ code: "timeout" });
    // The link itself is fine: the next request still crosses it.
    const got = await client.request("echo", { alive: true });
    expect(got).toEqual({ alive: true });
  });

  it("rejects a request made on an already-closed link", async () => {
    const { client } = hangPair();
    client.close("first");
    const error = await client.request("echo", {}).then(
      () => {
        throw new Error("expected a rejection");
      },
      (e) => e,
    );
    expect(error.code).toBe(MeshErrorCode.link_closed);
  });

  it("resolves closed exactly once, with the first reason", async () => {
    const { client } = makePair();
    client.close("first");
    client.close("second");
    expect(await client.closed).toBe("first");
  });
});

describe("the preamble itself", () => {
  it("is the exact line the spec spells", () => {
    expect(PREAMBLE).toBe("AWUI-MESH/1 READY\n");
  });
});
