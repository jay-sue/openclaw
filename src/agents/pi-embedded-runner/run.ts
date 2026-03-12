/**
 * ============================================================================
 * 嵌入式 Pi 代理主入口模块 (Embedded Pi Agent Runner)
 * ============================================================================
 *
 * 本模块是 OpenClaw AI 代理系统的核心运行入口，导出主函数 runEmbeddedPiAgent。
 *
 * 【模块概述】
 * 这是整个代理系统的"大脑"，负责协调所有组件完成一次完整的用户请求处理。
 * 从接收用户消息到返回 AI 响应，涉及队列调度、模型选择、认证管理、错误恢复等。
 *
 * 【核心职责】
 *
 * 1. **队列调度** (Queueing)
 *    - 通过双层 lane 机制确保并发安全
 *    - session lane: 串行化同一会话的请求，防止消息乱序
 *    - global lane: 控制跨会话的全局并发，防止资源耗尽
 *
 * 2. **工作区解析** (Workspace Resolution)
 *    - 根据 agentId/sessionKey 解析实际工作目录
 *    - 支持 fallback 机制，确保始终有有效工作区
 *
 * 3. **插件钩子执行** (Plugin Hooks)
 *    - before_model_resolve: 允许插件覆盖模型选择
 *    - before_agent_start: 允许插件注入运行时配置
 *    - 支持新旧钩子的兼容性合并
 *
 * 4. **模型与认证解析** (Model & Auth Resolution)
 *    - 从配置中解析 provider/model
 *    - 获取对应的 API Key
 *    - 验证上下文窗口大小
 *
 * 5. **多 Profile 轮换** (Auth Profile Rotation)
 *    - 在认证失败时自动切换到下一个认证配置
 *    - 在速率限制时标记冷却并轮换
 *    - 支持用户锁定特定 profile
 *
 * 6. **重试循环** (Retry Loop)
 *    - context overflow: 执行自动压缩或 tool result 截断
 *    - 认证错误: 轮换 auth profile
 *    - 速率限制: 标记冷却，轮换或 failover
 *    - 超时: 轮换 profile 或触发模型 failover
 *
 * 7. **用量汇总** (Usage Aggregation)
 *    - 累计多次 API 调用的 token 用量
 *    - 区分累加值和最后一次调用值
 *    - 准确计算上下文大小
 *
 * 【执行流程图】
 *
 * ```
 * ┌─────────────────┐
 * │ 用户发送消息    │
 * └────────┬────────┘
 *          ↓
 * ┌─────────────────┐
 * │ 入队 Session    │ ← 串行化同一会话
 * │     Lane        │
 * └────────┬────────┘
 *          ↓
 * ┌─────────────────┐
 * │ 入队 Global     │ ← 控制全局并发
 * │     Lane        │
 * └────────┬────────┘
 *          ↓
 * ┌─────────────────┐
 * │ 解析工作区      │
 * └────────┬────────┘
 *          ↓
 * ┌─────────────────┐
 * │ 运行插件钩子    │ ← before_model_resolve / before_agent_start
 * └────────┬────────┘
 *          ↓
 * ┌─────────────────┐
 * │ 解析模型配置    │ ← provider/model → Model 对象
 * └────────┬────────┘
 *          ↓
 * ┌─────────────────┐
 * │ 检查上下文窗口  │ ← 验证大小是否足够
 * └────────┬────────┘
 *          ↓
 * ┌─────────────────┐
 * │ 解析认证配置    │ ← 获取 API Key，选择 profile
 * └────────┬────────┘
 *          ↓
 * ┌─────────────────────────────────────────┐
 * │           主 重 试 循 环                │
 * │  ┌─────────────────────────────────┐   │
 * │  │ runEmbeddedAttempt()            │   │
 * │  │ (实际的模型 API 调用)           │   │
 * │  └───────────────┬─────────────────┘   │
 * │                  ↓                     │
 * │  ┌─────────────────────────────────┐   │
 * │  │ 检查结果                        │   │
 * │  │ - 成功 → 返回响应               │   │
 * │  │ - 上下文溢出 → 压缩/截断重试    │   │
 * │  │ - 认证错误 → 轮换 profile 重试  │   │
 * │  │ - 速率限制 → 轮换/failover      │   │
 * │  │ - 超时 → 轮换/failover          │   │
 * │  └─────────────────────────────────┘   │
 * └─────────────────────────────────────────┘
 *          ↓
 * ┌─────────────────┐
 * │ 构建响应        │ ← payloads + meta
 * │ 返回结果        │
 * └─────────────────┘
 * ```
 *
 * 【返回值】
 * EmbeddedPiRunResult 对象，包含：
 * - payloads: 响应负载数组（文本、错误等）
 * - meta: 运行元数据（用量、耗时、错误信息等）
 * - 消息工具输出（如果使用了 messaging tool）
 *
 * 【相关模块】
 * - run/attempt.ts: 单次尝试的执行逻辑
 * - run/payloads.ts: 响应 payload 构建
 * - model.ts: 模型解析
 * - auth-profiles.ts: 认证 profile 管理
 * - context-engine/: 上下文压缩引擎
 */

// ============================================================================
// Node.js 内置模块
// ============================================================================

// 加密模块：用于生成随机 ID（如工具调用 ID）
import { randomBytes } from "node:crypto";
// 文件系统模块（Promise 版本）：用于创建工作区目录
import fs from "node:fs/promises";
// ============================================================================
// 内部模块导入 - 自动回复相关
// ============================================================================
// 思考级别类型定义（off/low/medium/high）
// 控制模型的 reasoning/thinking 能力级别
import type { ThinkLevel } from "../../auto-reply/thinking.js";
// ============================================================================
// 内部模块导入 - 上下文引擎
// ============================================================================
// 上下文引擎初始化和解析函数
// 上下文引擎负责会话历史的存储、压缩和检索
import {
  ensureContextEnginesInitialized, // 确保上下文引擎已初始化
  resolveContextEngine, // 根据配置解析具体的上下文引擎实例
} from "../../context-engine/index.js";
// ============================================================================
// 内部模块导入 - 基础设施
// ============================================================================
// 退避策略工具：用于过载时的指数退避重试
import { computeBackoff, sleepWithAbort, type BackoffPolicy } from "../../infra/backoff.js";
// 安全随机数生成：用于生成诊断 ID 等
import { generateSecureToken } from "../../infra/secure-random.js";
// ============================================================================
// 内部模块导入 - 插件系统
// ============================================================================
// 全局钩子运行器：管理和执行插件钩子
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
// 插件钩子结果类型
import type { PluginHookBeforeAgentStartResult } from "../../plugins/types.js";
// ============================================================================
// 内部模块导入 - 进程与队列
// ============================================================================
// 命令队列：实现 lane 机制的核心函数
import { enqueueCommandInLane } from "../../process/command-queue.js";
// ============================================================================
// 内部模块导入 - 工具函数
// ============================================================================
// 消息通道类型检测：判断通道是否支持 Markdown 格式
import { isMarkdownCapableMessageChannel } from "../../utils/message-channel.js";
// ============================================================================
// 内部模块导入 - Agent 相关
// ============================================================================
// Agent 目录解析：获取 OpenClaw Agent 的工作目录路径
import { resolveOpenClawAgentDir } from "../agent-paths.js";
// Agent 作用域检查：检测是否配置了模型 fallback
import { hasConfiguredModelFallbacks } from "../agent-scope.js";
// ============================================================================
// 内部模块导入 - 认证 Profile 管理
// ============================================================================
// 认证 profile 状态管理函数
import {
  isProfileInCooldown, // 检查 profile 是否在冷却中
  type AuthProfileFailureReason, // profile 失败原因类型
  markAuthProfileFailure, // 标记 profile 失败
  markAuthProfileGood, // 标记 profile 健康
  markAuthProfileUsed, // 更新 profile 最后使用时间
  resolveProfilesUnavailableReason, // 解析所有 profile 不可用的原因
} from "../auth-profiles.js";
// ============================================================================
// 内部模块导入 - 上下文窗口管理
// ============================================================================
// 上下文窗口保护相关常量和函数
import {
  CONTEXT_WINDOW_HARD_MIN_TOKENS, // 硬性最小 token 数
  CONTEXT_WINDOW_WARN_BELOW_TOKENS, // 警告阈值
  evaluateContextWindowGuard, // 评估上下文窗口是否足够
  resolveContextWindowInfo, // 解析有效的上下文窗口信息
} from "../context-window-guard.js";
// ============================================================================
// 内部模块导入 - 默认值
// ============================================================================
// 系统默认值常量
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
// ============================================================================
// 内部模块导入 - 错误处理
// ============================================================================
// Failover 错误类型和状态解析
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";
// ============================================================================
// 内部模块导入 - 模型认证
// ============================================================================
// 模型认证相关函数
import {
  ensureAuthProfileStore, // 确保认证 profile 存储已加载
  getApiKeyForModel, // 获取模型的 API Key
  resolveAuthProfileOrder, // 解析 profile 轮换顺序
  type ResolvedProviderAuth, // 解析后的认证信息类型
} from "../model-auth.js";
// ============================================================================
// 内部模块导入 - 模型选择
// ============================================================================
// 提供商 ID 标准化：统一大小写、别名等
import { normalizeProviderId } from "../model-selection.js";
// 确保 models.json 配置文件存在
import { ensureOpenClawModelsJson } from "../models-config.js";
// ============================================================================
// 内部模块导入 - Pi 嵌入式辅助函数
// ============================================================================
// 错误分类、格式化和检测函数
import {
  formatBillingErrorMessage, // 格式化计费错误消息
  classifyFailoverReason, // 分类 failover 原因
  formatAssistantErrorText, // 格式化 assistant 错误文本
  isAuthAssistantError, // 检测认证错误
  isBillingAssistantError, // 检测计费错误
  isCompactionFailureError, // 检测压缩失败错误
  isLikelyContextOverflowError, // 检测上下文溢出错误
  isFailoverAssistantError, // 检测需要 failover 的错误
  isFailoverErrorMessage, // 检测 failover 错误消息
  parseImageSizeError, // 解析图片大小错误
  parseImageDimensionError, // 解析图片尺寸错误
  isRateLimitAssistantError, // 检测速率限制错误
  isTimeoutErrorMessage, // 检测超时错误消息
  pickFallbackThinkingLevel, // 选择降级的思考级别
  type FailoverReason, // failover 原因类型
} from "../pi-embedded-helpers.js";
// ============================================================================
// 内部模块导入 - 运行时插件
// ============================================================================
// 确保运行时插件已加载
import { ensureRuntimePluginsLoaded } from "../runtime-plugins.js";
// ============================================================================
// 内部模块导入 - 用量统计
// ============================================================================
// 用量计算和标准化函数
import { derivePromptTokens, normalizeUsage, type UsageLike } from "../usage.js";
// ============================================================================
// 内部模块导入 - 工作区
// ============================================================================
// 工作区解析和标识符脱敏
import { redactRunIdentifier, resolveRunWorkspaceDir } from "../workspace-run.js";
// ============================================================================
// 本地模块导入 - Lane 管理
// ============================================================================
// Lane 解析函数：用于队列调度
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";
// ============================================================================
// 本地模块导入 - 日志
// ============================================================================
// 本模块的日志记录器
import { log } from "./logger.js";
// ============================================================================
// 本地模块导入 - 模型解析
// ============================================================================
// 模型解析函数：根据 provider/modelId 获取完整模型配置
import { resolveModel } from "./model.js";
// ============================================================================
// 本地模块导入 - 运行尝试
// ============================================================================
// 单次运行尝试函数：执行实际的模型 API 调用
import { runEmbeddedAttempt } from "./run/attempt.js";
// Failover 决策日志记录器
import { createFailoverDecisionLogger } from "./run/failover-observation.js";
// 运行参数类型定义
import type { RunEmbeddedPiAgentParams } from "./run/params.js";
// 响应 payload 构建函数
import { buildEmbeddedRunPayloads } from "./run/payloads.js";
// ============================================================================
// 本地模块导入 - Tool Result 截断
// ============================================================================
// Tool result 截断相关函数
import {
  truncateOversizedToolResultsInSession, // 截断会话中过大的 tool result
  sessionLikelyHasOversizedToolResults, // 检测是否存在过大的 tool result
} from "./tool-result-truncation.js";
// ============================================================================
// 本地模块导入 - 类型定义
// ============================================================================
// 运行结果和元数据类型
import type { EmbeddedPiAgentMeta, EmbeddedPiRunResult } from "./types.js";
// 错误描述工具函数
import { describeUnknownError } from "./utils.js";

