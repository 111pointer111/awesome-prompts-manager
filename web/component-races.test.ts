import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ManagedPrompt, PlatformState, Prompt } from "../shared/protocol";
import { contentDirty, mergeContentSave, mergeNoteSave, newDraft, noteDirty, promptKey, reconcileDraft } from "./drafts";
import type { Draft, DraftUpdate } from "./drafts";

const prompt: ManagedPrompt = {
  id: "p", channelId: "c", name: "P", description: "", content: "old", defaultContent: "old", revision: "0",
  customized: false, readOnly: false, maxLength: 16000, variables: [], composition: [], effect: "next",
  note: "old note", noteRevision: 0, active: true,
};
const key = promptKey(prompt);
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const editor = readFileSync(new URL("./Editor.tsx", import.meta.url), "utf8");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

function draftState(initial: Draft) {
  const context = { drafts: { [key]: initial } as Record<string, Draft>, epoch: { current: 1 }, authenticated: { current: true } };
  const begin = app.indexOf("  function updateDraft(");
  const text = app.slice(begin, app.indexOf("\n\n  function ", begin + 10))
    .replace(/update: (?:Partial<Draft>|DraftUpdate)/, "update");
  const onDraft = new Function("selected", "authenticatedRef", "epoch", "draftEpoch", "promptKey", "newDraft", "setDrafts", text + "; return updateDraft;")(
    prompt, context.authenticated, context.epoch, 1, promptKey, newDraft,
    (update: (previous: Record<string, Draft>) => Record<string, Draft>) => { context.drafts = update(context.drafts); },
  ) as (update: DraftUpdate) => void;
  return { context, onDraft };
}

function saveHandler(kind: "content" | "note", submitted: Draft, onDraft: (update: DraftUpdate) => void, response: Promise<unknown>) {
  const begin = kind === "content" ? "  async function saveContent" : "  async function saveNote";
  const end = kind === "content" ? "  async function saveNote" : "  function loadLatestContent";
  const text = editor.slice(editor.indexOf(begin), editor.indexOf(end)).replace("api<Prompt>", "api");
  return new Function("api", "saving", "editable", "setSaving", "onDraft", "draft", "contentPath", "onRefresh", "onError", "messageOf", "mergeContentSave", "mergeNoteSave", text + `; return ${kind === "content" ? "saveContent" : "saveNote"};`)(
    () => response, null, true, () => undefined, onDraft, submitted, "/prompt", async () => undefined,
    () => undefined, String, mergeContentSave, mergeNoteSave,
  ) as () => Promise<void>;
}

test("旧正文保存返回时，保留切换条目后继续输入的正文", async () => {
  const submitted = { ...newDraft(prompt), content: "first edit" };
  const { context, onDraft } = draftState(submitted);
  const response = deferred<Prompt>();
  const save = saveHandler("content", { ...submitted }, onDraft, response.promise);
  const pending = save();
  onDraft({ content: "later edit after switching away and back" });
  response.resolve({ ...prompt, content: "first edit", revision: "1" });
  await pending;
  assert.equal(context.drafts[key]?.content, "later edit after switching away and back");
  assert.equal(context.drafts[key]?.baseContent, "first edit");
  assert.equal(context.drafts[key]?.revision, "1");
  assert.equal(contentDirty(context.drafts[key]!), true);
});

test("旧备注保存返回时，保留后续备注输入并更新已保存基线", async () => {
  const submitted = { ...newDraft(prompt), note: "submitted note" };
  const { context, onDraft } = draftState(submitted);
  const response = deferred<{ saved: boolean }>();
  const pending = saveHandler("note", { ...submitted }, onDraft, response.promise)();
  onDraft({ note: "later note after switching" });
  response.resolve({ saved: true });
  await pending;
  assert.equal(context.drafts[key]?.note, "later note after switching");
  assert.equal(context.drafts[key]?.baseNote, "submitted note");
  assert.equal(context.drafts[key]?.noteRevision, 1);
  assert.equal(noteDirty(context.drafts[key]!), true);
});

