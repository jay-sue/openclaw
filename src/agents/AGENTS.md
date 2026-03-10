# src/agents

OpenClaw 的 AI 代理核心模块，负责模型调用、工具链编排、会话管理、子代理生命周期、沙箱隔离与认证等。

## 目录结构

```
src/agents/
├── auth-profiles/       # 多认证 profile 管理（存储、轮询、OAuth、冷却、诊断）
├── cli-runner/          # CLI 代理运行辅助（参数构建、系统提示、输出解析）
├── pi-embedded-helpers/ # Pi 运行辅助（错误分类、轮次合并、图片清理、provider 适配）
├── pi-embedded-runner/  # 嵌入式 Pi 代理运行核心（运行队列、重试、压缩、历史）
├── pi-extensions/       # Pi 扩展（上下文修剪、压缩保护、SessionManager 注册）
├── sandbox/             # Docker 沙箱（容器管理、工作区挂载、文件桥接、工具策略）
├── schema/              # 工具 schema 适配（TypeBox 辅助、xAI/Gemini provider 清理）
├── skills/              # 技能加载与管理（配置、工作区同步、frontmatter 解析、过滤）
├── test-helpers/        # 测试辅助与 fixtures
├── tools/               # 高层工具实现（浏览器、Canvas、消息、会话、Web、TTS 等）
└── *.ts                 # 顶层模块（见下文）
```

## 核心模块

### 代理运行

| 文件 | 作用 |
|------|------|
| `pi-embedded.ts` | 嵌入式 Pi 代理公共 API（re-export） |
| `pi-embedded-runner.ts` | 代理运行入口：队列调度、中止、会话压缩 |
| `pi-embedded-subscribe.ts` | 流式订阅：SSE 回调分发与块分块 |
| `pi-embedded-subscribe.handlers.ts` | 流式事件处理（文本、工具调用、错误） |
| `pi-embedded-subscribe.tools.ts` | 流式工具调用执行 |

### 工具链

| 文件 | 作用 |
|------|------|
| `pi-tools.ts` | 工具链总装配：coding-agent 工具 + bash + openclaw 工具 + 策略过滤 |
| `openclaw-tools.ts` | OpenClaw 高层工具注册（消息、会话、Web、子代理等） |
| `bash-tools.ts` | Shell exec / process 工具 |
| `channel-tools.ts` | 消息通道操作工具 |
| `pi-tools.read.ts` | 文件读写工具（宿主机/沙箱两套） |
| `pi-tools.policy.ts` | 工具策略解析（profile/agent/group/sandbox/subagent 多层） |
| `tool-policy.ts` | 工具策略原语（owner-only、allowlist、profile 策略） |
| `tool-policy-pipeline.ts` | 策略管道：按步骤顺序过滤可用工具 |
| `tool-fs-policy.ts` | 文件系统级工具策略 |

### 子代理

| 文件 | 作用 |
|------|------|
| `subagent-registry.ts` | 子代理运行注册、持久化、终止 |
| `subagent-announce.ts` | 子代理完成通知（回调父会话） |
| `subagent-spawn.ts` | 子代理创建与启动 |
| `subagent-depth.ts` | 子代理嵌套深度限制 |
| `subagent-attachments.ts` | 子代理附件处理 |
| `acp-spawn.ts` | ACP (Agent Communication Protocol) 子代理创建 |

### 模型与认证

| 文件 | 作用 |
|------|------|
| `model-auth.ts` | API Key 解析、provider 配置查找 |
| `model-selection.ts` | 模型选择与 provider 归一化 |
| `model-catalog.ts` | 模型目录与元数据 |
| `model-scan.ts` | 模型扫描（本地 Ollama 等） |
| `models-config.ts` | `models.json` 读写与原子更新 |
| `auth-profiles.ts` | 多 profile 认证管理（re-export `auth-profiles/`） |
| `auth-health.ts` | 认证健康检查 |

### 会话与上下文

| 文件 | 作用 |
|------|------|
| `context.ts` | 会话上下文构建（引导文件、技能、workspace） |
| `bootstrap-files.ts` | 引导上下文文件收集 |
| `bootstrap-cache.ts` | 引导上下文缓存 |
| `bootstrap-hooks.ts` | 引导阶段钩子 |
| `bootstrap-budget.ts` | 引导 token 预算 |
| `session-write-lock.ts` | 会话写锁 |
| `workspace.ts` / `workspace-dir.ts` | 工作区解析与模板 |
| `skills.ts` | 技能系统入口 |

### 其他

| 文件 | 作用 |
|------|------|
| `usage.ts` | Token 用量统计与报告 |
| `content-blocks.ts` | 内容块工具（文本/图片/工具结果） |
| `trace-base.ts` / `cache-trace.ts` | 调用追踪 |
| `sandbox-media-paths.ts` | 沙箱媒体路径映射 |
| `cloudflare-ai-gateway.ts` | Cloudflare AI Gateway 集成 |
| `openai-ws-stream.ts` / `openai-ws-connection.ts` | OpenAI WebSocket 实时流 |
| `command-poll-backoff.ts` | 命令轮询退避策略 |

## 架构要点

1. **分层工具链**：`pi-tools.ts` 组合 `pi-coding-agent`（read/write/edit）、`bash-tools`（exec/process）、`openclaw-tools`（高层工具），再经 `tool-policy-pipeline` 多层策略过滤。
2. **策略管道**：工具经 profile → agent → group → sandbox → subagent 五层策略过滤后注入代理运行。
3. **沙箱隔离**：`sandbox/` 管理 Docker 容器与工作区挂载，`fs-bridge` 提供宿主机/容器间安全文件访问。
4. **子代理生命周期**：`subagent-registry` 管理注册与持久化，`subagent-announce` 完成通知，`subagent-spawn` 创建启动，支持嵌套深度限制。
5. **认证轮询**：`auth-profiles/` 支持多 provider 多 profile，带冷却、失败标记、自动过期与轮询排序。
6. **流式与压缩**：`pi-embedded-subscribe` 处理 SSE 流式回调，`pi-embedded-runner/compact` 在上下文溢出时执行会话压缩。
7. **Provider 适配**：`schema/` 和 `pi-embedded-helpers/` 处理各 provider（OpenAI、Anthropic、Google、xAI）的 schema 差异与轮次格式。

## 开发指南

- 工具 schema 避免 `Type.Union`（`anyOf`/`oneOf`/`allOf`），改用 `stringEnum` / `optionalStringEnum`（见 `schema/typebox.ts`）。
- 新增工具在 `tools/` 下实现，在 `openclaw-tools.ts` 注册，通过 `tool-policy.ts` 配置访问策略。
- 测试与源码同目录，命名 `*.test.ts`；测试辅助放 `test-helpers/`。
- 文件目标控制在 ~500 LOC 以内；大文件应拆分（如 `bash-tools.exec.ts` → `bash-tools.exec-host-shared.ts` 等）。
