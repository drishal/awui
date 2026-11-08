#!/usr/bin/env node
// A stand-in for `hermes gateway attach --json`: prints the one JSON line the real command
// prints (the owner's URL, the subprotocols with the ticket, its endpoint), with a ticket
// the scripted gateway really mints over its control socket. That is the shape awui dials
// from when the home's rendezvous cannot be used — Windows' named pipe, a missing socket.
//
// Usage: fake-hermes-attach.mjs <control-socket> <home>
//   FAKE_HERMES_CLIENT_SHA  the CLI's commit, when it should differ from the owner's
import net from "node:net";

const [socketPath, home] = process.argv.slice(2);
if (!socketPath || !home) throw new Error("usage: fake-hermes-attach.mjs <control-socket> <home>");

/** One control verb, answered. */
const ask = (payload) =>
  new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let data = "";
    socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      const end = data.indexOf("\n");
      if (end < 0) return;
      socket.destroy();
      let frame;
      try {
        frame = JSON.parse(data.slice(0, end));
      } catch {
        return reject(new Error("unreadable control answer"));
      }
      if (frame.ok !== true) return reject(new Error(String(frame.error)));
      resolve(frame.result ?? {});
    });
    socket.on("error", reject);
  });

const identity = await ask({ protocol: 1, id: 1, verb: "identify" });
const profile = (identity.served_profiles ?? []).find((entry) => entry?.home === home) ?? identity.served_profiles?.[0];
if (!profile?.profile_id) throw new Error("the gateway does not serve this home");
const grant = await ask({
  protocol: 1,
  id: 2,
  verb: "session-ticket",
  params: { profile_id: profile.profile_id, instance_id: identity.instance_id, purpose: "interactive", via: "cli" },
});
const url = `${String(identity.api_origin).replace(/^http/, "ws")}/api/ws`;
console.log(
  JSON.stringify({
    state: "ready",
    reason_code: "ready",
    client_code_sha: process.env.FAKE_HERMES_CLIENT_SHA ?? identity.code_sha,
    url,
    protocol: "hermes-gateway-v1",
    protocols: ["hermes-gateway-v1", `hermes-gateway-ticket.${grant.ticket}`],
    ticket: grant.ticket,
    endpoint: {
      profile_id: profile.profile_id,
      instance_id: identity.instance_id,
      api_origin: identity.api_origin,
      code_sha: identity.code_sha,
      runtime_protocol: 1,
      capabilities: identity.capabilities,
    },
  }),
);
