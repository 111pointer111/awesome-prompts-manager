# 提示词管理协议 v1

本文件随 Skill 分发。在平台仓库内，以 [docs/protocol.md](../../docs/protocol.md) 和 [shared/protocol.ts](../../shared/protocol.ts) 为接口规范来源。Python 与 TypeScript 参考实现分别位于仓库的 `examples/python/server.py`、`examples/typescript/server.ts`。

## 连接与目录

平台配置业务基础 URL 与 Bearer Token。下列路径追加到基础 URL，路径前缀可由业务复用已有路由。每次读取和修改均验证 `Authorization: Bearer <业务令牌>`，返回 JSON，HTTP 重定向按失败处理。

`GET /v1/prompts` 返回完整目录快照。

```json
{
  "protocolVersion": 1,
  "service": { "id": "example-service", "name": "示例服务" },
  "prompts": [{
    "id": "article-review",
    "name": "文章评分",
    "description": "按当前兴趣评价文章价值",
    "content": "请根据 {topics} 评价文章。",
    "defaultContent": "请根据 {topics} 评价文章。",
    "revision": "0",
    "customized": false,
    "readOnly": false,
    "maxLength": 16000,
    "variables": [{ "name": "topics", "description": "任务开始时取得的兴趣话题" }],
    "composition": ["评分模板", "本次内容偏好", "文章原文作为独立用户消息"],
    "effect": "下一项文章评审开始时使用，同一评审的分段与汇总固定版本"
  }]
}
```

`service.id`、`prompt.id` 在改名、重启和部署时保持稳定，目录内提示词 ID 唯一。ID 由英文字母或数字开头，其余字符使用英文字母、数字、点、下划线或连字符，总长 1～128 字符。平台用渠道 ID 和提示词 ID 关联备注，服务实例变化需要显式处理。

`content` 是当前原始模板，`defaultContent` 是当前部署代码提供的默认值，`revision` 是版本字符串，`customized` 表示使用自定义配置，`readOnly` 表示当前条目只读。`variables` 提供变量名称和说明，`composition` 描述实际组合顺序，`effect` 说明新任务生效单位。原始资料、变量实际值和密钥由原业务管理。

字符串长度使用 JavaScript UTF-16 代码单元，其他语言按相同单位校验。v1 的字段上限如下，业务通过 `maxLength` 声明实际模板上限。

| 字段 | 范围 |
| --- | --- |
| `service.id`、`id`、`variables[].name` | 1～128，字符规则同上 |
| `service.name`、`name` | 1～200 |
| `description` | 0～4000 |
| `content`、`defaultContent` | 1～131072 |
| `contentFormat` | 可选，`json` 表示正文为 JSON 配置；省略时按原有纯文本模板处理 |
| `revision`、`expectedRevision` | 字符串，1～128 |
| `maxLength` | 整数，1～131072 |
| `variables`、`composition` | 各 0～100 项 |
| `variables[].description`、`composition[]` | 每项 0～2000 |
| `effect` | 1～2000 |
| `prompts` | 0～1000 项 |
| 目录响应体 | 最多 8 MiB |

超过范围时先扩展协议和资源验证。

目录同步成功后，平台更新完整副本。失联保留最近成功副本，目录已移除项保留备注并标记失效。

## 单条读取、修改与恢复默认

`GET /v1/prompts/{id}` 返回目录内同结构的单条提示词。`PUT /v1/prompts/{id}` 接收下列对象，成功返回实际保存的单条提示词。

```json
{ "content": "新的模板，保留 {topics} 变量", "expectedRevision": "0" }
```

`content: null` 恢复当前默认值。`revision` 和 `expectedRevision` 都是字符串。业务原子比较版本并持久化，完成后返回新 revision。目录、单条读取与修改后的字段结构一致。

| 情况 | HTTP 状态 |
| --- | --- |
| 无效 Token | 401 |
| 未知 ID | 404 |
| 无效模板 | 400 |
| 只读条目修改 | 403 |
| 旧版本写入 | 409 |

错误对象为 `{"error":"稳定错误代码","message":"可读说明"}`，错误信息保持凭据脱敏。保存后重新读取确认内容和版本，连接中断时通过读取确认结果，写操作不自动重试。占位符和程序输出协议由原业务校验，备注通过平台的独立接口与版本保存。

### JSON 业务配置

整份业务配置可以作为独立条目接入，使用 `contentFormat: "json"`。`content` 和 `defaultContent` 仍为字符串，字符串内保存完整 JSON，可使用中文字段名。字段、类型、取值范围及启停含义由原业务校验，保存复用原配置的持久化存储。

平台比较这类条目的保存回执和回读结果时，先解析 JSON，再比较完整值。对象字段顺序和格式空白不影响确认，数组元素顺序仍参与比较。原业务应拒绝非法输入及需要改变字段值才能保存的输入，并返回可读的 400 错误，避免用户提交的值在保存时被悄悄改写。未声明 `contentFormat` 的模板继续逐字比较正文。

JSON 配置的 `customized` 表示当前配置是否与默认配置不同，普通 `PUT` 保存的回执可以为 `false`。`content: null` 仍恢复默认，回执须满足 `customized: false`，正文与 `defaultContent` 的 JSON 值相同。`revision` 同时覆盖原共享配置版本和默认值的变化，已有配置入口的修改也应使旧版本写入返回 409。保存后仍需回读确认内容和版本。

## 任务和缓存

原业务保存代码默认值及持久化覆盖，重启和重建容器后继续读取自定义配置。任务开始时一次读取所需整组模板并固定到结束，新任务使用新版。持久化写入使用事务或原子文件替换，缓存身份包含实际使用的整组指令或版本指纹。历史已完成结果按原业务规则保留，平台离线期间原业务继续读取本地提示词。
