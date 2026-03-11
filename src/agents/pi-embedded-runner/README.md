# pi-embedded-runner

嵌入式 Pi 代理运行核心：在 OpenClaw 内执行单次「用户消息 → LLM → 工具调用」的完整闭环，包括队列调度、认证轮换、上下文溢出压缩、历史裁剪与用量统计。

## 功能概述

- **队列与并发**：按会话 lane / 全局 lane 排队，保证同一会话串行、多会话可并行。
- **模型解析与认证**：解析 provider/model，多 auth profile 轮换与冷却，支持 GitHub Copilot token 刷新。
- **单次尝试 (attempt)**：加载会话、构建 payload、调用 pi-coding-agent 流式接口、处理工具调用与重试。
- **上下文溢出处理**：检测 context overflow，触发自动压缩 (compact) 或 tool result 截断，重试或返回友好错误。
- **Failover**：prompt 阶段与 assistant 阶段错误分类（auth/rate_limit/billing/timeout/overload），profile 轮换或抛出 FailoverError 触发上层 model fallback。
- **用量与元数据**：汇总 input/output/cache token，产出 `EmbeddedPiRunResult`（payloads + meta），供会话与 UI 使用。

## 目录与文件说明

### 入口与核心流程

| 文件       | 说明                                                                                                                                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.ts`   | **主入口** `runEmbeddedPiAgent`：lane 入队、workspace 解析、before_model_resolve/before_agent_start 钩子、resolveModel、auth profile 循环、重试循环（含 overflow 压缩与 tool result 截断）、用量汇总、返回 `EmbeddedPiRunResult`。 |
| `runs.ts`  | 运行状态注册表：`setActiveEmbeddedRun` / `clearActiveEmbeddedRun`、`abortEmbeddedPiRun`、`queueEmbeddedPiMessage`、`waitForActiveEmbeddedRuns` / `waitForEmbeddedPiRunEnd`。                                                       |
| `lanes.ts` | 解析会话 lane（`session:${key}`）与全局 lane，供 command-queue 入队。                                                                                                                                                              |
| `abort.ts` | `isRunnerAbortError`：判断错误是否为运行器中止（AbortError 或 message 含 "aborted"）。                                                                                                                                             |

### 类型与参数

| 文件            | 说明                                                                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`      | `EmbeddedPiAgentMeta`、`EmbeddedPiRunMeta`、`EmbeddedPiRunResult`、`EmbeddedPiCompactResult`、`EmbeddedSandboxInfo` 等公共类型。                                       |
| `run/params.ts` | `RunEmbeddedPiAgentParams`：会话/通道/workspace、prompt、provider/model、thinkLevel、timeout、回调等。                                                                 |
| `run/types.ts`  | `EmbeddedRunAttemptParams`、`EmbeddedRunAttemptResult`：单次 attempt 的入参与结果（aborted、timedOut、assistantTexts、toolMetas、lastAssistant、compactionCount 等）。 |

### 模型与认证

| 文件                              | 说明                                                                                                                                                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model.ts`                        | `resolveModel` / `resolveModelWithRegistry`：从 agentDir 发现 AuthStorage 与 ModelRegistry，解析 provider/model（含 config 内联、OpenRouter 透传、forward-compat），返回 model + authStorage + modelRegistry。 |
| `model.provider-normalization.ts` | 按 provider 规范化解析后的 model 字段（如 API 形态、reasoning 等）。                                                                                                                                           |

### 单次尝试 (run/attempt)

| 文件                                        | 说明                                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run/attempt.ts`                            | `runEmbeddedAttempt`：写锁、SessionManager 准备、加载历史、限制 history turns、构建 system prompt、注入扩展（context-pruning、compaction-safeguard）、组装 payload、选择 streamFn（OpenAI/Anthropic/Google/Ollama/WS 等）、流式订阅与工具执行、压缩重试与超时、返回 `EmbeddedRunAttemptResult`。 |
| `run/payloads.ts`                           | `buildEmbeddedRunPayloads`：根据 attempt 的 assistantTexts、toolMetas、lastAssistant、lastToolError 等生成对外 payload 列表（文本、媒体、错误、reasoning 等）。                                                                                                                                  |
| `run/payloads.test-helpers.ts`              | payload 构建相关的测试辅助。                                                                                                                                                                                                                                                                     |
| `run/images.ts`                             | 从 prompt 或参数中检测并加载图片（detectAndLoadPromptImages），供 payload 组装。                                                                                                                                                                                                                 |
| `run/history-image-prune.ts`                | 对会话历史中已处理过的图片进行裁剪，控制 token。                                                                                                                                                                                                                                                 |
| `run/compaction-timeout.ts`                 | 压缩过程中的超时检测与快照（selectCompactionTimeoutSnapshot、shouldFlagCompactionTimeout）。                                                                                                                                                                                                     |
| `run/compaction-retry-aggregate-timeout.ts` | 压缩重试时的聚合超时（waitForCompactionRetryWithAggregateTimeout）。                                                                                                                                                                                                                             |
| `run/failover-observation.ts`               | 创建 failover 决策日志（createFailoverDecisionLogger），用于观察 profile 轮换或 fallback 决策。                                                                                                                                                                                                  |

### 会话压缩 (compact)

