# 技术决策记录

## 已确认

### 2026-09-14：项目初始化范围

- 创建独立项目 `wechat2agent`。
- 当前只保留 Git 骨架和研究文档。
- 暂不加入运行时代码、依赖或具体技术栈。

### 2026-09-14：引入 gateway/ echo bot 雏形

- 项目开始引入运行时代码：`gateway/echo-bot.mjs`（Node.js，plain ESM JS，零构建）。
- 定位是命令交互的可测原型：实现斜杠命名空间命令协议（见"微信侧命令交互采用斜杠命名空间"），不接入真实 agent backend。
- 凭证存储于 `gateway/.storage/`（已 gitignore），复用 Phase 0 实测的登录态。
- SDK 的 QR 轮询超时缺陷在网关侧以登录重试包装规避。

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

### 2026-09-14：iLink 接入层确定直接依赖 wechatbot SDK

依据：Phase 0 实测通过（QR 登录、文本/图片收发、context_token 自动管理、凭证持久化与免扫码重启、4000 字符自然边界分片），详见 research.md 2.4。

附带记录两个已知边界：

- SDK 2.2.0 的 QR 状态轮询复用默认 15s HTTP 超时，扫码稍慢会中断登录。短期在网关侧重试登录，中期推动上游修复或维护 patch。
- 凭证文件为明文 JSON（权限 600）。生产形态下 iLink token 必须迁移到 Keychain 或加密存储，SDK 的可插拔 `Storage` 接口支持这一点。

### 2026-09-14：微信侧命令交互采用斜杠命名空间

- 路由规则只有一条：`/` 开头的消息进入命令解析，其余一律进 agent 会话。
- 编号菜单的选项也以斜杠形式呈现和选择：`/1`、`/2`，`/0` 取消。不引入 pending 状态机，从根上消除"裸数字被误吞"的歧义。
- 支持参数直写跳过菜单，如 `/backend zl`、`/model glm-5.2`。
- 命令交互（含菜单问答）不进入 agent 会话上下文。
- 破坏性命令（如任务运行中切换 backend）需要显式确认或先 `/cancel`。
- fallback 规则：菜单发出后，任何不匹配当前菜单选项的输入都使菜单作废并回到正常流程——非斜杠消息静默进入 agent（不提示"菜单已取消"），其他 `/` 命令视为新命令，越界选项提示"无效选项，菜单已取消"。不存在卡死状态。
- agent 的审批请求（waiting_for_approval）复用同一套斜杠选择机制。
- `/help` 提供命令发现。
- 后续可选优化：菜单超时提示、基于 `quotedMessage` 的引用回复精确匹配。

## 仍待讨论

- Gateway 的运行时语言和进程模型。
- 菜单栏控制面是否第一阶段实现。
- Codex、ZL 的 adapter 接口。
- workspace、权限和凭证模型。
- 任务队列、取消和事件推送策略。

