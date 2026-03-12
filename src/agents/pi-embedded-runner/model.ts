/**
 * ============================================================================
 * 模型解析模块 (Model Resolution Module)
 * ============================================================================
 *
 * 【模块概述】
 * 本模块是 OpenClaw Agent 系统的核心组件之一，负责根据 provider（提供商）和 modelId（模型标识符）
 * 从多个数据源中解析并构建可用的 AI 模型配置。
 *
 * 【主要职责】
 * 1. 模型发现与解析：从本地目录、配置文件、模型注册表中查找模型定义
 * 2. 认证存储管理：发现并关联模型所需的认证信息（API 密钥等）
 * 3. 配置合并与覆盖：支持多层配置的优先级合并（发现的模型 < 提供商配置 < 模型配置）
 * 4. 兼容性处理：支持 forward-compat 回退机制，确保新模型在旧配置下也能工作
 * 5. 透传代理支持：特殊处理 OpenRouter 等透传代理，允许使用未预注册的模型
 *
 * 【数据源优先级】（从高到低）
 * 1. 模型注册表 (ModelRegistry) - 来自 models.json 的预定义模型
 * 2. 内联配置 (Inline Config) - 来自 config.models.providers 的用户自定义模型
 * 3. Forward-compat 回退 - 基于模型 ID 模式的智能匹配
 * 4. OpenRouter 透传 - 任意 OpenRouter 支持的模型
 * 5. 提供商默认配置 - 当提供商已配置但模型未注册时的兜底
 *
 * 【典型使用场景】
 * - 用户请求使用 "openai/gpt-4" 模型
 * - 系统配置了自定义的本地 Ollama 模型
 * - 通过 OpenRouter 访问任意第三方模型
 * - 新版本模型在旧配置文件中的自动兼容
 *
 * 【相关模块】
 * - pi-model-discovery: 模型发现逻辑
 * - model-selection: 提供商 ID 标准化
 * - model-forward-compat: 前向兼容回退逻辑
 * - model-auth-markers: 认证标记处理
 */

// ============================================================================
// 类型导入
// ============================================================================

// 从 pi-ai 库导入核心类型
// Api: API 协议类型（如 openai-completions, anthropic-messages 等）
// Model: 模型配置的完整类型定义，包含 id, name, api, baseUrl, contextWindow 等
import type { Api, Model } from "@mariozechner/pi-ai";
// 从 pi-coding-agent 库导入存储和注册表类型
// AuthStorage: 认证信息存储接口，管理各提供商的 API 密钥
// ModelRegistry: 模型注册表接口，提供模型查找和枚举功能
import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
// 导入 OpenClaw 配置类型，包含用户的完整配置信息
import type { OpenClawConfig } from "../../config/config.js";
// 导入模型定义配置类型，用于描述单个模型的配置结构
import type { ModelDefinitionConfig } from "../../config/types.js";
// ============================================================================
// 功能模块导入
// ============================================================================
// 解析 OpenClaw Agent 的工作目录路径
// 默认为 ~/.openclaw/agents/<agentId>，存放模型配置、认证信息等
import { resolveOpenClawAgentDir } from "../agent-paths.js";
// 默认的上下文窗口大小（token 数量）
// 当模型配置中未指定 contextWindow 时使用此默认值
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
// 构建模型别名行的工具函数
// 用于生成用户友好的模型别名显示（如 "gpt4 -> openai/gpt-4"）
import { buildModelAliasLines } from "../model-alias-lines.js";
// 检测 HTTP 头部值是否为 secret-ref 占位符标记
// secret-ref 格式如 "${{secret:API_KEY}}"，用于延迟解析敏感信息
import { isSecretRefHeaderValueMarker } from "../model-auth-markers.js";
// 前向兼容模型解析函数
// 当精确匹配失败时，尝试基于模型 ID 模式进行智能回退匹配
import { resolveForwardCompatModel } from "../model-forward-compat.js";
// 提供商 ID 标准化工具函数
// findNormalizedProviderValue: 在配置对象中查找标准化后的提供商配置
// normalizeProviderId: 将提供商 ID 转换为标准格式（小写、去除特殊字符等）
import { findNormalizedProviderValue, normalizeProviderId } from "../model-selection.js";
// 模型发现函数
// discoverAuthStorage: 从指定目录发现并加载认证存储
// discoverModels: 基于认证存储发现可用的模型注册表
import { discoverAuthStorage, discoverModels } from "../pi-model-discovery.js";
// 提供商特定的模型标准化函数
// 处理不同提供商的特殊配置需求（如特定的 baseUrl 格式）
import { normalizeResolvedProviderModel } from "./model.provider-normalization.js";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 内联模型条目类型
 *
 * 表示从用户配置中解析出的单个模型定义，扩展了基础的 ModelDefinitionConfig，
 * 添加了运行时必需的字段。
 *
 * 【使用场景】
 * 当用户在配置文件中定义自定义提供商和模型时，如：
 * ```yaml
 * models:
 *   providers:
 *     my-llm:
 *       baseUrl: "http://localhost:8080/v1"
 *       models:
 *         - id: "my-model"
 *           api: "openai-completions"
 * ```
 * 这些配置会被解析为 InlineModelEntry 数组
 */
