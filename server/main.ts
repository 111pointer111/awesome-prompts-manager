import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createApp } from "./app.js";
import { Store } from "./store.js";

export async function main(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  process.umask(0o077);
  const origin = new URL(process.env.APP_ORIGIN ?? "http://localhost:3300").origin;
  const username = process.env.ADMIN_USERNAME ?? "admin";
  const password = process.env.ADMIN_PASSWORD;
  const key = Buffer.from(process.env.APP_SECRET ?? "", "base64");
  if (!password || password.length > 1024 || key.length !== 32 || !username || username.length > 100) {
    throw new Error("配置需要 ADMIN_PASSWORD（1～1024 字符）和 APP_SECRET（32 字节的 Base64），可先运行 node scripts/configure.mjs");
  }
  const dataDirectory = resolve(process.env.DATA_DIR ?? "data");
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const store = new Store(resolve(dataDirectory, "platform.sqlite"));
  const { app } = await createApp({ store, secret: key, origin, username, password, webDirectory: resolve("dist/web") });
  const port = Number(process.env.PORT ?? 3300);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT 无效");
  const server = app.listen(port, process.env.HOST ?? "0.0.0.0", () => console.log(`Prompt manager listening on port ${port}`));
  server.requestTimeout = 35000;
  server.headersTimeout = 10000;
  const shutdown = () => {
    server.close(() => { store.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error("启动失败，请检查配置、密钥和数据目录权限"); process.exitCode = 1; });
}