/** API Key 信息类型别名，包含 apiKey、profileId、mode 等认证相关字段 */
type ApiKeyInfo = ResolvedProviderAuth;

/**
 * GitHub Copilot token 状态管理对象类型。
 * 用于维护 Copilot API token 的生命周期，包括刷新定时器和并发控制。
 */
type CopilotTokenState = {
  /** 原始 GitHub token（用于换取 Copilot API token） */
  githubToken: string;
  /** Copilot token 过期时间戳（毫秒） */
  expiresAt: number;
  /** 定时刷新的计时器句柄 */
  refreshTimer?: ReturnType<typeof setTimeout>;
  /** 当前正在进行的刷新请求（用于避免重复刷新） */
  refreshInFlight?: Promise<void>;
};

/** Copilot token 刷新提前量：在过期前 5 分钟开始刷新 */
const COPILOT_REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** Copilot token 刷新失败后的重试间隔：60 秒 */
const COPILOT_REFRESH_RETRY_MS = 60 * 1000;
/** Copilot token 刷新最小延迟：防止过于频繁刷新 */
const COPILOT_REFRESH_MIN_DELAY_MS = 5 * 1000;

/**
 * 过载故障转移退避策略。
 * 保持足够明显的间隔避免紧密重试突发，同时又足够短以在单轮对话内保持响应性。
 */
const OVERLOAD_FAILOVER_BACKOFF_POLICY: BackoffPolicy = {
  initialMs: 250, // 初始退避 250ms
  maxMs: 1_500, // 最大退避 1.5s
  factor: 2, // 指数因子
  jitter: 0.2, // 20% 抖动
};

/**
 * Anthropic 拒绝测试魔术字符串。
 * 用于防止 Anthropic 的拒绝测试 token 污染会话记录。
 */
const ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";
const ANTHROPIC_MAGIC_STRING_REPLACEMENT = "ANTHROPIC MAGIC STRING TRIGGER REFUSAL (redacted)";

/**
 * 清理 prompt 中的 Anthropic 拒绝魔术字符串。
 * 将敏感的测试触发字符串替换为无害的占位符，避免污染会话历史。
 *
 * @param prompt - 原始用户输入
 * @returns 清理后的 prompt
 */
function scrubAnthropicRefusalMagic(prompt: string): string {
  if (!prompt.includes(ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL)) {
    return prompt;
  }
  return prompt.replaceAll(
    ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL,
    ANTHROPIC_MAGIC_STRING_REPLACEMENT,
  );
}

/**
 * 单次运行内多次 API 调用的 token 用量累加器。
 *
 * 由于一次代理运行可能包含多次 API 调用（工具调用循环、压缩重试等），
 * 需要累加所有调用的用量。但 last* 字段仅保留最近一次调用的值，
 * 用于准确上报当前上下文大小（避免累加导致的膨胀）。
 */
type UsageAccumulator = {
  /** 累计输入 token 数 */
  input: number;
  /** 累计输出 token 数 */
  output: number;
  /** 累计缓存读取 token 数 */
  cacheRead: number;
  /** 累计缓存写入 token 数 */
  cacheWrite: number;
  /** 累计总 token 数 */
  total: number;
  /** 最近一次 API 调用的缓存读取数（不累加） */
  lastCacheRead: number;
  /** 最近一次 API 调用的缓存写入数（不累加） */
  lastCacheWrite: number;
  /** 最近一次 API 调用的输入 token 数（不累加） */
  lastInput: number;
};

/**
 * 创建一个初始化的用量累加器。
 * 所有计数器归零。
 */
const createUsageAccumulator = (): UsageAccumulator => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  lastCacheRead: 0,
  lastCacheWrite: 0,
  lastInput: 0,
});

/**
 * 生成上下文溢出压缩诊断 ID。
 * 格式：ovf-{时间戳base36}-{4字节随机token}
 * 用于在日志中追踪特定的压缩事件。
 */
function createCompactionDiagId(): string {
  return `ovf-${Date.now().toString(36)}-${generateSecureToken(4)}`;
}

/**
 * 外层运行循环的防护性迭代次数限制。
 * 这些常量用于计算允许的最大重试次数，防止无限循环。
 */
/** 基础重试次数 */
const BASE_RUN_RETRY_ITERATIONS = 24;
/** 每个认证 profile 额外允许的重试次数 */
const RUN_RETRY_ITERATIONS_PER_PROFILE = 8;
/** 最小总重试次数 */
const MIN_RUN_RETRY_ITERATIONS = 32;
/** 最大总重试次数（硬上限） */
const MAX_RUN_RETRY_ITERATIONS = 160;

/**
 * 根据认证 profile 候选数量计算最大重试迭代次数。
 * profile 越多，允许的重试次数越多（因为每个 profile 都可能需要轮换）。
 *
 * @param profileCandidateCount - 可用的认证 profile 数量
 * @returns 计算后的最大重试次数
 */
function resolveMaxRunRetryIterations(profileCandidateCount: number): number {
  const scaled =
    BASE_RUN_RETRY_ITERATIONS +
    Math.max(1, profileCandidateCount) * RUN_RETRY_ITERATIONS_PER_PROFILE;
  return Math.min(MAX_RUN_RETRY_ITERATIONS, Math.max(MIN_RUN_RETRY_ITERATIONS, scaled));
}

/**
 * 检查用量对象是否包含有效值。
 * 任一字段为正有限数即视为有效。
 *
 * @param usage - 标准化后的用量对象
 * @returns 是否包含有效用量数据
 */
