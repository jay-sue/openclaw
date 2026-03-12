/**
 * 单次嵌入式尝试：runEmbeddedAttempt。负责写锁、SessionManager 准备、历史加载与轮次限制、
 * 系统提示与扩展注入、payload 组装、streamFn 选择（OpenAI/Anthropic/Google/Ollama/WS 等）、
 * 流式订阅与工具执行、压缩重试与超时，返回 EmbeddedRunAttemptResult。
 */
import fs from "node:fs/promises";
import os from "node:os";
import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { resolveHeartbeatPrompt } from "../../../auto-reply/heartbeat.js";
import { resolveChannelCapabilities } from "../../../config/channel-capabilities.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { getMachineDisplayName } from "../../../infra/machine-name.js";
import { ensureGlobalUndiciStreamTimeouts } from "../../../infra/net/undici-global-dispatcher.js";
import { MAX_IMAGE_BYTES } from "../../../media/constants.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentStartResult,
  PluginHookBeforePromptBuildResult,
} from "../../../plugins/types.js";
import { isCronSessionKey, isSubagentSessionKey } from "../../../routing/session-key.js";
import { joinPresentTextSegments } from "../../../shared/text/join-segments.js";
import { resolveSignalReactionLevel } from "../../../signal/reaction-level.js";
import { resolveTelegramInlineButtonsScope } from "../../../telegram/inline-buttons.js";
import { resolveTelegramReactionLevel } from "../../../telegram/reaction-level.js";
import { buildTtsSystemPromptHint } from "../../../tts/tts.js";
import { resolveUserPath } from "../../../utils.js";
import { normalizeMessageChannel } from "../../../utils/message-channel.js";
import { isReasoningTagProvider } from "../../../utils/provider-utils.js";
import { resolveOpenClawAgentDir } from "../../agent-paths.js";
import { resolveSessionAgentIds } from "../../agent-scope.js";
import { createAnthropicPayloadLogger } from "../../anthropic-payload-log.js";
import {
  analyzeBootstrapBudget,
  buildBootstrapPromptWarning,
  buildBootstrapTruncationReportMeta,
  buildBootstrapInjectionStats,
} from "../../bootstrap-budget.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "../../bootstrap-files.js";
import { createCacheTrace } from "../../cache-trace.js";
import {
  listChannelSupportedActions,
  resolveChannelMessageToolHints,
} from "../../channel-tools.js";
import { ensureCustomApiRegistered } from "../../custom-api-registry.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import { resolveOpenClawDocsPath } from "../../docs-path.js";
import { isTimeoutError } from "../../failover-error.js";
import { resolveImageSanitizationLimits } from "../../image-sanitization.js";
import { resolveModelAuthMode } from "../../model-auth.js";
import { normalizeProviderId, resolveDefaultModelForAgent } from "../../model-selection.js";
import { supportsModelTools } from "../../model-tool-support.js";
import { createConfiguredOllamaStreamFn } from "../../ollama-stream.js";
import { createOpenAIWebSocketStreamFn, releaseWsSession } from "../../openai-ws-stream.js";
import { resolveOwnerDisplaySetting } from "../../owner-display.js";
import {
  downgradeOpenAIFunctionCallReasoningPairs,
  isCloudCodeAssistFormatError,
  resolveBootstrapMaxChars,
  resolveBootstrapPromptTruncationWarningMode,
  resolveBootstrapTotalMaxChars,
  validateAnthropicTurns,
  validateGeminiTurns,
} from "../../pi-embedded-helpers.js";
import { subscribeEmbeddedPiSession } from "../../pi-embedded-subscribe.js";
import { createPreparedEmbeddedPiSettingsManager } from "../../pi-project-settings.js";
import { applyPiAutoCompactionGuard } from "../../pi-settings.js";
import { toClientToolDefinitions } from "../../pi-tool-definition-adapter.js";
import { createOpenClawCodingTools, resolveToolLoopDetectionConfig } from "../../pi-tools.js";
import { resolveSandboxContext } from "../../sandbox.js";
import { resolveSandboxRuntimeStatus } from "../../sandbox/runtime-status.js";
import { isXaiProvider } from "../../schema/clean-for-xai.js";
import { repairSessionFileIfNeeded } from "../../session-file-repair.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { sanitizeToolUseResultPairing } from "../../session-transcript-repair.js";
import {
  acquireSessionWriteLock,
  resolveSessionLockMaxHoldFromTimeout,
} from "../../session-write-lock.js";
import { detectRuntimeShell } from "../../shell-utils.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
  resolveSkillsPromptForRun,
} from "../../skills.js";
import { buildSystemPromptParams } from "../../system-prompt-params.js";
import { buildSystemPromptReport } from "../../system-prompt-report.js";
import { sanitizeToolCallIdsForCloudCodeAssist } from "../../tool-call-id.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../../tool-fs-policy.js";
import { normalizeToolName } from "../../tool-policy.js";
import { resolveTranscriptPolicy } from "../../transcript-policy.js";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../../workspace.js";
import { isRunnerAbortError } from "../abort.js";
import { appendCacheTtlTimestamp, isCacheTtlEligibleProvider } from "../cache-ttl.js";
import type { CompactEmbeddedPiSessionParams } from "../compact.js";
import { buildEmbeddedExtensionFactories } from "../extensions.js";
import { applyExtraParamsToAgent } from "../extra-params.js";
import {
  logToolSchemasForGoogle,
  sanitizeSessionHistory,
  sanitizeToolsForGoogle,
} from "../google.js";
import { getDmHistoryLimitFromSessionKey, limitHistoryTurns } from "../history.js";
import { log } from "../logger.js";
import { buildModelAliasLines } from "../model.js";
import {
  clearActiveEmbeddedRun,
  type EmbeddedPiQueueHandle,
  setActiveEmbeddedRun,
} from "../runs.js";
import { buildEmbeddedSandboxInfo } from "../sandbox-info.js";
import { prewarmSessionFile, trackSessionManagerAccess } from "../session-manager-cache.js";
import { prepareSessionManagerForRun } from "../session-manager-init.js";
import { resolveEmbeddedRunSkillEntries } from "../skills-runtime.js";
import {
  applySystemPromptOverrideToSession,
  buildEmbeddedSystemPrompt,
  createSystemPromptOverride,
} from "../system-prompt.js";
import { dropThinkingBlocks } from "../thinking.js";
import { collectAllowedToolNames } from "../tool-name-allowlist.js";
import { installToolResultContextGuard } from "../tool-result-context-guard.js";
import { splitSdkTools } from "../tool-split.js";
import { describeUnknownError, mapThinkingLevel } from "../utils.js";
import { flushPendingToolResultsAfterIdle } from "../wait-for-idle-before-flush.js";
import { waitForCompactionRetryWithAggregateTimeout } from "./compaction-retry-aggregate-timeout.js";
import {
  selectCompactionTimeoutSnapshot,
  shouldFlagCompactionTimeout,
} from "./compaction-timeout.js";
import { pruneProcessedHistoryImages } from "./history-image-prune.js";
import { detectAndLoadPromptImages } from "./images.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

/** 用于 before_prompt_build / before_agent_start 的钩子运行器类型 */
type PromptBuildHookRunner = {
  hasHooks: (hookName: "before_prompt_build" | "before_agent_start") => boolean;
  runBeforePromptBuild: (
    event: { prompt: string; messages: unknown[] },
    ctx: PluginHookAgentContext,
  ) => Promise<PluginHookBeforePromptBuildResult | undefined>;
  runBeforeAgentStart: (
    event: { prompt: string; messages: unknown[] },
    ctx: PluginHookAgentContext,
  ) => Promise<PluginHookBeforeAgentStartResult | undefined>;
};

/**
 * 判断当前 model 是否为 Ollama 或兼容 Ollama 的端点。
 *
 * 判断逻辑：
 * 1. provider 归一化后为 "ollama" → 是
 * 2. baseUrl 指向本地（localhost/127.0.0.1/::1）且端口为 11434 → 是
 * 3. provider 名包含 "ollama"、端口为 11434、路径为 "/" 或 "/v1" → 是（支持远程 Ollama OpenAI 兼容端点）
 *
 * @param model - 模型配置对象，包含 provider、baseUrl、api 字段
 * @returns 是否为 Ollama 兼容的提供商
 */
export function isOllamaCompatProvider(model: {
  provider?: string;
  baseUrl?: string;
  api?: string;
}): boolean {
  // 将 provider 归一化（统一大小写、去除空格等）
  const providerId = normalizeProviderId(model.provider ?? "");
  if (providerId === "ollama") {
    return true;
  }
  // 无 baseUrl 则无法判断是否为远程 Ollama
  if (!model.baseUrl) {
    return false;
  }
  try {
    const parsed = new URL(model.baseUrl);
    const hostname = parsed.hostname.toLowerCase();
    // 检测是否为本地地址（localhost、IPv4 回环、IPv6 回环）
    const isLocalhost =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]";
    // 本地 Ollama 默认监听 11434 端口
    if (isLocalhost && parsed.port === "11434") {
      return true;
    }

    // 当 provider 名本身暗示 Ollama（如 "my-ollama"）时，允许远程/局域网 Ollama OpenAI 兼容端点
    const providerHintsOllama = providerId.includes("ollama");
    const isOllamaPort = parsed.port === "11434";
    // Ollama OpenAI 兼容路径通常为根路径或 /v1
    const isOllamaCompatPath = parsed.pathname === "/" || /^\/v1\/?$/i.test(parsed.pathname);
    return providerHintsOllama && isOllamaPort && isOllamaCompatPath;
  } catch {
    return false;
  }
}

/**
 * 判断是否应为指定 provider 启用 num_ctx 注入。
 *
 * 配置层级优先级：
 * 1. 精确匹配 provider 配置中的 injectNumCtxForOpenAICompat 字段
 * 2. 归一化匹配（如 "My-Ollama" 与 "my_ollama" 视为相同）
 * 3. 默认返回 true（启用注入）
 *
 * @param params.config - OpenClaw 全局配置
 * @param params.providerId - 提供商 ID
 * @returns 是否启用 num_ctx 注入
 */
export function resolveOllamaCompatNumCtxEnabled(params: {
  config?: OpenClawConfig;
  providerId?: string;
}): boolean {
  const providerId = params.providerId?.trim();
  // 无 providerId 时默认启用
  if (!providerId) {
    return true;
  }
  const providers = params.config?.models?.providers;
  // 无 providers 配置时默认启用
  if (!providers) {
    return true;
  }
  // 精确匹配 provider 配置
  const direct = providers[providerId];
  if (direct) {
    return direct.injectNumCtxForOpenAICompat ?? true;
  }
  // 归一化后模糊匹配
  const normalized = normalizeProviderId(providerId);
  for (const [candidateId, candidate] of Object.entries(providers)) {
    if (normalizeProviderId(candidateId) === normalized) {
      return candidate.injectNumCtxForOpenAICompat ?? true;
    }
  }
  return true;
}

/**
 * 综合判断是否应为当前请求注入 Ollama 的 num_ctx 参数。
 *
 * 同时满足以下条件才返回 true：
 * 1. 模型使用 OpenAI 兼容 API (api === "openai-completions")
 * 2. 模型是 Ollama 兼容提供商
 * 3. 配置未禁用 num_ctx 注入
 *
 * @param params.model - 模型配置
 * @param params.config - OpenClaw 全局配置
 * @param params.providerId - 提供商 ID
 * @returns 是否应注入 num_ctx
 */
