import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExample } from "../examples/typescript/server.js";
import { ExamplePromptStore } from "../examples/typescript/store.js";
import { createApp } from "../server/app.js";
import { Channels, normalizeUrl } from "../server/channels.js";
import { decryptToken, encryptToken } from "../server/crypto.js";
import { Store } from "../server/store.js";
import type { PlatformState, Prompt } from "../shared/protocol.js";
import { catalogSchema } from "../shared/protocol.js";

const sourceToken = "synthetic-source-credential-for-testing";
const key = Buffer.alloc(32, 7);
const origin = "http://localhost:3300";

async function fixture(fetcher?: typeof fetch) {
  const example = createExample(":memory:", sourceToken);
  const source = example.app.listen(0, "127.0.0.1");
  await once(source, "listening");
  const sourceAddress = source.address();
  assert.ok(sourceAddress && typeof sourceAddress !== "string");
  const baseUrl = `http://127.0.0.1:${sourceAddress.port}`;
  const store = new Store(":memory:");
  const platform = await createApp({ store, secret: key, origin, username: "admin", password: "synthetic-admin-password", fetcher });
  const server = platform.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let cookie = "";
  const request = async (path: string, method = "GET", body?: unknown, authenticated = true, sendOrigin = true, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method, headers: { ...(sendOrigin ? { Origin: origin } : {}), ...(cookie && authenticated ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const login = async () => {
    const result = await request("/api/login", "POST", { username: "admin", password: "synthetic-admin-password" });
    assert.equal(result.status, 200);
    cookie = result.headers.get("set-cookie")!.split(";")[0]!;
    return result;
  };
  const add = async () => {
    const result = await request("/api/channels", "POST", { name: "示例渠道", baseUrl, token: sourceToken });
    assert.equal(result.status, 201);
    return (await result.json() as { id: string }).id;
  };
  const close = async () => {
    server.closeAllConnections(); source.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => source.close(() => resolve()))]);
    store.close(); example.store.close();
  };
  return { example, source, platform, store, baseUrl, request, login, add, close };
}

test("normal API entry protects credentials and mutations, logs out persistently", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request("/api/state", "GET", undefined, false)).status, 401);
    assert.equal((await f.request("/api/login", "POST", { username: "admin", password: "synthetic-admin-password" }, false, false)).status, 403);
    assert.equal((await f.request("/api/login", "POST", { username: "admin", password: "wrong" })).status, 401);
    const login = await f.login();
    assert.match(login.headers.get("set-cookie")!, /HttpOnly/);
    assert.match(login.headers.get("set-cookie")!, /SameSite=Strict/);
    const id = await f.add();
    const state = await (await f.request("/api/state")).json() as PlatformState;
    assert.equal(state.prompts[0]?.channelId, id);
    assert.equal(state.channels[0]?.serviceId, "typescript-example");
    assert.ok(!JSON.stringify(state).includes(sourceToken));
    assert.notEqual(f.store.channel(id).token, sourceToken);
    assert.equal(decryptToken(f.store.channel(id).token, key), sourceToken);
    assert.equal((await f.request("/api/channels", "POST", { name: "重复", baseUrl: f.baseUrl, token: sourceToken })).status, 409);
    assert.equal((await f.request("/api/logout", "POST")).status, 200);
    assert.equal((await f.request("/api/state")).status, 401);
  } finally { await f.close(); }
});

test("save reads back business version, detects stale writes, and restores defaults", async () => {
  const f = await fixture();
  try {
    await f.login(); const id = await f.add();
    const path = `/api/channels/${id}/prompts/article-review`;
    const original = f.example.store.get();
    const saved = await f.request(path, "PUT", { content: "新版 {topics} 评分", expectedRevision: original.revision });
    assert.equal(saved.status, 200);
    const updated = await saved.json() as Prompt;
    assert.notEqual(updated.revision, original.revision);
    assert.match(updated.revision, /^\d+:[0-9a-f]{64}$/);
    assert.equal(f.example.store.snapshot("实践").system.includes("新版 实践"), true);
    assert.equal((await f.request(path, "PUT", { content: "旧页面 {topics}", expectedRevision: original.revision })).status, 409);
    assert.equal((await f.request(path, "PUT", { content: "丢失变量", expectedRevision: updated.revision })).status, 400);
    const reset = await f.request(path, "PUT", { content: null, expectedRevision: updated.revision });
    assert.equal(reset.status, 200);
    const restored = await reset.json() as Prompt;
    assert.equal(restored.customized, false);
    assert.equal(restored.content, original.defaultContent);
    assert.notEqual(restored.revision, updated.revision);
    assert.equal(f.store.prompt(id, "article-review").revision, restored.revision);
  } finally { await f.close(); }
});

