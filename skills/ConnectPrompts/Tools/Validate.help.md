# Validate

这是仓库开发时可选的文档检查工具，检查入口结构、工作流路由、公开内容和随包目录示例，并比较随包示例与 `docs/protocol.md` 中的目录示例。

单目录使用时，直接读取 `SKILL.md`、对应工作流和随包 `Protocol.md`，按目标项目已有工具执行。`tsx` 仅用于本校验工具，Skill 的文本工作流独立于 `tsx` 和 LifeOS。

需要运行校验时，在仓库根目录复用已有的 `tsx` 开发依赖。

```sh
node --import tsx skills/ConnectPrompts/Tools/Validate.ts
node --import tsx skills/ConnectPrompts/Tools/Validate.ts --help
```

成功返回退出码 0，断言失败返回非零退出码并指出具体检查。该检查覆盖文档一致性，AI 在真实项目中的候选识别和接入效果通过 Scan、Integrate、Verify 的使用结果验收。