type InlineModelEntry = ModelDefinitionConfig & {
  /** 提供商标识符，如 "openai", "anthropic", "my-llm" */
  provider: string;
  /** 可选的 API 基础 URL，用于自定义端点或本地部署 */
  baseUrl?: string;
  /** 可选的自定义 HTTP 头部，用于认证或其他目的 */
  headers?: Record<string, string>;
};

/**
 * 内联提供商配置类型
 *
 * 表示用户在配置文件中定义的提供商级别配置。
 * 提供商配置可以包含多个模型，并设置共享的 baseUrl、api 类型和 headers。
 *
 * 【配置示例】
 * ```yaml
 * models:
 *   providers:
 *     azure-openai:           # 提供商 ID
 *       baseUrl: "https://my-azure.openai.azure.com/openai/deployments"
 *       api: "openai-completions"
 *       headers:
 *         api-key: "${AZURE_API_KEY}"
 *       models:
 *         - id: "gpt-4-deployment"
 *           contextWindow: 128000
 *         - id: "gpt-35-deployment"
 *           contextWindow: 16000
 * ```
 */
type InlineProviderConfig = {
  /** 提供商级别的 API 基础 URL，所有模型共享 */
  baseUrl?: string;
  /** 提供商级别的 API 协议类型，模型可覆盖 */
  api?: ModelDefinitionConfig["api"];
  /** 该提供商下的模型列表 */
  models?: ModelDefinitionConfig[];
  /** 提供商级别的 HTTP 头部，所有模型共享，模型级头部可覆盖 */
  headers?: unknown;
};

// ============================================================================
// 内部工具函数
// ============================================================================

/**
 * 清理和标准化模型的 HTTP 头部配置
 *
 * 【功能说明】
 * 将配置中的 headers 对象转换为干净的键值对格式，并可选地移除
 * secret-ref 占位符标记，防止敏感信息泄露到运行时日志或错误消息中。
 *
 * 【处理逻辑】
 * 1. 验证输入：确保 headers 是一个非数组的对象
 * 2. 遍历所有键值对：
 *    - 跳过非字符串类型的值
 *    - 如果启用了 stripSecretRefMarkers，跳过 secret-ref 占位符
 * 3. 返回清理后的对象，如果为空则返回 undefined
 *
 * 【Secret-Ref 占位符】
 * 格式示例: "${{secret:API_KEY}}" 或 "${{env:OPENAI_API_KEY}}"
 * 这些占位符用于延迟解析敏感信息，在实际 API 调用时才替换为真实值。
 * 在模型发现阶段，我们需要移除这些占位符以避免：
 * - 将占位符字符串误传给 API
 * - 在错误日志中暴露占位符格式
 *
 * @param headers - 原始的 headers 配置，可能是任意类型
 * @param opts - 可选配置
 * @param opts.stripSecretRefMarkers - 是否移除 secret-ref 占位符标记
 *
 * @returns 清理后的 headers 对象，或 undefined（如果输入无效或结果为空）
 *
 * @example
 * // 基本使用
 * sanitizeModelHeaders({ "Content-Type": "application/json", "X-Custom": 123 })
 * // 返回: { "Content-Type": "application/json" }  // 非字符串值被过滤
 *
 * @example
 * // 移除 secret-ref 标记
 * sanitizeModelHeaders(
 *   { "Authorization": "${{secret:API_KEY}}", "X-Version": "v1" },
 *   { stripSecretRefMarkers: true }
 * )
 * // 返回: { "X-Version": "v1" }  // secret-ref 被移除
 */
function sanitizeModelHeaders(
  headers: unknown,
  opts?: { stripSecretRefMarkers?: boolean },
): Record<string, string> | undefined {
  // 验证输入类型：必须是非空、非数组的对象
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return undefined;
  }

  // 构建清理后的 headers 对象
  const next: Record<string, string> = {};

  for (const [headerName, headerValue] of Object.entries(headers)) {
    // 跳过非字符串类型的值（如数字、布尔值、对象等）
    if (typeof headerValue !== "string") {
      continue;
    }

    // 如果启用了 secret-ref 移除选项，跳过占位符标记
    // 这防止了 "${{secret:...}}" 格式的字符串被传递到运行时
    if (opts?.stripSecretRefMarkers && isSecretRefHeaderValueMarker(headerValue)) {
      continue;
    }

    next[headerName] = headerValue;
  }

  // 如果没有有效的 header，返回 undefined 而不是空对象
  // 这使得后续的对象展开 (...headers) 更加安全
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * 标准化已解析的模型配置
 *
 * 【功能说明】
 * 对解析出的模型配置进行最终的标准化处理，确保不同提供商的模型配置
 * 符合统一的运行时格式。这是模型解析流程的最后一步。
 *
 * 【委托处理】
 * 实际的标准化逻辑委托给 normalizeResolvedProviderModel 函数，
 * 该函数会根据不同提供商的特殊需求进行处理，例如：
 * - 调整 baseUrl 格式
 * - 设置提供商特定的默认值
 * - 处理 API 版本兼容性
 *
 * @param params - 标准化参数
 * @param params.provider - 提供商标识符
 * @param params.model - 待标准化的模型配置
 *
 * @returns 标准化后的模型配置
 */
