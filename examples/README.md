# 可运行的接入示例

两个示例均使用本地 SQLite 保存自定义模板，通过原子版本比较避免并发覆盖。启动后用 Token 添加到平台，即可读取、修改、备注、恢复默认并验证下一项任务的读取结果。

先安装仓库依赖，生成独立测试凭据并只在当前终端使用。

```sh
npm ci
export PROMPT_MANAGEMENT_TOKEN="$(openssl rand -hex 32)"
npm run example:typescript
```

TypeScript 示例基础地址为 `http://127.0.0.1:3310`。Python 示例使用 Python 3.11 及以上的标准库，在另一个保留测试凭据的终端运行。

```sh
python3 examples/python/server.py
```

Python 示例基础地址为 `http://127.0.0.1:3311`。运行在 Docker 内的平台需要配置能够到达示例的地址，容器内的 `127.0.0.1` 指向容器自身。公开到局域网或私网时，先检查监听地址与访问控制。

`GET /task?topics=工程实践` 同样验证 Bearer Token，返回该次合成任务实际读取的模板版本及组装文本。保存后再次调用，检查新版是否被使用。它展示模型调用前的输入组装，示例未连接模型服务。

将 `content` 设置为 `null` 恢复默认值。重启示例后，已有 SQLite 配置继续生效。原业务接入时优先复用自己的数据库、配置和 HTTP 服务，参考 [协议](../docs/protocol.md) 与 [接入 Skill](../skills/ConnectPrompts/SKILL.md)。
