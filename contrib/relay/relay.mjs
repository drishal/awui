#!/usr/bin/env node
// The reference relay (E2): a zero-knowledge postbox for awui's encrypted tunnel.
// It holds ciphertext frames and channel ids in memory only — never a key, never
// plaintext. No dependencies; run it anywhere Node 22+ runs:
//
//   node relay.mjs [--port 4784]
//
// HTTP API (all bodies and answers are binary where noted):
//   POST /register  { channelId (string), secretHash (sha256 hex of the frame key) }
//                   -> 409 when the channel exists; 201 once registered
//   POST /channels/:id/frames   body: one sealed frame (binary)   -> 202
//   GET  /channels/:id/frames?after=<cursor>&secretHash=<hex>&wait=<seconds>
//                   -> the frames after that cursor as one binary body
//                      (each 4-byte big-endian length-prefixed), or 204
//   DELETE /channels/:id?secretHash=<hex>  -> tear the channel down
//
// The relay never sees the pairing secret or the frame key: the client registers a
// sha256 of the key, and presents the same hash to read or delete. A channel with no
// frames for 24 h is swept. No hosted relay ships with awui; this file is what a
// person runs themselves.
import { createHash } from "node:crypto";
import http from "node:http";

const port = Number(process.argv[process.argv.indexOf("--port") + 1] ?? "") || 4784;
const CHANNEL_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CHANNEL_BYTES = 8 * 1024 * 1024;
const MAX_WAIT_MS = 25_000;

/** One channel: the key's hash (never the key), its frames, and its last activity. */
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  try {
    if (req.method === "POST" && url.pathname === "/register") {
      const body = JSON.parse((await readBody(req, 4096)).toString("utf8") || "{}");
      const id = typeof body.channelId === "string" && body.channelId.length <= 64 ? body.channelId : null;
      if (!id || !hex(body.secretHash)) return send(res, 400, "channelId and a 64-hex secretHash are needed");
      if (channels.has(id)) return send(res, 409, "that channel already exists");
      channels.set(id, { secretHash: body.secretHash, frames: [], at: Date.now() });
      return send(res, 201, "registered");
    }
    const match = /^\/channels\/([A-Za-z0-9_-]{1,64})(\/frames)?$/.exec(url.pathname);
    if (!match) return send(res, 404, "no such route");
    const id = match[1];
    const channel = channels.get(id);
    const presented = url.searchParams.get("secretHash") ?? req.headers["x-awui-relay-key"];
    if (req.method === "POST" && match[2] === "/frames") {
      if (!channel) return send(res, 404, "no such channel");
      if (!presented || String(presented) !== channel.secretHash) return send(res, 403, "wrong channel key");
      const frame = await readBody(req, 256 * 1024 + 1024);
      if (channel.frames.length >= 512 || channel.bytes + frame.length > MAX_CHANNEL_BYTES) return send(res, 429, "the channel's queue is full");
      channel.frames.push(frame);
      channel.bytes = (channel.bytes ?? 0) + frame.length;
      channel.at = Date.now();
      wake(id);
      return send(res, 202, "accepted");
    }
    if (req.method === "GET" && match[2] === "/frames") {
      if (!channel) return send(res, 404, "no such channel");
      if (!presented || String(presented) !== channel.secretHash) return send(res, 403, "wrong channel key");
      let after = Number(url.searchParams.get("after") ?? "0") || 0;
      const wait = Math.min(Number(url.searchParams.get("wait") ?? "0") || 0, MAX_WAIT_MS);
      const deadline = Date.now() + wait;
      while (after >= channel.frames.length && Date.now() < deadline) {
        await new Promise((resolve) => {
          const set = waiters.get(id) ?? new Set();
          set.add(resolve);
          waiters.set(id, set);
          setTimeout(resolve, Math.min(deadline - Date.now(), 1000)).unref?.();
        });
        after = Number(url.searchParams.get("after") ?? "0") || 0;
      }
      const frames = channel.frames.slice(after);
      if (frames.length === 0) {
        res.writeHead(204);
        return res.end();
      }
      const head = Buffer.alloc(4);
      head.writeUInt32BE(frames.length);
      const body = Buffer.concat(frames.map((frame) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(frame.length);
        return Buffer.concat([len, frame]);
      }));
      res.writeHead(200, { "content-type": "application/octet-stream", "x-awui-cursor": String(channel.frames.length) });
      return res.end(Buffer.concat([head, body]));
    }
    if (req.method === "DELETE" && match[2] !== "/frames") {
      if (!channel) return send(res, 404, "no such channel");
      if (!presented || String(presented) !== channel.secretHash) return send(res, 403, "wrong channel key");
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

server.listen(port, "127.0.0.1", () => console.log(`awui reference relay on http://127.0.0.1:${port} (zero-knowledge; in-memory frames only)`));
