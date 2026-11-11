import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

const origin = new URL(process.argv[2] ?? "http://localhost:3300").origin;
const password = randomBytes(24).toString("base64url");
const secret = randomBytes(32).toString("base64");
try {
  writeFileSync(".env", `APP_ORIGIN=${origin}\nADMIN_USERNAME=admin\nADMIN_PASSWORD=${password}\nAPP_SECRET=${secret}\n`, { flag: "wx", mode: 0o600 });
  console.log("已创建 .env。管理员账号为 admin，密码保存在 ADMIN_PASSWORD。请在私有终端查看并妥善保存该文件。");
} catch (error) {
  if (error.code === "EEXIST") console.error(".env 已存在，保留现有配置。");
  else throw error;
  process.exitCode = 1;
}
