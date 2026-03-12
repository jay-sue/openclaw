/**
 * 上下文引擎初始化模块。
 *
 * 确保所有内置上下文引擎在使用前被注册一次。
 * 这是一个单例初始化模式，防止重复注册。
 */

import { registerLegacyContextEngine } from "./legacy.js";

/**
 * 初始化标志，确保只执行一次。
 * 使用模块级变量实现单例模式。
 */
let initialized = false;

/**
 * 确保所有内置上下文引擎被注册恰好一次。
 *
 * ## 设计目的
 *
 * Legacy 引擎始终被注册为安全的 fallback，使得 `resolveContextEngine()`
 * 可以解析默认的 "legacy" 插槽，而调用者无需记住手动注册。
 *
 * ## 扩展机制
 *
 * 额外的引擎由各自的插件在加载时通过 `api.registerContextEngine()` 注册。
 * 例如 LosslessClaw 插件会注册 "lossless-claw" 引擎。
 *
 * ## 调用时机
 *
 * 应在任何 `resolveContextEngine()` 调用之前调用此函数。
 * 典型的调用点在 `runEmbeddedPiAgent` 的重试循环开始前。
 *
 * ## 幂等性
 *
 * 此函数是幂等的，多次调用安全。
 *
 * @example
 * ```typescript
 * // 在代理运行前初始化
 * ensureContextEnginesInitialized();
 *
 * // 现在可以安全地解析引擎
 * const engine = await resolveContextEngine(config);
 * ```
 */
export function ensureContextEnginesInitialized(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  // 始终可用 - 作为 "legacy" 插槽默认值的安全 fallback
  registerLegacyContextEngine();
}
