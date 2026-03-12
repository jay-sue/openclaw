/**
 * 上下文引擎类型定义模块。
 *
 * 定义了上下文引擎的核心接口和结果类型。
 * 所有上下文引擎实现都必须遵循这些类型约定。
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

// ==================== 结果类型 ====================

/**
 * 上下文组装结果。
 *
 * `assemble()` 方法返回此类型，包含为模型准备好的消息列表。
 */
export type AssembleResult = {
  /** 有序的消息列表，作为模型上下文使用 */
  messages: AgentMessage[];
  /** 组装后上下文的估计 token 数 */
  estimatedTokens: number;
  /** 可选的引擎提供的指令，会被添加到运行时系统提示前 */
  systemPromptAddition?: string;
};

/**
 * 压缩操作结果。
 *
 * `compact()` 方法返回此类型，指示压缩是否成功执行。
 */
export type CompactResult = {
  /** 操作是否成功（无错误） */
  ok: boolean;
  /** 是否实际执行了压缩（可能因不需要而跳过） */
  compacted: boolean;
  /** 跳过或失败的原因说明 */
  reason?: string;
  /** 压缩详细结果（成功时提供） */
  result?: {
    /** 生成的上下文摘要 */
    summary?: string;
    /** 保留的第一条消息 ID */
    firstKeptEntryId?: string;
    /** 压缩前的 token 数 */
    tokensBefore: number;
    /** 压缩后的 token 数 */
    tokensAfter?: number;
    /** 额外的详细信息 */
    details?: unknown;
  };
};

/**
 * 消息摄入结果。
 *
 * `ingest()` 方法返回此类型，指示消息是否被成功摄入。
 */
export type IngestResult = {
  /** 消息是否被摄入（false 表示重复或无操作） */
  ingested: boolean;
};

/**
 * 批量消息摄入结果。
 *
 * `ingestBatch()` 方法返回此类型。
 */
export type IngestBatchResult = {
  /** 从批次中摄入的消息数量 */
  ingestedCount: number;
};

/**
 * 引导初始化结果。
 *
 * `bootstrap()` 方法返回此类型，用于会话的首次初始化。
 */
export type BootstrapResult = {
  /** 是否运行了引导并初始化了引擎存储 */
  bootstrapped: boolean;
  /** 导入的历史消息数量（如果适用） */
  importedMessages?: number;
  /** 跳过引导时的原因说明 */
  reason?: string;
};

/**
 * 上下文引擎元数据信息。
 */
export type ContextEngineInfo = {
  /** 引擎唯一标识符 */
  id: string;
  /** 引擎显示名称 */
  name: string;
  /** 引擎版本号 */
  version?: string;
  /** 为 true 时表示引擎管理自己的压缩生命周期 */
  ownsCompaction?: boolean;
};

/**
 * 子代理创建准备结果。
 *
 * 包含在子代理启动失败时执行回滚的句柄。
 */
export type SubagentSpawnPreparation = {
  /** 当子代理启动失败时回滚预创建设置 */
  rollback: () => void | Promise<void>;
};

/**
 * 子代理结束原因枚举。
 *
 * - `deleted`: 被手动删除
 * - `completed`: 正常完成
 * - `swept`: 被清理（如 TTL 过期）
 * - `released`: 被释放
 */
export type SubagentEndReason = "deleted" | "completed" | "swept" | "released";

/**
 * 运行时上下文类型。
 *
 * 用于传递调用者状态到引擎方法（如 compact/afterTurn）。
 */
export type ContextEngineRuntimeContext = Record<string, unknown>;

/**
 * 上下文引擎接口。
 *
 * 定义了可插拔的上下文管理契约。
 *
 * ## 核心方法（必需）
 *
 * - `ingest`: 摄入单条消息到引擎存储
 * - `assemble`: 在 token 预算内组装模型上下文
 * - `compact`: 压缩上下文以减少 token 使用
 *
 * ## 可选方法
 *
 * - `bootstrap`: 初始化会话状态，可导入历史上下文
 * - `ingestBatch`: 批量摄入一个完整轮次的消息
 * - `afterTurn`: 轮次完成后的后处理（持久化、后台压缩等）
 * - `prepareSubagentSpawn`: 子代理创建前的准备工作
 * - `onSubagentEnded`: 子代理生命周期结束通知
 * - `dispose`: 释放引擎持有的资源
 *
 * ## 实现示例
 *
 * ```typescript
 * class MyContextEngine implements ContextEngine {
 *   readonly info = { id: "my-engine", name: "My Engine", version: "1.0.0" };
 *
 *   async ingest({ sessionId, message }) {
 *     // 持久化消息到自定义存储
 *     return { ingested: true };
 *   }
 *
 *   async assemble({ sessionId, messages, tokenBudget }) {
 *     // 检索和排序消息
 *     return { messages, estimatedTokens: 0 };
 *   }
 *
 *   async compact({ sessionId, sessionFile, tokenBudget }) {
 *     // 执行自定义压缩逻辑
 *     return { ok: true, compacted: true };
 *   }
 * }
 * ```
 */
export interface ContextEngine {
  /** 引擎标识符和元数据 */
  readonly info: ContextEngineInfo;

