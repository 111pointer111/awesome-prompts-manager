import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
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

function draftState(initial: Draft, queued?: (() => void)[]) {
  const apply = (operation: () => void) => { if (queued) queued.push(operation); else operation(); };
  const context = {
    platform: { channels: [], prompts: [prompt] } as PlatformState,
    drafts: { [key]: initial } as Record<string, Draft>, epoch: { current: 1 }, authenticated: { current: true },
    sequence: { current: 0 }, responses: [] as ReturnType<typeof deferred<PlatformState>>[], errors: [] as unknown[],
    apply,
  };
  const begin = app.indexOf("  function updateDraft(");
  const text = app.slice(begin, app.indexOf("\n\n  function ", begin + 10))
    .replace(/update: (?:Partial<Draft>|DraftUpdate)/, "update");
  const onDraft = new Function("selected", "authenticatedRef", "epoch", "draftEpoch", "promptKey", "newDraft", "setDrafts", text + "; return updateDraft;")(
    prompt, context.authenticated, context.epoch, 1, promptKey, newDraft,
    (update: (previous: Record<string, Draft>) => Record<string, Draft>) => { apply(() => { context.drafts = update(context.drafts); }); },
  ) as (update: DraftUpdate) => void;
  function handler(name: "contentSaved" | "noteSaved") {
    const begin = app.indexOf(`  function ${name}(`);
    const text = app.slice(begin, app.indexOf("\n\n  function ", begin + 10));
    const javascript = ts.transpile(text, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None });
    return new Function("selected", "authenticatedRef", "epoch", "draftEpoch", "promptKey", "refreshSequence", "setPlatform", "updateDraft", "mergeContentSave", "mergeNoteSave", javascript + `; return ${name};`)(
      prompt, context.authenticated, context.epoch, 1, promptKey, context.sequence,
      (update: (previous: PlatformState) => PlatformState) => { apply(() => { context.platform = update(context.platform); }); },
      onDraft, mergeContentSave, mergeNoteSave,
    );
  }
  return {
    context, onDraft,
    onContentSaved: handler("contentSaved") as (submitted: Pick<Draft, "content" | "revision">, saved: Prompt) => void,
    onNoteSaved: handler("noteSaved") as (submitted: Pick<Draft, "note" | "noteRevision">) => void,
  };
}

function saveHandler(kind: "content" | "note", submitted: Draft, onDraft: (update: DraftUpdate) => void, response: Promise<unknown>, callbacks: {
  onContentSaved: (submitted: Pick<Draft, "content" | "revision">, saved: Prompt) => void;
  onNoteSaved: (submitted: Pick<Draft, "note" | "noteRevision">) => void;
  onRefresh?: () => Promise<void>;
}) {
  const begin = kind === "content" ? "  async function saveContent" : "  async function saveNote";
  const end = kind === "content" ? "  async function saveNote" : "  function loadLatestContent";
  const text = editor.slice(editor.indexOf(begin), editor.indexOf(end)).replace("api<Prompt>", "api");
  return new Function("api", "saving", "editable", "setSaving", "onDraft", "draft", "contentPath", "onRefresh", "onError", "messageOf", "onContentSaved", "onNoteSaved", text + `; return ${kind === "content" ? "saveContent" : "saveNote"};`)(
    () => response, null, true, () => undefined, onDraft, submitted, "/prompt", callbacks.onRefresh ?? (async () => undefined),
    () => undefined, String, callbacks.onContentSaved, callbacks.onNoteSaved,
  ) as () => Promise<void>;
}

