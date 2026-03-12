/**
 * ============================================================================
 * 嵌入式 Pi 运行状态注册表 (Embedded Pi Run Registry)
 * ============================================================================
 *
 * 【模块概述】
 * 本模块维护一个全局的运行状态注册表，用于追踪当前所有活跃的嵌入式 Pi 代理运行。
 * 它是连接 run.ts（运行执行）和外部控制（消息队列、中止、等待）的桥梁。
 *
 * 【核心功能】
 *
 * 1. **运行注册/注销**
 *    - setActiveEmbeddedRun: 运行开始时注册 handle
 *    - clearActiveEmbeddedRun: 运行结束时清除 handle
 *    - 自动触发会话状态变更日志
 *
 * 2. **消息队列**
 *    - queueEmbeddedPiMessage: 向正在流式输出的运行追加消息
 *    - 仅在运行处于流式状态且未压缩时生效
 *    - 用于实现"消息追加"功能（用户在 AI 响应时发送新消息）
 *
 * 3. **运行中止**
 *    - abortEmbeddedPiRun(sessionId): 中止指定会话的运行
 *    - abortEmbeddedPiRun(undefined, { mode: "all" }): 中止所有运行
 *    - abortEmbeddedPiRun(undefined, { mode: "compacting" }): 仅中止压缩中的运行
 *
 * 4. **等待机制**
 *    - waitForEmbeddedPiRunEnd: 等待指定会话的运行结束
 *    - waitForActiveEmbeddedRuns: 等待所有活跃运行结束
 *    - 用于优雅关闭、会话切换等场景
 *
 * 【数据结构】
 *
 * ```
 * ACTIVE_EMBEDDED_RUNS: Map<sessionId, EmbeddedPiQueueHandle>
 * ├── "session-abc" -> { queueMessage, isStreaming, isCompacting, abort }
 * ├── "session-def" -> { queueMessage, isStreaming, isCompacting, abort }
 * └── ...
 *
 * EMBEDDED_RUN_WAITERS: Map<sessionId, Set<EmbeddedRunWaiter>>
 * ├── "session-abc" -> Set<{ resolve, timer }>
 * └── ...
 * ```
 *
 * 【使用流程】
 *
 * ```
 * 1. run.ts 开始运行时:
 *    setActiveEmbeddedRun(sessionId, handle)
 *
 * 2. 运行期间:
 *    - 外部可调用 queueEmbeddedPiMessage() 追加消息
 *    - 外部可调用 abortEmbeddedPiRun() 中止运行
 *    - 外部可调用 waitForEmbeddedPiRunEnd() 等待结束
 *
 * 3. run.ts 结束运行时:
 *    clearActiveEmbeddedRun(sessionId, handle)
 *    → 自动通知所有等待者
 * ```
 *
 * 【线程安全说明】
 * Node.js 是单线程的，因此 Map 操作是原子的。但由于异步操作的存在，
 * clearActiveEmbeddedRun 会检查 handle 是否匹配，避免误清除被替换的运行。
 *
 * 【与其他模块的关系】
 * - run.ts: 在运行开始/结束时调用 set/clear
 * - 外部控制器: 调用 abort、queueMessage、waitFor 等函数
 * - diagnostic.js: 记录会话状态变更和消息队列日志
 */

// ============================================================================
// 导入
// ============================================================================