  /**
   * 初始化会话的引擎状态，可选地导入历史上下文。
   *
   * @param params.sessionId - 会话 ID
   * @param params.sessionFile - 会话文件路径
   * @returns 引导结果
   */
  bootstrap?(params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult>;

  /**
   * 摄入单条消息到引擎存储。
   *
   * 此方法在每条消息产生后立即调用，引擎可选择：
   * - 立即持久化到自定义存储
   * - 返回 no-op 让 SessionManager 处理（legacy 模式）
   *
   * @param params.sessionId - 会话 ID
   * @param params.message - 要摄入的消息
   * @param params.isHeartbeat - 是否属于心跳运行
   * @returns 摄入结果
   */
  ingest(params: {
    sessionId: string;
    message: AgentMessage;
    /** 为 true 时消息属于心跳运行 */
    isHeartbeat?: boolean;
  }): Promise<IngestResult>;

  /**
   * 将完成的轮次消息批量作为单个单元摄入。
   *
   * 相比逐条 `ingest()`，批量摄入可以优化存储写入。
   *
   * @param params.sessionId - 会话 ID
   * @param params.messages - 消息批次
   * @param params.isHeartbeat - 是否属于心跳运行
   * @returns 批量摄入结果
   */
  ingestBatch?(params: {
    sessionId: string;
    messages: AgentMessage[];
    /** 为 true 时批次属于心跳运行 */
    isHeartbeat?: boolean;
  }): Promise<IngestBatchResult>;

  /**
   * 在运行尝试完成后执行可选的轮次后生命周期工作。
   *
   * 引擎可使用此方法：
   * - 持久化规范上下文
   * - 触发后台压缩决策
   * - 更新索引或缓存
   *
   * @param params.sessionId - 会话 ID
   * @param params.sessionFile - 会话文件路径
   * @param params.messages - 当前所有消息
   * @param params.prePromptMessageCount - 发送 prompt 前存在的消息数
   * @param params.autoCompactionSummary - 运行时发出的自动压缩摘要
   * @param params.isHeartbeat - 是否属于心跳运行
   * @param params.tokenBudget - 模型上下文 token 预算
   * @param params.runtimeContext - 调用者状态上下文
   */
  afterTurn?(params: {
    sessionId: string;
    sessionFile: string;
    messages: AgentMessage[];
    /** 发送 prompt 前存在的消息数 */
    prePromptMessageCount: number;
    /** 运行时发出的可选自动压缩摘要 */
    autoCompactionSummary?: string;
    /** 为 true 时此轮次属于心跳运行 */
    isHeartbeat?: boolean;
    /** 主动压缩的可选模型上下文 token 预算 */
    tokenBudget?: number;
    /** 引擎需要调用者状态时的可选运行时上下文 */
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<void>;

  /**
   * 在 token 预算内组装模型上下文。
   *
   * 返回准备好供模型使用的有序消息集。
   *
   * @param params.sessionId - 会话 ID
   * @param params.messages - 输入消息列表
   * @param params.tokenBudget - token 预算上限
   * @returns 组装结果
   */
  assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult>;

  /**
   * 压缩上下文以减少 token 使用。
   *
   * 可能的策略包括：
   * - 创建摘要替换旧轮次
   * - 修剪过时的工具结果
   * - 合并相似消息
   *
   * @param params.sessionId - 会话 ID
   * @param params.sessionFile - 会话文件路径
   * @param params.tokenBudget - token 预算上限
   * @param params.force - 强制压缩，即使低于默认触发阈值
   * @param params.currentTokenCount - 调用者活动上下文的实时 token 估计
   * @param params.compactionTarget - 收敛目标（budget 或 threshold）
   * @param params.customInstructions - 自定义压缩指令
   * @param params.runtimeContext - 调用者状态上下文
   * @returns 压缩结果
   */
  compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    /** 强制压缩，即使低于默认触发阈值 */
    force?: boolean;
    /** 调用者活动上下文的可选实时 token 估计 */
    currentTokenCount?: number;
    /** 控制收敛目标；默认为 budget */
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    /** 引擎需要调用者状态时的可选运行时上下文 */
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<CompactResult>;

  /**
   * 在子运行开始前准备上下文引擎管理的子代理状态。
   *
   * 实现可返回一个 rollback 句柄，在准备成功后创建失败时调用。
   *
   * @param params.parentSessionKey - 父会话键
   * @param params.childSessionKey - 子会话键
   * @param params.ttlMs - 子代理 TTL（毫秒）
   * @returns 创建准备结果（可选）
   */
  prepareSubagentSpawn?(params: {
    parentSessionKey: string;
    childSessionKey: string;
    ttlMs?: number;
  }): Promise<SubagentSpawnPreparation | undefined>;

  /**
   * 通知上下文引擎子代理生命周期已结束。
   *
   * @param params.childSessionKey - 子会话键
   * @param params.reason - 结束原因
   */
  onSubagentEnded?(params: { childSessionKey: string; reason: SubagentEndReason }): Promise<void>;

  /**
   * 释放引擎持有的任何资源。
   *
   * 在代理运行结束时调用，用于清理数据库连接、文件句柄等。
   */
  dispose?(): Promise<void>;
}