test("保存响应到达前已有更高版本时，保留更新的正文和备注基线", async () => {
  const submitted = { ...newDraft(prompt), content: "first edit", note: "first note" };
  const { context, onDraft } = draftState(submitted);
  const contentResponse = deferred<Prompt>();
  const noteResponse = deferred<{ saved: boolean }>();
  const pendingContent = saveHandler("content", { ...submitted }, onDraft, contentResponse.promise)();
  const pendingNote = saveHandler("note", { ...submitted }, onDraft, noteResponse.promise)();
  onDraft({ content: "newer content", baseContent: "newer content", revision: "2", note: "newer note", baseNote: "newer note", noteRevision: 2 });
  contentResponse.resolve({ ...prompt, content: "first edit", revision: "1" });
  noteResponse.resolve({ saved: true });
  await Promise.all([pendingContent, pendingNote]);
  assert.equal(context.drafts[key]?.content, "newer content");
  assert.equal(context.drafts[key]?.baseContent, "newer content");
  assert.equal(context.drafts[key]?.revision, "2");
  assert.equal(context.drafts[key]?.baseNote, "newer note");
  assert.equal(context.drafts[key]?.noteRevision, 2);
});

test("登出并重新登录后，旧 Editor 保存回调不会恢复已清除的草稿", async () => {
  const submitted = { ...newDraft(prompt), content: "private draft" };
  const { context, onDraft } = draftState(submitted);
  const response = deferred<Prompt>();
  const pending = saveHandler("content", { ...submitted }, onDraft, response.promise)();
  context.epoch.current = 2;
  context.authenticated.current = false;
  context.drafts = {};
  context.epoch.current = 3;
  context.authenticated.current = true;
  response.resolve({ ...prompt, content: "private draft", revision: "1" });
  await pending;
  assert.deepEqual(context.drafts, {});
});

function refreshState() {
  const context = {
    platform: { channels: [], prompts: [prompt] } as PlatformState,
    drafts: { [key]: newDraft(prompt) }, epoch: { current: 1 }, authenticated: { current: true },
    sequence: { current: 0 }, responses: [] as ReturnType<typeof deferred<PlatformState>>[], errors: [] as unknown[],
  };
  const text = app.slice(app.indexOf("  const refresh = useCallback"), app.indexOf("\n\n  const synchronize"))
    .replace("api<PlatformState>", "api");
  const refresh = new Function("useCallback", "epoch", "refreshSequence", "api", "authenticatedRef", "setPlatform", "setDrafts", "promptKey", "reconcileDraft", "handleError", text + "; return refresh;")(
    (fn: unknown) => fn, context.epoch, context.sequence,
    () => { const response = deferred<PlatformState>(); context.responses.push(response); return response.promise; },
    context.authenticated, (next: PlatformState) => { context.platform = next; },
    (update: (previous: Record<string, Draft>) => Record<string, Draft>) => { context.drafts = update(context.drafts); },
    promptKey, reconcileDraft, (error: unknown) => { context.errors.push(error); },
  ) as () => Promise<void>;
  return { context, refresh };
}

test("同一登录会话的刷新响应乱序时，旧响应不能回退提示词版本", async () => {
  const { context, refresh } = refreshState();
  const older = refresh();
  const newer = refresh();
  context.responses[1]!.resolve({ channels: [], prompts: [{ ...prompt, content: "newest", revision: "1" }] });
  await newer;
  context.responses[0]!.resolve({ channels: [], prompts: [prompt] });
  await older;
  assert.equal(context.platform.prompts[0]?.revision, "1");
  assert.equal(context.drafts[key]?.content, "newest");
});

test("过时刷新请求的错误不能覆盖最新请求结果", async () => {
  const { context, refresh } = refreshState();
  const older = refresh();
  const newer = refresh();
  context.responses[1]!.resolve({ channels: [], prompts: [{ ...prompt, revision: "1" }] });
  await newer;
  context.responses[0]!.reject(new Error("old request failed"));
  await older;
  assert.deepEqual(context.errors, []);
});

test("登录会话改变后，旧刷新响应失效", async () => {
  const { context, refresh } = refreshState();
  const pending = refresh();
  context.epoch.current += 1;
  context.responses[0]!.resolve({ channels: [], prompts: [{ ...prompt, revision: "1" }] });
  await pending;
  assert.equal(context.platform.prompts[0]?.revision, "0");
});