test("sync preserves notes and offline snapshot, removed IDs retain notes", async () => {
  const f = await fixture();
  try {
    await f.login(); const id = await f.add();
    const path = `/api/channels/${id}/prompts/article-review/note`;
    assert.equal((await f.request(path, "PUT", { note: "北京 评分备注", expectedRevision: 0 })).status, 200);
    await f.platform.channels.sync(id);
    assert.equal(f.store.prompt(id, "article-review").note, "北京 评分备注");
    assert.equal((await f.request(path, "PUT", { note: "过期页面", expectedRevision: 0 })).status, 409);
    f.store.catalog(id, { protocolVersion: 1, service: { id: "typescript-example", name: "改名" }, prompts: [] });
    assert.equal(f.store.prompt(id, "article-review").active, false);
    assert.equal(f.store.prompt(id, "article-review").note, "北京 评分备注");
    await f.platform.channels.sync(id);
    assert.equal(f.store.prompt(id, "article-review").active, true);
    f.source.closeAllConnections(); await new Promise<void>(resolve => f.source.close(() => resolve()));
    await f.platform.channels.sync(id);
    assert.ok(f.store.channel(id).error);
    assert.equal(f.store.prompt(id, "article-review").note, "北京 评分备注");
    assert.equal((await f.request(path, "PUT", { note: "离线也能改备注", expectedRevision: 1 })).status, 200);
  } finally { await f.close(); }
});

test("per-channel serialization keeps an older sync from overwriting a saved prompt", async () => {
  const f = await fixture();
  try {
    await f.login(); const id = await f.add();
    const originalRevision = f.example.store.get().revision;
    const sync = f.platform.channels.sync(id);
    const save = f.platform.channels.save(id, "article-review", { content: "并发 {topics}", expectedRevision: originalRevision });
    const [, saved] = await Promise.all([sync, save]);
    assert.notEqual(saved.revision, originalRevision);
    assert.equal(f.store.prompt(id, "article-review").revision, saved.revision);
    assert.equal(f.store.prompt(id, "article-review").content, "并发 {topics}");
  } finally { await f.close(); }
});

