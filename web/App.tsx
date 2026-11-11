import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Channel, PlatformState } from "../shared/protocol";
import { api, ApiError, messageOf } from "./api";
import { ChannelDialog } from "./ChannelDialog";
import { contentDirty, matchesPrompt, newDraft, noteDirty, promptKey, reconcileDraft } from "./drafts";
import type { Draft, DraftUpdate } from "./drafts";
import { Editor, formatTime } from "./Editor";
import { Login } from "./Login";

const emptyState: PlatformState = { channels: [], prompts: [] };

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const authenticatedRef = useRef(false);
  const epoch = useRef(0);
  const refreshSequence = useRef(0);
  const [platform, setPlatform] = useState<PlatformState>(emptyState);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [channelFilter, setChannelFilter] = useState("");
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const [dialog, setDialog] = useState<{ channel?: Channel } | null>(null);
  const [syncRequested, setSyncRequested] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const handleError = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.code === "login_required") {
      epoch.current += 1;
      refreshSequence.current += 1;
      authenticatedRef.current = false;
      setAuthenticated(false);
      setPlatform(emptyState);
      setDialog(null);
      setMessage("登录已过期，重新登录后可以继续编辑未保存内容。");
      return;
    }
    setMessage(messageOf(error));
  }, []);

  const refresh = useCallback(async () => {
    const startedAt = epoch.current;
    const requestId = ++refreshSequence.current;
    try {
      const next = await api<PlatformState>("/api/state");
      if (!authenticatedRef.current || startedAt !== epoch.current || requestId !== refreshSequence.current) return;
      setPlatform(next);
      setDrafts(previous => {
        const reconciled = { ...previous };
        for (const prompt of next.prompts) {
          const key = promptKey(prompt);
          const draft = previous[key];
          if (draft) reconciled[key] = reconcileDraft(draft, prompt);
        }
        return reconciled;
      });
    } catch (error) {
      if (startedAt === epoch.current && authenticatedRef.current && requestId === refreshSequence.current) handleError(error);
    }
  }, [handleError]);

  const synchronize = useCallback(async () => {
    if (!authenticatedRef.current) return;
    const startedAt = epoch.current;
    setSyncRequested(true);
    try {
      await api("/api/sync", "POST");
      if (startedAt === epoch.current) await refresh();
    } catch (error) {
      if (startedAt === epoch.current) handleError(error);
    } finally {
      if (startedAt === epoch.current) setSyncRequested(false);
    }
  }, [handleError, refresh]);

  useEffect(() => {
    let active = true;
    void api<{ authenticated: boolean }>("/api/session").then(session => {
      if (!active) return;
      authenticatedRef.current = session.authenticated;
      setAuthenticated(session.authenticated);
    }).catch(error => {
      if (active) { setAuthenticated(false); setMessage(messageOf(error)); }
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    void refresh().then(() => synchronize());
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void synchronize();
    }, 60000);
    return () => window.clearInterval(interval);
  }, [authenticated, refresh, synchronize]);

  const synchronizing = platform.channels.some(channel => channel.syncing);
  useEffect(() => {
    if (!authenticated || !synchronizing) return;
    let active = true;
    let timeout: number;
    const poll = async () => {
      await refresh();
      if (active) timeout = window.setTimeout(() => { void poll(); }, 1500);
    };
    timeout = window.setTimeout(() => { void poll(); }, 1500);
    return () => { active = false; window.clearTimeout(timeout); };
  }, [authenticated, synchronizing, refresh]);

  const hasDrafts = Object.values(drafts).some(draft => contentDirty(draft) || noteDirty(draft));
  useEffect(() => {
    if (!hasDrafts) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasDrafts]);

  const channelNames = useMemo(() => new Map(platform.channels.map(channel => [channel.id, channel.name])), [platform.channels]);
  const visible = useMemo(() => platform.prompts.filter(prompt =>
    (!channelFilter || prompt.channelId === channelFilter) && matchesPrompt(prompt, channelNames.get(prompt.channelId) ?? "", query)
  ), [platform.prompts, channelFilter, channelNames, query]);
  const selected = platform.prompts.find(prompt => promptKey(prompt) === selectedKey) ?? (selectedKey === null ? visible[0] : undefined);
  const selectedChannel = selected ? platform.channels.find(channel => channel.id === selected.channelId) : undefined;
  const draft = selected ? drafts[promptKey(selected)] ?? newDraft(selected) : undefined;
  const filteredChannel = platform.channels.find(channel => channel.id === channelFilter);
  const draftEpoch = epoch.current;

  function updateDraft(update: DraftUpdate) {
    if (!selected || !authenticatedRef.current || draftEpoch !== epoch.current) return;
    const key = promptKey(selected);
    setDrafts(previous => {
      if (!authenticatedRef.current || draftEpoch !== epoch.current) return previous;
      const current = previous[key] ?? newDraft(selected);
      return { ...previous, [key]: typeof update === "function" ? update(current) : { ...current, ...update } };
    });
  }

  function handleCurrentError(error: unknown) {
    if (draftEpoch === epoch.current && authenticatedRef.current) handleError(error);
  }

  function refreshCurrent() {
    return draftEpoch === epoch.current && authenticatedRef.current ? refresh() : Promise.resolve();
  }

  function loggedIn() {
    epoch.current += 1;
    refreshSequence.current += 1;
    authenticatedRef.current = true;
    setSyncRequested(false);
    setMessage("");
    setAuthenticated(true);
  }

  async function logout() {
    if (loggingOut || (hasDrafts && !window.confirm("退出会清除所有未保存的输入，继续退出？"))) return;
    setLoggingOut(true);
    try {
      await api("/api/logout", "POST");
      epoch.current += 1;
      refreshSequence.current += 1;
      authenticatedRef.current = false;
      setAuthenticated(false);
      setPlatform(emptyState);
      setDrafts({});
      setSelectedKey(null);
      setChannelFilter("");
      setQuery("");
      setDialog(null);
      setMessage("");
      setSyncRequested(false);
    } catch (error) { handleError(error); }
    finally { setLoggingOut(false); }
  }

  if (authenticated === null) return <main className="loading-page" role="status">正在加载…</main>;
  if (!authenticated) return <Login onLogin={loggedIn} message={message} />;

  return <div className="app-shell">
    <aside className="sidebar" aria-label="渠道导航">
      <a className="brand" href="#" onClick={event => { event.preventDefault(); setChannelFilter(""); }}><span className="brand-mark" aria-hidden="true">p.</span><span>Prompts</span></a>
      <nav className="channel-navigation">
        <button className={`all-prompts ${!channelFilter ? "selected" : ""}`} type="button" onClick={() => setChannelFilter("")} aria-current={!channelFilter ? "page" : undefined}><span>全部提示词</span><span className="count">{platform.prompts.length}</span></button>
        <div className="nav-heading"><h2>渠道</h2><button className="icon-button" type="button" aria-label="添加渠道" title="添加渠道" onClick={() => setDialog({})}>＋</button></div>
        {platform.channels.length === 0 && <p className="nav-empty">添加业务地址，读取提示词目录。</p>}
        {platform.channels.map(channel => <div className={`channel-row ${channelFilter === channel.id ? "selected" : ""}`} key={channel.id}>
          <button className="channel-filter" type="button" onClick={() => setChannelFilter(channel.id)} aria-current={channelFilter === channel.id ? "page" : undefined}>
            <span className={`status-dot ${channel.error ? "offline" : channel.syncing ? "syncing" : "online"}`} aria-hidden="true" />
            <span className="channel-label"><span>{channel.name}</span><small>{channel.syncing ? "同步中" : channel.error ? "离线" : "已连接"}</small></span>
          </button>
          <button className="channel-config" type="button" aria-label={`配置${channel.name}`} onClick={() => setDialog({ channel })}>配置</button>
        </div>)}
      </nav>
      <footer className="sidebar-footer"><p>页面使用期间每 60 秒同步</p><button type="button" className="text-button" onClick={() => void logout()} disabled={loggingOut}>{loggingOut ? "正在退出…" : "退出登录"}</button></footer>
    </aside>

    <main className="workspace">
      <header className="workspace-header"><div><p className="eyebrow">提示词管理</p><h1>{filteredChannel?.name ?? "全部提示词"}</h1></div><button className="sync-button" type="button" onClick={() => void synchronize()} disabled={syncRequested || synchronizing}>{syncRequested || synchronizing ? "正在同步…" : "同步目录"}</button></header>
      {message && <div className="global-message" role="status"><span>{message}</span><button className="icon-button" type="button" aria-label="关闭提示" onClick={() => setMessage("")}>×</button></div>}
      <div className="working-area">
        <section className="prompt-browser" aria-label="提示词列表">
          <div className="search-area"><label className="visually-hidden" htmlFor="prompt-search">搜索提示词</label><input id="prompt-search" type="search" placeholder="搜索名称、正文或备注" value={query} onChange={event => setQuery(event.target.value)} /><div className="result-caption"><span>{visible.length} 条提示词</span>{query && <button className="text-button" type="button" onClick={() => setQuery("")}>清除搜索</button>}</div></div>
          {filteredChannel?.error && <p className="source-warning">{filteredChannel.error}<span>最近同步 {formatTime(filteredChannel.lastSyncedAt)}</span></p>}
          <div className="prompt-list">
            {visible.map(prompt => {
              const key = promptKey(prompt);
              const localDraft = drafts[key];
              const dirty = localDraft && (contentDirty(localDraft) || noteDirty(localDraft));
              const source = platform.channels.find(channel => channel.id === prompt.channelId);
              return <button className={`prompt-row ${selected && promptKey(selected) === key ? "selected" : ""}`} key={key} type="button" onClick={() => setSelectedKey(key)} aria-pressed={!!selected && promptKey(selected) === key}>
                <span className="prompt-source">{source?.name}{!prompt.active && " · 已移除"}{source?.error && " · 离线"}</span>
                <span className="prompt-name">{prompt.name}{dirty && <span className="draft-dot" title="有未保存内容" aria-label="有未保存内容" />}</span>
                <span className="prompt-description">{prompt.description || prompt.content}</span>
                {prompt.note && <span className="prompt-note-preview">备注 · {prompt.note}</span>}
                <span className="prompt-row-footer"><span>{prompt.customized ? "已自定义" : "默认内容"}</span><span>v{prompt.revision}</span></span>
              </button>;
            })}
            {visible.length === 0 && <div className="empty-state"><h2>{platform.channels.length === 0 ? "接入第一个业务" : "没有匹配的提示词"}</h2><p>{platform.channels.length === 0 ? "配置业务地址和 Token，自动读取可管理的提示词。" : query ? "试试其他关键词，或清除搜索条件。" : "同步目录，或选择其他渠道查看。"}</p>{platform.channels.length === 0 && <button className="primary" type="button" onClick={() => setDialog({})}>添加渠道</button>}</div>}
          </div>
        </section>
        {selected && selectedChannel && draft ? <Editor key={promptKey(selected)} prompt={selected} channel={selectedChannel} draft={draft} onDraft={updateDraft} onRefresh={refreshCurrent} onError={handleCurrentError} /> : <section className="editor empty-editor"><div><h2>选择一条提示词</h2><p>查看正文、运行时变量和备注。</p></div></section>}
      </div>
    </main>
    {dialog && <ChannelDialog key={dialog.channel?.id ?? "new"} channel={dialog.channel} onClose={() => setDialog(null)} onSaved={refreshCurrent} onError={handleCurrentError} />}
  </div>;
}
