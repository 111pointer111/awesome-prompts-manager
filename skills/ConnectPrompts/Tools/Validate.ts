import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--help")) {
  console.log("用法：node --import tsx skills/ConnectPrompts/Tools/Validate.ts\n检查 Skill 结构、公开内容和随包协议，仓库内同时核对规范示例。");
  process.exit(0);
}
assert.equal(process.argv.length, 2, "仅接受 --help 或不带参数");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const skill = read("SKILL.md");
assert.match(skill, /^---\nname: ConnectPrompts\ndescription: "[^\n]+USE WHEN[^\n]+"\n---\n/);
assert.ok(skill.split("\n").length < 100, "保持入口短小，细节放工作流");
for (const heading of ["Workflow Routing", "Gotchas", "Examples"]) {
  assert.ok(skill.includes(`## ${heading}\n`), `缺少 ${heading}`);
}

const workflowNames = readdirSync(resolve(root, "Workflows"));
assert.deepEqual(workflowNames.sort(), ["Integrate.md", "Scan.md", "Verify.md"]);
for (const name of workflowNames) {
  assert.ok(skill.includes(`Workflows/${name}`), `缺少路由 ${name}`);
  assert.ok(read(`Workflows/${name}`).includes("## Step 0"), `缺少范围确认 ${name}`);
}

const files = ["SKILL.md", "Protocol.md", "Tools/Validate.ts", "Tools/Validate.help.md", ...workflowNames.map(name => `Workflows/${name}`)];
for (const path of files) {
  const text = read(path);
  assert.doesNotMatch(text, /\/(?:Users|home)\/[A-Za-z0-9_-]+\//, `${path} 包含个人路径`);
  assert.doesNotMatch(text, /\b[\w-]+\.tail[0-9a-z]+\.ts\.net\b|\.claude\/LIFEOS/, `${path} 包含私有环境依赖`);
  assert.doesNotMatch(text, /(?:sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,})/, `${path} 包含凭据形态文本`);
  assert.ok(text.endsWith("\n"), `${path} 缺少结尾换行`);
}

const protocol = read("Protocol.md");
const paths = ["GET /v1/prompts", "GET /v1/prompts/{id}", "PUT /v1/prompts/{id}"];
const statuses = ["400", "401", "403", "404", "409"];
for (const path of paths) {
  assert.ok(protocol.includes(path), `协议缺少 ${path}`);
}
for (const status of statuses) {
  assert.match(protocol, new RegExp(`\\| ${status} \\|`), `协议缺少状态 ${status}`);
}
assert.ok(protocol.includes("content: null"));
assert.ok(protocol.includes("写操作不自动重试"));

const catalog = (text: string) => {
  const json = text.match(/```json\n([\s\S]*?)\n```/)?.[1];
  assert.ok(json, "协议缺少目录示例");
  return JSON.parse(json);
};
const fixture = catalog(protocol);
assert.equal(typeof fixture.prompts[0].revision, "string");
const repoProtocol = resolve(root, "../../docs/protocol.md");
try {
  const canonical = readFileSync(repoProtocol, "utf8");
  assert.deepEqual(fixture, catalog(canonical), "随包目录示例与仓库规范不一致");
  for (const path of paths) assert.ok(canonical.includes(path), `仓库规范缺少 ${path}`);
  for (const status of statuses) assert.ok(canonical.includes(status), `仓库规范缺少状态 ${status}`);
  assert.ok(canonical.includes("content: null"));
  assert.ok(canonical.includes("写操作不自动重试"));
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  console.log("独立分发目录，已检查随包协议");
}
console.log("ConnectPrompts 结构、公开内容与协议检查通过");
