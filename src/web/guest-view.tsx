// The guest link's own page, reached at /guest/:token outside the main app shell:
// redeem once, read one session's text-only history, queue a message for the owner.
// It calls only the /api/guest* routes with the guest cookie and never sees the app.
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { api, errorText } from "./api.js";
import { installRipple } from "./ripple.js";
import "./styles.css";

interface GuestMeta {
  id: string;
  title: string;
  harnessId: string;
  workspaceName: string;
  expiresAt: number;
  browserSession: "unused" | "bound";
  pending: Array<{ id: string; text: string; at: number }>;
}

interface GuestHistory {
  title: string;
  harnessId: string;
  workspaceName: string;
  expiresAt: number;
  history: Array<{ id: string; kind: "user" | "assistant"; text: string; at?: number }>;
}

const REDIRECTED = "guest_redeemed";

/** Redeems once per tab: the cookie is same-origin, so a reload finds the bound session. */
async function redeem(token: string): Promise<GuestMeta | null> {
  try {
    return (await api<{ guest: GuestMeta }>("/api/guests/redeem", { body: { token } })).guest;
  } catch (error) {
    // Already redeemed in this browser: the meta read decides.
    if (errorText(error).includes("claimed")) return null;
    throw error;
  }
}

/** The standalone page's body: one bounded view of one chat, one queued message at a time. */
export function GuestView({ token }: { token: string }) {
  const [meta, setMeta] = useState<GuestMeta | null>(null);
  const [history, setHistory] = useState<GuestHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const redeemed = useRef(false);

  const load = useCallback(async () => {
    try {
      const current = await api<GuestMeta>("/api/guest");
      setMeta(current);
      setHistory(await api<GuestHistory>("/api/guest/history"));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    if (sessionStorage.getItem(REDIRECTED) === token || redeemed.current) {
      void load();
      return;
    }
    redeemed.current = true;
    sessionStorage.setItem(REDIRECTED, token);
    redeem(token)
      .then((guest) => {
        if (guest) void load();
        else void load();
      })
      .catch((err) => setError(errorText(err)));
  }, [token, load]);

  // A guest page has no live stream: a short poll keeps the view close to the chat.
  useEffect(() => {
    if (!meta) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [meta, load]);

  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    try {
      await api("/api/guest/messages", { body: { text, requestId: `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` } });
      setDraft("");
      setNotice("Sent to the chat's owner for review.");
      void load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  if (error && !meta) {
    return (
      <main className="guest">
        <div className="guest-card">
          <h1>Guest link</h1>
          <p className="muted">{error}</p>
        </div>
      </main>
    );
  }
  if (!meta) {
    return (
      <main className="guest">
        <div className="guest-card">
          <p className="muted">Opening the shared session…</p>
        </div>
      </main>
    );
  }
  return (
    <main className="guest">
      <div className="guest-card">
        <header className="guest-head">
          <h1>{meta.title}</h1>
          <p className="muted">
            {meta.workspaceName} · {meta.harnessId} · shared read-only view, expires{" "}
            {new Date(meta.expiresAt).toLocaleString()}
          </p>
        </header>
        {history ? (
          <ol className="guest-history">
            {history.history.map((item) => (
              <li key={item.id} className={`guest-item guest-${item.kind}`}>
                <span className="guest-role">{item.kind === "user" ? "You / owner" : "Agent"}</span>
                <p>{item.text}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">Loading the conversation…</p>
        )}
        {notice ? <p className="guest-notice" role="status">{notice}</p> : null}
        <form
          className="guest-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <textarea
            value={draft}
            placeholder="Ask the owner to send a message to this chat…"
            maxLength={4000}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Message for the owner to review"
          />
          <button type="submit" className="btn" disabled={!draft.trim()}>
            Queue for review
          </button>
        </form>
        {meta.pending.length > 0 ? (
          <p className="muted">
            {meta.pending.length} message{meta.pending.length === 1 ? "" : "s"} waiting for the owner.
          </p>
        ) : null}
      </div>
    </main>
  );
}

/** The entry: /guest/:token renders the standalone view, anything else the app shell. */
export function mountGuestOrApp(): void {
  const match = location.pathname.match(/^\/guest\/([A-Za-z0-9_-]+)\/?$/);
  const root = document.getElementById("root");
  if (!root) return;
  installRipple();
  if (match) {
    import("./guest-view.js").then(({ GuestView }) => {
      createRoot(root).render(
        <StrictMode>
          <GuestView token={match[1]!} />
        </StrictMode>,
      );
    });
    return;
  }
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