const hasUsageValues = (
  usage: ReturnType<typeof normalizeUsage>,
): usage is NonNullable<ReturnType<typeof normalizeUsage>> =>
  !!usage &&
  [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.total].some(
    (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
  );

/**
 * 将单次 API 调用的用量合并到累加器中。
 *
 * 此函数执行两个操作：
 * 1. 累加所有字段到总计（用于最终用量报告）
 * 2. 更新 last* 字段为本次调用的值（用于准确的上下文大小计算）
 *
 * 为什么需要 last* 字段？因为多次工具调用循环会导致 cacheRead 累加，
 * 而每次调用的 cacheRead ≈ 当前上下文大小，累加 N 次就变成 N × 上下文大小，
 * 这会导致上下文大小报告严重失真。
 *
 * @param target - 累加器目标对象
 * @param usage - 本次 API 调用的用量
 */
const mergeUsageIntoAccumulator = (
  target: UsageAccumulator,
  usage: ReturnType<typeof normalizeUsage>,
) => {
  if (!hasUsageValues(usage)) {
    return;
  }
  // 累加所有用量字段
  target.input += usage.input ?? 0;
  target.output += usage.output ?? 0;
  target.cacheRead += usage.cacheRead ?? 0;
  target.cacheWrite += usage.cacheWrite ?? 0;
  target.total +=
    usage.total ??
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  // 更新 last* 字段为最近一次 API 调用的值，用于准确的上下文大小报告。
  // 累加的缓存总数会在多次工具调用往返时膨胀（每次调用报告 cacheRead ≈ 当前上下文大小）。
  target.lastCacheRead = usage.cacheRead ?? 0;
  target.lastCacheWrite = usage.cacheWrite ?? 0;
  target.lastInput = usage.input ?? 0;
};

/**
 * 将累加器转换为标准化用量对象，用于最终输出。
 *
 * 关键设计：使用最后一次 API 调用的缓存字段计算上下文大小，
 * 而不是累加值。原因见 https://github.com/openclaw/openclaw/issues/13698
 *
 * 累加的 cacheRead/cacheWrite 会膨胀上下文大小，因为每次工具调用往返
 * 都会报告 cacheRead ≈ 当前上下文大小，累加 N 次就变成 N × 上下文大小，
 * 最终被截断到 contextWindow（如 200k），导致报告不准确。
 *
 * 我们使用 lastInput/lastCacheRead/lastCacheWrite（来自最近一次 API 调用）
 * 计算缓存相关字段，但保留累加的 output（本轮生成的总文本量）。
 *
 * @param usage - 累加器对象
 * @returns 标准化用量对象，无有效数据时返回 undefined
 */
const toNormalizedUsage = (usage: UsageAccumulator) => {
  const hasUsage =
    usage.input > 0 ||
    usage.output > 0 ||
    usage.cacheRead > 0 ||
    usage.cacheWrite > 0 ||
    usage.total > 0;
  if (!hasUsage) {
    return undefined;
  }
  // 使用最后一次调用的值计算 prompt token 数
  const lastPromptTokens = usage.lastInput + usage.lastCacheRead + usage.lastCacheWrite;
  return {
    input: usage.lastInput || undefined,
    output: usage.output || undefined,
    cacheRead: usage.lastCacheRead || undefined,
    cacheWrite: usage.lastCacheWrite || undefined,
    total: lastPromptTokens + usage.output || undefined,
  };
};

/**
 * 解析当前错误上下文中的 provider 和 model。
 *
 * 优先使用最后一次 assistant 响应中报告的 provider/model，
 * 因为在 failover 场景下，实际使用的模型可能与请求的不同。
 *
 * @param params - 包含 lastAssistant 和默认 provider/model 的参数
 * @returns 解析后的 provider 和 model
 */
function resolveActiveErrorContext(params: {
  lastAssistant: { provider?: string; model?: string } | undefined;
  provider: string;
  model: string;
}): { provider: string; model: string } {
  return {
    provider: params.lastAssistant?.provider ?? params.provider,
    model: params.lastAssistant?.model ?? params.model,
  };
}

/**
 * 为错误返回路径构建 agentMeta 元数据。
 *
 * 此函数确保即使在错误情况下也保留累计的用量数据，
 * 使会话的 totalTokens 能反映实际的上下文大小，而不是过时的值。
 * 如果没有这个处理，错误返回会省略用量数据，导致会话保持上一次成功运行时设置的 totalTokens。
 *
 * @param params.sessionId - 会话 ID
 * @param params.provider - 模型提供商
 * @param params.model - 模型 ID
 * @param params.usageAccumulator - 用量累加器
 * @param params.lastRunPromptUsage - 最后一次运行的 prompt 用量
 * @param params.lastAssistant - 最后一次 assistant 响应（可选）
 * @param params.lastTurnTotal - 最近一次 API 调用报告的总 token 数，用于校正累加值
 * @returns 构建好的 agentMeta 对象
 */
function buildErrorAgentMeta(params: {
  sessionId: string;
  provider: string;
  model: string;
  usageAccumulator: UsageAccumulator;
  lastRunPromptUsage: ReturnType<typeof normalizeUsage> | undefined;
  lastAssistant?: { usage?: unknown } | null;
  /** 最近一次 API 调用报告的总 token 数，与成功路径的校正逻辑保持一致 */
  lastTurnTotal?: number;
}): EmbeddedPiAgentMeta {
  const usage = toNormalizedUsage(params.usageAccumulator);
  // 应用与成功路径相同的 lastTurnTotal 校正，
  // 使 usage.total 反映 API 报告的上下文大小，而非累加值。
  if (usage && params.lastTurnTotal && params.lastTurnTotal > 0) {
    usage.total = params.lastTurnTotal;
  }
  const lastCallUsage = params.lastAssistant
    ? normalizeUsage(params.lastAssistant.usage as UsageLike)
    : undefined;
  const promptTokens = derivePromptTokens(params.lastRunPromptUsage);
  return {
    sessionId: params.sessionId,
    provider: params.provider,
    model: params.model,
    // 仅在有实际 API 调用数据时才包含用量字段
    ...(usage ? { usage } : {}),
    ...(lastCallUsage ? { lastCallUsage } : {}),
    ...(promptTokens ? { promptTokens } : {}),
  };
}

/**
 * 执行一次嵌入式 Pi 代理运行。
 *
 * 这是代理系统的核心入口函数，负责完整的代理运行生命周期：
 *
 * ## 执行流程
 *
 * 1. **队列入队**：通过 session lane 和 global lane 确保并发安全
 * 2. **工作区解析**：根据参数解析实际工作目录
 * 3. **插件钩子**：运行 before_model_resolve 和 before_agent_start 钩子
 * 4. **模型解析**：解析 provider/model 配置，获取模型元数据
 * 5. **上下文窗口检查**：验证模型上下文窗口大小是否足够
 * 6. **认证解析**：获取 API Key，处理多 profile 轮换
 * 7. **重试循环**：
 *    - 调用 runEmbeddedAttempt 执行实际的 API 调用
 *    - 处理 context overflow：执行压缩或截断
 *    - 处理认证/速率限制错误：轮换到下一个 profile
 *    - 处理 failover：抛出 FailoverError 让外层处理
 * 8. **结果构建**：累计用量，构建响应 payloads
 *
 * ## 错误处理
 *
 * - context overflow：尝试自动压缩或截断超大 tool result
 * - 认证错误：轮换 auth profile
 * - 速率限制：标记 profile 冷却，轮换到下一个
 * - 计费错误：标记 profile，尝试 failover
 * - 超时：轮换 profile 或 failover
 *
 * @param params - 运行参数，包含 prompt、sessionId、配置等
 * @returns EmbeddedPiRunResult 包含响应 payloads 和元数据
 */
export async function runEmbeddedPiAgent(
  params: RunEmbeddedPiAgentParams,
): Promise<EmbeddedPiRunResult> {
  // ==================== 1. 初始化：解析 lane 和工具结果格式 ====================

  // 解析会话级和全局级的命令队列 lane
  // session lane 确保同一会话的请求串行执行
  // global lane 控制跨会话的全局并发
  const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
  const globalLane = resolveGlobalLane(params.lane);
  const enqueueGlobal =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(globalLane, task, opts));
  const enqueueSession =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(sessionLane, task, opts));

  // 根据消息通道类型决定工具结果的输出格式
  // 支持 Markdown 的通道使用 markdown 格式，否则使用 plain 格式
  const channelHint = params.messageChannel ?? params.messageProvider;
  const resolvedToolResultFormat =
    params.toolResultFormat ??
    (channelHint
      ? isMarkdownCapableMessageChannel(channelHint)
        ? "markdown"
        : "plain"
      : "markdown");

  // 检测是否为探测会话（用于健康检查等），影响日志级别
  const isProbeSession = params.sessionId?.startsWith("probe-") ?? false;

  // ==================== 2. 入队执行：双层队列确保并发安全 ====================
  // 先进入 session lane（串行化同一会话的请求），再进入 global lane（控制全局并发）
  return enqueueSession(() =>
    enqueueGlobal(async () => {
      // 记录运行开始时间，用于计算总耗时
      const started = Date.now();

      // ==================== 3. 工作区解析 ====================
      // 根据 workspaceDir/sessionKey/agentId 解析实际的工作目录
      const workspaceResolution = resolveRunWorkspaceDir({
        workspaceDir: params.workspaceDir,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        config: params.config,
      });
      const resolvedWorkspace = workspaceResolution.workspaceDir;

      // 脱敏处理，避免日志泄露敏感信息
      const redactedSessionId = redactRunIdentifier(params.sessionId);
      const redactedSessionKey = redactRunIdentifier(params.sessionKey);
      const redactedWorkspace = redactRunIdentifier(resolvedWorkspace);

      // 如果使用了 fallback 工作区，记录警告日志
      if (workspaceResolution.usedFallback) {
        log.warn(
          `[workspace-fallback] caller=runEmbeddedPiAgent reason=${workspaceResolution.fallbackReason} run=${params.runId} session=${redactedSessionId} sessionKey=${redactedSessionKey} agent=${workspaceResolution.agentId} workspace=${redactedWorkspace}`,
        );
      }

      // 确保运行时插件已加载（根据配置和工作区）
      ensureRuntimePluginsLoaded({
        config: params.config,
        workspaceDir: resolvedWorkspace,
      });

      // 保存当前工作目录，运行结束后恢复
      const prevCwd = process.cwd();

      // ==================== 4. 模型配置初始化 ====================
      // 解析 provider 和 model，使用默认值填充空值
      let provider = (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
      let modelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
      const agentDir = params.agentDir ?? resolveOpenClawAgentDir();

      // 检查是否配置了模型 fallback（用于故障转移）
      const fallbackConfigured = hasConfiguredModelFallbacks({
        cfg: params.config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      });

      // 确保 models.json 配置文件存在
      await ensureOpenClawModelsJson(params.config, agentDir);

      // ==================== 5. 插件钩子执行 ====================
      // 在 resolveModel() 之前运行 before_model_resolve 钩子，
      // 允许插件覆盖 provider/model 选择。
      //
      // 兼容性：同时检查 before_agent_start 钩子的覆盖字段（旧版兼容）。
      // 新钩子（before_model_resolve）优先级更高。
      let modelResolveOverride: { providerOverride?: string; modelOverride?: string } | undefined;
      let legacyBeforeAgentStartResult: PluginHookBeforeAgentStartResult | undefined;

      // 获取全局钩子运行器
      const hookRunner = getGlobalHookRunner();

      // 构建钩子上下文，包含会话和环境信息
      const hookCtx = {
        agentId: workspaceResolution.agentId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        workspaceDir: resolvedWorkspace,
        messageProvider: params.messageProvider ?? undefined,
        trigger: params.trigger,
        channelId: params.messageChannel ?? params.messageProvider ?? undefined,
      };

      // 运行 before_model_resolve 钩子（新版）
      if (hookRunner?.hasHooks("before_model_resolve")) {
        try {
          modelResolveOverride = await hookRunner.runBeforeModelResolve(
            { prompt: params.prompt },
            hookCtx,
          );
        } catch (hookErr) {
          log.warn(`before_model_resolve hook failed: ${String(hookErr)}`);
        }
      }

      // 运行 before_agent_start 钩子（旧版兼容路径）
      if (hookRunner?.hasHooks("before_agent_start")) {
        try {
          legacyBeforeAgentStartResult = await hookRunner.runBeforeAgentStart(
            { prompt: params.prompt },
            hookCtx,
          );
          // 合并覆盖值，新钩子优先
          modelResolveOverride = {
            providerOverride:
              modelResolveOverride?.providerOverride ??
              legacyBeforeAgentStartResult?.providerOverride,
            modelOverride:
              modelResolveOverride?.modelOverride ?? legacyBeforeAgentStartResult?.modelOverride,
          };
        } catch (hookErr) {
          log.warn(
            `before_agent_start hook (legacy model resolve path) failed: ${String(hookErr)}`,
          );
        }
      }

      // 应用钩子的覆盖值
      if (modelResolveOverride?.providerOverride) {
        provider = modelResolveOverride.providerOverride;
        log.info(`[hooks] provider overridden to ${provider}`);
      }
      if (modelResolveOverride?.modelOverride) {
        modelId = modelResolveOverride.modelOverride;
        log.info(`[hooks] model overridden to ${modelId}`);
      }

      // ==================== 6. 模型解析与验证 ====================
      // 解析模型配置，获取模型元数据、认证存储和模型注册表
      const { model, error, authStorage, modelRegistry } = resolveModel(
        provider,
        modelId,
        agentDir,
        params.config,
      );

      // 模型不存在时抛出 FailoverError，允许外层尝试 fallback 模型
      if (!model) {
        throw new FailoverError(error ?? `Unknown model: ${provider}/${modelId}`, {
          reason: "model_not_found",
          provider,
          model: modelId,
        });
      }

      // ==================== 7. 上下文窗口检查 ====================
      // 解析有效的上下文窗口大小（可能被配置限制）
      const ctxInfo = resolveContextWindowInfo({
        cfg: params.config,
        provider,
        modelId,
        modelContextWindow: model.contextWindow,
        defaultTokens: DEFAULT_CONTEXT_TOKENS,
      });

      // 将 contextTokens 上限应用到模型配置，
      // 使 pi-coding-agent 的自动压缩阈值使用有效限制，而非原生上下文窗口
      const effectiveModel =
        ctxInfo.tokens < (model.contextWindow ?? Infinity)
          ? { ...model, contextWindow: ctxInfo.tokens }
          : model;

      // 评估上下文窗口是否足够
      const ctxGuard = evaluateContextWindowGuard({
        info: ctxInfo,
        warnBelowTokens: CONTEXT_WINDOW_WARN_BELOW_TOKENS,
        hardMinTokens: CONTEXT_WINDOW_HARD_MIN_TOKENS,
      });

      // 上下文窗口偏小时记录警告
      if (ctxGuard.shouldWarn) {
        log.warn(
          `low context window: ${provider}/${modelId} ctx=${ctxGuard.tokens} (warn<${CONTEXT_WINDOW_WARN_BELOW_TOKENS}) source=${ctxGuard.source}`,
        );
      }

      // 上下文窗口低于硬性最小值时阻止运行
      if (ctxGuard.shouldBlock) {
        log.error(
          `blocked model (context window too small): ${provider}/${modelId} ctx=${ctxGuard.tokens} (min=${CONTEXT_WINDOW_HARD_MIN_TOKENS}) source=${ctxGuard.source}`,
        );
        throw new FailoverError(
          `Model context window too small (${ctxGuard.tokens} tokens). Minimum is ${CONTEXT_WINDOW_HARD_MIN_TOKENS}.`,
          { reason: "unknown", provider, model: modelId },
        );
      }

      // ==================== 8. 认证 Profile 初始化 ====================
      // 加载认证 profile 存储（不弹出 Keychain 提示）
      const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });

      // 解析首选 profile ID
      const preferredProfileId = params.authProfileId?.trim();

      // 检查是否锁定特定 profile（用户显式指定时锁定）
      // 锁定后不会自动轮换到其他 profile
      let lockedProfileId = params.authProfileIdSource === "user" ? preferredProfileId : undefined;
      if (lockedProfileId) {
        const lockedProfile = authStore.profiles[lockedProfileId];
        // 验证锁定的 profile 存在且属于正确的 provider
        if (
          !lockedProfile ||
          normalizeProviderId(lockedProfile.provider) !== normalizeProviderId(provider)
        ) {
          lockedProfileId = undefined;
        }
      }

      // 解析 profile 轮换顺序（考虑健康状态、优先级等）
      const profileOrder = resolveAuthProfileOrder({
        cfg: params.config,
        store: authStore,
        provider,
        preferredProfile: preferredProfileId,
      });

      // 锁定的 profile 必须在候选列表中
      if (lockedProfileId && !profileOrder.includes(lockedProfileId)) {
        throw new Error(`Auth profile "${lockedProfileId}" is not configured for ${provider}.`);
      }

      // 构建 profile 候选列表
      // 锁定时只使用锁定的 profile，否则使用完整的轮换顺序
      const profileCandidates = lockedProfileId
        ? [lockedProfileId]
        : profileOrder.length > 0
          ? profileOrder
          : [undefined]; // undefined 表示无 profile（使用环境变量等默认认证）
      let profileIndex = 0;

      // ==================== 9. 思考级别与 Copilot Token 管理 ====================

      // 初始化思考级别（off/low/medium/high），可能在重试时降级
      const initialThinkLevel = params.thinkLevel ?? "off";
      let thinkLevel = initialThinkLevel;
      // 记录已尝试过的思考级别，避免重复尝试失败的级别
      const attemptedThinking = new Set<ThinkLevel>();

      // API Key 信息和最后使用的 profile ID
      let apiKeyInfo: ApiKeyInfo | null = null;
      let lastProfileId: string | undefined;

      // GitHub Copilot 特有的 token 状态管理
      // Copilot 需要用 GitHub token 换取短期 API token，需要定期刷新
      const copilotTokenState: CopilotTokenState | null =
        model.provider === "github-copilot" ? { githubToken: "", expiresAt: 0 } : null;
      let copilotRefreshCancelled = false;
      const hasCopilotGithubToken = () => Boolean(copilotTokenState?.githubToken.trim());

      /**
       * 清除 Copilot token 刷新定时器
       */
      const clearCopilotRefreshTimer = () => {
        if (!copilotTokenState?.refreshTimer) {
          return;
        }
        clearTimeout(copilotTokenState.refreshTimer);
        copilotTokenState.refreshTimer = undefined;
      };

      /**
       * 停止 Copilot token 刷新（运行结束时调用）
       */
      const stopCopilotRefreshTimer = () => {
        if (!copilotTokenState) {
          return;
        }
        copilotRefreshCancelled = true;
        clearCopilotRefreshTimer();
      };

      /**
       * 刷新 Copilot API token。
       * 使用 GitHub token 换取新的 Copilot API token，并更新到 authStorage。
       *
       * @param reason - 刷新原因（用于日志）
       */
      const refreshCopilotToken = async (reason: string): Promise<void> => {
        if (!copilotTokenState) {
          return;
        }
        // 避免并发刷新
        if (copilotTokenState.refreshInFlight) {
          await copilotTokenState.refreshInFlight;
          return;
        }
        const { resolveCopilotApiToken } = await import("../../providers/github-copilot-token.js");
        copilotTokenState.refreshInFlight = (async () => {
          const githubToken = copilotTokenState.githubToken.trim();
          if (!githubToken) {
            throw new Error("Copilot refresh requires a GitHub token.");
          }
          log.debug(`Refreshing GitHub Copilot token (${reason})...`);
          const copilotToken = await resolveCopilotApiToken({
            githubToken,
          });
          // 更新 API token 到认证存储
          authStorage.setRuntimeApiKey(model.provider, copilotToken.token);
          copilotTokenState.expiresAt = copilotToken.expiresAt;
          const remaining = copilotToken.expiresAt - Date.now();
          log.debug(
            `Copilot token refreshed; expires in ${Math.max(0, Math.floor(remaining / 1000))}s.`,
          );
        })()
          .catch((err) => {
            log.warn(`Copilot token refresh failed: ${describeUnknownError(err)}`);
            throw err;
          })
          .finally(() => {
            copilotTokenState.refreshInFlight = undefined;
          });
        await copilotTokenState.refreshInFlight;
      };

      /**
       * 调度 Copilot token 的定期刷新。
       * 在 token 过期前 COPILOT_REFRESH_MARGIN_MS 时间开始刷新。
       * 刷新失败时会在 COPILOT_REFRESH_RETRY_MS 后重试。
       */
      const scheduleCopilotRefresh = (): void => {
        if (!copilotTokenState || copilotRefreshCancelled) {
          return;
        }
        if (!hasCopilotGithubToken()) {
          log.warn("Skipping Copilot refresh scheduling; GitHub token missing.");
          return;
        }
        clearCopilotRefreshTimer();
        const now = Date.now();
        // 计算下次刷新时间（过期前 5 分钟）
        const refreshAt = copilotTokenState.expiresAt - COPILOT_REFRESH_MARGIN_MS;
        const delayMs = Math.max(COPILOT_REFRESH_MIN_DELAY_MS, refreshAt - now);
        const timer = setTimeout(() => {
          if (copilotRefreshCancelled) {
            return;
          }
          refreshCopilotToken("scheduled")
            .then(() => scheduleCopilotRefresh())
            .catch(() => {
              if (copilotRefreshCancelled) {
                return;
              }
              // 刷新失败，安排重试
              const retryTimer = setTimeout(() => {
                if (copilotRefreshCancelled) {
                  return;
                }
                refreshCopilotToken("scheduled-retry")
                  .then(() => scheduleCopilotRefresh())
                  .catch(() => undefined);
              }, COPILOT_REFRESH_RETRY_MS);
              copilotTokenState.refreshTimer = retryTimer;
              if (copilotRefreshCancelled) {
                clearTimeout(retryTimer);
                copilotTokenState.refreshTimer = undefined;
              }
            });
        }, delayMs);
        copilotTokenState.refreshTimer = timer;
        // 防止在设置定时器后被取消的竞态条件
        if (copilotRefreshCancelled) {
          clearTimeout(timer);
          copilotTokenState.refreshTimer = undefined;
        }
      };

      // ==================== 10. 认证 Profile 辅助函数 ====================

      /**
       * 解析认证 profile failover 的原因。
       * 根据是否所有 profile 都在冷却以及错误消息来确定原因。
       *
       * @param params.allInCooldown - 是否所有 profile 都在冷却中
       * @param params.message - 错误消息
       * @param params.profileIds - profile ID 列表（可选）
       * @returns failover 原因
       */
      const resolveAuthProfileFailoverReason = (params: {
        allInCooldown: boolean;
        message: string;
        profileIds?: Array<string | undefined>;
      }): FailoverReason => {
        if (params.allInCooldown) {
          // 所有 profile 都在冷却，尝试确定具体原因
          const profileIds = (params.profileIds ?? profileCandidates).filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          );
          return (
            resolveProfilesUnavailableReason({
              store: authStore,
              profileIds,
            }) ?? "rate_limit"
          );
        }
        // 从错误消息分类 failover 原因
        const classified = classifyFailoverReason(params.message);
        return classified ?? "auth";
      };

      /**
       * 抛出认证 profile failover 错误。
       * 根据是否配置了 fallback 决定抛出 FailoverError 还是普通 Error。
       *
       * @param params.allInCooldown - 是否所有 profile 都在冷却中
       * @param params.message - 错误消息（可选）
       * @param params.error - 原始错误（可选）
       */
      const throwAuthProfileFailover = (params: {
        allInCooldown: boolean;
        message?: string;
        error?: unknown;
      }): never => {
        const fallbackMessage = `No available auth profile for ${provider} (all in cooldown or unavailable).`;
        const message =
          params.message?.trim() ||
          (params.error ? describeUnknownError(params.error).trim() : "") ||
          fallbackMessage;
        const reason = resolveAuthProfileFailoverReason({
          allInCooldown: params.allInCooldown,
          message,
          profileIds: profileCandidates,
        });
        // 配置了 fallback 时抛出 FailoverError，让外层尝试备选模型
        if (fallbackConfigured) {
          throw new FailoverError(message, {
            reason,
            provider,
            model: modelId,
            status: resolveFailoverStatus(reason),
            cause: params.error,
          });
        }
        // 没有 fallback 时直接抛出原始错误或新错误
        if (params.error instanceof Error) {
          throw params.error;
        }
        throw new Error(message);
      };

      /**
       * 为候选 profile 解析 API Key。
       *
       * @param candidate - profile ID（可选）
       * @returns 解析后的认证信息
       */
      const resolveApiKeyForCandidate = async (candidate?: string) => {
        return getApiKeyForModel({
          model,
          cfg: params.config,
          profileId: candidate,
          store: authStore,
          agentDir,
        });
      };

      /**
       * 应用 API Key 信息到认证存储。
       * 处理 Copilot 特殊情况（需要换取短期 token）。
       *
       * @param candidate - profile ID（可选）
       */
      const applyApiKeyInfo = async (candidate?: string): Promise<void> => {
        apiKeyInfo = await resolveApiKeyForCandidate(candidate);
        const resolvedProfileId = apiKeyInfo.profileId ?? candidate;

        // 没有 API Key 且不是 AWS SDK 模式时报错
        if (!apiKeyInfo.apiKey) {
          if (apiKeyInfo.mode !== "aws-sdk") {
            throw new Error(
              `No API key resolved for provider "${model.provider}" (auth mode: ${apiKeyInfo.mode}).`,
            );
          }
          // AWS SDK 模式不需要显式 API Key
          lastProfileId = resolvedProfileId;
          return;
        }

        // GitHub Copilot 需要用 GitHub token 换取 API token
        if (model.provider === "github-copilot") {
          const { resolveCopilotApiToken } =
            await import("../../providers/github-copilot-token.js");
          const copilotToken = await resolveCopilotApiToken({
            githubToken: apiKeyInfo.apiKey,
          });
          authStorage.setRuntimeApiKey(model.provider, copilotToken.token);
          if (copilotTokenState) {
            copilotTokenState.githubToken = apiKeyInfo.apiKey;
            copilotTokenState.expiresAt = copilotToken.expiresAt;
            scheduleCopilotRefresh();
          }
        } else {
          // 其他 provider 直接设置 API Key
          authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
        }
        lastProfileId = apiKeyInfo.profileId;
      };

      /**
       * 前进到下一个可用的认证 profile。
       * 跳过冷却中的 profile，尝试应用下一个有效的 profile。
       *
       * @returns 是否成功切换到新 profile
       */
      const advanceAuthProfile = async (): Promise<boolean> => {
        // 锁定 profile 时不允许轮换
        if (lockedProfileId) {
          return false;
        }
        let nextIndex = profileIndex + 1;
        while (nextIndex < profileCandidates.length) {
          const candidate = profileCandidates[nextIndex];
          // 跳过冷却中的 profile
          if (candidate && isProfileInCooldown(authStore, candidate)) {
            nextIndex += 1;
            continue;
          }
          try {
            await applyApiKeyInfo(candidate);
            profileIndex = nextIndex;
            // 切换 profile 后重置思考级别（新 profile 可能支持更高级别）
            thinkLevel = initialThinkLevel;
            attemptedThinking.clear();
            return true;
          } catch (err) {
            // 锁定 profile 失败时直接抛出
            if (candidate && candidate === lockedProfileId) {
              throw err;
            }
            nextIndex += 1;
          }
        }
        return false;
      };

      // ==================== 11. 初始 Profile 选择 ====================
      try {
        // 筛选出非锁定的自动轮换候选 profile
        const autoProfileCandidates = profileCandidates.filter(
          (candidate): candidate is string =>
            typeof candidate === "string" && candidate.length > 0 && candidate !== lockedProfileId,
        );

        // 检查是否所有自动候选 profile 都在冷却中
        const allAutoProfilesInCooldown =
          autoProfileCandidates.length > 0 &&
          autoProfileCandidates.every((candidate) => isProfileInCooldown(authStore, candidate));

        // 解析不可用原因（用于决定是否允许探测）
        const unavailableReason = allAutoProfilesInCooldown
          ? (resolveProfilesUnavailableReason({
              store: authStore,
              profileIds: autoProfileCandidates,
            }) ?? "rate_limit")
          : null;

        // 对于瞬态错误（速率限制、过载、计费），允许探测冷却中的 profile
        // 这可以在所有 profile 都因瞬态原因冷却时仍尝试请求
        const allowTransientCooldownProbe =
          params.allowTransientCooldownProbe === true &&
          allAutoProfilesInCooldown &&
          (unavailableReason === "rate_limit" ||
            unavailableReason === "overloaded" ||
            unavailableReason === "billing");
        let didTransientCooldownProbe = false;

        // 遍历 profile 候选列表，找到第一个可用的
        while (profileIndex < profileCandidates.length) {
          const candidate = profileCandidates[profileIndex];
          const inCooldown =
            candidate && candidate !== lockedProfileId && isProfileInCooldown(authStore, candidate);

          if (inCooldown) {
            // 冷却中的 profile：检查是否允许探测
            if (allowTransientCooldownProbe && !didTransientCooldownProbe) {
              didTransientCooldownProbe = true;
              log.warn(
                `probing cooldowned auth profile for ${provider}/${modelId} due to ${unavailableReason ?? "transient"} unavailability`,
              );
              // 继续使用这个冷却中的 profile 进行探测
            } else {
              // 跳过冷却中的 profile
              profileIndex += 1;
              continue;
            }
          }
          // 应用选中的 profile
          await applyApiKeyInfo(profileCandidates[profileIndex]);
          break;
        }

        // 所有 profile 都不可用
        if (profileIndex >= profileCandidates.length) {
          throwAuthProfileFailover({ allInCooldown: true });
        }
      } catch (err) {
        // FailoverError 直接向上传播
        if (err instanceof FailoverError) {
          throw err;
        }
        // 锁定 profile 失败时尝试 failover
        if (profileCandidates[profileIndex] === lockedProfileId) {
          throwAuthProfileFailover({ allInCooldown: false, error: err });
        }
        // 尝试切换到下一个 profile
        const advanced = await advanceAuthProfile();
        if (!advanced) {
          throwAuthProfileFailover({ allInCooldown: false, error: err });
        }
      }

      /**
       * 尝试为 Copilot 认证错误刷新 token。
       * 只在是认证错误且未重试过时执行。
       *
       * @param errorText - 错误文本
       * @param retried - 是否已重试过
       * @returns 是否成功刷新
       */
      const maybeRefreshCopilotForAuthError = async (
        errorText: string,
        retried: boolean,
      ): Promise<boolean> => {
        if (!copilotTokenState || retried) {
          return false;
        }
        // 只处理 failover 类型的认证错误
        if (!isFailoverErrorMessage(errorText)) {
          return false;
        }
        if (classifyFailoverReason(errorText) !== "auth") {
          return false;
        }
        try {
          await refreshCopilotToken("auth-error");
          scheduleCopilotRefresh();
          return true;
        } catch {
          return false;
        }
      };

      // ==================== 12. 重试循环状态变量 ====================

      /** 上下文溢出压缩的最大尝试次数 */
      const MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3;
      /** 最大运行循环迭代次数（根据 profile 数量动态计算） */
      const MAX_RUN_LOOP_ITERATIONS = resolveMaxRunRetryIterations(profileCandidates.length);

      /** 当前溢出压缩尝试次数 */
      let overflowCompactionAttempts = 0;
      /** 是否已尝试过 tool result 截断 */
      let toolResultTruncationAttempted = false;
      /** 已见过的引导提示警告签名（用于去重） */
      let bootstrapPromptWarningSignaturesSeen =
        params.bootstrapPromptWarningSignaturesSeen ??
        (params.bootstrapPromptWarningSignature ? [params.bootstrapPromptWarningSignature] : []);

      /** Token 用量累加器 */
      const usageAccumulator = createUsageAccumulator();
      /** 最后一次运行的 prompt 用量（用于计算上下文大小） */
      let lastRunPromptUsage: ReturnType<typeof normalizeUsage> | undefined;
      /** 自动压缩计数 */
      let autoCompactionCount = 0;
      /** 运行循环迭代次数 */
      let runLoopIterations = 0;
      /** 过载 failover 尝试次数（用于退避计算） */
      let overloadFailoverAttempts = 0;

      /**
       * 可能标记认证 profile 失败。
       * timeout 不标记为失败（是传输/模型路径问题，不是认证健康信号）。
       */
      const maybeMarkAuthProfileFailure = async (failure: {
        profileId?: string;
        reason?: AuthProfileFailureReason | null;
        config?: RunEmbeddedPiAgentParams["config"];
        agentDir?: RunEmbeddedPiAgentParams["agentDir"];
      }) => {
        const { profileId, reason } = failure;
        // 跳过无 profile、无原因或 timeout 的情况
        if (!profileId || !reason || reason === "timeout") {
          return;
        }
        await markAuthProfileFailure({
          store: authStore,
          profileId,
          reason,
          cfg: params.config,
          agentDir,
          runId: params.runId,
        });
      };

      /**
       * 将 failover 原因转换为 profile 失败原因。
       * timeout 被排除，因为它是传输/模型路径失败，不应该持久化到 profile 状态。
       */
      const resolveAuthProfileFailureReason = (
        failoverReason: FailoverReason | null,
      ): AuthProfileFailureReason | null => {
        if (!failoverReason || failoverReason === "timeout") {
          return null;
        }
        return failoverReason;
      };

      /**
       * 在过载 failover 前执行退避等待。
       * 只对 overloaded 原因执行，使用指数退避策略。
       */
      const maybeBackoffBeforeOverloadFailover = async (reason: FailoverReason | null) => {
        if (reason !== "overloaded") {
          return;
        }
        overloadFailoverAttempts += 1;
        const delayMs = computeBackoff(OVERLOAD_FAILOVER_BACKOFF_POLICY, overloadFailoverAttempts);
        log.warn(
          `overload backoff before failover for ${provider}/${modelId}: attempt=${overloadFailoverAttempts} delayMs=${delayMs}`,
        );
        try {
          await sleepWithAbort(delayMs, params.abortSignal);
        } catch (err) {
          // 处理中止信号
          if (params.abortSignal?.aborted) {
            const abortErr = new Error("Operation aborted", { cause: err });
            abortErr.name = "AbortError";
            throw abortErr;
          }
          throw err;
        }
      };

      // 初始化上下文引擎（一次初始化，跨重试复用，避免重复的初始化/连接开销）
      ensureContextEnginesInitialized();
      const contextEngine = await resolveContextEngine(params.config);
      // ==================== 13. 主重试循环 ====================
      try {
        /** 是否有待处理的认证重试（Copilot token 刷新后） */
        let authRetryPending = false;
        /** 最后一轮的总 token 数（提升作用域以便错误路径使用） */
        let lastTurnTotal: number | undefined;

        // 主重试循环：处理各种错误并决定是否重试
        while (true) {
          // ---------- 重试次数保护 ----------
          // 防止无限循环，超过最大迭代次数时返回错误
          if (runLoopIterations >= MAX_RUN_LOOP_ITERATIONS) {
            const message =
              `Exceeded retry limit after ${runLoopIterations} attempts ` +
              `(max=${MAX_RUN_LOOP_ITERATIONS}).`;
            log.error(
              `[run-retry-limit] sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `provider=${provider}/${modelId} attempts=${runLoopIterations} ` +
                `maxAttempts=${MAX_RUN_LOOP_ITERATIONS}`,
            );
            return {
              payloads: [
                {
                  text:
                    "Request failed after repeated internal retries. " +
                    "Please try again, or use /new to start a fresh session.",
                  isError: true,
                },
              ],
              meta: {
                durationMs: Date.now() - started,
                agentMeta: buildErrorAgentMeta({
                  sessionId: params.sessionId,
                  provider,
                  model: model.id,
                  usageAccumulator,
                  lastRunPromptUsage,
                  lastTurnTotal,
                }),
                error: { kind: "retry_limit", message },
              },
            };
          }
          runLoopIterations += 1;

          // 重置本轮状态
          const copilotAuthRetry = authRetryPending;
          authRetryPending = false;
          attemptedThinking.add(thinkLevel);

          // 确保工作区目录存在
          await fs.mkdir(resolvedWorkspace, { recursive: true });

          // 清理 Anthropic 拒绝测试魔术字符串（仅 Anthropic provider）
          const prompt =
            provider === "anthropic" ? scrubAnthropicRefusalMagic(params.prompt) : params.prompt;

          // ---------- 执行单次尝试 ----------
          // 调用 runEmbeddedAttempt 执行实际的模型 API 调用
          const attempt = await runEmbeddedAttempt({
            // 会话标识
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            trigger: params.trigger,
            memoryFlushWritePath: params.memoryFlushWritePath,

            // 消息通道信息
            messageChannel: params.messageChannel,
            messageProvider: params.messageProvider,
            agentAccountId: params.agentAccountId,
            messageTo: params.messageTo,
            messageThreadId: params.messageThreadId,

            // 群组信息
            groupId: params.groupId,
            groupChannel: params.groupChannel,
            groupSpace: params.groupSpace,

            // 发送者信息
            spawnedBy: params.spawnedBy,
            senderId: params.senderId,
            senderName: params.senderName,
            senderUsername: params.senderUsername,
            senderE164: params.senderE164,
            senderIsOwner: params.senderIsOwner,

            // 当前消息上下文
            currentChannelId: params.currentChannelId,
            currentThreadTs: params.currentThreadTs,
            currentMessageId: params.currentMessageId,
            replyToMode: params.replyToMode,
            hasRepliedRef: params.hasRepliedRef,

            // 文件与工作区
            sessionFile: params.sessionFile,
            workspaceDir: resolvedWorkspace,
            agentDir,
            config: params.config,
            contextEngine,
            contextTokenBudget: ctxInfo.tokens,
            skillsSnapshot: params.skillsSnapshot,

            // 用户输入
            prompt,
            images: params.images,
            disableTools: params.disableTools,

            // 模型配置
            provider,
            modelId,
            model: effectiveModel,
            authProfileId: lastProfileId,
            authProfileIdSource: lockedProfileId ? "user" : "auto",
            authStorage,
            modelRegistry,
            agentId: workspaceResolution.agentId,
            legacyBeforeAgentStartResult,

            // 运行配置
            thinkLevel,
            verboseLevel: params.verboseLevel,
            reasoningLevel: params.reasoningLevel,
            toolResultFormat: resolvedToolResultFormat,
            execOverrides: params.execOverrides,
            bashElevated: params.bashElevated,
            timeoutMs: params.timeoutMs,
            runId: params.runId,
            abortSignal: params.abortSignal,

            // 回调函数
            shouldEmitToolResult: params.shouldEmitToolResult,
            shouldEmitToolOutput: params.shouldEmitToolOutput,
            onPartialReply: params.onPartialReply,
            onAssistantMessageStart: params.onAssistantMessageStart,
            onBlockReply: params.onBlockReply,
            onBlockReplyFlush: params.onBlockReplyFlush,
            blockReplyBreak: params.blockReplyBreak,
            blockReplyChunking: params.blockReplyChunking,
            onReasoningStream: params.onReasoningStream,
            onReasoningEnd: params.onReasoningEnd,
            onToolResult: params.onToolResult,
            onAgentEvent: params.onAgentEvent,

            // 其他配置
            extraSystemPrompt: params.extraSystemPrompt,
            inputProvenance: params.inputProvenance,
            streamParams: params.streamParams,
            ownerNumbers: params.ownerNumbers,
            enforceFinalTag: params.enforceFinalTag,
            bootstrapPromptWarningSignaturesSeen,
            bootstrapPromptWarningSignature:
              bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1],
          });

          // ---------- 处理尝试结果 ----------
          // 解构尝试结果
          const {
            aborted, // 是否被中止
            promptError, // prompt 提交错误
            timedOut, // 是否超时
            timedOutDuringCompaction, // 是否在压缩期间超时
            sessionIdUsed, // 实际使用的会话 ID
            lastAssistant, // 最后的 assistant 响应
          } = attempt;

          // 更新已见警告签名列表（去重）
          bootstrapPromptWarningSignaturesSeen =
            attempt.bootstrapPromptWarningSignaturesSeen ??
            (attempt.bootstrapPromptWarningSignature
              ? Array.from(
                  new Set([
                    ...bootstrapPromptWarningSignaturesSeen,
                    attempt.bootstrapPromptWarningSignature,
                  ]),
                )
              : bootstrapPromptWarningSignaturesSeen);

          // 处理用量数据
          const lastAssistantUsage = normalizeUsage(lastAssistant?.usage as UsageLike);
          const attemptUsage = attempt.attemptUsage ?? lastAssistantUsage;
          mergeUsageIntoAccumulator(usageAccumulator, attemptUsage);

          // 保留最新模型调用的 prompt 大小，使会话 totalTokens 反映当前上下文用量，
          // 而非累加的工具循环用量
          lastRunPromptUsage = lastAssistantUsage ?? attemptUsage;
          lastTurnTotal = lastAssistantUsage?.total ?? attemptUsage?.total;

          // 累加压缩次数
          const attemptCompactionCount = Math.max(0, attempt.compactionCount ?? 0);
          autoCompactionCount += attemptCompactionCount;

          // 解析活动错误上下文（可能是 failover 后的实际 provider/model）
          const activeErrorContext = resolveActiveErrorContext({
            lastAssistant,
            provider,
            model: modelId,
          });

          // 格式化 assistant 错误文本（用于用户展示）
          const formattedAssistantErrorText = lastAssistant
            ? formatAssistantErrorText(lastAssistant, {
                cfg: params.config,
                sessionKey: params.sessionKey ?? params.sessionId,
                provider: activeErrorContext.provider,
                model: activeErrorContext.model,
              })
            : undefined;

          // 提取 assistant 错误消息（仅在 stopReason 为 error 时）
          const assistantErrorText =
            lastAssistant?.stopReason === "error"
              ? lastAssistant.errorMessage?.trim() || formattedAssistantErrorText
              : undefined;

          // ---------- 检测上下文溢出错误 ----------
          // 上下文溢出可能来自 promptError 或 assistantError
          const contextOverflowError = !aborted
            ? (() => {
                // 检查 prompt 提交错误
                if (promptError) {
                  const errorText = describeUnknownError(promptError);
                  if (isLikelyContextOverflowError(errorText)) {
                    return { text: errorText, source: "promptError" as const };
                  }
                  // 非溢出的 prompt 错误，不检查 assistant 错误
                  return null;
                }
                // 检查 assistant 响应中的溢出错误
                if (assistantErrorText && isLikelyContextOverflowError(assistantErrorText)) {
                  return { text: assistantErrorText, source: "assistantError" as const };
                }
                return null;
              })()
            : null;

          // ==================== 14. 上下文溢出处理 ====================
          if (contextOverflowError) {
            // 生成诊断 ID 用于日志追踪
            const overflowDiagId = createCompactionDiagId();
            const errorText = contextOverflowError.text;
            const msgCount = attempt.messagesSnapshot?.length ?? 0;

            // 记录溢出诊断信息
            log.warn(
              `[context-overflow-diag] sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `provider=${provider}/${modelId} source=${contextOverflowError.source} ` +
                `messages=${msgCount} sessionFile=${params.sessionFile} ` +
                `diagId=${overflowDiagId} compactionAttempts=${overflowCompactionAttempts} ` +
                `error=${errorText.slice(0, 200)}`,
            );

            const isCompactionFailure = isCompactionFailureError(errorText);
            const hadAttemptLevelCompaction = attemptCompactionCount > 0;

            // ---------- 策略 1：尝试后已有压缩，直接重试 ----------
            // 如果本次尝试已经执行了 SDK 自动压缩，避免立即再次显式压缩
            if (
              !isCompactionFailure &&
              hadAttemptLevelCompaction &&
              overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS
            ) {
              overflowCompactionAttempts++;
              log.warn(
                `context overflow persisted after in-attempt compaction (attempt ${overflowCompactionAttempts}/${MAX_OVERFLOW_COMPACTION_ATTEMPTS}); retrying prompt without additional compaction for ${provider}/${modelId}`,
              );
              continue;
            }

            // ---------- 策略 2：显式压缩 ----------
            // 仅在本次尝试未自动压缩时执行显式压缩
            if (
              !isCompactionFailure &&
              !hadAttemptLevelCompaction &&
              overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS
            ) {
              if (log.isEnabled("debug")) {
                log.debug(
                  `[compaction-diag] decision diagId=${overflowDiagId} branch=compact ` +
                    `isCompactionFailure=${isCompactionFailure} hasOversizedToolResults=unknown ` +
                    `attempt=${overflowCompactionAttempts + 1} maxAttempts=${MAX_OVERFLOW_COMPACTION_ATTEMPTS}`,
                );
              }
              overflowCompactionAttempts++;
              log.warn(
                `context overflow detected (attempt ${overflowCompactionAttempts}/${MAX_OVERFLOW_COMPACTION_ATTEMPTS}); attempting auto-compaction for ${provider}/${modelId}`,
              );

              // 调用上下文引擎执行压缩
              const compactResult = await contextEngine.compact({
                sessionId: params.sessionId,
                sessionFile: params.sessionFile,
                tokenBudget: ctxInfo.tokens,
                force: true,
                compactionTarget: "budget",
                runtimeContext: {
                  sessionKey: params.sessionKey,
                  messageChannel: params.messageChannel,
                  messageProvider: params.messageProvider,
                  agentAccountId: params.agentAccountId,
                  authProfileId: lastProfileId,
                  workspaceDir: resolvedWorkspace,
                  agentDir,
                  config: params.config,
                  skillsSnapshot: params.skillsSnapshot,
                  senderIsOwner: params.senderIsOwner,
                  provider,
                  model: modelId,
                  runId: params.runId,
                  thinkLevel,
                  reasoningLevel: params.reasoningLevel,
                  bashElevated: params.bashElevated,
                  extraSystemPrompt: params.extraSystemPrompt,
                  ownerNumbers: params.ownerNumbers,
                  trigger: "overflow",
                  diagId: overflowDiagId,
                  attempt: overflowCompactionAttempts,
                  maxAttempts: MAX_OVERFLOW_COMPACTION_ATTEMPTS,
                },
              });

              if (compactResult.compacted) {
                autoCompactionCount += 1;
                log.info(`auto-compaction succeeded for ${provider}/${modelId}; retrying prompt`);
                continue;
              }
              log.warn(
                `auto-compaction failed for ${provider}/${modelId}: ${compactResult.reason ?? "nothing to compact"}`,
              );
            }

            // ---------- 策略 3：截断超大 tool result ----------
            // 处理单个 tool result 超过上下文窗口的情况
            if (!toolResultTruncationAttempted) {
              const contextWindowTokens = ctxInfo.tokens;
              // 检测是否存在超大 tool result
              const hasOversized = attempt.messagesSnapshot
                ? sessionLikelyHasOversizedToolResults({
                    messages: attempt.messagesSnapshot,
                    contextWindowTokens,
                  })
                : false;

              if (hasOversized) {
                if (log.isEnabled("debug")) {
                  log.debug(
                    `[compaction-diag] decision diagId=${overflowDiagId} branch=truncate_tool_results ` +
                      `isCompactionFailure=${isCompactionFailure} hasOversizedToolResults=${hasOversized} ` +
                      `attempt=${overflowCompactionAttempts} maxAttempts=${MAX_OVERFLOW_COMPACTION_ATTEMPTS}`,
                  );
                }
                toolResultTruncationAttempted = true;
                log.warn(
                  `[context-overflow-recovery] Attempting tool result truncation for ${provider}/${modelId} ` +
                    `(contextWindow=${contextWindowTokens} tokens)`,
                );

                // 执行 tool result 截断
                const truncResult = await truncateOversizedToolResultsInSession({
                  sessionFile: params.sessionFile,
                  contextWindowTokens,
                  sessionId: params.sessionId,
                  sessionKey: params.sessionKey,
                });

                if (truncResult.truncated) {
                  log.info(
                    `[context-overflow-recovery] Truncated ${truncResult.truncatedCount} tool result(s); retrying prompt`,
                  );
                  // 注意：不重置 overflowCompactionAttempts，全局上限必须跨迭代保持，
                  // 防止无限压缩循环 (OC-65)
                  continue;
                }
                log.warn(
                  `[context-overflow-recovery] Tool result truncation did not help: ${truncResult.reason ?? "unknown"}`,
                );
              } else if (log.isEnabled("debug")) {
                log.debug(
                  `[compaction-diag] decision diagId=${overflowDiagId} branch=give_up ` +
                    `isCompactionFailure=${isCompactionFailure} hasOversizedToolResults=${hasOversized} ` +
                    `attempt=${overflowCompactionAttempts} maxAttempts=${MAX_OVERFLOW_COMPACTION_ATTEMPTS}`,
                );
              }
            }

            // ---------- 所有策略都失败，放弃并返回错误 ----------
            if (
              (isCompactionFailure ||
                overflowCompactionAttempts >= MAX_OVERFLOW_COMPACTION_ATTEMPTS ||
                toolResultTruncationAttempted) &&
              log.isEnabled("debug")
            ) {
              log.debug(
                `[compaction-diag] decision diagId=${overflowDiagId} branch=give_up ` +
                  `isCompactionFailure=${isCompactionFailure} hasOversizedToolResults=unknown ` +
                  `attempt=${overflowCompactionAttempts} maxAttempts=${MAX_OVERFLOW_COMPACTION_ATTEMPTS}`,
              );
            }

            const kind = isCompactionFailure ? "compaction_failure" : "context_overflow";
            return {
              payloads: [
                {
                  text:
                    "Context overflow: prompt too large for the model. " +
                    "Try /reset (or /new) to start a fresh session, or use a larger-context model.",
                  isError: true,
                },
              ],
              meta: {
                durationMs: Date.now() - started,
                agentMeta: buildErrorAgentMeta({
                  sessionId: sessionIdUsed,
                  provider,
                  model: model.id,
                  usageAccumulator,
                  lastRunPromptUsage,
                  lastAssistant,
                  lastTurnTotal,
                }),
                systemPromptReport: attempt.systemPromptReport,
                error: { kind, message: errorText },
              },
            };
          }

          // ==================== 15. Prompt 错误处理 ====================
          if (promptError && !aborted) {
            const errorText = describeUnknownError(promptError);

            // ---------- Copilot 认证错误重试 ----------
            if (await maybeRefreshCopilotForAuthError(errorText, copilotAuthRetry)) {
              authRetryPending = true;
              continue;
            }

            // ---------- 角色顺序错误 ----------
            // 消息角色必须交替（user/assistant），顺序错误时返回友好提示
            if (/incorrect role information|roles must alternate/i.test(errorText)) {
              return {
                payloads: [
                  {
                    text:
                      "Message ordering conflict - please try again. " +
                      "If this persists, use /new to start a fresh session.",
                    isError: true,
                  },
                ],
                meta: {
                  durationMs: Date.now() - started,
                  agentMeta: buildErrorAgentMeta({
                    sessionId: sessionIdUsed,
                    provider,
                    model: model.id,
                    usageAccumulator,
                    lastRunPromptUsage,
                    lastAssistant,
                    lastTurnTotal,
                  }),
                  systemPromptReport: attempt.systemPromptReport,
                  error: { kind: "role_ordering", message: errorText },
                },
              };
            }

            // ---------- 图片大小错误 ----------
            // 图片超过模型限制时返回友好提示（无需重试）
            const imageSizeError = parseImageSizeError(errorText);
            if (imageSizeError) {
              const maxMb = imageSizeError.maxMb;
              const maxMbLabel =
                typeof maxMb === "number" && Number.isFinite(maxMb) ? `${maxMb}` : null;
              const maxBytesHint = maxMbLabel ? ` (max ${maxMbLabel}MB)` : "";
              return {
                payloads: [
                  {
                    text:
                      `Image too large for the model${maxBytesHint}. ` +
                      "Please compress or resize the image and try again.",
                    isError: true,
                  },
                ],
                meta: {
                  durationMs: Date.now() - started,
                  agentMeta: buildErrorAgentMeta({
                    sessionId: sessionIdUsed,
                    provider,
                    model: model.id,
                    usageAccumulator,
                    lastRunPromptUsage,
                    lastAssistant,
                    lastTurnTotal,
                  }),
                  systemPromptReport: attempt.systemPromptReport,
                  error: { kind: "image_size", message: errorText },
                },
              };
            }

            // ---------- Failover 相关错误处理 ----------
            // 分类错误原因并标记 profile 失败
            const promptFailoverReason = classifyFailoverReason(errorText);
            const promptProfileFailureReason =
              resolveAuthProfileFailureReason(promptFailoverReason);
            await maybeMarkAuthProfileFailure({
              profileId: lastProfileId,
              reason: promptProfileFailureReason,
            });

            const promptFailoverFailure = isFailoverErrorMessage(errorText);
            // 在轮换前捕获失败的 profile ID
            const failedPromptProfileId = lastProfileId;

            // 创建 failover 决策日志记录器
            const logPromptFailoverDecision = createFailoverDecisionLogger({
              stage: "prompt",
              runId: params.runId,
              rawError: errorText,
              failoverReason: promptFailoverReason,
              profileFailureReason: promptProfileFailureReason,
              provider,
              model: modelId,
              profileId: failedPromptProfileId,
              fallbackConfigured,
              aborted,
            });

            // ---------- 策略 1：轮换 auth profile ----------
            // 对于非超时的 failover 错误，尝试切换到下一个 profile
            if (
              promptFailoverFailure &&
              promptFailoverReason !== "timeout" &&
              (await advanceAuthProfile())
            ) {
              logPromptFailoverDecision("rotate_profile");
              await maybeBackoffBeforeOverloadFailover(promptFailoverReason);
              continue;
            }

            // ---------- 策略 2：降低思考级别 ----------
            // 某些模型不支持高思考级别，尝试降级
            const fallbackThinking = pickFallbackThinkingLevel({
              message: errorText,
              attempted: attemptedThinking,
            });
            if (fallbackThinking) {
              log.warn(
                `unsupported thinking level for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
              );
              thinkLevel = fallbackThinking;
              continue;
            }

            // ---------- 策略 3：抛出 FailoverError 触发模型 fallback ----------
            // 配置了 fallback 时，抛出 FailoverError 让外层处理
            if (fallbackConfigured && promptFailoverFailure) {
              const status = resolveFailoverStatus(promptFailoverReason ?? "unknown");
              logPromptFailoverDecision("fallback_model", { status });
              await maybeBackoffBeforeOverloadFailover(promptFailoverReason);
              throw new FailoverError(errorText, {
                reason: promptFailoverReason ?? "unknown",
                provider,
                model: modelId,
                profileId: lastProfileId,
                status,
              });
            }

            // ---------- 无法恢复，向上抛出错误 ----------
            if (promptFailoverFailure || promptFailoverReason) {
              logPromptFailoverDecision("surface_error");
            }
            throw promptError;
          }

          // ==================== 16. Assistant 错误处理 ====================

          // ---------- 思考级别降级 ----------
          // 某些模型不支持高思考级别，尝试降级后重试
          const fallbackThinking = pickFallbackThinkingLevel({
            message: lastAssistant?.errorMessage,
            attempted: attemptedThinking,
          });
          if (fallbackThinking && !aborted) {
            log.warn(
              `unsupported thinking level for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
            );
            thinkLevel = fallbackThinking;
            continue;
          }

          // ---------- 错误类型分类 ----------
          const authFailure = isAuthAssistantError(lastAssistant); // 认证错误
          const rateLimitFailure = isRateLimitAssistantError(lastAssistant); // 速率限制
          const billingFailure = isBillingAssistantError(lastAssistant); // 计费错误
          const failoverFailure = isFailoverAssistantError(lastAssistant); // 需要 failover 的错误
          const assistantFailoverReason = classifyFailoverReason(lastAssistant?.errorMessage ?? "");
          const assistantProfileFailureReason =
            resolveAuthProfileFailureReason(assistantFailoverReason);
          const cloudCodeAssistFormatError = attempt.cloudCodeAssistFormatError;
          const imageDimensionError = parseImageDimensionError(lastAssistant?.errorMessage ?? "");

          // 在轮换前捕获失败的 profile ID
          const failedAssistantProfileId = lastProfileId;

          // 创建 failover 决策日志记录器
          const logAssistantFailoverDecision = createFailoverDecisionLogger({
            stage: "assistant",
            runId: params.runId,
            rawError: lastAssistant?.errorMessage?.trim(),
            failoverReason: assistantFailoverReason,
            profileFailureReason: assistantProfileFailureReason,
            provider: activeErrorContext.provider,
            model: activeErrorContext.model,
            profileId: failedAssistantProfileId,
            fallbackConfigured,
            timedOut,
            aborted,
          });

          // ---------- Copilot 认证错误重试 ----------
          if (
            authFailure &&
            (await maybeRefreshCopilotForAuthError(
              lastAssistant?.errorMessage ?? "",
              copilotAuthRetry,
            ))
          ) {
            authRetryPending = true;
            continue;
          }

          // ---------- 图片尺寸错误日志 ----------
          if (imageDimensionError && lastProfileId) {
            const details = [
              imageDimensionError.messageIndex !== undefined
                ? `message=${imageDimensionError.messageIndex}`
                : null,
              imageDimensionError.contentIndex !== undefined
                ? `content=${imageDimensionError.contentIndex}`
                : null,
              imageDimensionError.maxDimensionPx !== undefined
                ? `limit=${imageDimensionError.maxDimensionPx}px`
                : null,
            ]
              .filter(Boolean)
              .join(" ");
            log.warn(
              `Profile ${lastProfileId} rejected image payload${details ? ` (${details})` : ""}.`,
            );
          }

          // ---------- 判断是否需要轮换 profile ----------
          // 超时时尝试轮换账号/模型路径，但排除压缩期间的超时（模型已成功，不是 profile 问题）
          const shouldRotate =
            (!aborted && failoverFailure) || (timedOut && !timedOutDuringCompaction);

          if (shouldRotate) {
            if (lastProfileId) {
              const reason = timedOut ? "timeout" : assistantProfileFailureReason;
              // 超时跳过冷却标记：超时是模型/网络特定问题，不是认证问题。
              // 标记 profile 会污染同一 provider 的 fallback 模型
              // （例如 gpt-5.3 超时会阻止 gpt-5.2）
              await maybeMarkAuthProfileFailure({
                profileId: lastProfileId,
                reason,
              });
              if (timedOut && !isProbeSession) {
                log.warn(`Profile ${lastProfileId} timed out. Trying next account...`);
              }
              if (cloudCodeAssistFormatError) {
                log.warn(
                  `Profile ${lastProfileId} hit Cloud Code Assist format error. Tool calls will be sanitized on retry.`,
                );
              }
            }

            // ---------- 策略 1：轮换 profile ----------
            const rotated = await advanceAuthProfile();
            if (rotated) {
              logAssistantFailoverDecision("rotate_profile");
              await maybeBackoffBeforeOverloadFailover(assistantFailoverReason);
              continue;
            }

            // ---------- 策略 2：抛出 FailoverError 触发模型 fallback ----------
            if (fallbackConfigured) {
              await maybeBackoffBeforeOverloadFailover(assistantFailoverReason);
              // 优先使用格式化的错误消息（用户友好）而非原始 errorMessage
              const message =
                (lastAssistant
                  ? formatAssistantErrorText(lastAssistant, {
                      cfg: params.config,
                      sessionKey: params.sessionKey ?? params.sessionId,
                      provider: activeErrorContext.provider,
                      model: activeErrorContext.model,
                    })
                  : undefined) ||
                lastAssistant?.errorMessage?.trim() ||
                (timedOut
                  ? "LLM request timed out."
                  : rateLimitFailure
                    ? "LLM request rate limited."
                    : billingFailure
                      ? formatBillingErrorMessage(
                          activeErrorContext.provider,
                          activeErrorContext.model,
                        )
                      : authFailure
                        ? "LLM request unauthorized."
                        : "LLM request failed.");
              const status =
                resolveFailoverStatus(assistantFailoverReason ?? "unknown") ??
                (isTimeoutErrorMessage(message) ? 408 : undefined);
              logAssistantFailoverDecision("fallback_model", { status });
              throw new FailoverError(message, {
                reason: assistantFailoverReason ?? "unknown",
                provider: activeErrorContext.provider,
                model: activeErrorContext.model,
                profileId: lastProfileId,
                status,
              });
            }

            // ---------- 无法恢复，记录错误 ----------
            logAssistantFailoverDecision("surface_error");
          }

          // ==================== 17. 构建成功响应 ====================

          // ---------- 用量数据处理 ----------
          const usage = toNormalizedUsage(usageAccumulator);
          // 使用最后一轮的 API 报告总数校正累加值
          if (usage && lastTurnTotal && lastTurnTotal > 0) {
            usage.total = lastTurnTotal;
          }

          // 提取最后一次 API 调用的用量，用于上下文窗口利用率显示。
          // 累加的 `usage` 汇总了所有调用的输入 token（工具循环、压缩重试等），
          // 这会高估实际上下文大小。`lastCallUsage` 只反映最后一次调用，
          // 给出当前上下文的准确快照。
          const lastCallUsage = normalizeUsage(lastAssistant?.usage as UsageLike);
          const promptTokens = derivePromptTokens(lastRunPromptUsage);

          // 构建 agent 元数据
          const agentMeta: EmbeddedPiAgentMeta = {
            sessionId: sessionIdUsed,
            provider: lastAssistant?.provider ?? provider,
            model: lastAssistant?.model ?? model.id,
            usage,
            lastCallUsage: lastCallUsage ?? undefined,
            promptTokens,
            compactionCount: autoCompactionCount > 0 ? autoCompactionCount : undefined,
          };

          // ---------- 构建响应 payloads ----------
          const payloads = buildEmbeddedRunPayloads({
            assistantTexts: attempt.assistantTexts,
            toolMetas: attempt.toolMetas,
            lastAssistant: attempt.lastAssistant,
            lastToolError: attempt.lastToolError,
            config: params.config,
            sessionKey: params.sessionKey ?? params.sessionId,
            provider: activeErrorContext.provider,
            model: activeErrorContext.model,
            verboseLevel: params.verboseLevel,
            reasoningLevel: params.reasoningLevel,
            toolResultFormat: resolvedToolResultFormat,
            suppressToolErrorWarnings: params.suppressToolErrorWarnings,
            inlineToolResultsAllowed: false,
            didSendViaMessagingTool: attempt.didSendViaMessagingTool,
            didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
          });

          // ---------- 超时无响应处理 ----------
          // 超时中止可能导致运行没有任何 assistant payloads。
          // 发出显式超时错误而不是静默完成，避免调用者丢失这个轮次（变成孤立的用户消息）。
          if (timedOut && !timedOutDuringCompaction && payloads.length === 0) {
            return {
              payloads: [
                {
                  text:
                    "Request timed out before a response was generated. " +
                    "Please try again, or increase `agents.defaults.timeoutSeconds` in your config.",
                  isError: true,
                },
              ],
              meta: {
                durationMs: Date.now() - started,
                agentMeta,
                aborted,
                systemPromptReport: attempt.systemPromptReport,
              },
              didSendViaMessagingTool: attempt.didSendViaMessagingTool,
              didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
              messagingToolSentTexts: attempt.messagingToolSentTexts,
              messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
              messagingToolSentTargets: attempt.messagingToolSentTargets,
              successfulCronAdds: attempt.successfulCronAdds,
            };
          }

          // ---------- 运行成功完成 ----------
          log.debug(
            `embedded run done: runId=${params.runId} sessionId=${params.sessionId} durationMs=${Date.now() - started} aborted=${aborted}`,
          );

          // 标记 profile 为健康并更新最后使用时间
          if (lastProfileId) {
            await markAuthProfileGood({
              store: authStore,
              provider,
              profileId: lastProfileId,
              agentDir: params.agentDir,
            });
            await markAuthProfileUsed({
              store: authStore,
              profileId: lastProfileId,
              agentDir: params.agentDir,
            });
          }

          // 返回最终结果
          return {
            payloads: payloads.length ? payloads : undefined,
            meta: {
              durationMs: Date.now() - started,
              agentMeta,
              aborted,
              systemPromptReport: attempt.systemPromptReport,
              // 处理客户端工具调用（OpenResponses hosted tools）
              // 传播 LLM stop reason 以便调用者（生命周期事件、ACP 桥接）
              // 区分 end_turn 和 max_tokens
              stopReason: attempt.clientToolCall
                ? "tool_calls"
                : (lastAssistant?.stopReason as string | undefined),
              // 待处理的工具调用（如果有）
              pendingToolCalls: attempt.clientToolCall
                ? [
                    {
                      id: randomBytes(5).toString("hex").slice(0, 9),
                      name: attempt.clientToolCall.name,
                      arguments: JSON.stringify(attempt.clientToolCall.params),
                    },
                  ]
                : undefined,
            },
            // 消息工具相关的附加输出
            didSendViaMessagingTool: attempt.didSendViaMessagingTool,
            didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
            messagingToolSentTexts: attempt.messagingToolSentTexts,
            messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
            messagingToolSentTargets: attempt.messagingToolSentTargets,
            successfulCronAdds: attempt.successfulCronAdds,
          };
        }
      } finally {
        // ==================== 18. 清理 ====================
        // 释放上下文引擎资源
        await contextEngine.dispose?.();
        // 停止 Copilot token 刷新定时器
        stopCopilotRefreshTimer();
        // 恢复原始工作目录
        process.chdir(prevCwd);
      }
    }),
  );
}
