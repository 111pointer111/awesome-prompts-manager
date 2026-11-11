import type { ManagedPrompt, Prompt } from "../shared/protocol";

export interface Draft {
  content: string;
  baseContent: string;
  revision: string;
  note: string;
  baseNote: string;
  noteRevision: number;
  contentError: string;
  noteError: string;
  notice: string;
}

export type DraftUpdate = Partial<Draft> | ((current: Draft) => Draft);

export function promptKey(prompt: Pick<ManagedPrompt, "channelId" | "id">): string {
  return `${prompt.channelId}/${prompt.id}`;
}

export function newDraft(prompt: ManagedPrompt): Draft {
  return {
    content: prompt.content, baseContent: prompt.content, revision: prompt.revision,
    note: prompt.note, baseNote: prompt.note, noteRevision: prompt.noteRevision,
    contentError: "", noteError: "", notice: "",
  };
}

export function contentDirty(draft: Draft): boolean {
  return draft.content !== draft.baseContent;
}

export function noteDirty(draft: Draft): boolean {
  return draft.note !== draft.baseNote;
}

export function mergeContentSave(current: Draft, submitted: Pick<Draft, "content" | "revision">, saved: Pick<Prompt, "content" | "revision">): Draft {
  if (current.revision !== submitted.revision && current.revision !== saved.revision) return current;
  const hasLaterInput = current.content !== submitted.content;
  return {
    ...current,
    content: hasLaterInput ? current.content : saved.content,
    baseContent: saved.content,
    revision: saved.revision,
    contentError: "",
    notice: hasLaterInput ? `已保存为第 ${saved.revision} 版，后续输入仍未保存` : `已保存为第 ${saved.revision} 版`,
  };
}

export function mergeNoteSave(current: Draft, submitted: Pick<Draft, "note" | "noteRevision">): Draft {
  const savedRevision = submitted.noteRevision + 1;
  if (current.noteRevision !== submitted.noteRevision && current.noteRevision !== savedRevision) return current;
  return {
    ...current,
    baseNote: submitted.note,
    noteRevision: savedRevision,
    noteError: "",
    notice: current.note === submitted.note ? "备注已保存" : "已保存提交的备注，后续输入仍未保存",
  };
}

export function reconcileDraft(draft: Draft, prompt: ManagedPrompt): Draft {
  return {
    ...draft,
    ...(!contentDirty(draft) ? { content: prompt.content, baseContent: prompt.content, revision: prompt.revision } : {}),
    ...(!noteDirty(draft) ? { note: prompt.note, baseNote: prompt.note, noteRevision: prompt.noteRevision } : {}),
  };
}

export function matchesPrompt(prompt: ManagedPrompt, channelName: string, query: string): boolean {
  const text = [channelName, prompt.name, prompt.description, prompt.content, prompt.note].join("\n").normalize("NFKC").toLocaleLowerCase();
  return query.normalize("NFKC").toLocaleLowerCase().trim().split(/\s+/u).every(word => text.includes(word));
}
