import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Channel } from "../shared/protocol";
import { api, messageOf } from "./api";

interface Props {
  channel?: Channel;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (error: unknown) => void;
}

export function ChannelDialog({ channel, onClose, onSaved, onError }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(channel?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(channel?.baseUrl ?? "");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  function finishClose() {
    dialog.current?.close();
    onClose();
  }

  function close() {
    if (busy) return;
    const dirty = name !== (channel?.name ?? "") || baseUrl !== (channel?.baseUrl ?? "") || !!token;
    if (dirty && !window.confirm("放弃这次渠道配置修改？")) return;
    finishClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const input = { name: name.trim(), baseUrl: baseUrl.trim(), ...(token ? { token } : {}) };
      await api(channel ? `/api/channels/${channel.id}` : "/api/channels", channel ? "PUT" : "POST", input);
      setToken("");
      await onSaved();
      finishClose();
    } catch (failure) {
      setError(messageOf(failure));
      onError(failure);
    } finally { setBusy(false); }
  }

  return <dialog className="channel-dialog" ref={dialog} aria-labelledby="channel-title" onCancel={event => { event.preventDefault(); close(); }}>
    <form onSubmit={submit}>
      <header className="dialog-header"><h2 id="channel-title">{channel ? "配置渠道" : "添加渠道"}</h2><button className="icon-button" type="button" aria-label="关闭渠道配置" onClick={close} disabled={busy}>×</button></header>
      <p className="muted">填写业务的基础地址和管理 Token，验证后自动读取提示词目录。</p>
      <label htmlFor="channel-name">渠道名称</label>
      <input id="channel-name" autoFocus required maxLength={100} value={name} onChange={event => setName(event.target.value)} disabled={busy} placeholder="例如，内容采集" />
      <label htmlFor="channel-url">基础地址</label>
      <input id="channel-url" type="url" required maxLength={2048} value={baseUrl} onChange={event => setBaseUrl(event.target.value)} disabled={busy} placeholder="https://service.example.com/api/prompt-management" />
      <p className="field-help">平台将在这个地址后追加 /v1/prompts。</p>
      <label htmlFor="channel-token">管理 Token{channel && "（留空保留现有凭据）"}</label>
      <input id="channel-token" type="password" autoComplete="new-password" required={!channel} minLength={16} maxLength={4096} value={token} onChange={event => setToken(event.target.value)} disabled={busy} />
      {error && <p className="feedback error" role="alert">{error}</p>}
      <footer className="dialog-actions"><button type="button" onClick={close} disabled={busy}>取消</button><button className="primary" type="submit" disabled={busy}>{busy ? "正在验证…" : "验证并保存"}</button></footer>
    </form>
  </dialog>;
}
