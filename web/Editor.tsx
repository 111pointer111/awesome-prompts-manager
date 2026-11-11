import { useState } from "react";
import type { Channel, ManagedPrompt, Prompt } from "../shared/protocol";
import { api, messageOf } from "./api";
import { contentDirty, newDraft, noteDirty } from "./drafts";
import type { Draft, DraftUpdate } from "./drafts";

interface Props {
  prompt: ManagedPrompt;
  channel: Channel;
  draft: Draft;
  onDraft: (update: DraftUpdate) => void;
  onContentSaved: (submitted: Pick<Draft, "content" | "revision">, saved: Prompt) => void;
  onNoteSaved: (submitted: Pick<Draft, "note" | "noteRevision">) => void;
  onRefresh: () => Promise<void>;
  onError: (error: unknown) => void;
}

export function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "尚未同步";
}

export function Editor({ prompt, channel, draft, onDraft, onContentSaved, onNoteSaved, onRefresh, onError }: Props) {
  const [saving, setSaving] = useState<"content" | "note" | null>(null);
  const changedRemotely = prompt.revision !== draft.revision;
  const noteChangedRemotely = prompt.noteRevision !== draft.noteRevision;
  const editable = !channel.error && prompt.active && !prompt.readOnly;
  const contentPath = `/api/channels/${encodeURIComponent(prompt.channelId)}/prompts/${encodeURIComponent(prompt.id)}`;

  async function saveContent(reset = false) {
    if (saving || !editable) return;
    if (reset && !window.confirm("恢复为当前业务部署提供的默认提示词？当前正文输入会被替换。")) return;
    setSaving("content");
    onDraft({ contentError: "", notice: "" });
    const submitted = { content: draft.content, revision: draft.revision };
    try {
      const saved = await api<Prompt>(contentPath, "PUT", { content: reset ? null : submitted.content, expectedRevision: submitted.revision });
      onContentSaved(submitted, saved);
      await onRefresh();
    } catch (error) {
      onDraft({ contentError: messageOf(error) });
      onError(error);
      await onRefresh().catch(() => undefined);
    } finally { setSaving(null); }
  }

  async function saveNote() {
    if (saving) return;
    setSaving("note");
    onDraft({ noteError: "", notice: "" });
    const submitted = { note: draft.note, noteRevision: draft.noteRevision };
    try {
      await api(contentPath + "/note", "PUT", { note: submitted.note, expectedRevision: submitted.noteRevision });
      onNoteSaved(submitted);
      await onRefresh();
    } catch (error) {
      onDraft({ noteError: messageOf(error) });
      onError(error);
      await onRefresh().catch(() => undefined);
    } finally { setSaving(null); }
  }

  function loadLatestContent() {
    if (contentDirty(draft) && !window.confirm("载入业务最新版会替换当前未保存的正文，继续？")) return;
    const latest = newDraft(prompt);
    onDraft({ content: latest.content, baseContent: latest.baseContent, revision: latest.revision, contentError: "", notice: "已载入业务最新版" });
  }

  function loadLatestNote() {
    if (noteDirty(draft) && !window.confirm("载入最新备注会替换当前未保存的备注，继续？")) return;
    onDraft({ note: prompt.note, baseNote: prompt.note, noteRevision: prompt.noteRevision, noteError: "" });
  }

  return <section className="editor" aria-labelledby="editor-title">
    <header className="editor-heading">
      <div className="eyebrow">{channel.name}<span aria-hidden="true"> / </span>{prompt.customized ? "自定义内容" : "默认内容"}</div>
      <h2 id="editor-title">{prompt.name}</h2>
      {prompt.description && <p className="editor-description">{prompt.description}</p>}
      <div className="metadata-line"><span>版本 {prompt.revision}</span><span>最近同步 {formatTime(channel.lastSyncedAt)}</span>{prompt.readOnly && <span>只读</span>}</div>
    </header>
    <div className="editor-body">
      {channel.error && <p className="feedback warning" role="status">渠道离线，当前为最近一次同步的内容。{channel.error}</p>}
      {!prompt.active && <p className="feedback warning" role="status">业务目录已移除此提示词，保留上次内容与备注。</p>}
      {changedRemotely && <div className="feedback warning" role="status"><p>业务已有新版本，当前未保存的正文已保留。载入新版后再继续编辑。</p><details><summary>查看业务最新版（版本 {prompt.revision}）</summary><pre className="comparison-content">{prompt.content}</pre></details><button type="button" onClick={loadLatestContent} disabled={!!saving}>载入业务最新版</button></div>}
      <div className="section-label"><label htmlFor="prompt-content">提示词正文</label>{contentDirty(draft) && <span className="unsaved">未保存</span>}</div>
      <textarea id="prompt-content" className="content-input" value={draft.content} maxLength={prompt.maxLength} readOnly={!editable} disabled={!!saving} spellCheck={false} onChange={event => onDraft({ content: event.target.value, contentError: "", notice: "" })} />
      <div className="editor-actions"><span className="field-help">{draft.content.length.toLocaleString()} / {prompt.maxLength.toLocaleString()} 字符</span><div><button type="button" onClick={() => void saveContent(true)} disabled={!editable || !!saving || changedRemotely}>恢复默认</button><button className="primary" type="button" onClick={() => void saveContent()} disabled={!editable || !!saving || changedRemotely || !contentDirty(draft) || !draft.content.trim()}>{saving === "content" ? "正在保存…" : "保存正文"}</button></div></div>
      {draft.contentError && <p className="feedback error" role="alert">{draft.contentError}</p>}
      {draft.notice && <p className="feedback success" role="status">{draft.notice}</p>}
      <p className="effect"><span>生效规则</span>{prompt.effect}</p>
      <details className="prompt-details"><summary>变量与组合关系</summary>
        {prompt.variables.length ? <dl className="variables">{prompt.variables.map(variable => <div key={variable.name}><dt><code>{variable.name}</code></dt><dd>{variable.description}</dd></div>)}</dl> : <p className="muted">此模板未声明运行时变量。</p>}
        {prompt.composition.length > 0 && <><h3>请求组合</h3><ul className="composition">{prompt.composition.map((part, index) => <li key={`${index}-${part}`}>{part}</li>)}</ul></>}
      </details>
      <details className="prompt-details"><summary>当前部署的默认正文</summary><pre className="default-content">{prompt.defaultContent}</pre></details>
      <section className="notes-section" aria-labelledby="note-label">
        <div className="section-label"><label id="note-label" htmlFor="prompt-note">备注</label>{noteDirty(draft) && <span className="unsaved">未保存</span>}</div>
        <p className="field-help">备注保存在管理平台，可参与搜索。</p>
        {noteChangedRemotely && <div className="feedback warning" role="status"><p>备注已在其他页面更新，当前输入已保留。</p><details><summary>查看最新备注</summary><pre className="comparison-content">{prompt.note || "（空备注）"}</pre></details><button type="button" onClick={loadLatestNote} disabled={!!saving}>载入最新备注</button></div>}
        <textarea id="prompt-note" className="note-input" maxLength={10000} rows={4} value={draft.note} disabled={!!saving} onChange={event => onDraft({ note: event.target.value, noteError: "", notice: "" })} placeholder="记录用途、调整原因或需要留意的地方" />
        <div className="note-actions"><button type="button" onClick={() => void saveNote()} disabled={!!saving || noteChangedRemotely || !noteDirty(draft)}>{saving === "note" ? "正在保存…" : "保存备注"}</button></div>
        {draft.noteError && <p className="feedback error" role="alert">{draft.noteError}</p>}
      </section>
    </div>
  </section>;
}