export function shouldInjectOllamaCompatNumCtx(params: {
  model: { api?: string; provider?: string; baseUrl?: string };
  config?: OpenClawConfig;
  providerId?: string;
}): boolean {
  // 仅限走 OpenAI 兼容适配器路径；原生 Ollama API 不需要此注入
  if (params.model.api !== "openai-completions") {
    return false;
  }
  // 非 Ollama 兼容端点无需注入
  if (!isOllamaCompatProvider(params.model)) {
    return false;
  }
  // 检查配置是否禁用了 num_ctx 注入
  return resolveOllamaCompatNumCtxEnabled({
    config: params.config,
    providerId: params.providerId,
  });
}

/**
 * 包装 StreamFn，为 Ollama 兼容端点注入 num_ctx 参数。
 * Ollama 在使用 OpenAI 兼容 API 时默认上下文为 4096 token，需要显式设置 num_ctx 以使用更大的上下文窗口。
 * 该函数在 payload.options 中添加 num_ctx 字段后再传递给下游 onPayload 回调。
 *
 * @param baseFn - 原始流函数；若为空则使用 streamSimple
 * @param numCtx - 要注入的上下文窗口大小（token 数量）
 * @returns 包装后的 StreamFn
 */
export function wrapOllamaCompatNumCtx(baseFn: StreamFn | undefined, numCtx: number): StreamFn {
  const streamFn = baseFn ?? streamSimple;
  return (model, context, options) =>
    streamFn(model, context, {
      ...options,
      onPayload: (payload: unknown, payloadModel) => {
        // 若 payload 非对象则直接透传给下游
        if (!payload || typeof payload !== "object") {
          return options?.onPayload?.(payload, payloadModel);
        }
        const payloadRecord = payload as Record<string, unknown>;
        // 确保 options 字段存在
        if (!payloadRecord.options || typeof payloadRecord.options !== "object") {
          payloadRecord.options = {};
        }
        // 将 num_ctx 注入到 payload.options 中，使 Ollama 使用指定的上下文长度
        (payloadRecord.options as Record<string, unknown>).num_ctx = numCtx;
        return options?.onPayload?.(payload, payloadModel);
      },
    });
}

/**
 * 规范化工具调用名称，使其与已注册的工具名匹配。
 *
 * 部分模型返回的工具名可能带有前缀、命名空间或错误的大小写（如 "mcp.read" 或 "READ"），
 * 该函数尝试将其映射到 allowedToolNames 中的正确名称。
 *
 * 匹配策略（按优先级）：
 * 1. 精确匹配 trimmed 或其规范化形式
 * 2. 尝试去掉前缀后的后缀匹配（如 "namespace.toolName" → "toolName"）
 * 3. 大小写不敏感匹配（仅当唯一时才采用）
 *
 * @param rawName - 原始工具名
 * @param allowedToolNames - 允许的工具名集合
 * @returns 规范化后的工具名
 */
function normalizeToolCallNameForDispatch(rawName: string, allowedToolNames?: Set<string>): string {
  const trimmed = rawName.trim();
  if (!trimmed) {
    // 保留仅空白的占位符不变，避免被规约为空串导致后续出现 toolName="" 死循环
    return rawName;
  }
  // 无允许列表时直接返回裁剪后的名称
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return trimmed;
  }

  // 构建候选名称集合：原名 + 规范化名
  const candidateNames = new Set<string>([trimmed, normalizeToolName(trimmed)]);
  // 将 "/" 替换为 "." 后按段分割，生成后缀候选
  const normalizedDelimiter = trimmed.replace(/\//g, ".");
  const segments = normalizedDelimiter
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
  // 对于多段名称，尝试逐级去掉前缀作为候选
  if (segments.length > 1) {
    for (let index = 1; index < segments.length; index += 1) {
      const suffix = segments.slice(index).join(".");
      candidateNames.add(suffix);
      candidateNames.add(normalizeToolName(suffix));
    }
  }

  // 精确匹配
  for (const candidate of candidateNames) {
    if (allowedToolNames.has(candidate)) {
      return candidate;
    }
  }

  // 大小写不敏感匹配（仅当唯一匹配时采用）
  for (const candidate of candidateNames) {
    const folded = candidate.toLowerCase();
    let caseInsensitiveMatch: string | null = null;
    for (const name of allowedToolNames) {
      if (name.toLowerCase() !== folded) {
        continue;
      }
      // 如果已有一个匹配且不相同，说明存在歧义，放弃匹配
      if (caseInsensitiveMatch && caseInsensitiveMatch !== name) {
        return candidate;
      }
      caseInsensitiveMatch = name;
    }
    if (caseInsensitiveMatch) {
      return caseInsensitiveMatch;
    }
  }

  return trimmed;
}

/**
 * 判断内容块类型是否为工具调用。
 * 不同 API 使用不同的类型名称：toolCall、toolUse、functionCall。
 */
function isToolCallBlockType(type: unknown): boolean {
  return type === "toolCall" || type === "toolUse" || type === "functionCall";
}

/**
 * 规范化消息中工具调用的 ID。
 *
 * 处理逻辑：
 * 1. 去除 ID 首尾空白
 * 2. 为空 ID 或无 ID 的工具调用生成唯一回退 ID（call_auto_N）
 *
 * 这解决了部分模型返回空白或缺失工具 ID 的问题，确保后续 tool_result 能正确配对。
 *
 * @param message - 要处理的消息对象
 */
function normalizeToolCallIdsInMessage(message: unknown): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }

  // 第一遍：收集已使用的有效 ID
  const usedIds = new Set<string>();
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; id?: unknown };
    if (!isToolCallBlockType(typedBlock.type) || typeof typedBlock.id !== "string") {
      continue;
    }
    const trimmedId = typedBlock.id.trim();
    if (!trimmedId) {
      continue;
    }
    usedIds.add(trimmedId);
  }

  // 第二遍：规范化 ID 或生成回退 ID
  let fallbackIndex = 1;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; id?: unknown };
    if (!isToolCallBlockType(typedBlock.type)) {
      continue;
    }
    // 有效 ID：去除首尾空白
    if (typeof typedBlock.id === "string") {
      const trimmedId = typedBlock.id.trim();
      if (trimmedId) {
        if (typedBlock.id !== trimmedId) {
          typedBlock.id = trimmedId;
        }
        usedIds.add(trimmedId);
        continue;
      }
    }

    // 无效或空 ID：生成唯一回退 ID
    let fallbackId = "";
    while (!fallbackId || usedIds.has(fallbackId)) {
      fallbackId = `call_auto_${fallbackIndex++}`;
    }
    typedBlock.id = fallbackId;
    usedIds.add(fallbackId);
  }
}

/**
 * 规范化消息中所有工具调用的名称和 ID。
 *
 * 该函数遍历消息的 content 数组，对每个工具调用块：
 * 1. 将工具名映射到 allowedToolNames 中的正确名称
 * 2. 规范化工具调用 ID（去空白、生成回退 ID）
 *
 * @param message - 要处理的消息对象
 * @param allowedToolNames - 允许的工具名集合
 */
function trimWhitespaceFromToolCallNamesInMessage(
  message: unknown,
  allowedToolNames?: Set<string>,
): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  // 规范化每个工具调用块的名称
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; name?: unknown };
    if (!isToolCallBlockType(typedBlock.type) || typeof typedBlock.name !== "string") {
      continue;
    }
    const normalized = normalizeToolCallNameForDispatch(typedBlock.name, allowedToolNames);
    if (normalized !== typedBlock.name) {
      typedBlock.name = normalized;
    }
  }
  // 同时规范化 ID
  normalizeToolCallIdsInMessage(message);
}

/**
 * 包装流对象，在每次迭代和最终结果中规范化工具调用名称。
 *
 * @param stream - 原始流对象
 * @param allowedToolNames - 允许的工具名集合
 * @returns 包装后的流对象
 */
function wrapStreamTrimToolCallNames(
  stream: ReturnType<typeof streamSimple>,
  allowedToolNames?: Set<string>,
): ReturnType<typeof streamSimple> {
  // 包装 result() 方法
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    trimWhitespaceFromToolCallNamesInMessage(message, allowedToolNames);
    return message;
  };

  // 包装异步迭代器，在每个事件中规范化工具名
  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
    function () {
      const iterator = originalAsyncIterator();
      return {
        async next() {
          const result = await iterator.next();
          if (!result.done && result.value && typeof result.value === "object") {
            const event = result.value as {
              partial?: unknown;
              message?: unknown;
            };
            // 对流式部分和完整消息都进行规范化
            trimWhitespaceFromToolCallNamesInMessage(event.partial, allowedToolNames);
            trimWhitespaceFromToolCallNamesInMessage(event.message, allowedToolNames);
          }
          return result;
        },
        async return(value?: unknown) {
          return iterator.return?.(value) ?? { done: true as const, value: undefined };
        },
        async throw(error?: unknown) {
          return iterator.throw?.(error) ?? { done: true as const, value: undefined };
        },
      };
    };

  return stream;
}

/**
 * 包装 StreamFn，在流式响应中规范化工具调用名称。
 *
 * 部分模型（如某些 Ollama 模型）返回的工具名带首尾空格，
 * pi-agent-core 按字符串精确匹配分发，因此需要在执行前规范化。
 *
 * @param baseFn - 原始流函数
 * @param allowedToolNames - 允许的工具名集合
 * @returns 包装后的流函数
 */
export function wrapStreamFnTrimToolCallNames(
  baseFn: StreamFn,
  allowedToolNames?: Set<string>,
): StreamFn {
  return (model, context, options) => {
    const maybeStream = baseFn(model, context, options);
    // 处理可能返回 Promise 的情况
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamTrimToolCallNames(stream, allowedToolNames),
      );
    }
    return wrapStreamTrimToolCallNames(maybeStream, allowedToolNames);
  };
}

// ---------------------------------------------------------------------------
// xAI / Grok：对 tool call 参数中的 HTML 实体解码，避免 API 返回的 &amp; 等导致解析错误
// ---------------------------------------------------------------------------

/** 用于快速检测字符串是否包含 HTML 实体的正则 */
const HTML_ENTITY_RE = /&(?:amp|lt|gt|quot|apos|#39|#x[0-9a-f]+|#\d+);/i;

/**
 * 解码字符串中的 HTML 实体。
 *
 * 支持的实体：
 * - 命名实体：&amp; &quot; &apos; &#39; &lt; &gt;
 * - 十六进制数字实体：&#xHH;
 * - 十进制数字实体：&#NNN;
 *
 * @param value - 包含 HTML 实体的字符串
 * @returns 解码后的字符串
 */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gi, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

/**
 * 递归解码对象中所有字符串值的 HTML 实体。
 *
 * xAI/Grok API 有时会在工具调用参数中返回 HTML 转义的字符（如 &amp; 代替 &），
 * 这会导致工具参数解析错误。该函数递归遍历对象并解码所有字符串。
 *
 * @param obj - 要处理的对象/数组/字符串
 * @returns 解码后的值
 */
export function decodeHtmlEntitiesInObject(obj: unknown): unknown {
  // 字符串：检测并解码
  if (typeof obj === "string") {
    return HTML_ENTITY_RE.test(obj) ? decodeHtmlEntities(obj) : obj;
  }
  // 数组：递归处理每个元素
  if (Array.isArray(obj)) {
    return obj.map(decodeHtmlEntitiesInObject);
  }
  // 对象：递归处理每个属性值
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = decodeHtmlEntitiesInObject(val);
    }
    return result;
  }
  // 其他类型：原样返回
  return obj;
}

