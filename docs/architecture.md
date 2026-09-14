# 技术栈与总体架构建议

状态：讨论稿

更新时间：2026-09-14

本文记录 `wechat2agent` 当前推荐的技术栈和系统分层，作为后续实现讨论的起点，不代表所有选择已经冻结。

## 1. 推荐方案

```text
SwiftUI 菜单栏应用
        |
        | 本机 loopback HTTP，后续可换 Unix Domain Socket
        v
Node.js / TypeScript Gateway
        |
        +-- wechatbot iLink SDK
        +-- Codex Adapter
        +-- Zhanlu/Kilo Adapter
        +-- Session Store
        +-- Compact/Handoff Manager
        `-- Task Supervisor
```

核心原则：

- SwiftUI 负责 macOS 原生控制面和生命周期。
- TypeScript Gateway 负责微信、任务、会话和 Agent 适配。
- 同一个 backend 内尽量使用原生 session 续接。
- Codex 与 Zhanlu 之间不做原生 session 格式迁移，跨 backend 使用 compact/handoff。
- 先保持本地优先和单用户模型，避免过早引入远程服务或复杂多租户架构。

## 2. macOS 控制面

推荐使用 SwiftUI、`MenuBarExtra`、`SMAppService`、Keychain、Swift `Process` 和 `UserNotifications`。

菜单栏应用主要负责：

- 启动和停止 Gateway。
- 显示微信连接状态。
- 显示当前 backend、model、workspace 和活动任务。
- 管理 workspace、通知、开机启动和重新连接。
- 查看最近任务和错误日志入口。

SwiftUI 不直接承载 Agent 业务。全 Swift 会同时承担 iLink 协议、媒体加密、QR 登录、长轮询、JSONL/SSE 事件和多个 CLI harness 适配；这些能力与 Node/TypeScript 的现有 SDK 和 CLI 调用模型更匹配。

## 3. Gateway

推荐使用 Node.js + TypeScript，以便直接复用 `@wechatbot/wechatbot`，并方便调用 `codex`、`zl`、JSONL 和 SSE。

Gateway 负责：

```text
iLink 登录、轮询、发送、媒体
微信命令解析
Gateway session 管理
backend/model/variant 路由
任务启动、状态、取消和恢复
Codex/ZL 事件规范化
handoff/compact
workspace 和权限检查
事件节流和微信回复分片
```

Gateway 应维护统一任务事件模型，而不是把 Codex 或 ZL 的内部结构暴露给微信：

```text
task.started
task.progress
task.waiting_for_approval
task.completed
task.failed
task.cancelled
```

### 3.1 微信命令协议

采用斜杠命名空间，路由规则只有一条：`/` 开头的消息进入命令解析，其余一律进 agent 会话。

```text
用户: /backend
网关: 切换 backend
      /1 codex
      /2 zl
      /0 取消