test("persistent cache and encrypted credentials survive reopening", async () => {
  const directory = mkdtempSync(join(tmpdir(), "prompts-store-"));
  const f = await fixture();
  try {
    const store = new Store(join(directory, "test.sqlite"));
    const channels = new Channels(store, key);
    const id = await channels.add({ name: "持久化", baseUrl: f.baseUrl, token: sourceToken });
    store.note(id, "article-review", "保留备注", 0);
    store.close();
    const reopened = new Store(join(directory, "test.sqlite"));
    try {
      assert.equal(reopened.prompt(id, "article-review").note, "保留备注");
      assert.equal(decryptToken(reopened.channel(id).token, key), sourceToken);
    } finally { reopened.close(); }
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("upstream redirects never forward the management token to another destination", async () => {
  let stolen = false;
  const destination = createServer((_req, res) => { stolen = true; res.end("{}"); }).listen(0, "127.0.0.1");
  await once(destination, "listening");
  const target = destination.address(); assert.ok(target && typeof target !== "string");
  const source = createServer((_req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${target.port}` }); res.end(); }).listen(0, "127.0.0.1");
  await once(source, "listening");
  const address = source.address(); assert.ok(address && typeof address !== "string");
  const store = new Store(":memory:");
  try {
    const channels = new Channels(store, key);
    await assert.rejects(channels.add({ name: "跳转", baseUrl: `http://127.0.0.1:${address.port}`, token: sourceToken }), /业务连接失败/);
    assert.equal(stolen, false);
    assert.equal(store.channels().length, 0);
  } finally {
    source.closeAllConnections(); destination.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => source.close(() => resolve())), new Promise<void>(resolve => destination.close(() => resolve()))]);
    store.close();
  }
});

test("URL and encrypted credential checks reject unsafe or tampered configuration", () => {
  assert.equal(normalizeUrl("http://localhost:3310/api/"), "http://localhost:3310/api");
  assert.throws(() => normalizeUrl("https://username:secret@example.com"));
  assert.throws(() => normalizeUrl("file:///etc/passwd"));
  assert.throws(() => normalizeUrl("https://example.com/?token=value"));
  const encrypted = Buffer.from(encryptToken(sourceToken, key), "base64");
  encrypted[encrypted.length - 1] = encrypted[encrypted.length - 1]! ^ 1;
  assert.throws(() => decryptToken(encrypted.toString("base64"), key));
});

test("changing an address requires explicit credentials before contacting the destination", async () => {
  const f = await fixture();
  let contacted = false;
  const destination = createServer((_req, res) => { contacted = true; res.end("{}"); }).listen(0, "127.0.0.1");
  await once(destination, "listening");
  const target = destination.address(); assert.ok(target && typeof target !== "string");
  try {
    await f.login(); const id = await f.add();
    const result = await f.request(`/api/channels/${id}`, "PUT", { name: "更换地址", baseUrl: `http://127.0.0.1:${target.port}` });
    assert.equal(result.status, 400);
    assert.equal((await result.json()).error, "token_required_for_new_url");
    assert.equal(contacted, false);
    assert.equal(f.store.channel(id).base_url, f.baseUrl);
  } finally {
    destination.closeAllConnections(); await new Promise<void>(resolve => destination.close(() => resolve()));
    await f.close();
  }
});

test("a success response that ignored the requested edit is reported unconfirmed", async () => {
  const f = await fixture();
  try {
    await f.login(); const id = await f.add();
    const unchanged = f.example.store.get();
    const badUpstream: typeof fetch = async () => new Response(JSON.stringify(unchanged));
    const manager = new Channels(f.store, key, badUpstream);
    await assert.rejects(manager.save(id, "article-review", { content: "本次提交 {topics}", expectedRevision: unchanged.revision }), /保存结果待确认/);
    assert.equal(f.store.prompt(id, "article-review").content, unchanged.content);
    assert.match(f.store.channel(id).error!, /保存结果待确认/);
  } finally { await f.close(); }
});

test("failed channel configuration rolls back both metadata and cached content", async () => {
  const f = await fixture();
  try {
    await f.login(); const id = await f.add();
    const original = f.store.prompt(id, "article-review").content;
    f.store.db.exec("CREATE TRIGGER reject_channel_update BEFORE UPDATE OF base_url ON channels BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    const catalog = { protocolVersion: 1, service: { id: "typescript-example", name: "已变化" }, prompts: [{ ...f.example.store.get(), content: "新地址内容 {topics}" }] };
    const upstream: typeof fetch = async () => new Response(JSON.stringify(catalog));
    const manager = new Channels(f.store, key, upstream);
    await assert.rejects(manager.configure(id, { name: "更新", baseUrl: f.baseUrl + "/new", token: "explicit-new-synthetic-credential" }));
    assert.equal(f.store.channel(id).base_url, f.baseUrl);
    assert.equal(f.store.prompt(id, "article-review").content, original);
  } finally { await f.close(); }
});

test("login throttling separates client identities supplied by the trusted ingress", async () => {
  const f = await fixture();
  try {
    for (let count = 0; count < 10; count++) {
      const failed = await f.request("/api/login", "POST", { username: "admin", password: "wrong" }, false, true, { "X-Forwarded-For": "198.51.100.1" });
      assert.equal(failed.status, 401);
    }
    const blocked = await f.request("/api/login", "POST", { username: "admin", password: "synthetic-admin-password" }, false, true, { "X-Forwarded-For": "198.51.100.1" });
    assert.equal(blocked.status, 429);
    const other = await f.request("/api/login", "POST", { username: "admin", password: "synthetic-admin-password" }, false, true, { "X-Forwarded-For": "203.0.113.2" });
    assert.equal(other.status, 200);
  } finally { await f.close(); }
});

test("oversized malformed catalogs produce bounded validation failures", () => {
  const result = catalogSchema.safeParse({ protocolVersion: 1, service: { id: "fixture", name: "Fixture" }, prompts: Array(10001).fill(null) });
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.error.issues.length, 1);
  const f = createExample(":memory:", sourceToken);
  try {
    const prompt = { ...f.store.get(), variables: Array(10001).fill(null), composition: Array(10001).fill(null) };
    const nested = catalogSchema.safeParse({ protocolVersion: 1, service: { id: "fixture", name: "Fixture" }, prompts: [prompt] });
    assert.equal(nested.success, false);
    if (!nested.success) assert.equal(nested.error.issues.length, 1);
    const worstCase = { ...f.store.get(), variables: Array(100).fill({}), composition: Array(100).fill(0) };
    const atLimit = catalogSchema.safeParse({ protocolVersion: 1, service: { id: "fixture", name: "Fixture" }, prompts: Array(1000).fill(worstCase) });
    assert.equal(atLimit.success, false);
    if (!atLimit.success) assert.equal(atLimit.error.issues.length, 1);
  } finally { f.store.close(); }
});

test("a remote version conflict immediately refreshes the comparison snapshot", async () => {
  const f = await fixture();
  try {
    await f.login(); const id = await f.add();
    const originalRevision = f.example.store.get().revision;
    const other = f.example.store.save({ content: "业务其他入口已更新 {topics}", expectedRevision: originalRevision });
    const result = await f.request(`/api/channels/${id}/prompts/article-review`, "PUT", { content: "当前页面的修改 {topics}", expectedRevision: originalRevision });
    assert.equal(result.status, 409);
    const state = await (await f.request("/api/state")).json() as PlatformState;
    assert.equal(state.prompts[0]?.revision, other.revision);
    assert.equal(state.prompts[0]?.content, "业务其他入口已更新 {topics}");
  } finally { await f.close(); }
});

test("authenticated body requests cover the advertised UTF-16 template range", async () => {
  const example = createExample(":memory:", sourceToken);
  let current = { ...example.store.get(), maxLength: 131072, variables: [] };
  const originalRevision = current.revision;
  const savedRevision = "saved-large-template-version";
  const upstream: typeof fetch = async (url, init) => {
    if (init?.method === "PUT") {
      const update = JSON.parse(String(init.body));
      current = { ...current, content: update.content, revision: savedRevision, customized: true };
    }
    const body = String(url).endsWith("/v1/prompts")
      ? { protocolVersion: 1, service: { id: "large-example", name: "Large example" }, prompts: [current] }
      : current;
    return new Response(JSON.stringify(body));
  };
  const f = await fixture(upstream);
  try {
    await f.login(); const id = await f.add();
    const content = "中".repeat(100000);
    const response = await f.request(`/api/channels/${id}/prompts/article-review`, "PUT", { content, expectedRevision: originalRevision });
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.equal(saved.content.length, 100000);
    assert.equal(saved.revision, savedRevision);
  } finally { example.store.close(); await f.close(); }
});

test("reference store detects default upgrades while preserving overrides and task snapshots", () => {
  const directory = mkdtempSync(join(tmpdir(), "prompts-defaults-"));
  const path = join(directory, "example.sqlite");
  const original = new ExamplePromptStore(path);
  const firstDefault = original.get();
  const originalTask = original.snapshot("实践");
  const upgradedDefault = "请根据 {topics} 优先评价工程依据。";
  const upgraded = new ExamplePromptStore(path, upgradedDefault);
  const latestDefault = "请根据 {topics} 审核可复用经验。";
  let reopened: ExamplePromptStore | undefined;
  let latest: ExamplePromptStore | undefined;
  try {
    const current = upgraded.get();
    assert.equal(current.content, upgradedDefault);
    assert.notEqual(current.revision, firstDefault.revision);
    assert.throws(() => upgraded.save({ content: "旧页面的修改 {topics}", expectedRevision: firstDefault.revision }), { status: 409 });
    const custom = upgraded.save({ content: "自定义规则 {topics}", expectedRevision: current.revision });
    reopened = new ExamplePromptStore(path, upgradedDefault);
    assert.equal(reopened.get().revision, custom.revision);
    assert.equal(reopened.get().content, custom.content);
    latest = new ExamplePromptStore(path, latestDefault);
    const afterUpgrade = latest.get();
    assert.equal(afterUpgrade.content, custom.content);
    assert.equal(afterUpgrade.defaultContent, latestDefault);
    assert.equal(afterUpgrade.customized, true);
    assert.notEqual(afterUpgrade.revision, custom.revision);
    assert.throws(() => latest!.save({ content: null, expectedRevision: custom.revision }), { status: 409 });
    const reset = latest.save({ content: null, expectedRevision: afterUpgrade.revision });
    assert.equal(reset.content, latestDefault);
    assert.equal(reset.customized, false);
    assert.notEqual(reset.revision, afterUpgrade.revision);
    assert.equal(originalTask.revision, firstDefault.revision);
    assert.equal(originalTask.system.startsWith(firstDefault.content.replaceAll("{topics}", "实践")), true);
  } finally {
    original.close(); upgraded.close(); reopened?.close(); latest?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("JSON configurations accept formatting changes, confirm values, and preserve default semantics", async () => {
  let writes = 0;
  let mismatch = false;
  let value = { enabled: false, topics: ["AI"] };
  const defaults = JSON.stringify(value);
  const prompt = (): Prompt => ({
    id: "collection-direction", name: "采集方向", description: "合成采集配置",
    contentFormat: "json", content: JSON.stringify(value, null, writes % 2 ? 2 : 0), defaultContent: defaults,
    revision: String(writes), customized: value.enabled, readOnly: false, maxLength: 16000,
    variables: [], composition: [], effect: "下一轮采集读取配置",
  });
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/prompts")) return Response.json({ protocolVersion: 1, service: { id: "json-example", name: "配置业务" }, prompts: [prompt()] });
    if (init?.method === "PUT") {
      const update = JSON.parse(String(init.body));
      if (update.expectedRevision !== String(writes)) return Response.json({}, { status: 409 });
      value = update.content === null ? JSON.parse(defaults) : JSON.parse(update.content);
      writes++;
      if (mismatch) value = { ...value, topics: ["unexpected"] };
    }
    const result = prompt();
    if (init?.method !== "PUT") result.content = JSON.stringify({ topics: value.topics, enabled: value.enabled });
    return Response.json(result);
  };
  const f = await fixture(fetcher);
  try {
    await f.login(); const id = await f.add();
    const path = `/api/channels/${id}/prompts/collection-direction`;
    assert.equal((await f.request(path, "PUT", { content: "{invalid", expectedRevision: "0" })).status, 400);
    assert.equal(writes, 0);
    const saved = await f.request(path, "PUT", { content: '{ "topics": ["AI"], "enabled": true }', expectedRevision: "0" });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json() as Prompt).contentFormat, "json");
    const reset = await f.request(path, "PUT", { content: null, expectedRevision: "1" });
    assert.equal(reset.status, 200);
    assert.equal((await reset.json() as Prompt).customized, false);
    assert.equal((await f.request(path, "PUT", { content: defaults, expectedRevision: "2" })).status, 200);
    mismatch = true;
    assert.equal((await f.request(path, "PUT", { content: '{"enabled":true,"topics":["AI"]}', expectedRevision: "3" })).status, 502);
    assert.equal(catalogSchema.safeParse({ protocolVersion: 1, service: { id: "json-example", name: "配置" }, prompts: [{ ...prompt(), content: "broken" }] }).success, false);
  } finally { await f.close(); }
});