function normalizeResolvedModel(params: { provider: string; model: Model<Api> }): Model<Api> {
  return normalizeResolvedProviderModel(params);
}

// 重新导出 buildModelAliasLines 函数供外部使用
// 这允许其他模块通过本模块访问模型别名构建功能
export { buildModelAliasLines };

/**
 * 从用户配置中解析指定提供商的配置
 *
 * 【功能说明】
 * 在用户的 OpenClaw 配置文件中查找指定提供商的配置信息。
 * 支持精确匹配和标准化匹配两种模式。
 *
 * 【查找优先级】
 * 1. 精确匹配：直接使用 provider 作为键查找
 * 2. 标准化匹配：将 provider 标准化后再查找（处理大小写、别名等）
 *
 * 【配置结构示例】
 * ```yaml
 * # 用户配置文件 (~/.openclaw/config.yaml)
 * models:
 *   providers:
 *     openai:                    # 精确匹配 "openai"
 *       baseUrl: "https://api.openai.com/v1"
 *     Azure-OpenAI:              # 标准化后匹配 "azure-openai"
 *       baseUrl: "https://my-instance.azure.com"
 * ```
 *
 * @param cfg - OpenClaw 配置对象，可能为 undefined
 * @param provider - 要查找的提供商标识符
 *
 * @returns 找到的提供商配置，或 undefined（如果未找到）
 *
 * @example
 * // 精确匹配
 * resolveConfiguredProviderConfig(cfg, "openai")
 * // 返回 cfg.models.providers.openai
 *
 * @example
 * // 标准化匹配（大小写不敏感）
 * resolveConfiguredProviderConfig(cfg, "OpenAI")
 * // 如果存在 cfg.models.providers.openai，返回该配置
 */
function resolveConfiguredProviderConfig(
  cfg: OpenClawConfig | undefined,
  provider: string,
): InlineProviderConfig | undefined {
  // 获取用户配置中的 providers 部分
  const configuredProviders = cfg?.models?.providers;

  // 如果没有配置任何提供商，直接返回 undefined
  if (!configuredProviders) {
    return undefined;
  }

  // 首先尝试精确匹配（性能最优，且尊重用户的精确配置）
  const exactProviderConfig = configuredProviders[provider];
  if (exactProviderConfig) {
    return exactProviderConfig;
  }

  // 精确匹配失败，尝试标准化匹配
  // findNormalizedProviderValue 会将 provider 和配置键都标准化后比较
  // 这允许 "OpenAI" 匹配 "openai"，"azure_openai" 匹配 "azure-openai" 等
  return findNormalizedProviderValue(configuredProviders, provider);
}

/**
 * 将用户配置的覆盖项应用到已发现的模型上
 *
 * 【功能说明】
 * 这是配置合并的核心函数。当从模型注册表中发现一个模型后，
 * 需要将用户在配置文件中指定的覆盖项（如自定义 baseUrl、headers 等）
 * 合并到该模型配置中。
 *
 * 【配置优先级】（从低到高）
 * 1. discoveredModel - 来自 models.json 的基础模型定义
 * 2. providerConfig - 用户配置的提供商级别设置
 * 3. configuredModel - 用户配置的模型级别设置
 *
 * 较高优先级的配置会覆盖较低优先级的同名属性。
 *
 * 【Headers 合并策略】
 * Headers 采用三层合并策略：
 * ```
 * 最终 headers = {
 *   ...discoveredHeaders,    // 来自 models.json（已移除 secret-ref）
 *   ...providerHeaders,      // 来自用户配置的提供商级别
 *   ...configuredHeaders,    // 来自用户配置的模型级别
 * }
 * ```
 * 后面的 headers 会覆盖前面的同名 header。
 *
 * 【使用场景示例】
 * ```yaml
 * # 用户配置
 * models:
 *   providers:
 *     openai:
 *       baseUrl: "https://my-proxy.com/v1"  # 覆盖默认的 openai baseUrl
 *       headers:
 *         X-Custom-Header: "value"
 *       models:
 *         - id: "gpt-4"
 *           maxTokens: 4096                  # 覆盖默认的 maxTokens
 * ```
 *
 * @param params - 合并参数
 * @param params.discoveredModel - 从模型注册表发现的基础模型配置
 * @param params.providerConfig - 用户配置的提供商级别设置（可选）
 * @param params.modelId - 模型标识符，用于在 providerConfig.models 中查找
 *
 * @returns 合并后的完整模型配置
 */
