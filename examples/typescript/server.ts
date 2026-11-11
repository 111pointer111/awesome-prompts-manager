import { timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { ExamplePromptStore } from "./store.js";

export function createExample(path: string, token: string) {
  if (token.length < 32 || /\s/.test(token)) throw new Error("PROMPT_MANAGEMENT_TOKEN 需要至少 32 个无空白字符");
  const store = new ExamplePromptStore(path);
  const app = express();
  app.use((req, res, next) => {
    const expected = Buffer.from("Bearer " + token);
    const received = Buffer.from(req.headers.authorization ?? "");
    const count = req.rawHeaders.filter((header, index) => index % 2 === 0 && header.toLowerCase() === "authorization").length;
    if (count !== 1 || expected.length !== received.length || !timingSafeEqual(expected, received)) {
      res.status(401).json({ error: "unauthorized", message: "Token 无效" }); return;
    }
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "128kb" }));
  app.get("/v1/prompts", (_req, res) => res.json({ protocolVersion: 1, service: { id: "typescript-example", name: "TypeScript 示例" }, prompts: [store.get()] }));
  app.get("/v1/prompts/article-review", (_req, res) => res.json(store.get()));
  app.put("/v1/prompts/article-review", (req, res) => res.json(store.save(req.body)));
  // This exposes the exact pre-model assembly for a synthetic task, without paid inference.
  app.get("/task", (req, res) => res.json(store.snapshot(String(req.query.topics ?? "工程实践"))));
  app.use((_req, res) => { res.status(404).json({ error: "not_found", message: "条目不存在" }); });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const status = error instanceof ZodError ? 400 : typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 500;
    res.status(status).json({ error: status === 409 ? "conflict" : "invalid_input", message: status === 500 ? "操作未完成" : "请核对模板、变量和版本" });
  };
  app.use(errors);
  return { app, store };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = process.env.EXAMPLE_DB ?? "data/typescript-example.sqlite";
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const { app } = createExample(path, process.env.PROMPT_MANAGEMENT_TOKEN ?? "");
  app.listen(Number(process.env.EXAMPLE_PORT ?? 3310), "127.0.0.1");
}