/**
 * 解码消息中所有 xAI 工具调用参数里的 HTML 实体。
 *
 * @param message - 要处理的消息对象
 */
function decodeXaiToolCallArgumentsInMessage(message: unknown): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; arguments?: unknown };
    // 仅处理 toolCall 类型且有 arguments 的块
    if (typedBlock.type !== "toolCall" || !typedBlock.arguments) {
      continue;
    }
    if (typeof typedBlock.arguments === "object") {
      typedBlock.arguments = decodeHtmlEntitiesInObject(typedBlock.arguments);
    }
  }
}

/**
 * 包装流对象，解码 xAI 工具调用参数中的 HTML 实体。
 *
 * @param stream - 原始流对象
 * @returns 包装后的流对象
 */
function wrapStreamDecodeXaiToolCallArguments(
  stream: ReturnType<typeof streamSimple>,
): ReturnType<typeof streamSimple> {
  // 包装 result() 方法
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    decodeXaiToolCallArgumentsInMessage(message);
    return message;
  };

  // 包装异步迭代器
  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
    function () {
      const iterator = originalAsyncIterator();
      return {
        async next() {
          const result = await iterator.next();
          if (!result.done && result.value && typeof result.value === "object") {
            const event = result.value as { partial?: unknown; message?: unknown };
            decodeXaiToolCallArgumentsInMessage(event.partial);
            decodeXaiToolCallArgumentsInMessage(event.message);
          }
          return result;
        },
        async return(value?: unknown) {
          return iterator.return?.(value) ?? { done: true as const, value: undefined };
        },
        async throw(error?: unknown) {
          return iterator.throw?.(error) ?? { done: true as const, value: undefined };
        },
      };
    };
  return stream;
}

/**
 * 包装 StreamFn，解码 xAI 工具调用参数中的 HTML 实体。
 *
 * xAI/Grok API 有时会在工具参数中返回 HTML 转义字符，该包装器确保这些
 * 实体在工具执行前被正确解码。
 *
 * @param baseFn - 原始流函数
 * @returns 包装后的流函数
 */
function wrapStreamFnDecodeXaiToolCallArguments(baseFn: StreamFn): StreamFn {
  return (model, context, options) => {
    const maybeStream = baseFn(model, context, options);
    // 处理可能返回 Promise 的情况
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamDecodeXaiToolCallArguments(stream),
      );
    }
    return wrapStreamDecodeXaiToolCallArguments(maybeStream);
  };
}

/**
 * 解析 prompt 构建钩子的结果，合并 before_prompt_build 和旧版 before_agent_start 的输出。
 *
 * 该函数执行以下步骤：
 * 1. 调用 before_prompt_build 钩子（如果存在）
 * 2. 调用 before_agent_start 钩子（旧版兼容，如果存在且未提供 legacyBeforeAgentStartResult）
 * 3. 合并两个钩子的结果，before_prompt_build 优先
 *
 * @param params.prompt - 当前 prompt
 * @param params.messages - 会话历史消息
 * @param params.hookCtx - 钩子上下文（agent ID、session 信息等）
 * @param params.hookRunner - 钩子运行器
 * @param params.legacyBeforeAgentStartResult - 已执行的旧版钩子结果（可选）
 * @returns 合并后的钩子结果
 */
export async function resolvePromptBuildHookResult(params: {
  prompt: string;
  messages: unknown[];
  hookCtx: PluginHookAgentContext;
  hookRunner?: PromptBuildHookRunner | null;
  legacyBeforeAgentStartResult?: PluginHookBeforeAgentStartResult;
}): Promise<PluginHookBeforePromptBuildResult> {
  // 执行新版 before_prompt_build 钩子
  const promptBuildResult = params.hookRunner?.hasHooks("before_prompt_build")
    ? await params.hookRunner
        .runBeforePromptBuild(
          {
            prompt: params.prompt,
            messages: params.messages,
          },
          params.hookCtx,
        )
        .catch((hookErr: unknown) => {
          log.warn(`before_prompt_build hook failed: ${String(hookErr)}`);
          return undefined;
        })
    : undefined;

  // 执行旧版 before_agent_start 钩子（向后兼容）
  const legacyResult =
    params.legacyBeforeAgentStartResult ??
    (params.hookRunner?.hasHooks("before_agent_start")
      ? await params.hookRunner
          .runBeforeAgentStart(
            {
              prompt: params.prompt,
              messages: params.messages,
            },
            params.hookCtx,
          )
          .catch((hookErr: unknown) => {
            log.warn(
              `before_agent_start hook (legacy prompt build path) failed: ${String(hookErr)}`,
            );
            return undefined;
          })
      : undefined);

  // 合并结果：新版优先，旧版补充
  return {
    systemPrompt: promptBuildResult?.systemPrompt ?? legacyResult?.systemPrompt,
    prependContext: joinPresentTextSegments([
      promptBuildResult?.prependContext,
      legacyResult?.prependContext,
    ]),
    prependSystemContext: joinPresentTextSegments([
      promptBuildResult?.prependSystemContext,
      legacyResult?.prependSystemContext,
    ]),
    appendSystemContext: joinPresentTextSegments([
      promptBuildResult?.appendSystemContext,
      legacyResult?.appendSystemContext,
    ]),
  };
}

/**
 * 将钩子提供的上下文片段（prepend/append）合并到基础系统提示中。
 *
 * @param params.baseSystemPrompt - 基础系统提示
 * @param params.prependSystemContext - 要插入到系统提示开头的内容
 * @param params.appendSystemContext - 要追加到系统提示末尾的内容
 * @returns 合并后的系统提示；若无内容需合并则返回 undefined
 */
export function composeSystemPromptWithHookContext(params: {
  baseSystemPrompt?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
}): string | undefined {
  const prependSystem = params.prependSystemContext?.trim();
  const appendSystem = params.appendSystemContext?.trim();
  // 无需合并时返回 undefined，避免不必要的字符串操作
  if (!prependSystem && !appendSystem) {
    return undefined;
  }
  // 按顺序拼接：前置上下文 + 基础提示 + 后置上下文
  return joinPresentTextSegments(
    [params.prependSystemContext, params.baseSystemPrompt, params.appendSystemContext],
    { trim: true },
  );
}

/**
 * 根据会话类型决定系统提示模式。
 *
 * - subagent 会话和 cron 会话使用 "minimal" 模式（精简提示）
 * - 其他会话使用 "full" 模式（完整提示）
 *
 * @param sessionKey - 会话标识符
 * @returns 提示模式
 */
export function resolvePromptModeForSession(sessionKey?: string): "minimal" | "full" {
  if (!sessionKey) {
    return "full";
  }
  return isSubagentSessionKey(sessionKey) || isCronSessionKey(sessionKey) ? "minimal" : "full";
}

/**
 * 判断当前尝试是否应限制文件系统访问仅限工作区。
 *
 * @param params.config - OpenClaw 配置
 * @param params.sessionAgentId - 会话的 agent ID
 * @returns 是否限制文件访问仅限工作区
 */
export function resolveAttemptFsWorkspaceOnly(params: {
  config?: OpenClawConfig;
  sessionAgentId: string;
}): boolean {
  return resolveEffectiveToolFsWorkspaceOnly({
    cfg: params.config,
    agentId: params.sessionAgentId,
  });
}

/**
 * 将额外内容插入到系统提示开头。
 *
 * @param params.systemPrompt - 原始系统提示
 * @param params.systemPromptAddition - 要插入的额外内容
 * @returns 合并后的系统提示
 */
export function prependSystemPromptAddition(params: {
  systemPrompt: string;
  systemPromptAddition?: string;
}): string {
  if (!params.systemPromptAddition) {
    return params.systemPrompt;
  }
  return `${params.systemPromptAddition}\n\n${params.systemPrompt}`;
}

/**
 * 构建传入 context-engine afterTurn 钩子的运行时上下文。
 *
 * 该上下文包含当前尝试的关键参数，供 context engine 在每轮对话后执行清理、
 * 索引更新等操作时使用。
 *
 * @param params.attempt - 当前尝试的参数子集
 * @param params.workspaceDir - 工作区目录
 * @param params.agentDir - agent 数据目录
 * @returns context engine 所需的运行时上下文
 */
export function buildAfterTurnRuntimeContext(params: {
  attempt: Pick<
    EmbeddedRunAttemptParams,
    | "sessionKey"
    | "messageChannel"
    | "messageProvider"
    | "agentAccountId"
    | "config"
    | "skillsSnapshot"
    | "senderIsOwner"
    | "provider"
    | "modelId"
    | "thinkLevel"
    | "reasoningLevel"
    | "bashElevated"
    | "extraSystemPrompt"
    | "ownerNumbers"
    | "authProfileId"
  >;
  workspaceDir: string;
  agentDir: string;
}): Partial<CompactEmbeddedPiSessionParams> {
  return {
    sessionKey: params.attempt.sessionKey,
    messageChannel: params.attempt.messageChannel,
    messageProvider: params.attempt.messageProvider,
    agentAccountId: params.attempt.agentAccountId,
    authProfileId: params.attempt.authProfileId,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    config: params.attempt.config,
    skillsSnapshot: params.attempt.skillsSnapshot,
    senderIsOwner: params.attempt.senderIsOwner,
    provider: params.attempt.provider,
    model: params.attempt.modelId,
    thinkLevel: params.attempt.thinkLevel,
    reasoningLevel: params.attempt.reasoningLevel,
    bashElevated: params.attempt.bashElevated,
    extraSystemPrompt: params.attempt.extraSystemPrompt,
    ownerNumbers: params.attempt.ownerNumbers,
  };
}

/**
 * 统计单条消息的文本字符数和图片块数。
 *
 * 用于诊断上下文大小，帮助排查提前溢出问题。
 *
 * @param msg - 要统计的消息
 * @returns 文本字符数和图片块数
 */
function summarizeMessagePayload(msg: AgentMessage): { textChars: number; imageBlocks: number } {
  const content = (msg as { content?: unknown }).content;
  // 纯字符串内容
  if (typeof content === "string") {
    return { textChars: content.length, imageBlocks: 0 };
  }
  // 非数组内容（如空消息）
  if (!Array.isArray(content)) {
    return { textChars: 0, imageBlocks: 0 };
  }

  // 遍历内容块，分别统计文本和图片
  let textChars = 0;
  let imageBlocks = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; text?: unknown };
    if (typedBlock.type === "image") {
      imageBlocks++;
      continue;
    }
    if (typeof typedBlock.text === "string") {
      textChars += typedBlock.text.length;
    }
  }

  return { textChars, imageBlocks };
}

/**
 * 汇总整个会话上下文的统计信息。
 *
 * 统计内容包括：
 * - 各角色的消息数量
 * - 总文本字符数
 * - 总图片块数
 * - 单条消息的最大文本字符数
 *
 * 用于 debug 日志，帮助诊断上下文溢出问题。
 *
 * @param messages - 会话消息数组
 * @returns 汇总统计信息
 */
