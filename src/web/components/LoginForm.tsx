// Sign-in for other devices (LAN via HOST=0.0.0.0, or Tailscale Serve).
// This machine never sees it: local requests need no sign-in. A limited
// invitation (grants.ts) arrives as ?invite=<id> in the link the invite UI
// hands over: the sign-in is then bound to it, and the session can only do
// what that invitation names.
import { useState } from "react";
import { api, ApiError, errorText } from "../api.js";

export function LoginForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const invite = new URLSearchParams(window.location.search).get("invite") ?? undefined;

  return (
    <div className="fullscreen-message">
      <form
        className="login-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api("/api/login", { body: { username, password, ...(invite ? { invite } : {}) } });
            window.location.reload();
          } catch (err) {
            setError(err instanceof ApiError && err.status === 401 ? "Wrong username or password" : errorText(err));
            setPassword("");
            setBusy(false);
          }
        }}
      >
        <h1>Sign in</h1>
        <p className="muted">{invite ? "awui on another device needs your username and password. This sign-in is limited to what its invitation allows." : "awui on another device needs your username and password."}</p>
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
    </div>
  );
}
