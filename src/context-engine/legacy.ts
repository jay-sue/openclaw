/**
 * Legacy 上下文引擎实现模块。
 *
 * 提供默认的上下文引擎实现，保持与现有压缩行为的 100% 向后兼容。
 * 这是系统的 fallback 引擎，当没有配置自定义引擎时使用。
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { registerContextEngine } from "./registry.js";
import type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  ContextEngineRuntimeContext,
  IngestResult,
} from "./types.js";

/**
 * Legacy 上下文引擎。
 *
 * 将现有的压缩行为包装在 ContextEngine 接口后面，
 * 保持 100% 的向后兼容性。
 *
 * ## 设计原则
 *
 * - **最小干预**：尽可能让现有代码路径处理工作
 * - **向后兼容**：不改变任何现有行为
 * - **渐进迁移**：允许逐步迁移到新引擎
 *
 * ## 方法行为
 *
 * | 方法 | 行为 | 原因 |
 * |------|------|------|
 * | ingest | no-op | SessionManager 处理消息持久化 |
 * | assemble | pass-through | attempt.ts 的现有管道处理上下文组装 |
 * | afterTurn | no-op | legacy 流程在 SessionManager 中直接持久化 |
 * | compact | 委托 | 委托给 compactEmbeddedPiSessionDirect |
 * | dispose | no-op | 无需清理 |
 *
 * ## 使用场景
 *
 * - 默认配置（未指定引擎）
 * - 显式配置 `contextEngine: "legacy"`
 * - 新引擎失败时的 fallback
 */
export class LegacyContextEngine implements ContextEngine {
  /**
   * 引擎元数据。
   */
  readonly info: ContextEngineInfo = {
    id: "legacy",
    name: "Legacy Context Engine",
    version: "1.0.0",
  };

  /**
   * 摄入消息（no-op）。
   *
   * 在 legacy 流程中，SessionManager 负责消息持久化，
   * 因此这里只返回 `{ ingested: false }` 表示未处理。
   *
   * @returns 始终返回 `{ ingested: false }`
   */
  async ingest(_params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    // No-op: SessionManager 在 legacy 流程中处理消息持久化
    return { ingested: false };
  }

  /**
   * 组装上下文（pass-through）。
   *
   * 现有的 sanitize → validate → limit → repair 管道
   * 在 attempt.ts 中处理 legacy 引擎的上下文组装。
   * 这里只是原样返回消息，不做任何处理。
   *
   * @param params.messages - 输入消息列表
   * @returns 原样返回消息，estimatedTokens 为 0（由调用者处理估算）
   */
  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    // Pass-through: attempt.ts 中现有的 sanitize → validate → limit → repair
    // 管道处理 legacy 引擎的上下文组装。
    // 我们只是原样返回消息，带一个粗略的 token 估计。
    return {
      messages: params.messages,
      estimatedTokens: 0, // 调用者处理估算
    };
  }

  /**
   * 轮次后处理（no-op）。
   *
   * Legacy 流程在 SessionManager 中直接持久化上下文，
   * 不需要额外的后处理。
   */
  async afterTurn(_params: {
    sessionId: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<void> {
    // No-op: legacy 流程在 SessionManager 中直接持久化上下文
  }

  /**
   * 压缩上下文。
   *
   * 委托给 `compactEmbeddedPiSessionDirect` 执行实际的压缩逻辑。
   * 这保持了与现有压缩行为的完全兼容。
   *
   * ## 实现细节
   *
   * - 通过专用的运行时边界导入，保持延迟加载有效
   * - runtimeContext 携带完整的 CompactEmbeddedPiSessionParams 字段
   * - 将结果转换为标准的 CompactResult 格式
   *
   * @param params - 压缩参数
   * @returns 压缩结果
   */
  async compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<CompactResult> {
    // 通过专用运行时边界导入，保持延迟加载边界有效
    const { compactEmbeddedPiSessionDirect } =
      await import("../agents/pi-embedded-runner/compact.runtime.js");

    // runtimeContext 携带 run.ts 中调用者设置的完整 CompactEmbeddedPiSessionParams 字段。
    // 我们展开它们并覆盖直接来自 ContextEngine compact() 签名的字段。
    const runtimeContext = params.runtimeContext ?? {};

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 桥接 runtimeContext 匹配 CompactEmbeddedPiSessionParams
    const result = await compactEmbeddedPiSessionDirect({
      ...runtimeContext,
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
      tokenBudget: params.tokenBudget,
      force: params.force,
      customInstructions: params.customInstructions,
      workspaceDir: (runtimeContext.workspaceDir as string) ?? process.cwd(),
    } as Parameters<typeof compactEmbeddedPiSessionDirect>[0]);

    // 转换为标准 CompactResult 格式
    return {
      ok: result.ok,
      compacted: result.compacted,
      reason: result.reason,
      result: result.result
        ? {
            summary: result.result.summary,
            firstKeptEntryId: result.result.firstKeptEntryId,
            tokensBefore: result.result.tokensBefore,
            tokensAfter: result.result.tokensAfter,
            details: result.result.details,
          }
        : undefined,
    };
  }

  /**
   * 释放资源（no-op）。
   *
   * Legacy 引擎没有需要清理的资源。
   */
  async dispose(): Promise<void> {
    // Legacy 引擎没有需要清理的资源
  }
}

/**
 * 注册 Legacy 引擎到全局注册表。
 *
 * 此函数在 `ensureContextEnginesInitialized()` 中调用，
 * 确保 "legacy" 引擎始终可用作安全的 fallback。
 */
export function registerLegacyContextEngine(): void {
  registerContextEngine("legacy", () => new LegacyContextEngine());
}
