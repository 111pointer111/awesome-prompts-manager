# Awesome Prompts Manager

在一个网页里查看、搜索、备注和修改多个业务的 AI 提示词。每个业务配置一次地址和管理 Token，平台读取提示词目录，保存时写回原业务并回读确认。原业务负责保存和使用提示词，后续任务自动读取新版。

适合同时维护多个 AI 项目、采集任务和后台整理服务的个人开发者。项目希望让分散在不同服务里的提示词更容易查找和调整，并通过接入 Skill 帮助 AI 分析既有项目、提出最小改动方案。

项目开始于 2026 年 11 月 11 日，以[本账号仓库创建记录](https://api.github.com/repos/111pointer111/awesome-prompts-manager)为依据。

## 当前能力

- 登录管理员账户后，按渠道查看提示词，集中搜索名称、用途、正文和备注。搜索忽略英文大小写，多个关键词同时匹配。
- 添加渠道时验证地址和 Token，自动获取目录。可以修改渠道配置、轮换 Token，更换地址时需要明确填写该地址使用的 Token。
- 在同一页面编辑正文和备注，分别保存。正文保存使用原业务版本号，冲突和结果待确认时保留输入，支持查看远端内容再决定如何处理。
- 展示变量、组合关系、生效规则、默认内容和当前版本，支持恢复原业务默认值。
- 页面打开、使用期间每 60 秒及手动操作时同步。业务离线时查看最近一次副本和同步时间，备注仍可编辑。
- 原业务新增条目后自动出现在目录里。移除的条目标记失效，已有备注保留。

## 部署与启动

准备 Node.js 22.16 及以上、Python 3.11 及以上用于开发检查，生产镜像使用 Node.js 24。安装依赖后生成私有配置。

```sh
npm ci
node scripts/configure.mjs http://localhost:3300
npm run build
npm start
```

打开 `http://localhost:3300`，账号为 `admin`，初始密码保存在 `.env` 的 `ADMIN_PASSWORD` 中。脚本只创建新文件，已有配置需要自行编辑。`.env` 中的 `APP_SECRET` 是渠道凭据加密密钥，需要与数据库一起备份并在升级时保留。

### Docker Compose

```sh
node scripts/configure.mjs https://your-domain.example
docker compose build
mkdir -p data
docker compose run --rm --user root app chown node:node /app/data
docker compose up -d
```

服务发布到宿主机 `127.0.0.1:3300`，前置一个可信 HTTPS 反向代理。`APP_ORIGIN` 必须与浏览器访问的协议、主机和端口一致。端口冲突时在 `.env` 设置 `HOST_PORT`，容器内部仍使用 3300。

服务按一层可信反向代理解释 `X-Forwarded-For`，以区分登录限流的客户端。代理应覆盖客户端自行提供的转发头，应用端口只向该代理提供访问。源码中的 Compose 使用宿主机回环绑定。一个管理员账户管理全部渠道，适合个人自部署。

平台使用单实例、单 Node.js 进程，同时提供 API 和 React 静态文件。SQLite 位于 `/app/data/platform.sqlite`，保存管理员密码哈希、登录会话、渠道配置、加密 Token、提示词副本和备注。原业务保存的模板仍是业务任务实际读取的数据。

### 配置与备份

| 配置 | 用途 |
| --- | --- |
| `APP_ORIGIN` | 浏览器的完整访问源，例如 `https://your-domain.example` |
| `ADMIN_USERNAME`、`ADMIN_PASSWORD` | 管理员登录配置，修改后重启会更新账户并注销旧会话 |
| `APP_SECRET` | 32 字节 Base64 密钥，用于 AES-256-GCM 加密渠道 Token |
| `DATA_DIR` | 直接运行时的数据目录，默认 `data` |
| `HOST_PORT` | Compose 发布到宿主机的回环端口，默认 3300 |

备份时停止平台容器，将 `data/` 和 `.env` 一起保存到私有位置，再启动容器。恢复时使用同一份密钥和完整数据目录。渠道 Token 长期复用，业务撤销或轮换后需要在渠道配置中更新。管理员会话有效期为 30 天，退出登录会立即撤销当前会话。

## 接入自己的业务

准备平台后端能访问的 HTTP(S) 基础地址和独立 Bearer Token。可以使用局域网、VPN、现有反向代理或其他已经建立的网络通道。容器内的 `127.0.0.1` 指向容器自身，需要按实际网络配置地址。

业务提供以下接口，完整字段和错误约定见[协议规范](docs/protocol.md)。

| 接口 | 用途 |
| --- | --- |
| `GET /v1/prompts` | 获取完整目录与模板 |
| `GET /v1/prompts/{id}` | 读取单条提示词 |
| `PUT /v1/prompts/{id}` | 比较版本后保存，`content: null` 恢复默认 |

提示词模板在原业务中持久化，任务开始时取得固定版本。长文分段、汇总、纠错等调用沿用该任务的同一组模板。缓存身份包含实际使用的指令，历史已完成结果继续保留。

先运行 [Python 与 TypeScript 示例](examples/README.md)，可在自己的开发环境验证添加渠道、修改、回读和后续任务的模板组装。示例使用合成数据，通过 `/task` 返回模型调用前的组装结果。

## 让 AI 帮助接入

将 [skills/ConnectPrompts](skills/ConnectPrompts/SKILL.md) 安装到支持 `SKILL.md` 的 AI 工具，或让 AI 读取该目录的入口文件。该目录可单独分发，包含随包协议说明。

Skill 从真实模型请求追踪模板、拼接逻辑、存储、缓存和任务读取位置，列出候选及修改方案。用户选择范围并确认后，AI 复用原项目的配置、数据库和 HTTP 服务补齐接口，再验证实际任务是否读取新版。

模板、运行时资料和程序输出协议的处理方式由原业务决定。Skill 会标明依赖内部模板、旧入口以及尚未确认的调用关系，盘点范围随实际调查证据说明。

## 开发检查

```sh
npm run check
npm test
npm run build
```

检查包括平台 API、认证、凭据保护、版本冲突、保存回读、同步和备注持久化、前端草稿、两个语言的参考实现，以及 Skill 的结构和协议一致性。默认检查使用合成数据。

界面开发运行 `npm run dev:web`，后端运行 `npm run dev`。Vite 将 `/api` 转发到本机 3300，调试时将 `APP_ORIGIN` 设置为实际使用的 Vite 页面源。

## 许可证

[MIT](LICENSE)。
