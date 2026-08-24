# CrewClaw 仓库约定

CrewClaw 是面向养殖场生产协作场景的多渠道数字员工平台（个人独立项目）。

## 对外描述边界

- 当前仓库是可独立运行的平台实现：Agent 运行时、多用户工作区、记忆、Web/飞书/钉钉渠道、权限确认、定时任务与模型接入。
- 业务数据全部为本地模拟（见 src/farm-domain.ts），不接入真实猪场系统。
- 对外描述只说明已实现的技术闭环，不虚构用户量、线上部署、性能指标或业务收益；Agent 不做诊断、不开处方。

## 工程约定

- 提交信息使用简洁中文，按模块分批提交。
- 前端界面文案与视觉保持养殖场景定位（智牧工作台）。
- 平台层（agent-runtime / session-router / memory / auth / gateway）与场景层（farm-domain / tools）保持解耦，场景改造不重构平台层。
- 涉及模型接入的改动优先复用 Pi SDK 原生机制（models.json / auth.json / ModelRuntime.login）。
