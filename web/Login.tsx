import { useState } from "react";
import type { FormEvent } from "react";
import { api, messageOf } from "./api";

export function Login({ onLogin, message }: { onLogin: () => void; message: string }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/login", "POST", { username, password });
      setPassword("");
      onLogin();
    } catch (failure) { setError(messageOf(failure)); }
    finally { setBusy(false); }
  }

  return <main className="login-page">
    <div className="login-brand"><span className="brand-seal" aria-hidden="true">御</span><span>水墨御案</span></div>
    <form className="login-form" onSubmit={submit}>
      <h1>登录提示词管理</h1>
      <p className="muted">使用管理员账户访问你的业务渠道。</p>
      {message && <p className="feedback warning" role="status">{message}</p>}
      <label htmlFor="username">账号</label>
      <input id="username" name="username" autoComplete="username" required maxLength={100} value={username} onChange={event => setUsername(event.target.value)} disabled={busy} />
      <label htmlFor="password">密码</label>
      <input id="password" name="password" type="password" autoComplete="current-password" required maxLength={1024} value={password} onChange={event => setPassword(event.target.value)} disabled={busy} />
      {error && <p className="feedback error" role="alert">{error}</p>}
      <button className="primary login-submit" type="submit" disabled={busy}>{busy ? "正在登录…" : "登录"}</button>
    </form>
    <p className="login-footer">awesome-prompts-manager</p>
  </main>;
}
