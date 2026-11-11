import { useCallback, useEffect, useRef, useState } from "react";
import type { Channel, PlatformState, Prompt } from "../shared/protocol";
import { api, ApiError, messageOf } from "./api";
import { ChannelDialog } from "./ChannelDialog";
import { contentDirty, mergeContentSave, mergeNoteSave, newDraft, noteDirty, promptKey, reconcileDraft } from "./drafts";
import type { Draft, DraftUpdate } from "./drafts";
import { Editor } from "./Editor";
import { ImperialDesk } from "./ImperialDesk";
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
    const sameSession = () => authenticatedRef.current && startedAt === epoch.current;
    const isCurrent = () => sameSession() && requestId === refreshSequence.current;
    try {
      const next = await api<PlatformState>("/api/state");
      if (!isCurrent()) return;
      // Accepted reads keep FIFO order with saves, so a later save can compare the already-received version.
      setPlatform(previous => sameSession() ? next : previous);
      setDrafts(previous => {
        if (!sameSession()) return previous;
        const reconciled = { ...previous };
        for (const prompt of next.prompts) {
          const key = promptKey(prompt);
          const draft = previous[key];
          if (draft) reconciled[key] = reconcileDraft(draft, prompt);
        }
        return reconciled;
      });
    } catch (error) {
      if (isCurrent()) handleError(error);
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

  const selected = platform.prompts.find(prompt => promptKey(prompt) === selectedKey);
  const selectedChannel = selected ? platform.channels.find(channel => channel.id === selected.channelId) : undefined;
  const draft = selected ? drafts[promptKey(selected)] ?? newDraft(selected) : undefined;
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

  function contentSaved(submitted: Pick<Draft, "content" | "revision">, saved: Prompt) {
    if (!selected || !authenticatedRef.current || draftEpoch !== epoch.current) return;
    const key = promptKey(selected);
    refreshSequence.current += 1;
    setPlatform(previous => {
      if (!authenticatedRef.current || draftEpoch !== epoch.current) return previous;
      return { ...previous, prompts: previous.prompts.map(prompt => {
        if (promptKey(prompt) !== key || (prompt.revision !== submitted.revision && prompt.revision !== saved.revision)) return prompt;
        return { ...prompt, ...saved };
      }) };
    });
    updateDraft(current => mergeContentSave(current, submitted, saved));
  }

  function noteSaved(submitted: Pick<Draft, "note" | "noteRevision">) {
    if (!selected || !authenticatedRef.current || draftEpoch !== epoch.current) return;
    const key = promptKey(selected);
    const noteRevision = submitted.noteRevision + 1;
    refreshSequence.current += 1;
    setPlatform(previous => {
      if (!authenticatedRef.current || draftEpoch !== epoch.current) return previous;
      return { ...previous, prompts: previous.prompts.map(prompt => {
        if (promptKey(prompt) !== key || (prompt.noteRevision !== submitted.noteRevision && prompt.noteRevision !== noteRevision)) return prompt;
        return { ...prompt, note: submitted.note, noteRevision };
      }) };
    });
    updateDraft(current => mergeNoteSave(current, submitted));
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
      setDialog(null);
      setMessage("");
      setSyncRequested(false);
    } catch (error) { handleError(error); }
    finally { setLoggingOut(false); }
  }

  if (authenticated === null) return <main className="loading-page" role="status">正在加载…</main>;
  if (!authenticated) return <Login onLogin={loggedIn} message={message} />;

  return <>
    <ImperialDesk platform={platform} drafts={drafts} selectedKey={selectedKey} onSelect={setSelectedKey}
      onConfigure={channel => setDialog(channel ? { channel } : {})} onSync={() => void synchronize()}
      syncing={syncRequested || synchronizing} onLogout={() => void logout()} loggingOut={loggingOut}
      message={message} onDismissMessage={() => setMessage("")}>
      {selected && selectedChannel && draft && <Editor key={promptKey(selected)} prompt={selected} channel={selectedChannel} draft={draft} onDraft={updateDraft} onContentSaved={contentSaved} onNoteSaved={noteSaved} onRefresh={refreshCurrent} onError={handleCurrentError} />}
    </ImperialDesk>
    {dialog && <ChannelDialog key={dialog.channel?.id ?? "new"} channel={dialog.channel} onClose={() => setDialog(null)} onSaved={refreshCurrent} onError={handleCurrentError} />}
  </>;
}
