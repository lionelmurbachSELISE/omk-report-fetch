import { FormEvent, useState } from "react";
import { activateAccount } from "./selise";

interface Props {
  code: string;
}

export function ActivatePage({ code }: Props) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setLoading(true);
    try {
      await activateAccount(code, password);
      setDone(true);
      // Redirect to root (login) after short delay
      setTimeout(() => {
        window.location.href = "/";
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Activation failed.");
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-header">
            <h1>Account Activated</h1>
            <p>Your account is ready. Redirecting to sign in…</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <h1>Activate Account</h1>
          <p>Set a password to complete your account setup.</p>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          <div className="login-field">
            <label htmlFor="password">New Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Min. 8 characters"
              required
              autoComplete="new-password"
            />
          </div>

          <div className="login-field">
            <label htmlFor="confirm">Confirm Password</label>
            <input
              id="confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Repeat password"
              required
              autoComplete="new-password"
            />
          </div>

          {error && <div className="login-error">{error}</div>}

          <button className="primary login-submit" type="submit" disabled={loading}>
            {loading ? "Activating…" : "Activate Account"}
          </button>
        </form>
      </div>
    </div>
  );
}