function applyConfiguredProviderOverrides(params: {
  discoveredModel: Model<Api>;
  providerConfig?: InlineProviderConfig;
  modelId: string;
}): Model<Api> {
  const { discoveredModel, providerConfig, modelId } = params;

  // ============================================================================
  // 情况 1: 没有用户配置的覆盖项
  // ============================================================================
  // 直接返回发现的模型，但需要清理 headers 中的 secret-ref 标记
  // 这些标记来自 models.json，是持久化存储的占位符
  if (!providerConfig) {
    return {
      ...discoveredModel,
      // 从 models.json 发现的模型可能包含持久化的 secret-ref 标记
      // 需要在运行时移除这些标记，实际的认证信息由 AuthStorage 管理
      headers: sanitizeModelHeaders(discoveredModel.headers, { stripSecretRefMarkers: true }),
    };
  }

  // ============================================================================
  // 情况 2: 存在用户配置，进行多层合并
  // ============================================================================

  // 在用户配置的模型列表中查找当前模型的特定配置
  const configuredModel = providerConfig.models?.find((candidate) => candidate.id === modelId);

  // 分层清理和提取 headers
  // 发现的 headers：需要移除 secret-ref 标记
  const discoveredHeaders = sanitizeModelHeaders(discoveredModel.headers, {
    stripSecretRefMarkers: true,
  });
  // 提供商级别的 headers：用户配置，不需要移除 secret-ref（用户明确指定）
  const providerHeaders = sanitizeModelHeaders(providerConfig.headers);
  // 模型级别的 headers：用户配置，不需要移除 secret-ref
  const configuredHeaders = sanitizeModelHeaders(configuredModel?.headers);

  // ============================================================================
  // 优化路径: 用户配置没有实质性内容
  // ============================================================================
  // 如果用户的提供商配置中没有特定模型配置，也没有 baseUrl、api 或 headers，
  // 说明用户只是声明了提供商但没有进行任何覆盖，直接返回清理后的发现模型
  if (!configuredModel && !providerConfig.baseUrl && !providerConfig.api && !providerHeaders) {
    return {
      ...discoveredModel,
      headers: discoveredHeaders,
    };
  }

  // ============================================================================
  // 完整合并: 按优先级合并所有配置
  // ============================================================================
  return {
    // 基础: 从 models.json 发现的模型配置
    ...discoveredModel,

    // API 协议类型: 模型配置 > 提供商配置 > 发现的默认值
    api: configuredModel?.api ?? providerConfig.api ?? discoveredModel.api,

    // API 基础 URL: 提供商配置 > 发现的默认值
    // 注意: 这里没有模型级别的 baseUrl，因为同一提供商的所有模型通常共享 baseUrl
    baseUrl: providerConfig.baseUrl ?? discoveredModel.baseUrl,

    // 推理能力标记: 模型配置 > 发现的默认值
    reasoning: configuredModel?.reasoning ?? discoveredModel.reasoning,

    // 支持的输入类型: 模型配置 > 发现的默认值
    // 例如: ["text"], ["text", "image"], ["text", "image", "audio"]
    input: configuredModel?.input ?? discoveredModel.input,

    // 成本配置: 模型配置 > 发现的默认值
    // 包含每 token 的输入/输出成本，用于使用量统计
    cost: configuredModel?.cost ?? discoveredModel.cost,

    // 上下文窗口大小: 模型配置 > 发现的默认值
    // 表示模型能处理的最大 token 数量
    contextWindow: configuredModel?.contextWindow ?? discoveredModel.contextWindow,

    // 最大输出 token 数: 模型配置 > 发现的默认值
    maxTokens: configuredModel?.maxTokens ?? discoveredModel.maxTokens,

    // Headers 三层合并: 发现的 + 提供商级 + 模型级
    // 后面的会覆盖前面的同名 header
    headers:
      discoveredHeaders || providerHeaders || configuredHeaders
        ? {
            ...discoveredHeaders,
            ...providerHeaders,
            ...configuredHeaders,
          }
        : undefined,

    // 兼容性配置: 模型配置 > 发现的默认值
    // 用于处理特定模型的 API 兼容性问题
    compat: configuredModel?.compat ?? discoveredModel.compat,
  };
}

/**
 * 从用户配置构建扁平化的内联模型列表
 *
 * 【功能说明】
 * 将用户在 config.models.providers 中定义的嵌套提供商/模型结构，
 * 转换为扁平的模型条目数组。这使得后续的模型查找更加高效。
 *
 * 【使用场景】
 * 当用户配置了自定义提供商（如本地 LLM 服务器），但这些模型未在
 * 全局的 models.json 中注册时，需要从用户配置中构建模型列表。
 *
 * 【输入结构示例】
 * ```yaml
 * models:
 *   providers:
 *     local-llm:
 *       baseUrl: "http://localhost:8080/v1"
 *       api: "openai-completions"
 *       headers:
 *         Authorization: "Bearer local-token"
 *       models:
 *         - id: "llama-7b"
 *           contextWindow: 4096
 *         - id: "llama-13b"
 *           contextWindow: 8192
 *           headers:
 *             X-Model-Version: "v2"
 * ```
 *
 * 【输出结构】
 * ```javascript
 * [
 *   {
 *     id: "llama-7b",
 *     provider: "local-llm",
 *     baseUrl: "http://localhost:8080/v1",
 *     api: "openai-completions",
 *     contextWindow: 4096,
 *     headers: { Authorization: "Bearer local-token" }
 *   },
 *   {
 *     id: "llama-13b",
 *     provider: "local-llm",
 *     baseUrl: "http://localhost:8080/v1",
 *     api: "openai-completions",
 *     contextWindow: 8192,
 *     headers: {
 *       Authorization: "Bearer local-token",  // 继承自提供商
 *       "X-Model-Version": "v2"               // 模型级别覆盖
 *     }
 *   }
 * ]
 * ```
 *
 * 【Headers 继承规则】
 * 模型级别的 headers 会继承并可能覆盖提供商级别的 headers：
 * ```
 * 最终 headers = { ...providerHeaders, ...modelHeaders }
 * ```
 *
 * @param providers - 用户配置的提供商映射表 (providerId -> InlineProviderConfig)
 *
 * @returns 扁平化的模型条目数组，每个条目包含完整的运行时配置
 */
