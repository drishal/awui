#!/usr/bin/env node
// The reference relay (E2): a zero-knowledge postbox for awui's encrypted tunnel.
// It holds ciphertext frames and channel ids in memory only — never a key, never
// plaintext. No dependencies; run it anywhere Node 22+ runs:
//
//   node relay.mjs [--port 4784]
//
// HTTP API (all bodies and answers are binary where noted). The bearer check is the
// SHA-256 of the pairing secret, always in the `x-awui-relay-key` header — never in a
// URL, where a proxy would log it:
//   POST /register                body: { channelId } + header
//                                 -> 409 when the channel exists; 201 once registered
//   POST /channels/:id/frames     body: one sealed frame (binary) + header   -> 202
//   GET  /channels/:id/frames?after=<seq>&wait=<seconds> + header
//                                 -> the frames with a sequence above `after` as one
//                                    binary body (each 4-byte big-endian length-
//                                    prefixed), or 204; `x-awui-cursor` names the
//                                    newest sequence in the channel
//   POST /channels/:id/ack        body: { cursor } + header
//                                 -> 200 { cursor, dropped }: every frame at or below
//                                    `cursor` is dropped and the bytes freed
//   DELETE /channels/:id + header -> tear the channel down
//
// The relay never sees the pairing secret or a frame key: the client registers a
// sha256 of the secret, and presents the same hash to read, acknowledge, or delete.
// A channel with no frames for 24 h is swept. No hosted relay ships with awui; this
// file is what a person runs themselves.
import http from "node:http";

// `--port 0` binds a free one and reports it, which a test uses to stay off a fixed port.
const requested = Number(process.argv[process.argv.indexOf("--port") + 1] ?? "");
const port = Number.isInteger(requested) && requested >= 0 ? requested : 4784;
const CHANNEL_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CHANNEL_BYTES = 8 * 1024 * 1024;
const MAX_FRAMES = 512;
const MAX_WAIT_MS = 25_000;

/** One channel: the secret's hash (never the secret), its frames with sequence numbers, and its last activity. */
const channels = new Map();

const sweep = () => {
  const now = Date.now();
  for (const [id, channel] of channels) if (now - channel.at > CHANNEL_TTL_MS) channels.delete(id);
};
setInterval(sweep, 60 * 60 * 1000).unref();

const waiters = new Map();
const wake = (id) => {
  for (const res of waiters.get(id) ?? []) res();
  waiters.delete(id);
};

const readBody = (req, limit) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const hex = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
/** The one bearer check: the header only, so the secret's hash never lands in a URL. */
const presentedHash = (req) => {
  const value = req.headers["x-awui-relay-key"];
  return typeof value === "string" && hex(value) ? value : null;
};
const cursorOf = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  try {
    if (req.method === "POST" && url.pathname === "/register") {
      const body = JSON.parse((await readBody(req, 4096)).toString("utf8") || "{}");
      const id = typeof body.channelId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(body.channelId) ? body.channelId : null;
      const secretHash = presentedHash(req);
      if (!id || !secretHash) return send(res, 400, "a channelId and an x-awui-relay-key hash are needed");
      if (channels.has(id)) return send(res, 409, "that channel already exists");
      channels.set(id, { secretHash, frames: [], nextSeq: 1, acked: 0, bytes: 0, at: Date.now() });
      return send(res, 201, "registered");
    }
    const match = /^\/channels\/([A-Za-z0-9_-]{1,64})(\/frames|\/ack)?$/.exec(url.pathname);
    if (!match) return send(res, 404, "no such route");
    const id = match[1];
    const channel = channels.get(id);
    if (!channel) return send(res, 404, "no such channel");
    const presented = presentedHash(req);
    if (!presented || presented !== channel.secretHash) return send(res, 403, "wrong channel key");
    if (req.method === "POST" && match[2] === "/frames") {
      const frame = await readBody(req, 256 * 1024 + 1024);
      if (channel.frames.length >= MAX_FRAMES || channel.bytes + frame.length > MAX_CHANNEL_BYTES) return send(res, 429, "the channel's queue is full");
      // A relay-assigned sequence is the cursor both sides acknowledge; the frames
      // themselves stay opaque ciphertext.
      channel.frames.push({ seq: channel.nextSeq, data: frame });
      channel.nextSeq += 1;
      channel.bytes += frame.length;
      channel.at = Date.now();
      wake(id);
      return send(res, 202, "accepted");
    }
    if (req.method === "GET" && match[2] === "/frames") {
      const after = cursorOf(url.searchParams.get("after") ?? "0");
      if (after === null) return send(res, 400, "after is a non-negative sequence number");
      const wait = Math.min(Number(url.searchParams.get("wait") ?? "0") || 0, MAX_WAIT_MS);
      const deadline = Date.now() + wait;
      while (after >= channel.nextSeq - 1 && Date.now() < deadline) {
        await new Promise((resolve) => {
          const set = waiters.get(id) ?? new Set();
          set.add(resolve);
          waiters.set(id, set);
          setTimeout(resolve, Math.min(deadline - Date.now(), 1000)).unref?.();
        });
      }
      const frames = channel.frames.filter((entry) => entry.seq > after);
      if (frames.length === 0) {
        res.writeHead(204, { "x-awui-cursor": String(channel.nextSeq - 1) });
        return res.end();
      }
      const head = Buffer.alloc(4);
      head.writeUInt32BE(frames.length);
      const body = Buffer.concat(frames.map((entry) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(entry.data.length);
        return Buffer.concat([len, entry.data]);
      }));
      res.writeHead(200, { "content-type": "application/octet-stream", "x-awui-cursor": String(channel.nextSeq - 1) });
      return res.end(Buffer.concat([head, body]));
    }
    if (req.method === "POST" && match[2] === "/ack") {
      const body = JSON.parse((await readBody(req, 4096)).toString("utf8") || "{}");
      const cursor = cursorOf(body.cursor);
      if (cursor === null) return send(res, 400, "cursor is a non-negative sequence number");
      // An acknowledge never moves backwards: an old, repeated, or out-of-order ack is
      // clamped to what was already dropped, and the frame bytes go with the frames.
      const target = Math.min(Math.max(cursor, channel.acked), channel.nextSeq - 1);
      const before = channel.frames.length;
      channel.frames = channel.frames.filter((entry) => entry.seq > target);
      channel.acked = target;
      channel.bytes = channel.frames.reduce((sum, entry) => sum + entry.data.length, 0);
      return sendJson(res, 200, { cursor: channel.acked, dropped: before - channel.frames.length });
    }
    if (req.method === "DELETE" && match[2] === undefined) {
      channels.delete(id);
      wake(id);
      return send(res, 200, "torn down");
    }
    send(res, 405, "method not allowed");
  } catch (error) {
    send(res, error.message === "too large" ? 413 : 500, error.message === "too large" ? "frame too large" : "relay error");
  }
});

function send(res, status, message) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

server.listen(port, "127.0.0.1", () => {
  const bound = server.address().port;
  console.log(`awui reference relay on http://127.0.0.1:${bound} (zero-knowledge; in-memory frames only)`);
});