// 诊断日志工具
// - diag: 通用诊断日志记录器，用于 debug/warn 级别日志
// - logMessageQueued: 记录消息入队事件
// - logSessionStateChange: 记录会话状态变更（processing/idle）
import {
  diagnosticLogger as diag,
  logMessageQueued,
  logSessionStateChange,
} from "../../logging/diagnostic.js";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 单次嵌入式运行的控制句柄
 *
 * 每个活跃的运行都有一个 handle，提供以下能力：
 *
 * @property queueMessage - 向运行追加一条消息
 *   - 消息会被加入运行的内部队列
 *   - 在当前工具调用循环结束后处理
 *   - 返回 Promise，完成时表示消息已入队（不是已处理）
 *
 * @property isStreaming - 检查运行是否正在流式输出
 *   - true: 模型正在生成响应
 *   - false: 运行正在执行工具或等待
 *   - 只有流式状态下才能追加消息
 *
 * @property isCompacting - 检查运行是否正在执行压缩
 *   - true: 正在压缩会话历史（处理上下文溢出）
 *   - false: 正常运行状态
 *   - 压缩期间不接受新消息
 *
 * @property abort - 中止运行
 *   - 发送中止信号给运行
 *   - 运行会在合适的时机停止
 *   - 中止是异步的，调用后运行不会立即结束
 */
type EmbeddedPiQueueHandle = {
  queueMessage: (text: string) => Promise<void>;
  isStreaming: () => boolean;
  isCompacting: () => boolean;
  abort: () => void;
};

// ============================================================================
// 全局状态
// ============================================================================

/**
 * 当前活跃的嵌入式运行注册表
 *
 * 结构: sessionId -> EmbeddedPiQueueHandle
 *
 * 【生命周期】
 * - 运行开始时通过 setActiveEmbeddedRun() 添加
 * - 运行结束时通过 clearActiveEmbeddedRun() 移除
 *
 * 【并发说明】
 * 同一个 sessionId 同时只能有一个活跃运行。
 * 如果新运行在旧运行结束前开始，会替换旧的 handle（触发 "run_replaced" 日志）。
 */
const ACTIVE_EMBEDDED_RUNS = new Map<string, EmbeddedPiQueueHandle>();

/**
 * 等待运行结束的等待者
 *
 * 结构: { resolve, timer }
 * - resolve: Promise 的 resolve 函数，调用时表示运行已结束
 * - timer: 超时定时器，超时时自动 resolve(false)
 */
type EmbeddedRunWaiter = {
  /** Promise 的 resolve 函数，参数表示是否正常结束（true）或超时（false） */
  resolve: (ended: boolean) => void;
  /** 超时定时器句柄 */
  timer: NodeJS.Timeout;
};

/**
 * 运行结束等待者注册表
 *
 * 结构: sessionId -> Set<EmbeddedRunWaiter>
 *
 * 【工作原理】
 * 1. waitForEmbeddedPiRunEnd() 创建一个 waiter 并加入 Set
 * 2. 运行结束时 notifyEmbeddedRunEnded() 遍历 Set，resolve 所有 waiters
 * 3. 超时时 waiter 自己从 Set 中移除并 resolve(false)
 *
 * 【为什么用 Set】
 * 同一个 sessionId 可能有多个调用者在等待，每个都需要被通知。
 */
const EMBEDDED_RUN_WAITERS = new Map<string, Set<EmbeddedRunWaiter>>();

// ============================================================================
// 消息队列函数
// ============================================================================

/**
 * 向当前活跃且处于流式状态的运行追加一条消息
 *
 * 【功能说明】
 * 当用户在 AI 正在响应时发送新消息，该消息会被"追加"到当前运行中，
 * 而不是启动一个新的运行。这实现了"消息追加"功能。
 *
 * 【前置条件】（全部满足才能入队成功）
 * 1. 指定 sessionId 存在活跃运行
 * 2. 运行正在流式输出（isStreaming() === true）
 * 3. 运行未在执行压缩（isCompacting() === false）
 *
 * 【使用场景】
 * ```
 * 用户: "帮我写一个函数"
 * AI: "好的，我来帮你写..." [正在流式输出]
 * 用户: "要用 TypeScript"  [追加消息]
 * → queueEmbeddedPiMessage(sessionId, "要用 TypeScript")
 * → AI 会在合适时机看到追加的消息并调整响应
 * ```
 *
 * 【为什么压缩时不能追加】
 * 压缩会修改会话历史，在此期间追加消息可能导致：
 * - 消息被压缩掉
 * - 消息顺序混乱
 * - 上下文不一致
 *
 * @param sessionId - 目标会话 ID
 * @param text - 要追加的消息文本
 *
 * @returns 是否成功入队
 *   - true: 消息已入队，将被处理
 *   - false: 入队失败（无活跃运行、非流式状态或正在压缩）
 */