export function buildInlineProviderModels(
  providers: Record<string, InlineProviderConfig>,
): InlineModelEntry[] {
  // 使用 flatMap 将嵌套的 providers -> models 结构展平
  return Object.entries(providers).flatMap(([providerId, entry]) => {
    // 清理提供商 ID，移除首尾空白
    const trimmed = providerId.trim();

    // 跳过空的提供商 ID（可能是配置错误）
    if (!trimmed) {
      return [];
    }

    // 提取并清理提供商级别的 headers
    const providerHeaders = sanitizeModelHeaders(entry?.headers);

    // 将该提供商下的每个模型转换为完整的 InlineModelEntry
    return (entry?.models ?? []).map((model) => ({
      // 展开模型的原始配置（id, contextWindow, maxTokens 等）
      ...model,

      // 添加提供商标识符
      provider: trimmed,

      // 继承提供商的 baseUrl（模型级别通常不单独设置 baseUrl）
      baseUrl: entry?.baseUrl,

      // API 协议: 模型配置优先，否则使用提供商配置
      api: model.api ?? entry?.api,

      // Headers 合并: 使用 IIFE 进行条件合并
      headers: (() => {
        // 提取并清理模型级别的 headers
        const modelHeaders = sanitizeModelHeaders((model as InlineModelEntry).headers);

        // 如果两个级别都没有 headers，返回 undefined
        if (!providerHeaders && !modelHeaders) {
          return undefined;
        }

        // 合并 headers: 提供商级别为基础，模型级别覆盖
        return {
          ...providerHeaders,
          ...modelHeaders,
        };
      })(),
    }));
  });
}

/**
 * 使用已有的模型注册表解析 provider/modelId
 *
 * 【功能说明】
 * 这是模型解析的核心函数，实现了多层回退的模型查找策略。
 * 当用户请求使用特定的 provider/modelId 组合时，本函数会按优先级
 * 尝试多种数据源，确保尽可能找到可用的模型配置。
 *
 * 【解析优先级】（按顺序尝试）
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ 优先级 1: 模型注册表 (ModelRegistry)                                    │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ 来源: models.json 预定义 + 运行时发现                                   │
 * │ 特点: 最完整的模型信息，包含精确的 contextWindow、cost 等               │
 * │ 示例: openai/gpt-4, anthropic/claude-3-sonnet                          │
 * └─────────────────────────────────────────────────────────────────────────┘
 *                                    ↓ 未找到
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ 优先级 2: 内联配置 (Inline Config)                                      │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ 来源: 用户配置文件 config.models.providers                              │
 * │ 特点: 用户自定义的模型，必须指定 api 类型                               │
 * │ 示例: local-llm/llama-7b, my-proxy/custom-model                        │
 * └─────────────────────────────────────────────────────────────────────────┘
 *                                    ↓ 未找到
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ 优先级 3: 前向兼容回退 (Forward-Compat)                                 │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ 来源: 基于模型 ID 模式的智能匹配                                        │
 * │ 特点: 允许新模型在旧配置下工作（如 gpt-4-turbo-preview 回退到 gpt-4）  │
 * │ 示例: openai/gpt-4-0125-preview → 使用 gpt-4 的配置                    │
 * └─────────────────────────────────────────────────────────────────────────┘
 *                                    ↓ 未找到
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ 优先级 4: OpenRouter 透传                                               │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ 条件: provider 为 "openrouter"                                         │
 * │ 特点: OpenRouter 是透传代理，支持任意 OpenRouter 上可用的模型           │
 * │ 示例: openrouter/anthropic/claude-3-opus                               │
 * └─────────────────────────────────────────────────────────────────────────┘
 *                                    ↓ 未找到
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ 优先级 5: 提供商默认配置 / Mock 模型                                    │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ 条件: 提供商已配置 或 模型 ID 以 "mock-" 开头                          │
 * │ 特点: 使用提供商的默认 API 和 baseUrl 构建最小可用配置                  │
 * │ 示例: my-provider/any-model, mock-provider/mock-model                  │
 * └─────────────────────────────────────────────────────────────────────────┘
 *                                    ↓ 未找到
 *                              返回 undefined
 *
 * @param params - 解析参数
 * @param params.provider - 提供商标识符 (如 "openai", "anthropic", "local-llm")
 * @param params.modelId - 模型标识符 (如 "gpt-4", "claude-3-sonnet", "llama-7b")
 * @param params.modelRegistry - 已初始化的模型注册表
 * @param params.cfg - OpenClaw 配置对象（可选）
 *
 * @returns 解析成功时返回完整的模型配置，否则返回 undefined
 */
