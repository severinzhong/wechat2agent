# 调研结果

更新时间：2026-09-14

本文记录已经核实过的事实、公开项目和实测结果。推测和未验证事项单独标注，不作为当前实现承诺。

## 1. 目标问题

目标是构建一个本地优先的微信 Agent Gateway：

```text
微信 iLink
    -> Gateway
       -> Codex
       -> Zhanlu/Kilo
       -> 后续其他 harness
```

微信侧期望支持：

- 切换 backend。
- 切换 model 和推理参数。
- 查看任务状态。
- 取消、继续或 fork 任务。
- 跨 backend 时通过 compact/handoff 传递上下文。

## 2. iLink 实现对比

### 2.1 腾讯官方仓库

仓库：[Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)

这是腾讯维护的 OpenClaw 微信渠道插件，不是独立的通用 iLink SDK。其 package manifest 包含：

- `@tencent-weixin/openclaw-weixin`
- `author: Tencent`
- `license: MIT`
- OpenClaw peer dependency

协议相关代码主要位于：

```text
src/api/
src/auth/
src/cdn/
src/media/
src/messaging/
src/storage/
```

OpenClaw 适配层主要包括 channel 注册、OpenClaw session、pairing、命令路由、reply progress 和插件配置。

腾讯实现值得作为协议参考，尤其包括：

- `iLink-App-Id` 和 `iLink-App-ClientVersion`。
- `X-WECHAT-UIN` 和请求认证头。
- QR 登录、IDC redirect、pairing code、绑定状态。
- `getupdates` 长轮询和 abort。
- `context_token` 管理。
- session 过期和重登录。
- CDN 上传/下载及 AES-128-ECB。
- 大整数消息 ID 的无损解析。
- 更细的网络错误分类和测试覆盖。

目前没有找到腾讯单独发布的 `ilink-sdk` 或 `wechat-ilink-sdk` 公共仓库。

### 2.2 社区独立 SDK

仓库：[corespeed-io/wechatbot](https://github.com/corespeed-io/wechatbot)

它不是腾讯 SDK 的二次封装，而是直接实现 iLink Bot API 的社区 SDK。README 说明其实现受 `openclaw-weixin` 启发。

Node 包：`@wechatbot/wechatbot`，MIT 许可证。另有 Python、Go、Rust 实现。

主要能力：

- QR 登录和凭证持久化。
- 长轮询、cursor 管理和自动重试。
- `context_token` 生命周期管理。
- 输入状态。
- 文本、图片、文件、语音和视频。
- CDN AES-128-ECB 加密。
- session 过期后的重新登录。
- 文本自然边界分片。
- 多实例/多账号隔离。

仓库已有 Pi 扩展：[pi-agent](https://github.com/corespeed-io/wechatbot/tree/main/pi-agent)。

### 2.3 初步结论

当前更适合：

```text
wechatbot SDK       作为独立 Gateway 的起始接入层
Tencent 仓库        作为 iLink 协议和边界行为的对照实现
```

不建议直接把腾讯 OpenClaw 插件作为本项目运行时依赖，因为它绑定 OpenClaw channel/runtime 接口。

## 3. WeConnect 评估

仓库：[WillbsoluteVodka/wechat2all](https://github.com/WillbsoluteVodka/wechat2all)

WeConnect 是 Tauri + React/TypeScript 的 macOS 桌面应用，不是 TUI。它有 iLink、Router、Route Protocol 和桌面控制台，架构上看似接近目标。

但其现有 Codex Route 的实际定位是：

```text
微信 -> WeConnect -> Codex Desktop/ChatGPT GUI
```

它需要辅助功能、自动化和可能的屏幕录制权限，并通过 GUI 自动化注入消息。它不是纯粹的 `codex exec --json` 或 Codex app-server 适配器。

因此本项目暂不基于 WeConnect 继续开发。该副本已移至 macOS 废纸篓，可恢复。

## 4. Codex 接入边界

本机 Codex CLI 提供：

```text
codex exec --json
codex app-server
```

其中：

- `codex exec --json` 适合一次任务/JSONL 事件流。
- `codex app-server` 更适合长期连接、事件订阅和持久会话。
- `--model`、工作目录、sandbox 和 approval policy 可由网关配置。

待后续确认：第一版使用 `codex exec --json`，还是直接接 app-server。

## 5. Zhanlu/Kilo 接续实测

本机 `zl` 是 Kilo/OpenCode 体系的改造版本。已验证以下能力：

### 5.1 CLI 能力

```text
zl serve
zl run --attach <url>
zl run --session <id>
zl run --continue
zl run --fork
zl export <sessionID>
zl session list
```

`zl run` 支持：

- `--model provider/model`。
- `--variant`。
- `--dir`。
- `--format json`。
- `--session`、`--continue`、`--fork`。
- `--attach`。

### 5.2 实测结果

在隔离的 ZL server 和临时目录中：

1. 创建 session。
2. 第一轮使用 `zhanlu/qwen3.7-max`，输出 `FIRST_OK`。
3. 同一 session 第二轮切换 `zhanlu/glm-5.2`，variant 切换为 `max`。
4. 第二轮正确复述 `FIRST_OK`。
5. 事件记录了新的 `providerID=zhanlu`、`modelID=zhanlu/glm-5.2` 和 `variant=max`。
6. `POST /session/:id/fork` 成功创建子 session。
7. `zl run --attach ... --session <id>` 成功续接并返回 `CLI_RESUME_OK`。

结论：

```text
同 backend 内：保留 native session，可切 model/variant
跨 backend：生成 compact/handoff，再启动或恢复另一个 backend
```

### 5.3 ZL 集成约束

- `zl serve` 的 instance 与工作目录绑定。
- attach 时传 `--dir` 不会改变已经运行的 server instance 目录。
- 网关需要按 workspace 管理 server，或使用 server HTTP API 的 directory instance/header。
- CLI 和 HTTP API 的模型 ID 表达存在差异，需要在网关中规范化。

## 6. 建议的目标架构

```text
macOS 控制面（后续评估菜单栏）
        |
        v
Gateway Supervisor
  |- iLink adapter
  |- session store
  |- backend/model router
  |- task lifecycle
  |- compact/handoff manager
  |- Codex adapter
  `- ZL adapter
```

建议的会话模型：

```text
Gateway session
  |- wechat peer
  |- backend
  |- model
  |- variant/thinking
  |- workspace
  |- Codex native session (optional)
  |- ZL native session (optional)
  `- handoff reference (optional)
```

## 7. 重要安全与运维约束

- 微信联系人必须有 allowlist 或 pairing 策略。
- workspace 必须使用白名单，不能允许消息任意指定绝对路径。
- `--auto`、无审批执行和 danger-full-access 需要显式配置。
- iLink token、Codex 凭证、ZL 凭证不能放在普通项目配置中，应评估 Keychain。
- 一个 iLink 账号只允许一个活跃 poller。
- 长任务事件需要节流，不能每个 JSONL/SSE 事件都发送到微信。
- Codex session ID 与 ZL session ID 必须分开保存。

## 8. 当前未决事项

- Node.js、Swift/SwiftUI、Tauri，或混合架构。
- `wechatbot` 直接依赖，还是抽取/对照腾讯协议层。
- Codex 使用 `exec --json` 还是 app-server。
- ZL 使用 CLI wrapper 还是直接 server HTTP/SSE API。
- session store 使用 JSONL、SQLite、Keychain + 文件，还是其他组合。
- 菜单栏应用是否与 Gateway 同进程，还是 supervisor + sidecar。
- 微信侧命令协议和权限确认交互。

