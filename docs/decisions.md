# 技术决策记录

## 已确认

### 2026-09-14：项目初始化范围

- 创建独立项目 `wechat2agent`。
- 当前只保留 Git 骨架和研究文档。
- 暂不加入运行时代码、依赖或具体技术栈。

### 2026-09-14：暂不采用 WeConnect 作为底座

原因：现有 Codex Route 依赖 Codex Desktop/ChatGPT GUI 自动化，权限要求包括 Accessibility、Automation 和可能的 Screen Recording；这与优先使用 CLI/app-server 的目标不匹配。

### 2026-09-14：同 backend 原生续接，跨 backend handoff

- 同一 backend 内保留 Codex 或 ZL 的 native session。
- model/variant 切换优先作为下一轮 prompt 的参数。
- Codex 与 ZL 之间不做原生 session 格式迁移。
- 跨 backend 时使用 compact/handoff。

### 2026-09-14：iLink 接入层的当前方向

- 以 `@wechatbot/wechatbot` 作为独立 Gateway 的候选起点。
- 以 `Tencent/openclaw-weixin` 作为协议行为和边界情况的对照实现。
- 不直接依赖 OpenClaw channel/runtime。

## 仍待讨论

- Gateway 的运行时语言和进程模型。
- 菜单栏控制面是否第一阶段实现。
- Codex、ZL 的 adapter 接口。
- workspace、权限和凭证模型。
- 任务队列、取消和事件推送策略。