export function resolveModelWithRegistry(params: {
  provider: string;
  modelId: string;
  modelRegistry: ModelRegistry;
  cfg?: OpenClawConfig;
}): Model<Api> | undefined {
  const { provider, modelId, modelRegistry, cfg } = params;

  // 预先获取用户配置的提供商设置，后续多个分支都会用到
  const providerConfig = resolveConfiguredProviderConfig(cfg, provider);

  // ============================================================================
  // 优先级 1: 从模型注册表查找
  // ============================================================================
  // 模型注册表包含 models.json 中的预定义模型和运行时发现的模型
  // 这是最可靠的数据源，包含完整的模型元数据
  const model = modelRegistry.find(provider, modelId) as Model<Api> | null;

  if (model) {
    // 找到模型后，应用用户配置的覆盖项并标准化
    return normalizeResolvedModel({
      provider,
      model: applyConfiguredProviderOverrides({
        discoveredModel: model,
        providerConfig,
        modelId,
      }),
    });
  }

  // ============================================================================
  // 优先级 2: 从内联配置查找
  // ============================================================================
  // 用户可能在配置文件中定义了自定义提供商和模型
  // 这些模型不在全局的 models.json 中，但有完整的 API 配置
  const providers = cfg?.models?.providers ?? {};
  const inlineModels = buildInlineProviderModels(providers);

  // 标准化提供商 ID 以支持大小写不敏感的匹配
  const normalizedProvider = normalizeProviderId(provider);

  // 在内联模型列表中查找匹配项
  const inlineMatch = inlineModels.find(
    (entry) => normalizeProviderId(entry.provider) === normalizedProvider && entry.id === modelId,
  );

  // 只有当内联模型指定了 api 类型时才认为是有效配置
  // 没有 api 类型的配置无法确定如何与模型通信
  if (inlineMatch?.api) {
    return normalizeResolvedModel({ provider, model: inlineMatch as Model<Api> });
  }

  // ============================================================================
  // 优先级 3: 前向兼容回退
  // ============================================================================
  // 重要: 前向兼容检查必须在通用提供商配置回退之前进行！
  // 原因: 如果先使用通用提供商配置，可能会给新模型分配错误的 API 类型，
  // 导致特定的传输协议被破坏。
  //
  // 前向兼容的工作原理:
  // - 新发布的模型（如 gpt-4-turbo-2024-04-09）可能还没有被添加到 models.json
  // - 但这些模型通常与已知模型（如 gpt-4）兼容
  // - resolveForwardCompatModel 会基于模型 ID 的模式进行智能匹配
  const forwardCompat = resolveForwardCompatModel(provider, modelId, modelRegistry);

  if (forwardCompat) {
    return normalizeResolvedModel({
      provider,
      model: applyConfiguredProviderOverrides({
        discoveredModel: forwardCompat,
        providerConfig,
        modelId,
      }),
    });
  }

  // ============================================================================
  // 优先级 4: OpenRouter 透传代理
  // ============================================================================
  // OpenRouter 是一个特殊的透传代理服务，它聚合了多个 AI 提供商的模型
  // 任何在 OpenRouter 上可用的模型都应该能够工作，无需预先注册到本地目录
  //
  // OpenRouter 的特点:
  // - 统一的 API 端点: https://openrouter.ai/api/v1
  // - 使用 OpenAI 兼容的 API 格式
  // - 模型 ID 可以是任意 OpenRouter 支持的格式（如 "anthropic/claude-3-opus"）
  if (normalizedProvider === "openrouter") {
    return normalizeResolvedModel({
      provider,
      model: {
        id: modelId,
        name: modelId,
        api: "openai-completions", // OpenRouter 使用 OpenAI 兼容 API
        provider,
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: false, // 保守默认值，推理能力由实际模型决定
        input: ["text"], // 默认支持文本输入
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // 成本未知，设为 0
        contextWindow: DEFAULT_CONTEXT_TOKENS,
        // maxTokens 与 models-config.providers.ts 中的 OPENROUTER_DEFAULT_MAX_TOKENS 保持一致
        maxTokens: 8192,
      } as Model<Api>,
    });
  }

  // ============================================================================
  // 优先级 5: 提供商默认配置 / Mock 模型兜底
  // ============================================================================
  // 当以上所有查找都失败时，如果满足以下条件之一，仍然尝试构建可用配置:
  // 1. 提供商已在用户配置中注册（即使该特定模型未注册）
  // 2. 模型 ID 以 "mock-" 开头（用于测试目的）
  //
  // 这个兜底逻辑允许:
  // - 用户配置一个提供商后，使用该提供商的任意模型
  // - 测试代码使用 mock 模型而无需预先注册
  const configuredModel = providerConfig?.models?.find((candidate) => candidate.id === modelId);
  const providerHeaders = sanitizeModelHeaders(providerConfig?.headers);
  const modelHeaders = sanitizeModelHeaders(configuredModel?.headers);

  if (providerConfig || modelId.startsWith("mock-")) {
    return normalizeResolvedModel({
      provider,
      model: {
        id: modelId,
        name: modelId,
        // API 类型: 优先使用提供商配置，否则默认使用 openai-responses
        // openai-responses 是最通用的 API 格式，大多数提供商都兼容
        api: providerConfig?.api ?? "openai-responses",
        provider,
        baseUrl: providerConfig?.baseUrl,
        reasoning: configuredModel?.reasoning ?? false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        // 上下文窗口: 模型配置 > 提供商第一个模型的配置 > 默认值
        contextWindow:
          configuredModel?.contextWindow ??
          providerConfig?.models?.[0]?.contextWindow ??
          DEFAULT_CONTEXT_TOKENS,
        // 最大输出 token: 同上的优先级
        maxTokens:
          configuredModel?.maxTokens ??
          providerConfig?.models?.[0]?.maxTokens ??
          DEFAULT_CONTEXT_TOKENS,
        headers:
          providerHeaders || modelHeaders ? { ...providerHeaders, ...modelHeaders } : undefined,
      } as Model<Api>,
    });
  }

  // 所有查找策略都失败，返回 undefined
  // 调用方应该处理这种情况并显示适当的错误信息
  return undefined;
}

