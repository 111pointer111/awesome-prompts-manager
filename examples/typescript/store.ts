import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { updateSchema } from "../../shared/protocol.js";
import type { Prompt } from "../../shared/protocol.js";

export const defaultContent = "请根据 {topics} 评价文章的实际价值。";

export class ExamplePromptStore {
  private readonly db: DatabaseSync;

  constructor(path: string, private readonly defaultTemplate = defaultContent) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS prompt_settings(id INTEGER PRIMARY KEY CHECK(id=1),content TEXT,revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO prompt_settings(id,content,revision) VALUES(1,NULL,0);`);
  }

  get(): Prompt {
    const row = this.db.prepare("SELECT content,revision FROM prompt_settings WHERE id=1").get() as { content: string | null; revision: number };
    const content = row.content ?? this.defaultTemplate;
    const fingerprint = createHash("sha256").update(JSON.stringify([this.defaultTemplate, content])).digest("hex");
    return {
      id: "article-review", name: "文章评分", description: "示例文章评分的业务偏好模板",
      content, defaultContent: this.defaultTemplate, revision: `${row.revision}:${fingerprint}`,
      customized: row.content !== null, readOnly: false, maxLength: 16000,
      variables: [{ name: "topics", description: "本次任务的兴趣话题，由业务填入" }],
      composition: ["本条评分偏好", "业务固定的输出格式要求"],
      effect: "下一项文章评审开始时读取并固定到本项任务结束",
    };
  }

  save(input: unknown): Prompt {
    const update = updateSchema.parse(input);
    if (update.content !== null && (!update.content.trim() || update.content.includes("\0") || update.content.length > 16000 || !update.content.includes("{topics}"))) {
      throw Object.assign(new Error("模板需包含 {topics}，且长度在 1～16000 之间"), { status: 400 });
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.get().revision !== update.expectedRevision) throw Object.assign(new Error("提示词已更新，请重新读取"), { status: 409 });
      this.db.prepare("UPDATE prompt_settings SET content=?,revision=revision+1 WHERE id=1").run(update.content);
      const saved = this.get();
      this.db.exec("COMMIT");
      return saved;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  snapshot(topics: string) {
    const prompt = this.get();
    return { revision: prompt.revision, system: prompt.content.replaceAll("{topics}", topics) + "\n输出 JSON，包含 score（0～100）和 reason。" };
  }

  close(): void { this.db.close(); }
}
