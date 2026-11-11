# 开发约定

- 先读 README、docs/protocol.md 和相关调用方，保持平台、协议、示例、接入 Skill 一致。
- 以用户确认的功能为范围，优先复用现有业务能力和标准库，按存储、渠道通信、HTTP 和界面职责组织代码。
- 用户数据和凭据位于运行目录。公开示例使用合成内容，不提交 .env、数据库、生产提示词或访问凭据。
- 修改后运行 npm run check、npm test 和 npm run build，按影响补充浏览器及真实接入验证。
- 提交使用中文 Conventional Commits，README 区分已实现、已验证和已部署状态。