// ============================================================================
// 公开 API 函数
// ============================================================================

/**
 * 完整的模型解析入口函数
 *
 * 【功能说明】
 * 这是模型解析的最高层入口函数，负责:
 * 1. 初始化认证存储 (AuthStorage) - 管理各提供商的 API 密钥
 * 2. 初始化模型注册表 (ModelRegistry) - 可用模型的目录
 * 3. 执行模型解析 - 查找并构建模型配置
 * 4. 错误处理 - 当模型未找到时生成有帮助的错误信息
 *
 * 【与 resolveModelWithRegistry 的区别】
 * - resolveModel: 自动发现 authStorage 和 modelRegistry，是完整的端到端流程
 * - resolveModelWithRegistry: 需要外部提供 modelRegistry，适合批量操作或自定义场景
 *
 * 【典型调用场景】
 * ```typescript
 * // Agent 启动时解析默认模型
 * const result = resolveModel("openai", "gpt-4");
 * if (result.error) {
 *   console.error(result.error);
 *   return;
 * }
 * const { model, authStorage, modelRegistry } = result;
 * ```
 *
 * 【返回值说明】
 * 函数总是返回 authStorage 和 modelRegistry，即使模型解析失败。
 * 这允许调用方在错误处理中使用这些对象（如列出可用模型）。
 *
 * @param provider - 提供商标识符 (如 "openai", "anthropic")
 * @param modelId - 模型标识符 (如 "gpt-4", "claude-3-sonnet")
 * @param agentDir - Agent 工作目录路径（可选，默认使用标准路径 ~/.openclaw/agents/<id>）
 * @param cfg - OpenClaw 配置对象（可选）
 *
 * @returns 包含以下字段的对象:
 *   - model: 解析成功时的模型配置，失败时为 undefined
 *   - error: 解析失败时的错误信息，成功时为 undefined
 *   - authStorage: 认证存储实例（总是返回）
 *   - modelRegistry: 模型注册表实例（总是返回）
 *
 * @example
 * // 成功场景
 * const result = resolveModel("openai", "gpt-4");
 * // result = {
 * //   model: { id: "gpt-4", api: "openai-completions", ... },
 * //   error: undefined,
 * //   authStorage: AuthStorage {...},
 * //   modelRegistry: ModelRegistry {...}
 * // }
 *
 * @example
 * // 失败场景 - 未知模型
 * const result = resolveModel("openai", "gpt-999");
 * // result = {
 * //   model: undefined,
 * //   error: "Unknown model: openai/gpt-999",
 * //   authStorage: AuthStorage {...},
 * //   modelRegistry: ModelRegistry {...}
 * // }
 *
 * @example
 * // 失败场景 - 本地提供商未配置
 * const result = resolveModel("ollama", "llama2");
 * // result = {
 * //   model: undefined,
 * //   error: "Unknown model: ollama/llama2. Ollama requires authentication...",
 * //   authStorage: AuthStorage {...},
 * //   modelRegistry: ModelRegistry {...}
 * // }
 */