用户: /2
网关: 已切换到 zl
```

- 编号菜单的选项以 `/1`、`/2` 形式选择，`/0` 取消；不使用裸数字，不引入 pending 状态机。
- 菜单 fallback：任何不匹配当前菜单选项的输入都使菜单作废并回到正常流程。非斜杠消息静默进 agent，其他 `/` 命令视为新命令，越界选项提示"无效选项，菜单已取消"。
- 支持参数直写跳过菜单：`/backend zl`、`/model glm-5.2`。
- 命令交互（含菜单问答）不进入 agent 会话上下文。
- 破坏性命令（任务运行中切换 backend 等）需要显式确认或先 `/cancel`。
- agent 审批请求复用同一套斜杠选择机制：`/1 批准`、`/2 拒绝`。
- `/help` 提供命令发现。

## 4. Backend Adapter

每个 backend 建议实现：

```text
startTask(input)
continueTask(input)
cancelTask(taskId)
forkTask(sessionId)
getStatus(taskId)
listModels()
compactSession(sessionId)
```

### Codex

第一阶段优先评估：

```bash
codex exec --json
```

它适合快速建立端到端链路，并以 JSONL 读取任务事件。后续再接入 `codex app-server`，以支持长期 session、事件订阅、取消和审批。

Codex GUI 自动化不作为主路径，因为它会引入 Accessibility、Automation 和可能的 Screen Recording 权限。

### Zhanlu/Kilo

短期可以封装：

```bash
zl run --attach <server> --session <id> --format json
```

长期建议直接使用 ZL/Kilo server API 和事件流，以获得 session 创建和恢复、model/variant 切换、SSE 订阅、abort、fork 和 workspace instance 管理。

ZL server 与 workspace instance 绑定。网关不能假设在 attach 时传 `--dir` 就能改变已运行 server 的工作目录，应按 workspace 管理 server，或使用 server API 的 directory instance 机制。

## 5. Session、模型和 handoff

网关维护一个面向微信用户的逻辑会话：

```text
wechat_peer
current_backend
current_model
current_variant
workspace
active_task
codex_native_session
zl_native_session
handoff_reference
```

同一 backend 内：

- 保留该 backend 的 native session。
- 新一轮 prompt 可以修改 model 或 variant。
- 尽量使用原生继续、取消、fork 和 compact 能力。
- 不生成跨 backend handoff。

跨 backend 时：

1. 停止或等待当前任务达到可切换状态。
2. 生成当前 backend 的 compact/handoff。
3. 保存任务目标、已完成工作、修改文件、测试结果、未解决问题和下一步。
4. 创建或恢复目标 backend 的 native session。
5. 将 handoff 作为新 backend 的上下文输入。

## 6. 存储与凭证

建议使用 SQLite 或等价本地状态库保存：

```text
gateway_sessions
backend_sessions
tasks
messages
workspaces
handoffs
```

敏感凭证使用 macOS Keychain 保存：iLink bot token、Codex/Zhanlu 凭证或引用，以及本地 Gateway capability token。不要把明文 token/API key 放入 Git、普通 JSON 配置或调试日志。

第一版如果希望降低依赖，也可以先用受限 JSONL/JSON 文件，但存储接口应独立出来，后续可替换为 SQLite。

## 7. Swift 与 Gateway 通信

第一阶段使用：

```text
SwiftUI App <-> http://127.0.0.1:<port> <-> Gateway
```

Gateway 启动时生成 capability token，SwiftUI 通过受保护的本地配置传递该 token。后续如需更严格的本机边界，可以改用 Unix Domain Socket 和进程生命周期校验。不建议一开始引入远程 HTTP 服务。

## 8. 安全边界

- 微信联系人使用 allowlist 或 pairing 策略。
- workspace 使用白名单，不能接受微信消息任意指定绝对路径。
- `--auto`、无审批执行和 danger-full-access 必须显式开启。
- 长任务默认不把每个 JSONL/SSE 事件推送到微信，应节流为阶段进度和最终结果。
- 一个 iLink 账号只允许一个活跃 poller。
- Codex session ID 和 ZL session ID 分开保存。
- 所有从微信进入的命令都经过解析、授权和参数校验。

## 9. 建议目录

```text
wechat2agent/
├── app-macos/       # SwiftUI 菜单栏应用
├── gateway/         # Node.js/TypeScript Gateway
├── adapters/
│   ├── codex/
│   └── zhanlu/
├── protocol/        # Gateway 内部事件和控制协议
├── storage/
└── docs/
```

这只是建议目录，不在当前阶段创建运行时代码。

## 10. 分阶段路线

### Phase 0：技术验证

- 确认 `wechatbot` 的登录、收消息和回复。（已完成，见 research.md 2.4）
- 确认 Codex `exec --json` 的事件映射。
- 确认 ZL attach/server API 的持续 session、换模型和取消。（已完成，见 research.md 5.2）
- 记录各 adapter 的权限需求。

### Phase 1：最小 Gateway

- 单一 iLink 账号。
- 一个允许的 workspace。
- `/backend`、`/model`、`/status`、`/cancel`。
- Codex 和 ZL 的文字输入输出。
- 本地文件状态。

### Phase 2：可靠会话

- native session 恢复。
- fork、compact、handoff。
- workspace 白名单。
- 任务队列和崩溃恢复。
- 事件节流和通知。

### Phase 3：macOS 控制面

- SwiftUI 菜单栏应用。
- Gateway sidecar 管理。
- Keychain。
- 开机启动和系统通知。
- 日志和状态查看。

### Phase 4：扩展

- Claude、Pi 或其他 harness。
- 多 workspace。
- 多 iLink 账号。
- 更丰富的媒体和审批交互。

## 11. 尚未冻结的选择

- Gateway 是否使用 Node.js 单进程，还是拆成 supervisor 与 worker。
- Codex 第一版直接使用 `exec --json`，还是从 app-server 开始。
- ZL 第一版使用 CLI wrapper，还是直接接 server HTTP/SSE。
- 第一版使用 JSONL 文件，还是直接引入 SQLite。
- SwiftUI 控制面是否和第一版 Gateway 同步开发。
- 是否需要把协议核心从 `wechatbot` 抽出，以便更紧密跟随腾讯实现。

