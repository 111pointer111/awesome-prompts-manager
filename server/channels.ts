import { z } from "zod";
import { catalogSchema, promptSchema, updateSchema } from "../shared/protocol.js";
import type { Catalog, Prompt } from "../shared/protocol.js";
import { decryptToken, encryptToken } from "./crypto.js";
import { AppError } from "./errors.js";
import { Store } from "./store.js";

const channelInput = z.object({
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().url().max(2048),
  token: z.string().min(16).max(4096).refine(value => !/[\s\x00-\x1f\x7f]/u.test(value)),
}).strict();

export function normalizeUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new AppError(400, "invalid_url", "请输入 HTTP(S) 基础地址，凭据填写在 Token 字段");
  }
  return url.href.replace(/\/+$/, "");
}

export class Channels {
  readonly syncing = new Set<string>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private syncingAll = false;

  constructor(readonly store: Store, private readonly key: Buffer, private readonly fetcher: typeof fetch = fetch) {}

  private async request(baseUrl: string, token: string, path: string, body?: unknown): Promise<unknown> {
    try {
      const response = await this.fetcher(baseUrl + path, {
        method: body === undefined ? "GET" : "PUT",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error", signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const messages: Record<number, string> = {
          400: "业务拒绝了模板格式，请检查变量和输出要求", 401: "渠道 Token 无效或已撤销",
          403: "渠道没有此操作权限", 404: "业务接口或提示词不存在", 409: "提示词已有新版本，请同步后比较再保存",
        };
        throw new AppError(response.status < 500 ? response.status : 502, "upstream_rejected", messages[response.status] ?? "业务服务暂时不可用");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("missing body");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8 * 1024 * 1024) throw new AppError(502, "catalog_too_large", "业务响应超过 8 MiB 限制");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Upstream exception text can contain URLs or credentials, so it stays off the API.
      throw new AppError(502, "upstream_unavailable", "业务连接失败或返回无效数据，请核对地址、Token 和私网连接");
    }
  }

  async add(input: unknown): Promise<string> {
    const value = channelInput.parse(input);
    const baseUrl = normalizeUrl(value.baseUrl);
    const catalog = catalogSchema.parse(await this.request(baseUrl, value.token, "/v1/prompts"));
    return this.store.addChannel(value.name, baseUrl, encryptToken(value.token, this.key), catalog);
  }

  async configure(id: string, input: unknown): Promise<void> {
    return this.serial(id, async () => {
      const value = channelInput.omit({ token: true }).extend({ token: channelInput.shape.token.optional() }).parse(input);
      const current = this.store.channel(id);
      const baseUrl = normalizeUrl(value.baseUrl);
      if (baseUrl !== current.base_url && !value.token) {
        throw new AppError(400, "token_required_for_new_url", "更换业务地址时，请明确填写新地址使用的 Token");
      }
      const token = value.token ?? decryptToken(current.token, this.key);
      const catalog = catalogSchema.parse(await this.request(baseUrl, token, "/v1/prompts"));
      if (current.service_id && catalog.service.id !== current.service_id) {
        throw new AppError(409, "service_mismatch", "业务实例标识改变，请添加独立渠道");
      }
      const duplicate = this.store.db.prepare("SELECT id FROM channels WHERE base_url=? AND id<>?").get(baseUrl, id);
      if (duplicate) throw new AppError(409, "duplicate_channel", "这个地址已经添加过");
      this.store.configure(id, value.name, baseUrl, encryptToken(token, this.key), catalog);
    });
  }

  async sync(id: string): Promise<void> {
    if (this.syncing.has(id)) return;
    this.syncing.add(id);
    try {
      await this.serial(id, async () => {
        const channel = this.store.channel(id);
        const data = await this.request(channel.base_url, decryptToken(channel.token, this.key), "/v1/prompts");
        this.store.catalog(id, catalogSchema.parse(data));
      });
    } catch (error) {
      this.store.fail(id, error instanceof AppError ? error.message : "目录格式不符合接入协议");
    } finally {
      this.syncing.delete(id);
    }
  }

  async syncAll(): Promise<void> {
    if (this.syncingAll) return;
    this.syncingAll = true;
    try {
      for (const channel of this.store.channels()) await this.sync(channel.id);
    } finally {
      this.syncingAll = false;
    }
  }

  async save(id: string, promptId: string, input: unknown): Promise<Prompt> {
    return this.serial(id, async () => {
      const update = updateSchema.parse(input);
      const cached = this.store.prompt(id, promptId);
      if (!cached.active || cached.readOnly) throw new AppError(403, "read_only", "此提示词当前无法编辑");
      if (update.content !== null && (!update.content.trim() || update.content.includes("\0") || update.content.length > cached.maxLength)) {
        throw new AppError(400, "invalid_prompt", `提示词需要非空文本，长度最多 ${cached.maxLength} 个代码单元`);
      }
      const channel = this.store.channel(id);
      const token = decryptToken(channel.token, this.key);
      const path = "/v1/prompts/" + encodeURIComponent(promptId);
      let accepted: Prompt;
      try {
        accepted = promptSchema.parse(await this.request(channel.base_url, token, path, update));
        const expected = update.content ?? accepted.defaultContent;
        const changed = accepted.content !== cached.content || accepted.customized !== cached.customized;
        if (accepted.id !== promptId || accepted.content !== expected || accepted.customized !== (update.content !== null)
          || (changed && accepted.revision === update.expectedRevision)) throw new Error("save receipt mismatch");
      } catch (error) {
        if (error instanceof AppError && error.status < 500) throw error;
        this.store.fail(id, "保存结果待确认，请同步业务后核对版本和内容");
        throw new AppError(502, "save_unconfirmed", "保存结果待确认，当前输入已保留，请同步后核对，避免重复提交");
      }
      this.store.updatePrompt(id, accepted);
      try {
        const confirmed = promptSchema.parse(await this.request(channel.base_url, token, path));
        if (confirmed.id !== promptId || confirmed.revision !== accepted.revision || confirmed.content !== accepted.content) {
          throw new Error("readback changed");
        }
        this.store.updatePrompt(id, confirmed);
        return confirmed;
      } catch {
        this.store.fail(id, "业务已接收保存，回读尚未确认，请同步核对");
        throw new AppError(502, "readback_unconfirmed", "业务已接收保存，回读尚未确认，当前输入已保留，请同步核对");
      }
    });
  }

  private async serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.operations.set(id, next);
    try { return await next; }
    finally { if (this.operations.get(id) === next) this.operations.delete(id); }
  }
}
