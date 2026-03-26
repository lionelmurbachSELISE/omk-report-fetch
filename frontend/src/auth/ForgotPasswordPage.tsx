import { FormEvent, useState } from "react";
import { forgotPassword } from "./selise";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await forgotPassword(email);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-header">
            <h1>Check your email</h1>
            <p>If an account exists for <strong>{email}</strong>, you'll receive a password reset link shortly.</p>
          </div>
          <button
            className="primary login-submit"
            style={{ marginTop: "1rem" }}
            onClick={() => (window.location.href = "/")}
          >
            Back to Sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <h1>Forgot Password</h1>
          <p>Enter your email and we'll send you a reset link.</p>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          <div className="login-field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              autoComplete="email"
            />
          </div>

          {error && <div className="login-error">{error}</div>}

          <button className="primary login-submit" type="submit" disabled={loading}>
            {loading ? "Sending…" : "Send Reset Link"}
          </button>
        </form>

        <p className="login-footer">
          <a href="/" style={{ color: "inherit" }}>← Back to Sign in</a>
        </p>
      </div>
    </div>
  );
}
