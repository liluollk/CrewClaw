# Shared Team Workspace and Scoped Memory Design

## Goal

将 CrewClaw 从“一人一工作区”调整为“多人共享团队 Workspace”，同时把长期记忆拆分为团队记忆和当前会话记忆，避免不同群聊的专属知识互相泄漏；个人私聊和个人记忆暂不纳入本次范围。

## Product model

```text
User ── membership ──> Workspace（团队）
                         ├─ AgentProfile（岗位 Agent）
                         ├─ workspace memory（团队共享）
                         ├─ conversation memory（当前群聊）
                         └─ channel/session
```

当前用户仍通过登录建立身份，但 Workspace 不再等同于用户；一个 Workspace 可以有多个成员。用户可以在自己加入的多个 Workspace 之间切换。

## Memory policy

- `workspace`：团队规则、公共流程和共享知识；当前 Workspace 成员可检索。
- `conversation`：当前群聊、话题或 Web 会话的局部约定；只在相同 `sessionKey` 下检索。
- 既有记忆迁移为 `workspace`，不丢数据。
- `remember_memory` 未明确范围时默认写入当前会话；明确表达团队规则时才写入 Workspace。
- `recall_memory` 在会话中合并 Workspace 记忆和当前会话记忆，不检索其他会话。
- `personal` 作用域、跨渠道个人身份绑定和个人私聊记忆留待后续版本。

## Authorization

- `owner` / `admin`：管理成员、Agent 身份、渠道、任务和团队记忆。
- `member`：使用 Agent、查看可见记忆、创建当前会话记忆。
- 高风险确认记录 `requestedBy`；共享 Workspace 中当前仍按 Workspace 会话归属确认，第一阶段保留 Web 确认入口。
- 现有 Cookie 登录机制保留，改为通过 `workspace_members` 判断 Workspace 访问权。

## Runtime and routing

- Web、IM 和定时任务仍共享现有 Agent Runtime、工具和权限回路。
- Web Session 持久化当前 Workspace；SessionKey 以 Workspace/渠道/账号/对话/话题维度继续隔离，Agent 绑定用于运行时选择和审计。
- `turnContext` 增加操作者 ID，供记忆和工具审计使用。
- 现有进程内串行队列保留；本次不引入 Kafka、RabbitMQ 或 Redis。

## Migration

- 新增 `workspace_members` 并把现有 `workspaces.owner` 回填为 owner 成员。
- 旧工作区、Agent 绑定、聊天历史和记忆保留。
- 新增记忆字段采用默认值 `workspace`，保证旧 API 和旧数据兼容。

## Success criteria

1. 两个用户可以进入同一个 Workspace，且只有成员可以访问其数据。
2. 同一 Workspace 的团队记忆可被不同群聊检索。
3. 运营群记忆不会出现在销售群检索结果中。
4. 旧的记忆、聊天和身份数据迁移后仍可读取。
5. Agent 工具审计能够识别 Workspace、Agent、Session 和操作者。
6. 现有测试全部保持通过，并新增成员权限和记忆作用域测试。
