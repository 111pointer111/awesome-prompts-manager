import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { hashPassword, tokenDigest, verifyPassword } from "./crypto.js";
import { AppError } from "./errors.js";
import { Store } from "./store.js";

const credentials = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(1024) }).strict();
const lifetime = 30 * 24 * 60 * 60 * 1000;

export class Auth {
  private readonly attempts = new Map<string, { count: number; started: number }>();

  constructor(private readonly store: Store, private readonly secure: boolean) {}

  async initialize(username: string, password: string): Promise<void> {
    const current = this.store.db.prepare("SELECT username,password FROM admin WHERE id=1").get() as { username: string; password: string } | undefined;
    if (current && current.username === username && await verifyPassword(password, current.password)) return;
    const encoded = await hashPassword(password);
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.db.prepare("INSERT INTO admin(id,username,password) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,password=excluded.password")
        .run(username, encoded);
      this.store.db.exec("DELETE FROM sessions; COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  private session(req: Request): string {
    return req.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith("apm_session="))?.slice(12) ?? "";
  }

  authenticated(req: Request): boolean {
    const token = this.session(req);
    if (!/^[a-f0-9]{64}$/.test(token)) return false;
    return !!this.store.db.prepare("SELECT digest FROM sessions WHERE digest=? AND expires>?").get(tokenDigest(token), Date.now());
  }

  async login(req: Request, res: Response): Promise<void> {
    const now = Date.now();
    for (const [ip, value] of this.attempts) {
      if (now - value.started > 60000) this.attempts.delete(ip);
    }
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const attempt = this.attempts.get(ip) ?? { count: 0, started: now };
    if (!this.attempts.has(ip) && this.attempts.size >= 1000) this.attempts.delete(this.attempts.keys().next().value!);
    this.attempts.set(ip, attempt);
    if (++attempt.count > 10) throw new AppError(429, "login_limited", "尝试过于频繁，请稍后重试");
    const input = credentials.parse(req.body);
    const current = this.store.db.prepare("SELECT username,password FROM admin WHERE id=1").get() as { username: string; password: string };
    const correctPassword = await verifyPassword(input.password, current.password);
    if (input.username !== current.username || !correctPassword) throw new AppError(401, "invalid_credentials", "账号或密码不正确");
    this.attempts.delete(ip);
    const token = randomBytes(32).toString("hex");
    this.store.db.prepare("DELETE FROM sessions WHERE expires<=?").run(Date.now());
    this.store.db.prepare("INSERT INTO sessions(digest,expires) VALUES(?,?)").run(tokenDigest(token), Date.now() + lifetime);
    res.cookie("apm_session", token, { httpOnly: true, secure: this.secure, sameSite: "strict", path: "/", maxAge: lifetime });
    res.json({ authenticated: true });
  }

  logout(req: Request, res: Response): void {
    this.store.db.prepare("DELETE FROM sessions WHERE digest=?").run(tokenDigest(this.session(req)));
    res.clearCookie("apm_session", { httpOnly: true, secure: this.secure, sameSite: "strict", path: "/" });
    res.json({ authenticated: false });
  }
}
