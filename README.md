# wechat2agent

微信 iLink 作为消息入口，连接 Codex、Zhanlu/Kilo 等本地 coding agent 的研究与开发项目。

当前阶段只保留研究文档和技术决策记录，暂不引入运行时代码或技术栈依赖。

## 文档

- [调研结果](docs/research.md)
- [技术决策记录](docs/decisions.md)

## 当前目标

- 在微信侧切换 backend、model 和运行参数。
- 在同一 backend 内尽量保留原生 session 续接能力。
- 在跨 backend 时通过 compact/handoff 传递上下文。
- 后续评估 macOS 菜单栏应用形态。

## 当前状态

项目处于技术选型阶段。任何实现方案都需要先经过后续讨论确认。