export function resolveModel(
  provider: string,
  modelId: string,
  agentDir?: string,
  cfg?: OpenClawConfig,
): {
  model?: Model<Api>;
  error?: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
} {
  // ============================================================================
  // 步骤 1: 确定 Agent 工作目录
  // ============================================================================
  // 如果未指定 agentDir，使用默认的 OpenClaw Agent 目录
  // 默认路径通常是 ~/.openclaw/agents/<agentId>
  const resolvedAgentDir = agentDir ?? resolveOpenClawAgentDir();

  // ============================================================================
  // 步骤 2: 发现认证存储
  // ============================================================================
  // AuthStorage 管理各提供商的 API 密钥和认证信息
  // 它从以下位置收集认证配置:
  // - 环境变量 (如 OPENAI_API_KEY)
  // - 配置文件 (如 ~/.openclaw/credentials/)
  // - Agent 目录中的本地配置
  const authStorage = discoverAuthStorage(resolvedAgentDir);

  // ============================================================================
  // 步骤 3: 发现模型注册表
  // ============================================================================
  // ModelRegistry 是可用模型的目录，包含:
  // - 预定义模型 (来自 models.json)
  // - 基于 authStorage 动态发现的模型 (如有 API 密钥的提供商的所有模型)
  const modelRegistry = discoverModels(authStorage, resolvedAgentDir);

  // ============================================================================
  // 步骤 4: 执行模型解析
  // ============================================================================
  // 使用已初始化的 modelRegistry 进行多层回退查找
  const model = resolveModelWithRegistry({ provider, modelId, modelRegistry, cfg });

  // ============================================================================
  // 步骤 5: 返回结果
  // ============================================================================
  if (model) {
    // 解析成功: 返回模型配置和相关对象
    return { model, authStorage, modelRegistry };
  }

  // 解析失败: 返回错误信息和相关对象
  // 注意: 即使失败也返回 authStorage 和 modelRegistry，
  // 调用方可能需要它们来显示可用模型列表或进行其他诊断
  return {
    error: buildUnknownModelError(provider, modelId),
    authStorage,
    modelRegistry,
  };
}

// ============================================================================
// 错误处理工具
// ============================================================================

/**
 * 本地提供商的配置提示映射表
 *
 * 【背景说明】
 * 某些本地运行的 AI 提供商（如 Ollama、vLLM）虽然不需要真正的认证，
 * 但 OpenClaw 的模型发现机制要求设置一个 API 密钥才能将其注册为可用提供商。
 *
 * 【常见问题】
 * 用户经常在配置中设置 `agents.defaults.model.primary: "ollama/llama2"`，
 * 但忘记设置 `OLLAMA_API_KEY` 环境变量，导致看到令人困惑的 "Unknown model" 错误。
 *
 * 【解决方案】
 * 当检测到这些已知的本地提供商时，在错误信息中添加具体的配置提示，
 * 帮助用户快速定位和解决问题。
 *
 * 相关 Issue: https://github.com/openclaw/openclaw/issues/17328
 */
const LOCAL_PROVIDER_HINTS: Record<string, string> = {
  /**
   * Ollama 提示
   *
   * Ollama 是一个本地运行的 LLM 服务器，不需要真正的 API 密钥。
   * 但为了让 OpenClaw 识别它为可用提供商，需要设置一个占位符密钥。
   * 任何非空值都可以工作，推荐使用 "ollama-local" 以表明意图。
   */
  ollama:
    "Ollama requires authentication to be registered as a provider. " +
    'Set OLLAMA_API_KEY="ollama-local" (any value works) or run "openclaw configure". ' +
    "See: https://docs.openclaw.ai/providers/ollama",

  /**
   * vLLM 提示
   *
   * vLLM 是一个高性能的 LLM 推理服务器，通常部署在本地或私有云。
   * 与 Ollama 类似，需要设置一个占位符 API 密钥来启用提供商发现。
   */
  vllm:
    "vLLM requires authentication to be registered as a provider. " +
    'Set VLLM_API_KEY (any value works) or run "openclaw configure". ' +
    "See: https://docs.openclaw.ai/providers/vllm",
};

/**
 * 构建模型未找到的错误信息
 *
 * 【功能说明】
 * 当模型解析失败时，构建一个有帮助的错误信息。
 * 对于已知的本地提供商，会附加具体的配置指导。
 *
 * 【错误信息格式】
 * - 基本格式: "Unknown model: <provider>/<modelId>"
 * - 带提示: "Unknown model: <provider>/<modelId>. <配置提示>"
 *
 * @param provider - 提供商标识符
 * @param modelId - 模型标识符
 *
 * @returns 格式化的错误信息字符串
 *
 * @example
 * buildUnknownModelError("openai", "gpt-999")
 * // 返回: "Unknown model: openai/gpt-999"
 *
 * @example
 * buildUnknownModelError("ollama", "llama2")
 * // 返回: "Unknown model: ollama/llama2. Ollama requires authentication..."
 */
function buildUnknownModelError(provider: string, modelId: string): string {
  // 构建基本错误信息
  const base = `Unknown model: ${provider}/${modelId}`;

  // 查找是否有针对该提供商的配置提示
  // 使用小写比较以支持大小写不敏感的匹配
  const hint = LOCAL_PROVIDER_HINTS[provider.toLowerCase()];

  // 如果有提示，附加到错误信息后面
  return hint ? `${base}. ${hint}` : base;
}