export function queueEmbeddedPiMessage(sessionId: string, text: string): boolean {
  // 查找目标会话的运行 handle
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);

  // 检查 1: 是否存在活跃运行
  if (!handle) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=no_active_run`);
    return false;
  }

  // 检查 2: 是否处于流式输出状态
  // 只有流式状态下才能追加消息，因为此时 AI 正在生成响应，可以看到新消息
  if (!handle.isStreaming()) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=not_streaming`);
    return false;
  }

  // 检查 3: 是否正在执行压缩
  // 压缩期间会话历史不稳定，不能追加消息
  if (handle.isCompacting()) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=compacting`);
    return false;
  }

  // 记录消息入队日志
  logMessageQueued({ sessionId, source: "pi-embedded-runner" });

  // 调用 handle 的 queueMessage 方法追加消息
  // 使用 void 忽略返回的 Promise，因为我们只关心是否成功入队
  void handle.queueMessage(text);

  return true;
}

// ============================================================================
// 运行中止函数
// ============================================================================

/**
 * 中止嵌入式 Pi 运行
 *
 * 【功能说明】
 * 提供灵活的运行中止能力，支持：
 * 1. 中止指定会话的运行
 * 2. 中止所有活跃运行
 * 3. 仅中止正在压缩的运行
 *
 * 【中止行为】
 * - 中止是异步的：调用 abort() 后运行不会立即停止
 * - 运行会在下一个安全点检查中止信号并停止
 * - 中止后运行会正常清理并触发 waiters
 *
 * 【使用场景】
 * - 用户主动取消请求
 * - 系统关闭前清理
 * - 会话超时处理
 * - 压缩超时处理（仅中止压缩中的运行）
 */

/**
 * 中止指定会话的嵌入式运行
 *
 * @param sessionId - 要中止的会话 ID
 * @returns 是否成功发送中止信号
 *   - true: 找到运行并成功调用 abort()
 *   - false: 未找到运行或 abort() 抛出异常
 */
export function abortEmbeddedPiRun(sessionId: string): boolean;

/**
 * 按模式中止多个运行
 *
 * @param sessionId - 必须为 undefined（表示批量模式）
 * @param opts - 中止选项
 * @param opts.mode - 中止模式
 *   - "all": 中止所有活跃运行
 *   - "compacting": 仅中止正在执行压缩的运行
 *
 * @returns 是否成功中止了至少一个运行
 *
 * @example
 * // 中止所有运行（用于系统关闭）
 * abortEmbeddedPiRun(undefined, { mode: "all" });
 *
 * @example
 * // 仅中止压缩中的运行（用于压缩超时）
 * abortEmbeddedPiRun(undefined, { mode: "compacting" });
 */
export function abortEmbeddedPiRun(
  sessionId: undefined,
  opts: { mode: "all" | "compacting" },
): boolean;

/**
 * 中止函数的实际实现
 */
export function abortEmbeddedPiRun(
  sessionId?: string,
  opts?: { mode?: "all" | "compacting" },
): boolean {
  // ============================================================================
  // 模式 1: 中止指定会话
  // ============================================================================
  if (typeof sessionId === "string" && sessionId.length > 0) {
    const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);

    // 未找到活跃运行
    if (!handle) {
      diag.debug(`abort failed: sessionId=${sessionId} reason=no_active_run`);
      return false;
    }

    diag.debug(`aborting run: sessionId=${sessionId}`);

    // 尝试调用 abort()，捕获可能的异常
    try {
      handle.abort();
    } catch (err) {
      diag.warn(`abort failed: sessionId=${sessionId} err=${String(err)}`);
      return false;
    }

    return true;
  }

  // ============================================================================
  // 模式 2: 批量中止
  // ============================================================================
  const mode = opts?.mode;

  // ---------- 仅中止压缩中的运行 ----------
  // 用于处理压缩超时场景：只中止正在压缩的运行，不影响正常运行
  if (mode === "compacting") {
    let aborted = false;

    for (const [id, handle] of ACTIVE_EMBEDDED_RUNS) {
      // 跳过非压缩状态的运行
      if (!handle.isCompacting()) {
        continue;
      }

      diag.debug(`aborting compacting run: sessionId=${id}`);

      try {
        handle.abort();
        aborted = true;
      } catch (err) {
        diag.warn(`abort failed: sessionId=${id} err=${String(err)}`);
      }
    }

    return aborted;
  }

  // ---------- 中止所有运行 ----------
  // 用于系统关闭或紧急清理场景
  if (mode === "all") {
    let aborted = false;

    for (const [id, handle] of ACTIVE_EMBEDDED_RUNS) {
      diag.debug(`aborting run: sessionId=${id}`);

      try {
        handle.abort();
        aborted = true;
      } catch (err) {
        diag.warn(`abort failed: sessionId=${id} err=${String(err)}`);
      }
    }

    return aborted;
  }

  // 未指定有效模式
  return false;
}

// ============================================================================
// 状态查询函数
// ============================================================================

/**
 * 检查指定会话是否有活跃的嵌入式运行
 *
 * 【使用场景】
 * - 判断是否可以启动新运行（避免重复运行）
 * - 判断是否可以追加消息
 * - 显示会话状态指示器
 *
 * @param sessionId - 会话 ID
 * @returns 是否存在活跃运行
 *
 * @example
 * if (isEmbeddedPiRunActive(sessionId)) {
 *   // 会话正在处理中，等待或追加消息
 * } else {
 *   // 可以启动新运行
 * }
 */
export function isEmbeddedPiRunActive(sessionId: string): boolean {
  const active = ACTIVE_EMBEDDED_RUNS.has(sessionId);

  // 仅在活跃时记录日志，减少日志噪音
  if (active) {
    diag.debug(`run active check: sessionId=${sessionId} active=true`);
  }

  return active;
}

/**
 * 检查指定会话的运行是否正在流式输出
 *
 * 【与 isEmbeddedPiRunActive 的区别】
 * - isEmbeddedPiRunActive: 只检查是否存在运行
 * - isEmbeddedPiRunStreaming: 检查运行是否正在流式输出
 *
 * 运行可能存在但不在流式状态（例如正在执行工具或压缩）。
 *
 * @param sessionId - 会话 ID
 * @returns 是否正在流式输出
 *   - true: 存在运行且正在流式输出
 *   - false: 不存在运行，或运行不在流式状态
 */
export function isEmbeddedPiRunStreaming(sessionId: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);

  if (!handle) {
    return false;
  }

  return handle.isStreaming();
}

/**
 * 获取当前活跃运行的总数
 *
 * 【使用场景】
 * - 监控系统负载
 * - 优雅关闭时判断是否还有运行需要等待
 * - 并发控制决策
 *
 * @returns 活跃运行数量
 */
export function getActiveEmbeddedRunCount(): number {
  return ACTIVE_EMBEDDED_RUNS.size;
}

// ============================================================================
// 等待函数
// ============================================================================

/**
 * 等待所有活跃的嵌入式运行结束
 *
 * 【功能说明】
 * 阻塞等待直到所有活跃运行都结束，或超时。
 * 使用轮询机制检查运行状态。
 *
 * 【使用场景】
 * - 系统重启前等待运行结束
 * - 优雅关闭时确保压缩运行释放会话写锁
 * - 批量操作前确保系统空闲
 *
 * 【工作原理】
 * ```
 * 开始等待
 *     ↓
 * ┌───────────────────┐
 * │ 检查活跃运行数量  │
 * └─────────┬─────────┘
 *           ↓
 *      数量 == 0?
 *       /      \
 *     是        否
 *      ↓         ↓
 *  返回 true   超时了?
 *              /    \
 *            是      否
 *             ↓       ↓
 *         返回 false  等待 pollMs
 *                      ↓
 *                  返回检查
 * ```
 *
 * @param timeoutMs - 最大等待时间（毫秒），默认 15 秒
 * @param opts - 可选配置
 * @param opts.pollMs - 轮询间隔（毫秒），默认 250ms
 *
 * @returns Promise<{ drained: boolean }>
 *   - drained: true 表示所有运行已结束
 *   - drained: false 表示超时，仍有运行在执行
 *
 * @example
 * // 等待所有运行结束，最多 30 秒
 * const result = await waitForActiveEmbeddedRuns(30_000);
 * if (!result.drained) {
 *   console.warn("Still have active runs after timeout");
 * }
 */
export async function waitForActiveEmbeddedRuns(
  timeoutMs = 15_000,
  opts?: { pollMs?: number },
): Promise<{ drained: boolean }> {
  // 解析轮询间隔，确保至少 10ms
  const pollMsRaw = opts?.pollMs ?? 250;
  const pollMs = Math.max(10, Math.floor(pollMsRaw));

  // 确保超时时间至少等于一次轮询间隔
  const maxWaitMs = Math.max(pollMs, Math.floor(timeoutMs));

  const startedAt = Date.now();

  // 轮询循环
  while (true) {
    // 检查是否已全部结束
    if (ACTIVE_EMBEDDED_RUNS.size === 0) {
      return { drained: true };
    }

    // 检查是否超时
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= maxWaitMs) {
      diag.warn(
        `wait for active embedded runs timed out: activeRuns=${ACTIVE_EMBEDDED_RUNS.size} timeoutMs=${maxWaitMs}`,
      );
      return { drained: false };
    }

    // 等待下一次轮询
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * 等待指定会话的嵌入式运行结束
 *
 * 【功能说明】
 * 等待特定会话的运行结束，支持超时。
 * 与 waitForActiveEmbeddedRuns 不同，这个函数使用事件驱动而非轮询。
 *
 * 【使用场景】
 * - 等待前一个运行结束后再启动新运行
 * - 会话切换时等待旧会话处理完毕
 * - 实现请求串行化
 *
 * 【工作原理】
 * 1. 如果运行不存在，立即返回 true
 * 2. 创建一个 waiter 对象并注册
 * 3. 运行结束时会调用 notifyEmbeddedRunEnded() 通知所有 waiters
 * 4. 超时时 waiter 自己清理并返回 false
 *
 * 【竞态条件处理】
 * 注册 waiter 后会再次检查运行是否存在，
 * 处理"注册期间运行结束"的竞态条件。
 *
 * @param sessionId - 会话 ID
 * @param timeoutMs - 最大等待时间（毫秒），默认 15 秒
 *
 * @returns Promise<boolean>
 *   - true: 运行已结束（或本就不存在）
 *   - false: 等待超时
 *
 * @example
 * // 等待会话运行结束
 * const ended = await waitForEmbeddedPiRunEnd(sessionId, 10_000);
 * if (!ended) {
 *   console.warn("Run did not end within timeout");
 * }
 */
export function waitForEmbeddedPiRunEnd(sessionId: string, timeoutMs = 15_000): Promise<boolean> {
  // 快速路径：无效 sessionId 或运行不存在，立即返回
  if (!sessionId || !ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
    return Promise.resolve(true);
  }

  diag.debug(`waiting for run end: sessionId=${sessionId} timeoutMs=${timeoutMs}`);

  return new Promise((resolve) => {
    // 获取或创建该 sessionId 的等待者集合
    const waiters = EMBEDDED_RUN_WAITERS.get(sessionId) ?? new Set();

    // 创建等待者对象
    const waiter: EmbeddedRunWaiter = {
      resolve,
      // 设置超时定时器
      timer: setTimeout(
        () => {
          // 超时处理：从集合中移除自己
          waiters.delete(waiter);

          // 如果集合为空，清理 Map 条目
          if (waiters.size === 0) {
            EMBEDDED_RUN_WAITERS.delete(sessionId);
          }

          diag.warn(`wait timeout: sessionId=${sessionId} timeoutMs=${timeoutMs}`);

          // 返回 false 表示超时
          resolve(false);
        },
        Math.max(100, timeoutMs), // 确保至少 100ms
      ),
    };

    // 将等待者加入集合
    waiters.add(waiter);
    EMBEDDED_RUN_WAITERS.set(sessionId, waiters);

    // 竞态条件检查：注册期间运行可能已经结束
    // 再次检查运行是否存在
    if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
      // 运行已结束，清理并立即返回
      waiters.delete(waiter);
      if (waiters.size === 0) {
        EMBEDDED_RUN_WAITERS.delete(sessionId);
      }
      clearTimeout(waiter.timer);
      resolve(true);
    }
  });
}

/**
 * 通知所有等待者：指定会话的运行已结束
 *
 * 【内部函数】
 * 由 clearActiveEmbeddedRun() 在运行结束时调用。
 * 遍历所有等待该 sessionId 的 waiters，清除定时器并 resolve(true)。
 *
 * @param sessionId - 已结束运行的会话 ID
 */
function notifyEmbeddedRunEnded(sessionId: string) {
  const waiters = EMBEDDED_RUN_WAITERS.get(sessionId);

  // 无等待者，直接返回
  if (!waiters || waiters.size === 0) {
    return;
  }

  // 从 Map 中移除（避免在遍历时修改）
  EMBEDDED_RUN_WAITERS.delete(sessionId);

  diag.debug(`notifying waiters: sessionId=${sessionId} waiterCount=${waiters.size}`);

  // 通知所有等待者
  for (const waiter of waiters) {
    // 清除超时定时器
    clearTimeout(waiter.timer);
    // 返回 true 表示正常结束
    waiter.resolve(true);
  }
}

// ============================================================================
// 运行注册/注销函数
// ============================================================================

/**
 * 注册活跃的嵌入式运行
 *
 * 【功能说明】
 * 在运行开始时调用，将运行的控制 handle 注册到全局注册表。
 * 注册后，外部可以通过本模块的函数与运行交互。
 *
 * 【调用时机】
 * 由 run.ts 在运行开始时调用（进入主重试循环之前）。
 *
 * 【状态变更日志】
 * 会自动记录会话状态变更：
 * - "run_started": 新运行开始
 * - "run_replaced": 替换了已存在的运行（异常情况）
 *
 * 【probe 会话处理】
 * 以 "probe-" 开头的 sessionId 是探测会话（健康检查等），
 * 不记录调试日志以减少噪音。
 *
 * @param sessionId - 会话 ID
 * @param handle - 运行控制句柄
 * @param sessionKey - 会话键（可选，用于日志）
 *
 * @example
 * // run.ts 中的使用
 * const handle = {
 *   queueMessage: async (text) => { ... },
 *   isStreaming: () => streamingState,
 *   isCompacting: () => compactingState,
 *   abort: () => { abortController.abort() },
 * };
 * setActiveEmbeddedRun(sessionId, handle, sessionKey);
 */
export function setActiveEmbeddedRun(
  sessionId: string,
  handle: EmbeddedPiQueueHandle,
  sessionKey?: string,
) {
  // 检查是否已有活跃运行（用于日志区分）
  const wasActive = ACTIVE_EMBEDDED_RUNS.has(sessionId);

  // 注册 handle（如果已存在会替换）
  ACTIVE_EMBEDDED_RUNS.set(sessionId, handle);

  // 记录会话状态变更
  logSessionStateChange({
    sessionId,
    sessionKey,
    state: "processing",
    // 区分新运行和替换运行
    reason: wasActive ? "run_replaced" : "run_started",
  });

  // 非探测会话记录调试日志
  if (!sessionId.startsWith("probe-")) {
    diag.debug(`run registered: sessionId=${sessionId} totalActive=${ACTIVE_EMBEDDED_RUNS.size}`);
  }
}

/**
 * 清除活跃的嵌入式运行
 *
 * 【功能说明】
 * 在运行结束时调用，从全局注册表中移除运行的 handle。
 * 移除后会通知所有等待该运行结束的 waiters。
 *
 * 【调用时机】
 * 由 run.ts 在运行结束时调用（finally 块中）。
 *
 * 【Handle 匹配检查】
 * 只有当传入的 handle 与注册表中的 handle 相同时才会清除。
 * 这防止了以下竞态条件：
 * - 运行 A 开始
 * - 运行 B 替换运行 A（异常情况）
 * - 运行 A 结束，调用 clearActiveEmbeddedRun
 * - 如果不检查 handle，会误清除运行 B
 *
 * 【副作用】
 * - 记录会话状态变更（state: "idle", reason: "run_completed"）
 * - 调用 notifyEmbeddedRunEnded() 通知等待者
 *
 * @param sessionId - 会话 ID
 * @param handle - 运行控制句柄（必须与注册时相同）
 * @param sessionKey - 会话键（可选，用于日志）
 */
export function clearActiveEmbeddedRun(
  sessionId: string,
  handle: EmbeddedPiQueueHandle,
  sessionKey?: string,
) {
  // 检查 handle 是否匹配
  if (ACTIVE_EMBEDDED_RUNS.get(sessionId) === handle) {
    // 从注册表中移除
    ACTIVE_EMBEDDED_RUNS.delete(sessionId);

    // 记录会话状态变更
    logSessionStateChange({ sessionId, sessionKey, state: "idle", reason: "run_completed" });

    // 非探测会话记录调试日志
    if (!sessionId.startsWith("probe-")) {
      diag.debug(`run cleared: sessionId=${sessionId} totalActive=${ACTIVE_EMBEDDED_RUNS.size}`);
    }

    // 通知所有等待该运行结束的 waiters
    notifyEmbeddedRunEnded(sessionId);
  } else {
    // Handle 不匹配，跳过清除（可能已被替换）
    diag.debug(`run clear skipped: sessionId=${sessionId} reason=handle_mismatch`);
  }
}

// ============================================================================
// 测试工具
// ============================================================================

/**
 * 测试用工具函数集合
 *
 * 【注意】
 * 这些函数仅供测试使用，不应在生产代码中调用。
 * 它们会直接操作全局状态，可能导致不一致。
 */
export const __testing = {
  /**
   * 重置所有活跃运行状态
   *
   * 【功能】
   * - 清除所有等待者（先 resolve 所有 waiters 并清除定时器）
   * - 清空活跃运行注册表
   *
   * 【使用场景】
   * 测试用例的 beforeEach/afterEach 中调用，确保测试隔离。
   */
  resetActiveEmbeddedRuns() {
    // 先清理所有等待者
    for (const waiters of EMBEDDED_RUN_WAITERS.values()) {
      for (const waiter of waiters) {
        // 清除定时器防止内存泄漏
        clearTimeout(waiter.timer);
        // resolve(true) 让等待的测试代码继续执行
        waiter.resolve(true);
      }
    }

    // 清空两个 Map
    EMBEDDED_RUN_WAITERS.clear();
    ACTIVE_EMBEDDED_RUNS.clear();
  },
};

// ============================================================================
// 类型导出
// ============================================================================

/**
 * 导出 EmbeddedPiQueueHandle 类型供外部使用
 *
 * 外部模块（如 run.ts）需要知道这个类型以正确构造 handle 对象。
 */
export type { EmbeddedPiQueueHandle };
