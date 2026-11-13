// Sign-in for other devices (LAN via HOST=0.0.0.0, or Tailscale Serve).
// This machine never sees it: local requests need no sign-in. An invitation link
// (grants.ts) carries the invitation's id and its own one-time secret, so the
// sign-in needs only that link and is bound to what the invitation allows. Any
// other visit is the owner's full-access sign-in with username and password.
import { useState } from "react";
import { api, ApiError, errorText } from "../api.js";

export function LoginForm() {
  const params = new URLSearchParams(window.location.search);
  const invite = params.get("invite") ?? "";
  const key = params.get("key") ?? "";
  // An id alone proves nothing (an old link, or a guess): it is an ordinary visit.
  const limited = invite !== "" && key !== "";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const signIn = async (body: Record<string, string>) => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/login", { body });
      window.location.reload();
    } catch (err) {
      const wrongPassword = err instanceof ApiError && err.status === 401;
      setError(wrongPassword ? (limited ? "This invitation was revoked, or its link is wrong. Ask the owner for a new one." : "Wrong username or password") : errorText(err));
      setPassword("");
      setBusy(false);
    }
  };

  return (
    <div className="fullscreen-message">
      {limited ? (
        <form
          className="login-card"
          onSubmit={(e) => {
            e.preventDefault();
            void signIn({ invite, inviteSecret: key });
          }}
        >
          <h1>Sign in</h1>
          <p className="muted">This link signs this device in with the limited access its invitation allows. It needs no password.</p>
          {error ? (
            <p className="login-error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" className="btn btn-primary login-submit" disabled={busy}>
            {busy ? "Signing in…" : "Continue"}
          </button>
        </form>
      ) : (
        <form
          className="login-card"
          onSubmit={(e) => {
            e.preventDefault();
            void signIn({ username, password });
          }}
        >
          <h1>Sign in</h1>
          <p className="muted">awui on another device needs your username and password.</p>
          <label className="login-field">
            <span>Username</span>
            <input className="input" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
          </label>
          <label className="login-field">
            <span>Password</span>
            <input className="input" name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {error ? (
            <p className="login-error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" className="btn btn-primary login-submit" disabled={busy || !username || !password}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      )}
    </div>
  );
}
