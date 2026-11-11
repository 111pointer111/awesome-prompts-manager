import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { catalogSchema, promptSchema } from "../shared/protocol.js";
import type { Catalog, Channel, ManagedPrompt, Prompt } from "../shared/protocol.js";
import { AppError } from "./errors.js";

interface ChannelRow {
  id: string;
  name: string;
  base_url: string;
  token: string;
  service_id: string | null;
  service_name: string | null;
  last_synced_at: string | null;
  last_attempt_at: string | null;
  error: string | null;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS admin (
        id INTEGER PRIMARY KEY CHECK(id = 1), username TEXT NOT NULL, password TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL UNIQUE, token TEXT NOT NULL,
        service_id TEXT, service_name TEXT, last_synced_at TEXT, last_attempt_at TEXT, error TEXT
      );
      CREATE TABLE IF NOT EXISTS prompts (
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        id TEXT NOT NULL, data TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
        note TEXT NOT NULL DEFAULT '', note_revision INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(channel_id, id)
      );
    `);
  }

  channel(id: string): ChannelRow {
    const row = this.db.prepare("SELECT * FROM channels WHERE id=?").get(id) as unknown as ChannelRow | undefined;
    if (!row) throw new AppError(404, "channel_not_found", "渠道不存在");
    return row;
  }

  channels(): ChannelRow[] {
    return this.db.prepare("SELECT * FROM channels ORDER BY rowid").all() as unknown as ChannelRow[];
  }

  addChannel(name: string, baseUrl: string, token: string, catalog: Catalog): string {
    const id = randomUUID();
    this.transaction(() => {
      if (this.db.prepare("SELECT id FROM channels WHERE base_url=?").get(baseUrl)) {
        throw new AppError(409, "duplicate_channel", "这个地址已经添加过");
      }
      this.db.prepare("INSERT INTO channels(id,name,base_url,token) VALUES(?,?,?,?)").run(id, name, baseUrl, token);
      this.catalog(id, catalog);
    });
    return id;
  }

  catalog(id: string, input: Catalog): void {
    const catalog = catalogSchema.parse(input);
    const current = this.channel(id);
    if (current.service_id && current.service_id !== catalog.service.id) {
      throw new AppError(409, "service_mismatch", "业务实例标识改变，请核对渠道地址");
    }
    this.transaction(() => {
      this.db.prepare("UPDATE prompts SET active=0 WHERE channel_id=?").run(id);
      const upsert = this.db.prepare(`
        INSERT INTO prompts(channel_id,id,data,active) VALUES(?,?,?,1)
        ON CONFLICT(channel_id,id) DO UPDATE SET data=excluded.data, active=1
      `);
      for (const prompt of catalog.prompts) upsert.run(id, prompt.id, JSON.stringify(prompt));
      const time = new Date().toISOString();
      this.db.prepare(`UPDATE channels SET service_id=?,service_name=?,last_synced_at=?,last_attempt_at=?,error=NULL WHERE id=?`)
        .run(catalog.service.id, catalog.service.name, time, time, id);
    });
  }

  configure(id: string, name: string, baseUrl: string, token: string, catalog: Catalog): void {
    this.transaction(() => {
      this.catalog(id, catalog);
      this.db.prepare("UPDATE channels SET name=?,base_url=?,token=? WHERE id=?").run(name, baseUrl, token, id);
    });
  }

  prompt(channelId: string, promptId: string): ManagedPrompt {
    this.channel(channelId);
    const row = this.db.prepare("SELECT * FROM prompts WHERE channel_id=? AND id=?")
      .get(channelId, promptId) as { data: string; note: string; note_revision: number; active: number } | undefined;
    if (!row) throw new AppError(404, "prompt_not_found", "提示词不存在");
    return { ...promptSchema.parse(JSON.parse(row.data)), channelId, note: row.note, noteRevision: row.note_revision, active: !!row.active };
  }

  updatePrompt(channelId: string, prompt: Prompt): void {
    this.db.prepare("UPDATE prompts SET data=?,active=1 WHERE channel_id=? AND id=?")
      .run(JSON.stringify(promptSchema.parse(prompt)), channelId, prompt.id);
    this.db.prepare("UPDATE channels SET error=NULL WHERE id=?").run(channelId);
  }

  note(channelId: string, promptId: string, note: string, expectedRevision: number): void {
    this.prompt(channelId, promptId);
    const changed = this.db.prepare(`UPDATE prompts SET note=?,note_revision=note_revision+1
      WHERE channel_id=? AND id=? AND note_revision=?`).run(note, channelId, promptId, expectedRevision);
    if (!changed.changes) throw new AppError(409, "note_conflict", "备注已被其他页面修改，请先刷新");
  }

  fail(id: string, message: string): void {
    this.db.prepare("UPDATE channels SET error=?,last_attempt_at=? WHERE id=?")
      .run(message, new Date().toISOString(), id);
  }

  channelViews(syncing: Set<string>): Channel[] {
    return this.channels().map(row => ({
      id: row.id, name: row.name, baseUrl: row.base_url, serviceId: row.service_id,
      serviceName: row.service_name, lastSyncedAt: row.last_synced_at,
      lastAttemptAt: row.last_attempt_at, error: row.error, syncing: syncing.has(row.id),
    }));
  }

  *prompts(): Generator<ManagedPrompt> {
    const identities = this.db.prepare("SELECT channel_id,id FROM prompts ORDER BY rowid").all();
    for (const row of identities) yield this.prompt(String(row.channel_id), String(row.id));
  }

  private transaction<T>(operation: () => T): T {
    // Catalog insertion can participate in the channel creation transaction.
    if (this.db.isTransaction) return operation();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