function summarizeSessionContext(messages: AgentMessage[]): {
  roleCounts: string;
  totalTextChars: number;
  totalImageBlocks: number;
  maxMessageTextChars: number;
} {
  // 按角色统计消息数
  const roleCounts = new Map<string, number>();
  let totalTextChars = 0;
  let totalImageBlocks = 0;
  let maxMessageTextChars = 0;

  for (const msg of messages) {
    const role = typeof msg.role === "string" ? msg.role : "unknown";
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);

    const payload = summarizeMessagePayload(msg);
    totalTextChars += payload.textChars;
    totalImageBlocks += payload.imageBlocks;
    // 记录单条消息的最大文本量
    if (payload.textChars > maxMessageTextChars) {
      maxMessageTextChars = payload.textChars;
    }
  }

  return {
    // 格式化角色计数为 "assistant:5,user:4" 形式
    roleCounts:
      [...roleCounts.entries()]
        .toSorted((a, b) => a[0].localeCompare(b[0]))
        .map(([role, count]) => `${role}:${count}`)
        .join(",") || "none",
    totalTextChars,
    totalImageBlocks,
    maxMessageTextChars,
  };
}

/**
 * 执行单次嵌入式 agent 尝试。
 *
 * 这是嵌入式 Pi agent 运行的核心函数，负责完整的会话流程：
 *
 * 1. **环境准备**
 *    - 解析工作区路径，创建目录
 *    - 设置沙箱环境（如果启用）
 *    - 加载技能配置和环境变量
 *
 * 2. **Bootstrap 文件加载**
 *    - 加载 AGENTS.md/CLAUDE.md 等引导文件
 *    - 分析并检测上下文预算使用情况
 *
 * 3. **会话管理**
 *    - 获取会话写锁，防止并发写入
 *    - 加载或创建 SessionManager
 *    - 限制历史轮次，清理无效消息
 *
 * 4. **系统提示构建**
 *    - 构建包含运行时信息的系统提示
 *    - 执行 before_prompt_build 钩子
 *    - 注入技能提示和上下文
 *
 * 5. **模型配置**
 *    - 选择并配置 StreamFn（OpenAI/Anthropic/Google/Ollama/WS 等）
 *    - 应用额外参数和包装器
 *
 * 6. **Prompt 执行**
 *    - 检测并加载图片
 *    - 执行流式 prompt
 *    - 订阅并处理工具调用
 *
 * 7. **压缩与超时处理**
 *    - 等待压缩重试完成
 *    - 处理超时情况，保存快照
 *
 * 8. **清理与返回**
 *    - 执行 afterTurn 钩子
 *    - 释放资源和锁
 *    - 返回尝试结果
 *
 * @param params - 嵌入式运行尝试参数
 * @returns 尝试结果，包含消息快照、工具元数据、错误信息等
 */
