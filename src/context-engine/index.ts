/**
 * context-engine 模块公共 API 入口。
 *
 * 本模块提供可插拔的上下文管理引擎接口，用于 AI 代理的会话上下文管理。
 * 支持自定义引擎实现（如 LosslessClaw）替换默认的 legacy 引擎。
 *
 * ## 核心概念
 *
 * - **ContextEngine**：上下文引擎接口，定义 ingest/assemble/compact 等方法
 * - **Registry**：引擎注册表，管理已注册的引擎工厂函数
 * - **LegacyContextEngine**：默认引擎，保持与现有压缩行为的向后兼容
 *
 * ## 使用方式
 *
 * ```typescript
 * import { resolveContextEngine, ensureContextEnginesInitialized } from "./context-engine";
 *
 * // 确保内置引擎已注册
 * ensureContextEnginesInitialized();
 *
 * // 根据配置解析引擎实例
 * const engine = await resolveContextEngine(config);
 *
 * // 使用引擎方法
 * await engine.ingest({ sessionId, message });
 * const assembled = await engine.assemble({ sessionId, messages, tokenBudget });
 * await engine.compact({ sessionId, sessionFile, tokenBudget });
 * ```
 *
 * ## 插件扩展
 *
 * 插件可通过 `registerContextEngine` 注册自定义引擎：
 *
 * ```typescript
 * registerContextEngine("my-engine", () => new MyContextEngine());
 * ```
 *
 * 然后在配置中指定使用：
 *
 * ```json
 * { "plugins": { "slots": { "contextEngine": "my-engine" } } }
 * ```
 */

// ==================== 类型导出 ====================
export type {
  /** 上下文引擎接口 */
  ContextEngine,
  /** 引擎元数据信息 */
  ContextEngineInfo,
  /** 上下文组装结果 */
  AssembleResult,
  /** 压缩操作结果 */
  CompactResult,
  /** 消息摄入结果 */
  IngestResult,
} from "./types.js";

// ==================== 注册表 API ====================
export {
  /** 注册上下文引擎工厂 */
  registerContextEngine,
  /** 获取已注册的引擎工厂 */
  getContextEngineFactory,
  /** 列出所有已注册的引擎 ID */
  listContextEngineIds,
  /** 根据配置解析上下文引擎实例 */
  resolveContextEngine,
} from "./registry.js";
export type { ContextEngineFactory } from "./registry.js";

// ==================== Legacy 引擎 ====================
export {
  /** Legacy 上下文引擎实现 */
  LegacyContextEngine,
  /** 注册 Legacy 引擎到注册表 */
  registerLegacyContextEngine,
} from "./legacy.js";

// ==================== 初始化 ====================
export {
  /** 确保内置上下文引擎已初始化注册 */
  ensureContextEnginesInitialized,
} from "./init.js";
