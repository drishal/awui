// The service worker: notifications, the share target, and a page for when the
// server cannot be reached. It never caches the app: a page load goes to the
// network as before, so a rebuild shows on the next reload; only when that
// load fails does it answer with a short offline page.
//
// A push carries no payload; it only says "something happened". The notes are
// read from the server with this device's cookie, and one is skipped when a
// visible window is already showing its chat. An approval's note carries its
// two answers, so the notification's Approve and Deny buttons post one with
// that same cookie, without opening the app.
//
// Sharing to awui (the manifest's share_target) arrives as a POST navigation
// from outside the app, which a SameSite=Strict cookie does not ride on, so
// the server could not take it. This worker takes it instead: it keeps the
// shared text and images in its own cache and opens the app, which picks them
// up and puts them in a new chat's composer.

let cursor = null;
const shown = new Set();
const SHARE_CACHE = "awui-share";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// The page asks for this when it finds a newer worker waiting. An installed iOS
// app does not reliably activate a worker that called skipWaiting() from
// install — the old one keeps serving its shell (WebKit bug 199110) — so the
// reload path posts this and waits for controllerchange.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("push", (event) => event.waitUntil(showNotes()));

async function showNotes() {
  let data;
  try {
    const res = await fetch(`/api/notifications${cursor === null ? "" : `?since=${cursor}`}`, { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return;
  }
  cursor = data.now;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const watching = (hash) => windows.some((w) => w.visibilityState === "visible" && new URL(w.url).hash === hash);
  for (const note of data.notes) {
    if (shown.has(note.id) || (note.roomId ? watching(`#room=${note.roomId}`) : note.chatId && watching(`#chat=${note.chatId}`))) continue;
    shown.add(note.id);
    await self.registration.showNotification(note.title, {
      body: note.body,
      tag: note.id,
      data: { chatId: note.chatId, sessionId: note.sessionId, roomId: note.roomId ?? null, approval: note.approval ?? null },
      requireInteraction: note.kind === "ask",
      ...(note.approval
        ? {
            actions: [
              { action: "approve", title: "Approve" },
              { action: "deny", title: "Deny" },
            ],
          }
        : {}),
    });
  }
}

/** Send the approval's answer the button chose; say how it went in a short notification. */
async function answer(data, choice) {
  const { chatId, roomId, approval } = data;
  // A room's bots answer through the room, never the chat routes (which refuse a room's chats).
  const url = roomId
    ? `/api/rooms/${encodeURIComponent(roomId)}/requests/${encodeURIComponent(approval.requestId)}/answer`
    : `/api/chats/${encodeURIComponent(chatId)}/requests/${encodeURIComponent(approval.requestId)}`;
  let outcome;
  try {
    const res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: approval[choice] }),
    });
    outcome = res.ok ? (choice === "approve" ? "Approved" : "Denied") : res.status === 409 ? "Already answered" : res.status === 401 ? "Sign in again to answer" : `Could not answer (HTTP ${res.status})`;
  } catch {
    outcome = "Could not reach the server";
  }
  await self.registration.showNotification(outcome, { tag: `answer-${approval.requestId}`, data: { chatId, roomId }, silent: true });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data ?? {};
  if ((event.action === "approve" || event.action === "deny") && data.approval) {
    event.waitUntil(answer(data, event.action));
    return;
  }
  const { chatId, sessionId, roomId } = data;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const target = windows.find((w) => w.focused) ?? windows[0];
      if (target) {
        await target.focus();
        if (roomId) target.postMessage({ type: "open-room", roomId });
        else if (chatId) target.postMessage({ type: "open-chat", chatId, sessionId });
        return;
      }
      await self.clients.openWindow(roomId ? `/#room=${roomId}` : chatId ? `/#chat=${chatId}` : "/");
    })(),
  );
});

/** Keep a share's text and images until the app asks for them, then open it. */
async function takeShare(request) {
  const form = await request.formData();
  const cache = await caches.open(SHARE_CACHE);
  const text = [form.get("title"), form.get("text"), form.get("url")].filter((v) => typeof v === "string" && v.trim()).join("\n");
  const files = form.getAll("images").filter((f) => f instanceof File && f.type.startsWith("image/")).slice(0, 8);
  await cache.put("/share/text", new Response(text));
  await cache.put("/share/count", new Response(String(files.length)));
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    await cache.put(`/share/image/${i}`, new Response(file, { headers: { "content-type": file.type, "x-name": encodeURIComponent(file.name || `shared-${i + 1}`) } }));
  }
  return Response.redirect("/?share=1", 303);
}

/** What a page load answers when the server cannot be reached. Plain HTML, no script: it retries itself. */
function offlinePage() {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta http-equiv="refresh" content="15"><title>awui · offline</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}main{max-width:22rem;padding:24px;text-align:center}h1{font-size:18px;margin:0 0 8px}p{margin:0 0 16px;color:GrayText}a{display:inline-block;padding:10px 18px;border-radius:999px;border:1px solid GrayText;color:inherit;text-decoration:none}</style></head>
<body><main><h1>The awui server is unreachable</h1><p>Your chats keep running on it. Check that the server is up and that this device can reach it (Tailscale connected?). This page tries again every 15 seconds.</p><a href="/">Try again</a></main></body></html>`;
  return new Response(html, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.method === "POST" && url.pathname === "/share") {
    event.respondWith(takeShare(request));
    return;
  }
  // Page loads only: everything else goes to the network untouched.
  if (request.mode === "navigate" && request.method === "GET") {
    event.respondWith(fetch(request).catch(() => offlinePage()));
  }
});