export async function runEmbeddedAttempt(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  // 解析并规范化工作区路径
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  // 保存当前工作目录，便于后续恢复
  const prevCwd = process.cwd();
  // 创建本次运行专用的中止控制器
  const runAbortController = new AbortController();
  // 确保全局 undici 流超时配置已初始化
  ensureGlobalUndiciStreamTimeouts();

  log.debug(
    `embedded run start: runId=${params.runId} sessionId=${params.sessionId} provider=${params.provider} model=${params.modelId} thinking=${params.thinkLevel} messageChannel=${params.messageChannel ?? params.messageProvider ?? "unknown"}`,
  );

  // 确保工作区目录存在
  await fs.mkdir(resolvedWorkspace, { recursive: true });

  // -------------------------------------------------------------------------
  // 阶段 1：沙箱环境解析与工作区设置
  // -------------------------------------------------------------------------

  // 沙箱会话键：优先使用 sessionKey，否则回退到 sessionId
  const sandboxSessionKey = params.sessionKey?.trim() || params.sessionId;
  // 解析沙箱配置：检查是否启用沙箱、工作区访问权限等
  const sandbox = await resolveSandboxContext({
    config: params.config,
    sessionKey: sandboxSessionKey,
    workspaceDir: resolvedWorkspace,
  });
  // 确定实际工作区：沙箱启用时根据访问权限选择目录
  const effectiveWorkspace = sandbox?.enabled
    ? sandbox.workspaceAccess === "rw"
      ? resolvedWorkspace // 读写权限：使用原工作区
      : sandbox.workspaceDir // 只读权限：使用沙箱隔离目录
    : resolvedWorkspace;
  await fs.mkdir(effectiveWorkspace, { recursive: true });

  // -------------------------------------------------------------------------
  // 阶段 2：技能加载与环境变量设置
  // -------------------------------------------------------------------------

  // 保存恢复技能环境变量的清理函数
  let restoreSkillEnv: (() => void) | undefined;
  // 切换到有效工作区目录
  process.chdir(effectiveWorkspace);
  try {
    // 解析要加载的技能条目
    const { shouldLoadSkillEntries, skillEntries } = resolveEmbeddedRunSkillEntries({
      workspaceDir: effectiveWorkspace,
      config: params.config,
      skillsSnapshot: params.skillsSnapshot,
    });
    // 应用技能环境变量覆盖；从快照或实时技能配置加载
    restoreSkillEnv = params.skillsSnapshot
      ? applySkillEnvOverridesFromSnapshot({
          snapshot: params.skillsSnapshot,
          config: params.config,
        })
      : applySkillEnvOverrides({
          skills: skillEntries ?? [],
          config: params.config,
        });

    // 构建技能提示文本，用于注入系统提示
    const skillsPrompt = resolveSkillsPromptForRun({
      skillsSnapshot: params.skillsSnapshot,
      entries: shouldLoadSkillEntries ? skillEntries : undefined,
      config: params.config,
      workspaceDir: effectiveWorkspace,
    });

    // -------------------------------------------------------------------------
    // 阶段 3：Bootstrap 文件加载与上下文预算分析
    // -------------------------------------------------------------------------

    const sessionLabel = params.sessionKey ?? params.sessionId;
    // 加载 bootstrap 文件（AGENTS.md、CLAUDE.md 等）和上下文文件
    const { bootstrapFiles: hookAdjustedBootstrapFiles, contextFiles } =
      await resolveBootstrapContextForRun({
        workspaceDir: effectiveWorkspace,
        config: params.config,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        warn: makeBootstrapWarn({ sessionLabel, warn: (message) => log.warn(message) }),
        contextMode: params.bootstrapContextMode,
        runKind: params.bootstrapContextRunKind,
      });
    // 获取 bootstrap 字符数限制配置
    const bootstrapMaxChars = resolveBootstrapMaxChars(params.config);
    const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(params.config);
    // 分析 bootstrap 内容是否超出预算
    const bootstrapAnalysis = analyzeBootstrapBudget({
      files: buildBootstrapInjectionStats({
        bootstrapFiles: hookAdjustedBootstrapFiles,
        injectedFiles: contextFiles,
      }),
      bootstrapMaxChars,
      bootstrapTotalMaxChars,
    });
    // 解析截断警告模式（silent/warn/error）
    const bootstrapPromptWarningMode = resolveBootstrapPromptTruncationWarningMode(params.config);
    // 构建截断警告（如果有）
    const bootstrapPromptWarning = buildBootstrapPromptWarning({
      analysis: bootstrapAnalysis,
      mode: bootstrapPromptWarningMode,
      seenSignatures: params.bootstrapPromptWarningSignaturesSeen,
      previousSignature: params.bootstrapPromptWarningSignature,
    });
    // 如果检测到 AGENTS.md 文件，提醒用户提交更改
    const workspaceNotes = hookAdjustedBootstrapFiles.some(
      (file) => file.name === DEFAULT_BOOTSTRAP_FILENAME && !file.missing,
    )
      ? ["Reminder: commit your changes in this workspace after edits."]
      : undefined;

    // -------------------------------------------------------------------------
    // 阶段 4：Agent 配置与工具创建
    // -------------------------------------------------------------------------

    // agent 数据目录（存放会话、日志等）
    const agentDir = params.agentDir ?? resolveOpenClawAgentDir();

    // 解析会话的 agent ID：可能是默认 agent 或根据 sessionKey 推导的子 agent
    const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
      sessionKey: params.sessionKey,
      config: params.config,
      agentId: params.agentId,
    });
    // 判断是否限制文件系统访问仅限工作区
    const effectiveFsWorkspaceOnly = resolveAttemptFsWorkspaceOnly({
      config: params.config,
      sessionAgentId,
    });
    // 判断模型是否支持原生图片输入（用于视觉任务）
    const modelHasVision = params.model.input?.includes("image") ?? false;
    // 创建 OpenClaw 编码工具集（read、write、shell、message 等）
    const toolsRaw = params.disableTools
      ? []
      : createOpenClawCodingTools({
          agentId: sessionAgentId,
          exec: {
            ...params.execOverrides,
            elevated: params.bashElevated,
          },
          sandbox,
          messageProvider: params.messageChannel ?? params.messageProvider,
          agentAccountId: params.agentAccountId,
          messageTo: params.messageTo,
          messageThreadId: params.messageThreadId,
          groupId: params.groupId,
          groupChannel: params.groupChannel,
          groupSpace: params.groupSpace,
          spawnedBy: params.spawnedBy,
          senderId: params.senderId,
          senderName: params.senderName,
          senderUsername: params.senderUsername,
          senderE164: params.senderE164,
          senderIsOwner: params.senderIsOwner,
          sessionKey: sandboxSessionKey,
          sessionId: params.sessionId,
          runId: params.runId,
          agentDir,
          workspaceDir: effectiveWorkspace,
          config: params.config,
          abortSignal: runAbortController.signal,
          modelProvider: params.model.provider,
          modelId: params.modelId,
          modelContextWindowTokens: params.model.contextWindow,
          modelAuthMode: resolveModelAuthMode(params.model.provider, params.config),
          currentChannelId: params.currentChannelId,
          currentThreadTs: params.currentThreadTs,
          currentMessageId: params.currentMessageId,
          replyToMode: params.replyToMode,
          hasRepliedRef: params.hasRepliedRef,
          modelHasVision,
          requireExplicitMessageTarget:
            params.requireExplicitMessageTarget ?? isSubagentSessionKey(params.sessionKey),
          disableMessageTool: params.disableMessageTool,
        });
    // 判断模型是否支持工具调用
    const toolsEnabled = supportsModelTools(params.model);
    // 为 Google 模型清理工具定义（处理不兼容的 schema 特性）
    const tools = sanitizeToolsForGoogle({
      tools: toolsEnabled ? toolsRaw : [],
      provider: params.provider,
    });
    // 客户端工具（OpenResponses 托管工具）
    const clientTools = toolsEnabled ? params.clientTools : undefined;
    // 收集所有允许的工具名称，用于后续名称规范化
    const allowedToolNames = collectAllowedToolNames({
      tools,
      clientTools,
    });
    // 为 Google 模型记录工具 schema（调试用）
    logToolSchemasForGoogle({ tools, provider: params.provider });

    // -------------------------------------------------------------------------
    // 阶段 5：运行时信息与系统提示构建
    // -------------------------------------------------------------------------

    // 获取机器显示名称（用于系统提示）
    const machineName = await getMachineDisplayName();
    // 规范化消息通道名称（telegram、signal、discord 等）
    const runtimeChannel = normalizeMessageChannel(params.messageChannel ?? params.messageProvider);
    // 解析通道能力（inlineButtons、reactions 等）
    let runtimeCapabilities = runtimeChannel
      ? (resolveChannelCapabilities({
          cfg: params.config,
          channel: runtimeChannel,
          accountId: params.agentAccountId,
        }) ?? [])
      : undefined;
    // Telegram 特殊处理：检查是否启用内联按钮
    if (runtimeChannel === "telegram" && params.config) {
      const inlineButtonsScope = resolveTelegramInlineButtonsScope({
        cfg: params.config,
        accountId: params.agentAccountId ?? undefined,
      });
      if (inlineButtonsScope !== "off") {
        if (!runtimeCapabilities) {
          runtimeCapabilities = [];
        }
        if (
          !runtimeCapabilities.some((cap) => String(cap).trim().toLowerCase() === "inlinebuttons")
        ) {
          runtimeCapabilities.push("inlineButtons");
        }
      }
    }
    // 解析反应表情指导（Telegram/Signal 支持）
    const reactionGuidance =
      runtimeChannel && params.config
        ? (() => {
            if (runtimeChannel === "telegram") {
              const resolved = resolveTelegramReactionLevel({
                cfg: params.config,
                accountId: params.agentAccountId ?? undefined,
              });
              const level = resolved.agentReactionGuidance;
              return level ? { level, channel: "Telegram" } : undefined;
            }
            if (runtimeChannel === "signal") {
              const resolved = resolveSignalReactionLevel({
                cfg: params.config,
                accountId: params.agentAccountId ?? undefined,
              });
              const level = resolved.agentReactionGuidance;
              return level ? { level, channel: "Signal" } : undefined;
            }
            return undefined;
          })()
        : undefined;
    // 构建沙箱信息（用于系统提示）
    const sandboxInfo = buildEmbeddedSandboxInfo(sandbox, params.bashElevated);
    // 判断是否为支持推理标签的提供商（如 Anthropic Claude）
    const reasoningTagHint = isReasoningTagProvider(params.provider);
    // 解析当前通道的消息动作（如 react、edit），用于系统提示
    const channelActions = runtimeChannel
      ? listChannelSupportedActions({
          cfg: params.config,
          channel: runtimeChannel,
        })
      : undefined;
    const messageToolHints = runtimeChannel
      ? resolveChannelMessageToolHints({
          cfg: params.config,
          channel: runtimeChannel,
          accountId: params.agentAccountId,
        })
      : undefined;

    // 解析 agent 的默认模型配置
    const defaultModelRef = resolveDefaultModelForAgent({
      cfg: params.config ?? {},
      agentId: sessionAgentId,
    });
    const defaultModelLabel = `${defaultModelRef.provider}/${defaultModelRef.model}`;
    // 构建系统提示参数：运行时信息、用户时区等
    const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildSystemPromptParams({
      config: params.config,
      agentId: sessionAgentId,
      workspaceDir: effectiveWorkspace,
      cwd: process.cwd(),
      runtime: {
        host: machineName,
        os: `${os.type()} ${os.release()}`,
        arch: os.arch(),
        node: process.version,
        model: `${params.provider}/${params.modelId}`,
        defaultModel: defaultModelLabel,
        shell: detectRuntimeShell(),
        channel: runtimeChannel,
        capabilities: runtimeCapabilities,
        channelActions,
      },
    });
    // 判断是否为默认 agent（影响心跳提示是否注入）
    const isDefaultAgent = sessionAgentId === defaultAgentId;
    // 决定系统提示模式：subagent/cron 使用 minimal，其他使用 full
    const promptMode = resolvePromptModeForSession(params.sessionKey);
    // 解析 OpenClaw 文档路径（用于系统提示）
    const docsPath = await resolveOpenClawDocsPath({
      workspaceDir: effectiveWorkspace,
      argv1: process.argv[1],
      cwd: process.cwd(),
      moduleUrl: import.meta.url,
    });
    // TTS 提示（如果启用语音合成）
    const ttsHint = params.config ? buildTtsSystemPromptHint(params.config) : undefined;
    // 解析所有者显示设置
    const ownerDisplay = resolveOwnerDisplaySetting(params.config);

    // 构建完整的嵌入式系统提示
    const appendPrompt = buildEmbeddedSystemPrompt({
      workspaceDir: effectiveWorkspace,
      defaultThinkLevel: params.thinkLevel,
      reasoningLevel: params.reasoningLevel ?? "off",
      extraSystemPrompt: params.extraSystemPrompt,
      ownerNumbers: params.ownerNumbers,
      ownerDisplay: ownerDisplay.ownerDisplay,
      ownerDisplaySecret: ownerDisplay.ownerDisplaySecret,
      reasoningTagHint,
      heartbeatPrompt: isDefaultAgent
        ? resolveHeartbeatPrompt(params.config?.agents?.defaults?.heartbeat?.prompt)
        : undefined,
      skillsPrompt,
      docsPath: docsPath ?? undefined,
      ttsHint,
      workspaceNotes,
      reactionGuidance,
      promptMode,
      acpEnabled: params.config?.acp?.enabled !== false,
      runtimeInfo,
      messageToolHints,
      sandboxInfo,
      tools,
      modelAliasLines: buildModelAliasLines(params.config),
      userTimezone,
      userTime,
      userTimeFormat,
      contextFiles,
      bootstrapTruncationWarningLines: bootstrapPromptWarning.lines,
      memoryCitationsMode: params.config?.memory?.citations,
    });
    // 构建系统提示报告（用于调试和审计）
    const systemPromptReport = buildSystemPromptReport({
      source: "run",
      generatedAt: Date.now(),
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      provider: params.provider,
      model: params.modelId,
      workspaceDir: effectiveWorkspace,
      bootstrapMaxChars,
      bootstrapTotalMaxChars,
      bootstrapTruncation: buildBootstrapTruncationReportMeta({
        analysis: bootstrapAnalysis,
        warningMode: bootstrapPromptWarningMode,
        warning: bootstrapPromptWarning,
      }),
      sandbox: (() => {
        const runtime = resolveSandboxRuntimeStatus({
          cfg: params.config,
          sessionKey: sandboxSessionKey,
        });
        return { mode: runtime.mode, sandboxed: runtime.sandboxed };
      })(),
      systemPrompt: appendPrompt,
      bootstrapFiles: hookAdjustedBootstrapFiles,
      injectedFiles: contextFiles,
      skillsPrompt,
      tools,
    });
    // 创建系统提示覆盖函数（允许钩子动态修改）
    const systemPromptOverride = createSystemPromptOverride(appendPrompt);
    let systemPromptText = systemPromptOverride();

    // -------------------------------------------------------------------------
    // 阶段 6：会话管理器初始化
    // -------------------------------------------------------------------------

    // 获取会话写锁，防止并发写同一 session 文件；超时时间由 timeoutMs 推导
    const sessionLock = await acquireSessionWriteLock({
      sessionFile: params.sessionFile,
      maxHoldMs: resolveSessionLockMaxHoldFromTimeout({
        timeoutMs: params.timeoutMs,
      }),
    });

    // 会话管理器和会话对象
    let sessionManager: ReturnType<typeof guardSessionManager> | undefined;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    // 工具结果上下文守卫的清理函数
    let removeToolResultContextGuard: (() => void) | undefined;
    try {
      // 修复可能损坏的会话文件
      await repairSessionFileIfNeeded({
        sessionFile: params.sessionFile,
        warn: (message) => log.warn(message),
      });
      // 检查会话文件是否已存在
      const hadSessionFile = await fs
        .stat(params.sessionFile)
        .then(() => true)
        .catch(() => false);

      // 解析转录策略：是否删除 thinking 块、清理 tool call ID 等
      const transcriptPolicy = resolveTranscriptPolicy({
        modelApi: params.model?.api,
        provider: params.provider,
        modelId: params.modelId,
      });

      // 预热会话文件（缓存优化）
      await prewarmSessionFile(params.sessionFile);
      // 打开并包装会话管理器，添加输入验证守卫
      sessionManager = guardSessionManager(SessionManager.open(params.sessionFile), {
        agentId: sessionAgentId,
        sessionKey: params.sessionKey,
        inputProvenance: params.inputProvenance,
        allowSyntheticToolResults: transcriptPolicy.allowSyntheticToolResults,
        allowedToolNames,
      });
      // 记录会话管理器访问（用于 LRU 缓存）
      trackSessionManagerAccess(params.sessionFile);

      // 如果有上下文引擎且会话文件已存在，执行 bootstrap
      if (hadSessionFile && params.contextEngine?.bootstrap) {
        try {
          await params.contextEngine.bootstrap({
            sessionId: params.sessionId,
            sessionFile: params.sessionFile,
          });
        } catch (bootstrapErr) {
          log.warn(`context engine bootstrap failed: ${String(bootstrapErr)}`);
        }
      }

      // 为本次运行准备会话管理器
      await prepareSessionManagerForRun({
        sessionManager,
        sessionFile: params.sessionFile,
        hadSessionFile,
        sessionId: params.sessionId,
        cwd: effectiveWorkspace,
      });

      const settingsManager = createPreparedEmbeddedPiSettingsManager({
        cwd: effectiveWorkspace,
        agentDir,
        cfg: params.config,
      });
      applyPiAutoCompactionGuard({
        settingsManager,
        contextEngineInfo: params.contextEngine?.info,
      });

      // 构建扩展工厂（compaction-safeguard、context-pruning 等），并设置 compaction/pruning 运行时状态；需传入 resourceLoader 才会生效
      const extensionFactories = buildEmbeddedExtensionFactories({
        cfg: params.config,
        sessionManager,
        provider: params.provider,
        modelId: params.modelId,
        model: params.model,
      });
      // 仅在有扩展工厂需要注册时创建显式 resourceLoader，否则由 createAgentSession 使用内置默认
      let resourceLoader: DefaultResourceLoader | undefined;
      if (extensionFactories.length > 0) {
        resourceLoader = new DefaultResourceLoader({
          cwd: resolvedWorkspace,
          agentDir,
          settingsManager,
          extensionFactories,
        });
        await resourceLoader.reload();
      }

      // 提前获取 hook runner，便于创建工具时使用
      const hookRunner = getGlobalHookRunner();

      // -------------------------------------------------------------------------
      // 阶段 7：工具分类与会话创建
      // -------------------------------------------------------------------------

      // 将工具分为内置工具和自定义工具
      const { builtInTools, customTools } = splitSdkTools({
        tools,
        sandboxEnabled: !!sandbox?.enabled,
      });

      // 将客户端工具（OpenResponses 托管工具）加入 customTools
      // 这些工具由客户端执行，而非服务端
      let clientToolCallDetected: { name: string; params: Record<string, unknown> } | null = null;
      // 解析工具循环检测配置（防止无限循环调用）
      const clientToolLoopDetection = resolveToolLoopDetectionConfig({
        cfg: params.config,
        agentId: sessionAgentId,
      });
      // 转换客户端工具为工具定义
      const clientToolDefs = clientTools
        ? toClientToolDefinitions(
            clientTools,
            (toolName, toolParams) => {
              // 当检测到客户端工具调用时记录
              clientToolCallDetected = { name: toolName, params: toolParams };
            },
            {
              agentId: sessionAgentId,
              sessionKey: sandboxSessionKey,
              sessionId: params.sessionId,
              runId: params.runId,
              loopDetection: clientToolLoopDetection,
            },
          )
        : [];

      // 合并所有自定义工具
      const allCustomTools = [...customTools, ...clientToolDefs];

      // 创建 agent 会话
      ({ session } = await createAgentSession({
        cwd: resolvedWorkspace,
        agentDir,
        authStorage: params.authStorage,
        modelRegistry: params.modelRegistry,
        model: params.model,
        thinkingLevel: mapThinkingLevel(params.thinkLevel),
        tools: builtInTools,
        customTools: allCustomTools,
        sessionManager,
        settingsManager,
        resourceLoader,
      }));
      // 应用系统提示覆盖
      applySystemPromptOverrideToSession(session, systemPromptText);
      if (!session) {
        throw new Error("Embedded agent session missing");
      }
      const activeSession = session;

      // 安装工具结果上下文守卫：防止工具结果超出上下文窗口
      removeToolResultContextGuard = installToolResultContextGuard({
        agent: activeSession.agent,
        contextWindowTokens: Math.max(
          1,
          Math.floor(
            params.model.contextWindow ?? params.model.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
          ),
        ),
      });

      // 创建缓存追踪器（用于调试缓存命中）
      const cacheTrace = createCacheTrace({
        cfg: params.config,
        env: process.env,
        runId: params.runId,
        sessionId: activeSession.sessionId,
        sessionKey: params.sessionKey,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.model.api,
        workspaceDir: params.workspaceDir,
      });
      // 创建 Anthropic payload 日志器（用于调试）
      const anthropicPayloadLogger = createAnthropicPayloadLogger({
        env: process.env,
        runId: params.runId,
        sessionId: activeSession.sessionId,
        sessionKey: params.sessionKey,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.model.api,
        workspaceDir: params.workspaceDir,
      });

      // -------------------------------------------------------------------------
      // 阶段 8：StreamFn 配置（根据模型 API 选择传输方式）
      // -------------------------------------------------------------------------

      // Ollama 原生 API：绕过 SDK 的 streamSimple，直接走 /api/chat 以保证流式与工具调用稳定 (#11828)
      if (params.model.api === "ollama") {
        // 优先使用配置的 provider baseUrl，使 Docker/远程 Ollama 稳定可用
        const providerConfig = params.config?.models?.providers?.[params.model.provider];
        const providerBaseUrl =
          typeof providerConfig?.baseUrl === "string" ? providerConfig.baseUrl : undefined;
        const ollamaStreamFn = createConfiguredOllamaStreamFn({
          model: params.model,
          providerBaseUrl,
        });
        activeSession.agent.streamFn = ollamaStreamFn;
        ensureCustomApiRegistered(params.model.api, ollamaStreamFn);
      } else if (params.model.api === "openai-responses" && params.provider === "openai") {
        // OpenAI Responses API：使用 WebSocket 传输以提升实时性
        const wsApiKey = await params.authStorage.getApiKey(params.provider);
        if (wsApiKey) {
          activeSession.agent.streamFn = createOpenAIWebSocketStreamFn(wsApiKey, params.sessionId, {
            signal: runAbortController.signal,
          });
        } else {
          log.warn(`[ws-stream] no API key for provider=${params.provider}; using HTTP transport`);
          activeSession.agent.streamFn = streamSimple;
        }
      } else {
        // 默认：使用标准 HTTP 流式传输
        // 固定 streamFn 引用，便于 vitest 稳定 mock @mariozechner/pi-ai
        activeSession.agent.streamFn = streamSimple;
      }

      // 使用 OpenAI 兼容 API 的 Ollama 需在 payload.options 中传入 num_ctx，否则默认 4096 上下文
      const providerIdForNumCtx =
        typeof params.model.provider === "string" && params.model.provider.trim().length > 0
          ? params.model.provider
          : params.provider;
      // 判断是否需要注入 num_ctx 参数
      const shouldInjectNumCtx = shouldInjectOllamaCompatNumCtx({
        model: params.model,
        config: params.config,
        providerId: providerIdForNumCtx,
      });
      if (shouldInjectNumCtx) {
        // 计算要注入的上下文窗口大小
        const numCtx = Math.max(
          1,
          Math.floor(
            params.model.contextWindow ?? params.model.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
          ),
        );
        activeSession.agent.streamFn = wrapOllamaCompatNumCtx(activeSession.agent.streamFn, numCtx);
      }

      applyExtraParamsToAgent(
        activeSession.agent,
        params.config,
        params.provider,
        params.modelId,
        params.streamParams,
        params.thinkLevel,
        sessionAgentId,
      );

      if (cacheTrace) {
        cacheTrace.recordStage("session:loaded", {
          messages: activeSession.messages,
          system: systemPromptText,
          note: "after session create",
        });
        activeSession.agent.streamFn = cacheTrace.wrapStreamFn(activeSession.agent.streamFn);
      }

      // Copilot/Claude 在任意后续调用（含工具续写）中可能拒绝持久化了的 thinking 块；包装 streamFn 使每次请求前清洗消息
      if (transcriptPolicy.dropThinkingBlocks) {
        const inner = activeSession.agent.streamFn;
        activeSession.agent.streamFn = (model, context, options) => {
          const ctx = context as unknown as { messages?: unknown };
          const messages = ctx?.messages;
          if (!Array.isArray(messages)) {
            return inner(model, context, options);
          }
          const sanitized = dropThinkingBlocks(messages as unknown as AgentMessage[]) as unknown;
          if (sanitized === messages) {
            return inner(model, context, options);
          }
          const nextContext = {
            ...(context as unknown as Record<string, unknown>),
            messages: sanitized,
          } as unknown;
          return inner(model, nextContext as typeof context, options);
        };
      }

      // Mistral 等严格 provider 会拒绝不符合格式的 tool call id（如 [a-zA-Z0-9]{9}）。sanitizeSessionHistory 只在 attempt 开始时处理历史，
      // 而 agent 循环内部的 tool call → tool result 不经过该路径，故包装 streamFn 使每次出站请求都带清洗后的 tool call id
      if (transcriptPolicy.sanitizeToolCallIds && transcriptPolicy.toolCallIdMode) {
        const inner = activeSession.agent.streamFn;
        const mode = transcriptPolicy.toolCallIdMode;
        activeSession.agent.streamFn = (model, context, options) => {
          const ctx = context as unknown as { messages?: unknown };
          const messages = ctx?.messages;
          if (!Array.isArray(messages)) {
            return inner(model, context, options);
          }
          const sanitized = sanitizeToolCallIdsForCloudCodeAssist(messages as AgentMessage[], mode);
          if (sanitized === messages) {
            return inner(model, context, options);
          }
          const nextContext = {
            ...(context as unknown as Record<string, unknown>),
            messages: sanitized,
          } as unknown;
          return inner(model, nextContext as typeof context, options);
        };
      }

      if (
        params.model.api === "openai-responses" ||
        params.model.api === "openai-codex-responses"
      ) {
        const inner = activeSession.agent.streamFn;
        activeSession.agent.streamFn = (model, context, options) => {
          const ctx = context as unknown as { messages?: unknown };
          const messages = ctx?.messages;
          if (!Array.isArray(messages)) {
            return inner(model, context, options);
          }
          const sanitized = downgradeOpenAIFunctionCallReasoningPairs(messages as AgentMessage[]);
          if (sanitized === messages) {
            return inner(model, context, options);
          }
          const nextContext = {
            ...(context as unknown as Record<string, unknown>),
            messages: sanitized,
          } as unknown;
          return inner(model, nextContext as typeof context, options);
        };
      }

      // 部分模型返回的工具名带首尾空格（如 " read "），pi-agent-core 按字符串精确匹配分发，故在流式响应上先规范化再执行工具
      activeSession.agent.streamFn = wrapStreamFnTrimToolCallNames(
        activeSession.agent.streamFn,
        allowedToolNames,
      );

      if (isXaiProvider(params.provider, params.modelId)) {
        activeSession.agent.streamFn = wrapStreamFnDecodeXaiToolCallArguments(
          activeSession.agent.streamFn,
        );
      }

      if (anthropicPayloadLogger) {
        activeSession.agent.streamFn = anthropicPayloadLogger.wrapStreamFn(
          activeSession.agent.streamFn,
        );
      }

      try {
        const prior = await sanitizeSessionHistory({
          messages: activeSession.messages,
          modelApi: params.model.api,
          modelId: params.modelId,
          provider: params.provider,
          allowedToolNames,
          config: params.config,
          sessionManager,
          sessionId: params.sessionId,
          policy: transcriptPolicy,
        });
        cacheTrace?.recordStage("session:sanitized", { messages: prior });
        const validatedGemini = transcriptPolicy.validateGeminiTurns
          ? validateGeminiTurns(prior)
          : prior;
        const validated = transcriptPolicy.validateAnthropicTurns
          ? validateAnthropicTurns(validatedGemini)
          : validatedGemini;
        const truncated = limitHistoryTurns(
          validated,
          getDmHistoryLimitFromSessionKey(params.sessionKey, params.config),
        );
        // 裁剪轮次后重新做 tool_use/tool_result 配对修复：limitHistoryTurns 可能删掉含 tool_use 的 assistant，导致 tool_result 孤立
        const limited = transcriptPolicy.repairToolUseResultPairing
          ? sanitizeToolUseResultPairing(truncated)
          : truncated;
        cacheTrace?.recordStage("session:limited", { messages: limited });
        if (limited.length > 0) {
          activeSession.agent.replaceMessages(limited);
        }

        if (params.contextEngine) {
          try {
            const assembled = await params.contextEngine.assemble({
              sessionId: params.sessionId,
              messages: activeSession.messages,
              tokenBudget: params.contextTokenBudget,
            });
            if (assembled.messages !== activeSession.messages) {
              activeSession.agent.replaceMessages(assembled.messages);
            }
            if (assembled.systemPromptAddition) {
              systemPromptText = prependSystemPromptAddition({
                systemPrompt: systemPromptText,
                systemPromptAddition: assembled.systemPromptAddition,
              });
              applySystemPromptOverrideToSession(activeSession, systemPromptText);
              log.debug(
                `context engine: prepended system prompt addition (${assembled.systemPromptAddition.length} chars)`,
              );
            }
          } catch (assembleErr) {
            log.warn(
              `context engine assemble failed, using pipeline messages: ${String(assembleErr)}`,
            );
          }
        }
      } catch (err) {
        await flushPendingToolResultsAfterIdle({
          agent: activeSession?.agent,
          sessionManager,
          clearPendingOnTimeout: true,
        });
        activeSession.dispose();
        throw err;
      }

      let aborted = Boolean(params.abortSignal?.aborted);
      let timedOut = false;
      let timedOutDuringCompaction = false;
      const getAbortReason = (signal: AbortSignal): unknown =>
        "reason" in signal ? (signal as { reason?: unknown }).reason : undefined;
      const makeTimeoutAbortReason = (): Error => {
        const err = new Error("request timed out");
        err.name = "TimeoutError";
        return err;
      };
      const makeAbortError = (signal: AbortSignal): Error => {
        const reason = getAbortReason(signal);
        const err = reason ? new Error("aborted", { cause: reason }) : new Error("aborted");
        err.name = "AbortError";
        return err;
      };
      const abortRun = (isTimeout = false, reason?: unknown) => {
        aborted = true;
        if (isTimeout) {
          timedOut = true;
        }
        if (isTimeout) {
          runAbortController.abort(reason ?? makeTimeoutAbortReason());
        } else {
          runAbortController.abort(reason);
        }
        void activeSession.abort();
      };
      const abortable = <T>(promise: Promise<T>): Promise<T> => {
        const signal = runAbortController.signal;
        if (signal.aborted) {
          return Promise.reject(makeAbortError(signal));
        }
        return new Promise<T>((resolve, reject) => {
          const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            reject(makeAbortError(signal));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          promise.then(
            (value) => {
              signal.removeEventListener("abort", onAbort);
              resolve(value);
            },
            (err) => {
              signal.removeEventListener("abort", onAbort);
              reject(err);
            },
          );
        });
      };

      const subscription = subscribeEmbeddedPiSession({
        session: activeSession,
        runId: params.runId,
        hookRunner: getGlobalHookRunner() ?? undefined,
        verboseLevel: params.verboseLevel,
        reasoningMode: params.reasoningLevel ?? "off",
        toolResultFormat: params.toolResultFormat,
        shouldEmitToolResult: params.shouldEmitToolResult,
        shouldEmitToolOutput: params.shouldEmitToolOutput,
        onToolResult: params.onToolResult,
        onReasoningStream: params.onReasoningStream,
        onReasoningEnd: params.onReasoningEnd,
        onBlockReply: params.onBlockReply,
        onBlockReplyFlush: params.onBlockReplyFlush,
        blockReplyBreak: params.blockReplyBreak,
        blockReplyChunking: params.blockReplyChunking,
        onPartialReply: params.onPartialReply,
        onAssistantMessageStart: params.onAssistantMessageStart,
        onAgentEvent: params.onAgentEvent,
        enforceFinalTag: params.enforceFinalTag,
        config: params.config,
        sessionKey: sandboxSessionKey,
        sessionId: params.sessionId,
        agentId: sessionAgentId,
      });

      const {
        assistantTexts,
        toolMetas,
        unsubscribe,
        waitForCompactionRetry,
        isCompactionInFlight,
        getMessagingToolSentTexts,
        getMessagingToolSentMediaUrls,
        getMessagingToolSentTargets,
        getSuccessfulCronAdds,
        didSendViaMessagingTool,
        getLastToolError,
        getUsageTotals,
        getCompactionCount,
      } = subscription;

      const queueHandle: EmbeddedPiQueueHandle = {
        queueMessage: async (text: string) => {
          await activeSession.steer(text);
        },
        isStreaming: () => activeSession.isStreaming,
        isCompacting: () => subscription.isCompacting(),
        abort: abortRun,
      };
      setActiveEmbeddedRun(params.sessionId, queueHandle, params.sessionKey);

      let abortWarnTimer: NodeJS.Timeout | undefined;
      const isProbeSession = params.sessionId?.startsWith("probe-") ?? false;
      const abortTimer = setTimeout(
        () => {
          if (!isProbeSession) {
            log.warn(
              `embedded run timeout: runId=${params.runId} sessionId=${params.sessionId} timeoutMs=${params.timeoutMs}`,
            );
          }
          if (
            shouldFlagCompactionTimeout({
              isTimeout: true,
              isCompactionPendingOrRetrying: subscription.isCompacting(),
              isCompactionInFlight: activeSession.isCompacting,
            })
          ) {
            timedOutDuringCompaction = true;
          }
          abortRun(true);
          if (!abortWarnTimer) {
            abortWarnTimer = setTimeout(() => {
              if (!activeSession.isStreaming) {
                return;
              }
              if (!isProbeSession) {
                log.warn(
                  `embedded run abort still streaming: runId=${params.runId} sessionId=${params.sessionId}`,
                );
              }
            }, 10_000);
          }
        },
        Math.max(1, params.timeoutMs),
      );

      let messagesSnapshot: AgentMessage[] = [];
      let sessionIdUsed = activeSession.sessionId;
      const onAbort = () => {
        const reason = params.abortSignal ? getAbortReason(params.abortSignal) : undefined;
        const timeout = reason ? isTimeoutError(reason) : false;
        if (
          shouldFlagCompactionTimeout({
            isTimeout: timeout,
            isCompactionPendingOrRetrying: subscription.isCompacting(),
            isCompactionInFlight: activeSession.isCompacting,
          })
        ) {
          timedOutDuringCompaction = true;
        }
        abortRun(timeout, reason);
      };
      if (params.abortSignal) {
        if (params.abortSignal.aborted) {
          onAbort();
        } else {
          params.abortSignal.addEventListener("abort", onAbort, {
            once: true,
          });
        }
      }

      // hook runner 已在创建工具前取得
      const hookAgentId = sessionAgentId;

      let promptError: unknown = null;
      let promptErrorSource: "prompt" | "compaction" | null = null;
      const prePromptMessageCount = activeSession.messages.length;
      try {
        const promptStartedAt = Date.now();

        // 执行 before_prompt_build 钩子，供插件注入 prompt 上下文；兼容旧逻辑：同时检查 before_agent_start 的上下文字段
        let effectivePrompt = params.prompt;
        const hookCtx = {
          agentId: hookAgentId,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          workspaceDir: params.workspaceDir,
          messageProvider: params.messageProvider ?? undefined,
          trigger: params.trigger,
          channelId: params.messageChannel ?? params.messageProvider ?? undefined,
        };
        const hookResult = await resolvePromptBuildHookResult({
          prompt: params.prompt,
          messages: activeSession.messages,
          hookCtx,
          hookRunner,
          legacyBeforeAgentStartResult: params.legacyBeforeAgentStartResult,
        });
        {
          if (hookResult?.prependContext) {
            effectivePrompt = `${hookResult.prependContext}\n\n${params.prompt}`;
            log.debug(
              `hooks: prepended context to prompt (${hookResult.prependContext.length} chars)`,
            );
          }
          const legacySystemPrompt =
            typeof hookResult?.systemPrompt === "string" ? hookResult.systemPrompt.trim() : "";
          if (legacySystemPrompt) {
            applySystemPromptOverrideToSession(activeSession, legacySystemPrompt);
            systemPromptText = legacySystemPrompt;
            log.debug(`hooks: applied systemPrompt override (${legacySystemPrompt.length} chars)`);
          }
          const prependedOrAppendedSystemPrompt = composeSystemPromptWithHookContext({
            baseSystemPrompt: systemPromptText,
            prependSystemContext: hookResult?.prependSystemContext,
            appendSystemContext: hookResult?.appendSystemContext,
          });
          if (prependedOrAppendedSystemPrompt) {
            const prependSystemLen = hookResult?.prependSystemContext?.trim().length ?? 0;
            const appendSystemLen = hookResult?.appendSystemContext?.trim().length ?? 0;
            applySystemPromptOverrideToSession(activeSession, prependedOrAppendedSystemPrompt);
            systemPromptText = prependedOrAppendedSystemPrompt;
            log.debug(
              `hooks: applied prependSystemContext/appendSystemContext (${prependSystemLen}+${appendSystemLen} chars)`,
            );
          }
        }

        log.debug(`embedded run prompt start: runId=${params.runId} sessionId=${params.sessionId}`);
        cacheTrace?.recordStage("prompt:before", {
          prompt: effectivePrompt,
          messages: activeSession.messages,
        });

        // 修复孤立的末尾 user 消息，避免新 prompt 违反角色交替顺序
        const leafEntry = sessionManager.getLeafEntry();
        if (leafEntry?.type === "message" && leafEntry.message.role === "user") {
          if (leafEntry.parentId) {
            sessionManager.branch(leafEntry.parentId);
          } else {
            sessionManager.resetLeaf();
          }
          const sessionContext = sessionManager.buildSessionContext();
          activeSession.agent.replaceMessages(sessionContext.messages);
          log.warn(
            `Removed orphaned user message to prevent consecutive user turns. ` +
              `runId=${params.runId} sessionId=${params.sessionId}`,
          );
        }

        try {
          // 历史图片裁剪：对已有 assistant 回复的 user 轮次中的 image 块替换为占位，幂等且每轮可执行
          const didPruneImages = pruneProcessedHistoryImages(activeSession.messages);
          if (didPruneImages) {
            activeSession.agent.replaceMessages(activeSession.messages);
          }

          // 为支持视觉的模型检测并加载 prompt 中引用的图片；图片仅作用于当前 prompt（类 pi 行为）
          const imageResult = await detectAndLoadPromptImages({
            prompt: effectivePrompt,
            workspaceDir: effectiveWorkspace,
            model: params.model,
            existingImages: params.images,
            maxBytes: MAX_IMAGE_BYTES,
            maxDimensionPx: resolveImageSanitizationLimits(params.config).maxDimensionPx,
            workspaceOnly: effectiveFsWorkspaceOnly,
            // 启用沙箱时强制沙箱路径限制
            sandbox:
              sandbox?.enabled && sandbox?.fsBridge
                ? { root: sandbox.workspaceDir, bridge: sandbox.fsBridge }
                : undefined,
          });

          cacheTrace?.recordStage("prompt:images", {
            prompt: effectivePrompt,
            messages: activeSession.messages,
            note: `images: prompt=${imageResult.images.length}`,
          });

          // 诊断：在发 prompt 前打上下文大小日志，便于排查提前溢出
          if (log.isEnabled("debug")) {
            const msgCount = activeSession.messages.length;
            const systemLen = systemPromptText?.length ?? 0;
            const promptLen = effectivePrompt.length;
            const sessionSummary = summarizeSessionContext(activeSession.messages);
            log.debug(
              `[context-diag] pre-prompt: sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `messages=${msgCount} roleCounts=${sessionSummary.roleCounts} ` +
                `historyTextChars=${sessionSummary.totalTextChars} ` +
                `maxMessageTextChars=${sessionSummary.maxMessageTextChars} ` +
                `historyImageBlocks=${sessionSummary.totalImageBlocks} ` +
                `systemPromptChars=${systemLen} promptChars=${promptLen} ` +
                `promptImages=${imageResult.images.length} ` +
                `provider=${params.provider}/${params.modelId} sessionFile=${params.sessionFile}`,
            );
          }

          if (hookRunner?.hasHooks("llm_input")) {
            hookRunner
              .runLlmInput(
                {
                  runId: params.runId,
                  sessionId: params.sessionId,
                  provider: params.provider,
                  model: params.modelId,
                  systemPrompt: systemPromptText,
                  prompt: effectivePrompt,
                  historyMessages: activeSession.messages,
                  imagesCount: imageResult.images.length,
                },
                {
                  agentId: hookAgentId,
                  sessionKey: params.sessionKey,
                  sessionId: params.sessionId,
                  workspaceDir: params.workspaceDir,
                  messageProvider: params.messageProvider ?? undefined,
                },
              )
              .catch((err) => {
                log.warn(`llm_input hook failed: ${String(err)}`);
              });
          }

          // 仅在有图片时传入 images 选项，避免部分模型不接受 images 参数而出错
          if (imageResult.images.length > 0) {
            await abortable(activeSession.prompt(effectivePrompt, { images: imageResult.images }));
          } else {
            await abortable(activeSession.prompt(effectivePrompt));
          }
        } catch (err) {
          promptError = err;
          promptErrorSource = "prompt";
        } finally {
          log.debug(
            `embedded run prompt end: runId=${params.runId} sessionId=${params.sessionId} durationMs=${Date.now() - promptStartedAt}`,
          );
        }

        // 在等待压缩前抓取消息快照，以便超时时能返回完整消息；抓取前后各检查一次 isCompacting，避免抓取期间压缩启动导致竞态
        const wasCompactingBefore = activeSession.isCompacting;
        const snapshot = activeSession.messages.slice();
        const wasCompactingAfter = activeSession.isCompacting;
        // 仅当抓取前后都未在压缩时，才信任该快照
        const preCompactionSnapshot = wasCompactingBefore || wasCompactingAfter ? null : snapshot;
        const preCompactionSessionId = activeSession.sessionId;
        const COMPACTION_RETRY_AGGREGATE_TIMEOUT_MS = 60_000;

        try {
          // 在等待压缩前先刷掉缓存的 block 回复，用户才能立即看到助手回复；否则会等压缩结束（大上下文可达数分钟）(#35074)
          if (params.onBlockReplyFlush) {
            await params.onBlockReplyFlush();
          }

          const compactionRetryWait = await waitForCompactionRetryWithAggregateTimeout({
            waitForCompactionRetry,
            abortable,
            aggregateTimeoutMs: COMPACTION_RETRY_AGGREGATE_TIMEOUT_MS,
            isCompactionStillInFlight: isCompactionInFlight,
          });
          if (compactionRetryWait.timedOut) {
            timedOutDuringCompaction = true;
            if (!isProbeSession) {
              log.warn(
                `compaction retry aggregate timeout (${COMPACTION_RETRY_AGGREGATE_TIMEOUT_MS}ms): ` +
                  `proceeding with pre-compaction state runId=${params.runId} sessionId=${params.sessionId}`,
              );
            }
          }
        } catch (err) {
          if (isRunnerAbortError(err)) {
            if (!promptError) {
              promptError = err;
              promptErrorSource = "compaction";
            }
            if (!isProbeSession) {
              log.debug(
                `compaction wait aborted: runId=${params.runId} sessionId=${params.sessionId}`,
              );
            }
          } else {
            throw err;
          }
        }

        const compactionOccurredThisAttempt = getCompactionCount() > 0;

        // 在 prompt + 压缩重试完成后再追加 cache-TTL 时间戳。此前在 prompt 前追加，会在压缩与下一次 prompt 之间插入 custom entry，
        // 破坏 prepareCompaction() 根据最后一条类型做的判断，导致二次压缩。见 https://github.com/openclaw/openclaw/issues/9282
        // 若在压缩期间超时则跳过，会话状态可能不一致
        if (!timedOutDuringCompaction && !compactionOccurredThisAttempt) {
          const shouldTrackCacheTtl =
            params.config?.agents?.defaults?.contextPruning?.mode === "cache-ttl" &&
            isCacheTtlEligibleProvider(params.provider, params.modelId);
          if (shouldTrackCacheTtl) {
            appendCacheTtlTimestamp(sessionManager, {
              timestamp: Date.now(),
              provider: params.provider,
              modelId: params.modelId,
            });
          }
        }

        // 若超时发生在压缩期间，优先使用压缩前快照（若有）；压缩只重组消息，不增加 user/assistant 轮次
        const snapshotSelection = selectCompactionTimeoutSnapshot({
          timedOutDuringCompaction,
          preCompactionSnapshot,
          preCompactionSessionId,
          currentSnapshot: activeSession.messages.slice(),
          currentSessionId: activeSession.sessionId,
        });
        if (timedOutDuringCompaction) {
          if (!isProbeSession) {
            log.warn(
              `using ${snapshotSelection.source} snapshot: timed out during compaction runId=${params.runId} sessionId=${params.sessionId}`,
            );
          }
        }
        messagesSnapshot = snapshotSelection.messagesSnapshot;
        sessionIdUsed = snapshotSelection.sessionIdUsed;

        if (promptError && promptErrorSource === "prompt" && !compactionOccurredThisAttempt) {
          try {
            sessionManager.appendCustomEntry("openclaw:prompt-error", {
              timestamp: Date.now(),
              runId: params.runId,
              sessionId: params.sessionId,
              provider: params.provider,
              model: params.modelId,
              api: params.model.api,
              error: describeUnknownError(promptError),
            });
          } catch (entryErr) {
            log.warn(`failed to persist prompt error entry: ${String(entryErr)}`);
          }
        }

        // 让当前 context engine 执行本轮后的生命周期
        if (params.contextEngine) {
          const afterTurnRuntimeContext = buildAfterTurnRuntimeContext({
            attempt: params,
            workspaceDir: effectiveWorkspace,
            agentDir,
          });

          if (typeof params.contextEngine.afterTurn === "function") {
            try {
              await params.contextEngine.afterTurn({
                sessionId: sessionIdUsed,
                sessionFile: params.sessionFile,
                messages: messagesSnapshot,
                prePromptMessageCount,
                tokenBudget: params.contextTokenBudget,
                runtimeContext: afterTurnRuntimeContext,
              });
            } catch (afterTurnErr) {
              log.warn(`context engine afterTurn failed: ${String(afterTurnErr)}`);
            }
          } else {
            // 回退：逐条 ingest 新消息
            const newMessages = messagesSnapshot.slice(prePromptMessageCount);
            if (newMessages.length > 0) {
              if (typeof params.contextEngine.ingestBatch === "function") {
                try {
                  await params.contextEngine.ingestBatch({
                    sessionId: sessionIdUsed,
                    messages: newMessages,
                  });
                } catch (ingestErr) {
                  log.warn(`context engine ingest failed: ${String(ingestErr)}`);
                }
              } else {
                for (const msg of newMessages) {
                  try {
                    await params.contextEngine.ingest({
                      sessionId: sessionIdUsed,
                      message: msg,
                    });
                  } catch (ingestErr) {
                    log.warn(`context engine ingest failed: ${String(ingestErr)}`);
                  }
                }
              }
            }
          }
        }

        cacheTrace?.recordStage("session:after", {
          messages: messagesSnapshot,
          note: timedOutDuringCompaction
            ? "compaction timeout"
            : promptError
              ? "prompt error"
              : undefined,
        });
        anthropicPayloadLogger?.recordUsage(messagesSnapshot, promptError);

        // 执行 agent_end 钩子供插件分析会话；fire-and-forget 不 await；压缩超时也执行以便插件打日志/清理
        if (hookRunner?.hasHooks("agent_end")) {
          hookRunner
            .runAgentEnd(
              {
                messages: messagesSnapshot,
                success: !aborted && !promptError,
                error: promptError ? describeUnknownError(promptError) : undefined,
                durationMs: Date.now() - promptStartedAt,
              },
              {
                agentId: hookAgentId,
                sessionKey: params.sessionKey,
                sessionId: params.sessionId,
                workspaceDir: params.workspaceDir,
                messageProvider: params.messageProvider ?? undefined,
              },
            )
            .catch((err) => {
              log.warn(`agent_end hook failed: ${err}`);
            });
        }
      } finally {
        clearTimeout(abortTimer);
        if (abortWarnTimer) {
          clearTimeout(abortWarnTimer);
        }
        if (!isProbeSession && (aborted || timedOut) && !timedOutDuringCompaction) {
          log.debug(
            `run cleanup: runId=${params.runId} sessionId=${params.sessionId} aborted=${aborted} timedOut=${timedOut}`,
          );
        }
        try {
          unsubscribe();
        } catch (err) {
          // unsubscribe() 不应抛错；若抛则视为严重 bug。用 error 级别打日志，但不在 finally 里 rethrow，以免掩盖上方 try 的异常
          log.error(
            `CRITICAL: unsubscribe failed, possible resource leak: runId=${params.runId} ${String(err)}`,
          );
        }
        clearActiveEmbeddedRun(params.sessionId, queueHandle, params.sessionKey);
        params.abortSignal?.removeEventListener?.("abort", onAbort);
      }

      const lastAssistant = messagesSnapshot
        .slice()
        .toReversed()
        .find((m) => m.role === "assistant");

      const toolMetasNormalized = toolMetas
        .filter(
          (entry): entry is { toolName: string; meta?: string } =>
            typeof entry.toolName === "string" && entry.toolName.trim().length > 0,
        )
        .map((entry) => ({ toolName: entry.toolName, meta: entry.meta }));

      if (hookRunner?.hasHooks("llm_output")) {
        hookRunner
          .runLlmOutput(
            {
              runId: params.runId,
              sessionId: params.sessionId,
              provider: params.provider,
              model: params.modelId,
              assistantTexts,
              lastAssistant,
              usage: getUsageTotals(),
            },
            {
              agentId: hookAgentId,
              sessionKey: params.sessionKey,
              sessionId: params.sessionId,
              workspaceDir: params.workspaceDir,
              messageProvider: params.messageProvider ?? undefined,
            },
          )
          .catch((err) => {
            log.warn(`llm_output hook failed: ${String(err)}`);
          });
      }

      return {
        aborted,
        timedOut,
        timedOutDuringCompaction,
        promptError,
        sessionIdUsed,
        bootstrapPromptWarningSignaturesSeen: bootstrapPromptWarning.warningSignaturesSeen,
        bootstrapPromptWarningSignature: bootstrapPromptWarning.signature,
        systemPromptReport,
        messagesSnapshot,
        assistantTexts,
        toolMetas: toolMetasNormalized,
        lastAssistant,
        lastToolError: getLastToolError?.(),
        didSendViaMessagingTool: didSendViaMessagingTool(),
        messagingToolSentTexts: getMessagingToolSentTexts(),
        messagingToolSentMediaUrls: getMessagingToolSentMediaUrls(),
        messagingToolSentTargets: getMessagingToolSentTargets(),
        successfulCronAdds: getSuccessfulCronAdds(),
        cloudCodeAssistFormatError: Boolean(
          lastAssistant?.errorMessage && isCloudCodeAssistFormatError(lastAssistant.errorMessage),
        ),
        attemptUsage: getUsageTotals(),
        compactionCount: getCompactionCount(),
        // 检测到客户端工具调用（OpenResponses 托管工具）
        clientToolCall: clientToolCallDetected ?? undefined,
      };
    } finally {
      // 离开本次 attempt 前务必销毁 session 并释放锁。
      //
      // BUGFIX：在 flush 待处理 tool result 前先等待 agent 真正空闲。pi-agent-core 的自动重试在收到 assistant 消息时就 resolve waitForRetry()，
      // 早于重试循环内工具执行完成。若不等待就 flush，会在工具仍在执行时插入“缺少 tool result”的合成错误，导致静默失败。
      // 见 https://github.com/openclaw/openclaw/issues/8643
      removeToolResultContextGuard?.();
      await flushPendingToolResultsAfterIdle({
        agent: session?.agent,
        sessionManager,
        clearPendingOnTimeout: true,
      });
      session?.dispose();
      releaseWsSession(params.sessionId);
      await sessionLock.release();
    }
  } finally {
    restoreSkillEnv?.();
    process.chdir(prevCwd);
  }
}
