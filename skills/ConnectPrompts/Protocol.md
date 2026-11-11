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

目录最多 1000 项，响应体最多 8 MiB，单个模板上限为 131072 个 JavaScript UTF-16 代码单元，业务通过 `maxLength` 声明具体上限。其他语言计算长度时使用相同单位。超过范围时先扩展协议和资源验证。

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

## 任务和缓存

原业务保存代码默认值及持久化覆盖，重启和重建容器后继续读取自定义配置。任务开始时一次读取所需整组模板并固定到结束，新任务使用新版。持久化写入使用事务或原子文件替换，缓存身份包含实际使用的整组指令或版本指纹。历史已完成结果按原业务规则保留，平台离线期间原业务继续读取本地提示词。