test("旧正文保存返回时，保留切换条目后继续输入的正文", async () => {
  const submitted = { ...newDraft(prompt), content: "first edit" };
  const state = draftState(submitted);
  const { context, onDraft } = state;
  const response = deferred<Prompt>();
  const save = saveHandler("content", { ...submitted }, onDraft, response.promise, state);
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
  const state = draftState(submitted);
  const { context, onDraft } = state;
  const response = deferred<{ saved: boolean }>();
  const pending = saveHandler("note", { ...submitted }, onDraft, response.promise, state)();
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
  const state = draftState(submitted);
  const { context, onDraft } = state;
  const contentResponse = deferred<Prompt>();
  const noteResponse = deferred<{ saved: boolean }>();
  const pendingContent = saveHandler("content", { ...submitted }, onDraft, contentResponse.promise, state)();
  const pendingNote = saveHandler("note", { ...submitted }, onDraft, noteResponse.promise, state)();
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
  const state = draftState(submitted);
  const { context, onDraft } = state;
  const response = deferred<Prompt>();
  const pending = saveHandler("content", { ...submitted }, onDraft, response.promise, state)();
  context.epoch.current = 2;
  context.authenticated.current = false;
  context.drafts = {};
  context.epoch.current = 3;
  context.authenticated.current = true;
  response.resolve({ ...prompt, content: "private draft", revision: "1" });
  await pending;
  assert.deepEqual(context.drafts, {});
});

