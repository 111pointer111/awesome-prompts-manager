import express from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ErrorRequestHandler } from "express";
import { z, ZodError } from "zod";
import { identifier } from "../shared/protocol.js";
import { Auth } from "./auth.js";
import { Channels } from "./channels.js";
import { AppError } from "./errors.js";
import { Store } from "./store.js";

export interface AppOptions {
  store: Store;
  secret: Buffer;
  origin: string;
  username: string;
  password: string;
  webDirectory?: string;
  fetcher?: typeof fetch;
}

export async function createApp(options: AppOptions) {
  const app = express();
  const channels = new Channels(options.store, options.secret, options.fetcher);
  const auth = new Auth(options.store, options.origin.startsWith("https:"));
  await auth.initialize(options.username, options.password);
  app.disable("x-powered-by");
  // The published port is loopback-only; one trusted reverse proxy owns forwarded headers.
  app.set("trust proxy", 1);
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    next();
  });
  app.get("/healthz", (_req, res) => { res.json({ status: "ok" }); });
  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.origin !== options.origin) {
      throw new AppError(403, "origin_denied", "请求来源不匹配，请从管理平台页面操作");
    }
    if (req.headers["sec-fetch-site"] === "cross-site") throw new AppError(403, "origin_denied", "请求来源不匹配");
    next();
  });
  app.use("/api", express.json({ limit: "256kb", strict: true }));
  app.get("/api/session", (req, res) => { res.json({ authenticated: auth.authenticated(req) }); });
  app.post("/api/login", (req, res) => auth.login(req, res));
  app.use("/api", (req, _res, next) => {
    if (!auth.authenticated(req)) throw new AppError(401, "login_required", "请先登录");
    next();
  });
  app.post("/api/logout", (req, res) => { auth.logout(req, res); });
  app.get("/api/state", async (_req, res) => {
    function* snapshot() {
      yield `{"channels":${JSON.stringify(options.store.channelViews(channels.syncing))},"prompts":[`;
      let separator = "";
      for (const prompt of options.store.prompts()) {
        yield separator + JSON.stringify(prompt);
        separator = ",";
      }
      yield "]}";
    }
    // Backpressure bounds server memory while the browser receives a large cached directory.
    res.type("json");
    await pipeline(Readable.from(snapshot(), { objectMode: false, highWaterMark: 16384 }), res);
  });
  app.post("/api/channels", async (req, res) => {
    const id = await channels.add(req.body);
    res.status(201).json({ id });
  });
  app.put("/api/channels/:channelId", async (req, res) => {
    await channels.configure(z.uuid().parse(req.params.channelId), req.body);
    res.json({ saved: true });
  });
  app.post("/api/sync", (_req, res) => {
    void channels.syncAll().catch(() => console.error("Channel synchronization failed"));
    res.status(202).json({ accepted: true });
  });
  app.post("/api/channels/:channelId/sync", (req, res) => {
    const id = z.uuid().parse(req.params.channelId);
    options.store.channel(id);
    void channels.sync(id).catch(() => console.error("Channel synchronization failed"));
    res.status(202).json({ accepted: true });
  });
  app.put("/api/channels/:channelId/prompts/:promptId", async (req, res) => {
    const prompt = await channels.save(z.uuid().parse(req.params.channelId), identifier.parse(req.params.promptId), req.body);
    res.json(prompt);
  });
  app.put("/api/channels/:channelId/prompts/:promptId/note", (req, res) => {
    const input = z.object({ note: z.string().max(10000), expectedRevision: z.number().int().nonnegative() }).strict().parse(req.body);
    options.store.note(z.uuid().parse(req.params.channelId), identifier.parse(req.params.promptId), input.note, input.expectedRevision);
    res.json({ saved: true });
  });
  app.use("/api", (_req, res) => { res.status(404).json({ error: "not_found", message: "接口不存在" }); });
  if (options.webDirectory) app.use(express.static(options.webDirectory, { index: "index.html", dotfiles: "deny" }));
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (res.headersSent) { res.destroy(); return; }
    if (error instanceof AppError) { res.status(error.status).json({ error: error.code, message: error.message }); return; }
    if (error instanceof ZodError || error instanceof SyntaxError) { res.status(400).json({ error: "invalid_input", message: "请求格式无效，请核对输入" }); return; }
    if (typeof error === "object" && error !== null && "status" in error && error.status === 413) {
      res.status(413).json({ error: "too_large", message: "请求内容过大" }); return;
    }
    console.error("Request failed", error instanceof Error ? error.name : "unknown");
    res.status(500).json({ error: "request_failed", message: "操作未完成，请重试或检查服务状态" });
  };
  app.use(errors);
  return { app, channels };
}
