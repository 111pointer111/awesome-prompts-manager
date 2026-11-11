import assert from "node:assert/strict";
import test from "node:test";
import type { ManagedPrompt } from "../shared/protocol";
import { contentDirty, matchesPrompt, newDraft, noteDirty, promptKey, reconcileDraft } from "./drafts";

const prompt: ManagedPrompt = {
  id: "review", channelId: "channel-a", name: "文章评分", description: "评估工程内容",
  content: "Review the supplied article.", defaultContent: "Review the supplied article.", revision: "1",
  customized: false, readOnly: false, maxLength: 16000, variables: [], composition: [], effect: "下一任务生效",
  note: "北京采集服务", noteRevision: 1, active: true,
};

test("关键词搜索覆盖多个字段并忽略大小写", () => {
  assert.equal(matchesPrompt(prompt, "内容采集", "北京 REVIEW"), true);
  assert.equal(matchesPrompt(prompt, "内容采集", "文章 工程"), true);
  assert.equal(matchesPrompt(prompt, "内容采集", "北京 不存在"), false);
  assert.equal(matchesPrompt(prompt, "内容采集", "  "), true);
});

test("刷新保留未保存正文及其旧版本，独立更新干净备注", () => {
  const draft = { ...newDraft(prompt), content: "我的未保存内容" };
  const remote = { ...prompt, content: "业务新正文", revision: "2", note: "远端新备注", noteRevision: 2 };
  const result = reconcileDraft(draft, remote);
  assert.equal(result.content, "我的未保存内容");
  assert.equal(result.baseContent, prompt.content);
  assert.equal(result.revision, "1");
  assert.equal(result.note, "远端新备注");
  assert.equal(result.noteRevision, 2);
  assert.equal(contentDirty(result), true);
  assert.equal(noteDirty(result), false);
});

test("刷新保留未保存备注，干净正文跟随业务最新版", () => {
  const draft = { ...newDraft(prompt), note: "未保存备注" };
  const remote = { ...prompt, content: "业务新正文", revision: "2", note: "另一个页面的备注", noteRevision: 2 };
  const result = reconcileDraft(draft, remote);
  assert.equal(result.content, "业务新正文");
  assert.equal(result.revision, "2");
  assert.equal(result.note, "未保存备注");
  assert.equal(result.noteRevision, 1);
});

test("不同渠道的同名提示词草稿互相独立", () => {
  assert.notEqual(promptKey(prompt), promptKey({ ...prompt, channelId: "channel-b" }));
});
