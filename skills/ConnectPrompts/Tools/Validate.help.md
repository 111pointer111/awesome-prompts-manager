# Validate

检查本 Skill 的入口结构、工作流路由、公开内容和随包目录示例。位于平台仓库内时，同时比较随包示例与 `docs/protocol.md` 中的目录示例。

在仓库根目录运行，复用仓库已有的 `tsx` 开发依赖。

```sh
node --import tsx skills/ConnectPrompts/Tools/Validate.ts
node --import tsx skills/ConnectPrompts/Tools/Validate.ts --help
```

成功返回退出码 0，断言失败返回非零退出码并指出具体检查。该检查覆盖文档一致性，AI 在真实项目中的候选识别和接入效果通过 Scan、Integrate、Verify 的使用结果验收。