function refreshState(context = draftState(newDraft(prompt)).context) {
  const text = app.slice(app.indexOf("  const refresh = useCallback"), app.indexOf("\n\n  const synchronize"))
    .replace("api<PlatformState>", "api");
  const refresh = new Function("useCallback", "epoch", "refreshSequence", "api", "authenticatedRef", "setPlatform", "setDrafts", "promptKey", "reconcileDraft", "handleError", text + "; return refresh;")(
    (fn: unknown) => fn, context.epoch, context.sequence,
    () => { const response = deferred<PlatformState>(); context.responses.push(response); return response.promise; },
    context.authenticated, (update: PlatformState | ((previous: PlatformState) => PlatformState)) => { context.apply(() => { context.platform = typeof update === "function" ? update(context.platform) : update; }); },
    (update: (previous: Record<string, Draft>) => Record<string, Draft>) => { context.apply(() => { context.drafts = update(context.drafts); }); },
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

test("保存确认立即更新目录版本，后续目录读取延迟时不产生假冲突", async () => {
  const submitted = { ...newDraft(prompt), content: "new content" };
  const state = draftState(submitted);
  const response = deferred<Prompt>();
  const refreshed = deferred<void>();
  let waitingForRefresh = false;
  const pending = saveHandler("content", submitted, state.onDraft, response.promise, {
    ...state,
    onRefresh: () => { waitingForRefresh = true; return refreshed.promise; },
  })();
  response.resolve({ ...prompt, content: submitted.content, revision: `1:${"a".repeat(64)}` });
  await Promise.resolve();
  try {
    assert.equal(waitingForRefresh, true);
    assert.equal(state.context.platform.prompts[0]?.revision, state.context.drafts[key]?.revision);
    assert.equal(state.context.platform.prompts[0]?.content, submitted.content);
  } finally { refreshed.resolve(); await pending; }
});

test("备注保存确认立即更新目录备注版本，保留保存后的输入", async () => {
  const submitted = { ...newDraft(prompt), note: "submitted note" };
  const state = draftState(submitted);
  const response = deferred<{ saved: boolean }>();
  const refreshed = deferred<void>();
  const pending = saveHandler("note", submitted, state.onDraft, response.promise, {
    ...state, onRefresh: () => refreshed.promise,
  })();
  state.onDraft({ note: "later note" });
  response.resolve({ saved: true });
  await Promise.resolve();
  try {
    assert.equal(state.context.platform.prompts[0]?.noteRevision, state.context.drafts[key]?.noteRevision);
    assert.equal(state.context.platform.prompts[0]?.note, submitted.note);
    assert.equal(state.context.drafts[key]?.note, "later note");
  } finally { refreshed.resolve(); await pending; }
});

test("保存确认使此前发出的目录读取失效，旧目录不能回退保存版本", async () => {
  const submitted = { ...newDraft(prompt), content: "new content" };
  const state = draftState(submitted);
  const { refresh } = refreshState(state.context);
  const oldRefresh = refresh();
  const response = deferred<Prompt>();
  const pending = saveHandler("content", submitted, state.onDraft, response.promise, state)();
  const saved = { ...prompt, content: submitted.content, revision: `1:${"b".repeat(64)}` };
  response.resolve(saved);
  await pending;
  state.context.responses[0]!.resolve({ channels: [], prompts: [prompt] });
  await oldRefresh;
  assert.equal(state.context.platform.prompts[0]?.revision, saved.revision);
  assert.equal(state.context.drafts[key]?.revision, saved.revision);
});

test("按 FIFO 应用旧目录 0 与后续保存 1，最终保留保存确认版本", async () => {
  const submitted = { ...newDraft(prompt), content: "new content" };
  const queued: (() => void)[] = [];
  const state = draftState(submitted, queued);
  const { refresh } = refreshState(state.context);
  const oldRefresh = refresh();
  state.context.responses[0]!.resolve({ channels: [], prompts: [prompt] });
  await oldRefresh;
  const saved = { ...prompt, content: submitted.content, revision: `1:${"c".repeat(64)}` };
  state.onContentSaved(submitted, saved);
  for (const update of queued) update();
  assert.equal(state.context.platform.prompts[0]?.revision, saved.revision);
  assert.equal(state.context.drafts[key]?.revision, saved.revision);
});

test("按 FIFO 应用较新目录 2 与迟到保存 1，刷新失败仍保留新版和后续输入", async () => {
  const submitted = { ...newDraft(prompt), content: "submitted A" };
  const queued: (() => void)[] = [];
  const state = draftState(submitted, queued);
  const { refresh } = refreshState(state.context);
  const response = deferred<Prompt>();
  const pending = saveHandler("content", submitted, state.onDraft, response.promise, { ...state, onRefresh: refresh })();
  const sync = refresh();
  const newer = { ...prompt, content: "newer B", revision: "2" };
  state.context.responses[0]!.resolve({ channels: [], prompts: [newer] });
  await sync;
  state.onDraft({ content: "later C" });
  response.resolve({ ...prompt, content: submitted.content, revision: "1" });
  await Promise.resolve();
  state.context.responses[1]!.reject(new Error("follow-up refresh failed"));
  await pending;
  for (const update of queued) update();
  assert.equal(state.context.platform.prompts[0]?.revision, "2");
  assert.equal(state.context.platform.prompts[0]?.content, "newer B");
  assert.equal(state.context.drafts[key]?.content, "later C");
  assert.equal(state.context.drafts[key]?.baseContent, submitted.content);
  assert.equal(state.context.drafts[key]?.revision, "1");
  assert.equal(contentDirty(state.context.drafts[key]!), true);
  assert.equal(state.context.errors.length, 1);
});

test("较新备注 2 入队后迟到保存 1，按 FIFO 保留新版备注与后续草稿", async () => {
  const submitted = { ...newDraft(prompt), note: "submitted note A" };
  const queued: (() => void)[] = [];
  const state = draftState(submitted, queued);
  const { refresh } = refreshState(state.context);
  const pending = refresh();
  state.context.responses[0]!.resolve({ channels: [], prompts: [{ ...prompt, note: "newer note B", noteRevision: 2 }] });
  await pending;
  state.onDraft({ note: "later note C" });
  state.onNoteSaved(submitted);
  for (const update of queued) update();
  assert.equal(state.context.platform.prompts[0]?.noteRevision, 2);
  assert.equal(state.context.platform.prompts[0]?.note, "newer note B");
  assert.equal(state.context.drafts[key]?.note, "later note C");
  assert.equal(state.context.drafts[key]?.baseNote, submitted.note);
  assert.equal(state.context.drafts[key]?.noteRevision, 1);
  assert.equal(noteDirty(state.context.drafts[key]!), true);
});

test("已接收目录的 FIFO 更新仍在会话改变时失效", async () => {
  const queued: (() => void)[] = [];
  const state = draftState(newDraft(prompt), queued);
  const { refresh } = refreshState(state.context);
  const pending = refresh();
  state.context.responses[0]!.resolve({ channels: [], prompts: [{ ...prompt, revision: "2" }] });
  await pending;
  state.context.epoch.current += 1;
  state.context.authenticated.current = false;
  state.context.platform = { channels: [], prompts: [] };
  state.context.drafts = {};
  for (const update of queued) update();
  assert.deepEqual(state.context.platform.prompts, []);
  assert.deepEqual(state.context.drafts, {});
});
