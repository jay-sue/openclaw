/**
 * 上下文引擎注册表模块。
 *
 * 管理上下文引擎的注册、查找和解析。
 * 使用全局 Symbol 确保跨 bundle chunk 的单例性。
 */

import type { OpenClawConfig } from "../config/config.js";
import { defaultSlotIdForKey } from "../plugins/slots.js";
import type { ContextEngine } from "./types.js";

/**
 * 上下文引擎工厂函数类型。
 *
 * 工厂函数创建 ContextEngine 实例。
 * 支持异步创建，用于需要数据库连接等资源的引擎。
 *
 * @example
 * ```typescript
 * // 同步工厂
 * const syncFactory: ContextEngineFactory = () => new MyEngine();
 *
 * // 异步工厂（需要初始化资源）
 * const asyncFactory: ContextEngineFactory = async () => {
 *   const db = await connectToDatabase();
 *   return new MyEngine(db);
 * };
 * ```
 */
export type ContextEngineFactory = () => ContextEngine | Promise<ContextEngine>;

// ===========================================================================
// 注册表（模块级单例）
// ===========================================================================

/**
 * 全局注册表状态的 Symbol 键。
 *
 * 使用 Symbol.for() 确保跨重复的 dist chunk 共享同一个注册表。
 * 这解决了 #40096 问题：发布构建可能将 context-engine 注册表
 * 分割到多个输出 chunk 中。
 */
const CONTEXT_ENGINE_REGISTRY_STATE = Symbol.for("openclaw.contextEngineRegistryState");

/**
 * 注册表状态类型。
 */
type ContextEngineRegistryState = {
  /** 引擎 ID 到工厂函数的映射 */
  engines: Map<string, ContextEngineFactory>;
};

/**
 * 获取全局注册表状态。
 *
 * 使用 Symbol.for() 键确保进程全局共享，
 * 即使有多个重复的 dist chunk 也能共享同一个注册表 Map。
 *
 * @returns 注册表状态对象
 */
function getContextEngineRegistryState(): ContextEngineRegistryState {
  const globalState = globalThis as typeof globalThis & {
    [CONTEXT_ENGINE_REGISTRY_STATE]?: ContextEngineRegistryState;
  };
  if (!globalState[CONTEXT_ENGINE_REGISTRY_STATE]) {
    globalState[CONTEXT_ENGINE_REGISTRY_STATE] = {
      engines: new Map<string, ContextEngineFactory>(),
    };
  }
  return globalState[CONTEXT_ENGINE_REGISTRY_STATE];
}

/**
 * 注册一个上下文引擎实现。
 *
 * 将引擎工厂函数注册到全局注册表中。
 * 如果同一 ID 已存在，会覆盖之前的注册。
 *
 * @param id - 引擎唯一标识符（如 "legacy", "lossless-claw"）
 * @param factory - 创建引擎实例的工厂函数
 *
 * @example
 * ```typescript
 * // 注册自定义引擎
 * registerContextEngine("my-engine", () => new MyContextEngine());
 *
 * // 注册需要异步初始化的引擎
 * registerContextEngine("db-engine", async () => {
 *   const connection = await createDatabaseConnection();
 *   return new DatabaseContextEngine(connection);
 * });
 * ```
 */
export function registerContextEngine(id: string, factory: ContextEngineFactory): void {
  getContextEngineRegistryState().engines.set(id, factory);
}

/**
 * 获取已注册引擎的工厂函数。
 *
 * @param id - 引擎标识符
 * @returns 工厂函数，未注册时返回 undefined
 */
export function getContextEngineFactory(id: string): ContextEngineFactory | undefined {
  return getContextEngineRegistryState().engines.get(id);
}

/**
 * 列出所有已注册的引擎 ID。
 *
 * @returns 引擎 ID 数组
 *
 * @example
 * ```typescript
 * const ids = listContextEngineIds();
 * console.log(ids); // ["legacy", "lossless-claw", "my-engine"]
 * ```
 */
export function listContextEngineIds(): string[] {
  return [...getContextEngineRegistryState().engines.keys()];
}

// ===========================================================================
// 解析
// ===========================================================================

/**
 * 根据插件插槽配置解析要使用的 ContextEngine。
 *
 * ## 解析顺序
 *
 * 1. `config.plugins.slots.contextEngine`（显式插槽覆盖）
 * 2. 默认插槽值（"legacy"）
 *
 * ## 错误处理
 *
 * 如果解析的引擎 ID 没有已注册的工厂，会抛出错误。
 * 错误消息包含请求的 ID 和所有可用引擎的列表。
 *
 * @param config - OpenClaw 配置对象（可选）
 * @returns 解析后的 ContextEngine 实例
 * @throws 当引擎未注册时
 *
 * @example
 * ```typescript
 * // 使用默认引擎（legacy）
 * const engine = await resolveContextEngine();
 *
 * // 使用配置指定的引擎
 * const config = { plugins: { slots: { contextEngine: "lossless-claw" } } };
 * const engine = await resolveContextEngine(config);
 * ```
 */
export async function resolveContextEngine(config?: OpenClawConfig): Promise<ContextEngine> {
  // 从配置中读取插槽值
  const slotValue = config?.plugins?.slots?.contextEngine;

  // 解析引擎 ID：优先使用配置值，否则使用默认值
  const engineId =
    typeof slotValue === "string" && slotValue.trim()
      ? slotValue.trim()
      : defaultSlotIdForKey("contextEngine");

  // 查找工厂函数
  const factory = getContextEngineRegistryState().engines.get(engineId);
  if (!factory) {
    throw new Error(
      `Context engine "${engineId}" is not registered. ` +
        `Available engines: ${listContextEngineIds().join(", ") || "(none)"}`,
    );
  }

  // 调用工厂创建实例（支持异步）
  return factory();
}