| 文件                           | 说明                                                                                                                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compact.ts`                   | `compactEmbeddedPiSession`（导出在 pi-embedded-runner 层）：在 context engine 上执行压缩，支持 overflow/manual 触发、token 预算、force；内部包含会话加载、消息度量、摘要生成、写回与 internal hook。 |
| `compact.runtime.ts`           | 压缩运行时依赖（如与 context engine、session file 的交互）。                                                                                                                                         |
| `compaction-safety-timeout.ts` | 压缩安全超时（compactWithSafetyTimeout、EMBEDDED_COMPACTION_TIMEOUT_MS），防止压缩卡死。                                                                                                             |

### 历史与上下文

| 文件                       | 说明                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `history.ts`               | `limitHistoryTurns`：按轮次限制历史条数；`getHistoryLimitFromSessionKey`：从 sessionKey 与 config 解析 dmHistoryLimit / historyLimit。 |
| `system-prompt.ts`         | `buildEmbeddedSystemPrompt`、`applySystemPromptOverrideToSession`、`createSystemPromptOverride`：构建嵌入式运行的系统提示并应用覆盖。  |
| `session-manager-init.ts`  | 为本次运行准备 SessionManager（prewarm、扩展、锁等）。                                                                                 |
| `session-manager-cache.ts` | SessionManager 的预热与访问跟踪（prewarmSessionFile、trackSessionManagerAccess）。                                                     |

### 扩展与提供商适配

| 文件                           | 说明                                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `extensions.ts`                | `buildEmbeddedExtensionFactories`：根据 config 组装 context-pruning（含 cache-ttl）、compaction-safeguard 等扩展工厂。 |
| `google.ts`                    | Google/Gemini 相关：sanitizeSessionHistory、sanitizeToolsForGoogle、logToolSchemasForGoogle。                          |
| `anthropic-stream-wrappers.ts` | Anthropic 流式封装。                                                                                                   |
| `openai-stream-wrappers.ts`    | OpenAI 流式封装。                                                                                                      |
| `moonshot-stream-wrappers.ts`  | Moonshot 流式封装。                                                                                                    |
| `proxy-stream-wrappers.ts`     | 代理流式封装。                                                                                                         |
| `extra-params.ts`              | 按 provider/model 注入额外 API 参数（如 cache、reasoning、tool 流等）。                                                |

### 工具与输出

| 文件                            | 说明                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `tool-name-allowlist.ts`        | 收集本次运行允许的工具名（collectAllowedToolNames），用于工具名规范化与过滤。                                        |
| `tool-split.ts`                 | 将 SDK 工具拆分为不同集合（splitSdkTools），供不同调用路径使用。                                                     |
| `tool-result-truncation.ts`     | 会话内超大 tool result 的检测与截断（sessionLikelyHasOversizedToolResults、truncateOversizedToolResultsInSession）。 |
| `tool-result-context-guard.ts`  | 安装 tool result 上下文守卫（installToolResultContextGuard），限制注入上下文的 tool result 大小。                    |
| `tool-result-char-estimator.ts` | 根据内容估算 tool result 字符数，用于预算控制。                                                                      |
| `thinking.ts`                   | 与 think 级别相关的处理（如 dropThinkingBlocks）。                                                                   |

### 缓存与杂项

| 文件                            | 说明                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `cache-ttl.ts`                  | Cache TTL 时间戳的追加与读取（appendCacheTtlTimestamp、readLastCacheTtlTimestamp、isCacheTtlEligibleProvider）。 |
| `skills-runtime.ts`             | 解析本次运行使用的技能条目（resolveEmbeddedRunSkillEntries）。                                                   |
| `sandbox-info.ts`               | 构建嵌入式沙箱信息（buildEmbeddedSandboxInfo），供 system prompt 或工具使用。                                    |
| `logger.ts`                     | 子系统 logger（agent/embedded）。                                                                                |
| `utils.ts`                      | 通用工具（如 describeUnknownError、mapThinkingLevel）。                                                          |
| `wait-for-idle-before-flush.ts` | 在空闲后刷新待处理的 tool result（flushPendingToolResultsAfterIdle）。                                           |

### 测试与 Fixture

- `*.test.ts`：与对应源文件同名的单元/集成测试。
- `run.overflow-compaction.fixture.ts`、`run.overflow-compaction.mocks.shared.ts`：溢出压缩相关共享 fixture 与 mock。

## 流程图与架构图

- **架构图**：`docs/pi-embedded-runner-architecture.drawio` — 模块分层与依赖关系（入口、模型认证、单次尝试、压缩与历史、工具与扩展、类型）。
- **主流程**：`docs/pi-embedded-runner-flow.drawio` — 从 `runEmbeddedPiAgent` 入队、解析、认证、重试循环、overflow 压缩、failover 到返回的流程图。

图表为 draw.io XML，可用 [draw.io](https://app.diagrams.net/) 或 VS Code Draw.io 插件打开编辑。

## 依赖关系概要

- **run.ts** 依赖：lanes、logger、model、run/attempt、run/params、run/payloads、tool-result-truncation、types、utils、context-engine、auth-profiles、model-auth、session-write-lock、plugins、command-queue 等。
- **run/attempt.ts** 依赖：SessionManager、pi-coding-agent、pi-embedded-subscribe、system-prompt、extensions、history、payloads、images、compaction-timeout、compaction-retry-aggregate-timeout、failover-observation、runs、session-manager-init、skills-runtime、tool-name-allowlist、tool-result-context-guard、wait-for-idle-before-flush 等。
- **compact.ts** 依赖：context-engine、SessionManager、history、system-prompt、extensions、session-write-lock、compaction-safety-timeout、internal-hooks 等。

## 相关文档

- 上层入口与流式订阅：`src/agents/pi-embedded-runner.ts`、`pi-embedded-subscribe.ts`。
- 代理模块总览：`src/agents/AGENTS.md`、`src/agents/CLAUDE.md`。
