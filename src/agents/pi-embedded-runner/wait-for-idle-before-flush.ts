/**
 * 在 agent 空闲后再刷新待处理的 tool result，避免在流式输出或工具执行中途刷新导致乱序或重复。
 */
type IdleAwareAgent = {
  waitForIdle?: (() => Promise<void>) | undefined;
};

type ToolResultFlushManager = {
  flushPendingToolResults?: (() => void) | undefined;
  clearPendingToolResults?: (() => void) | undefined;
};

/** 等待 agent 空闲的默认超时（30 秒） */
export const DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS = 30_000;

/** 尽最大努力等待 agent 进入空闲；无 waitForIdle 或超时则返回 true（表示已超时） */
async function waitForAgentIdleBestEffort(
  agent: IdleAwareAgent | null | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const waitForIdle = agent?.waitForIdle;
  if (typeof waitForIdle !== "function") {
    return false;
  }

  const idleResolved = Symbol("idle");
  const idleTimedOut = Symbol("timeout");
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      waitForIdle.call(agent).then(() => idleResolved),
      new Promise<symbol>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(idleTimedOut), timeoutMs);
        timeoutHandle.unref?.();
      }),
    ]);
    return outcome === idleTimedOut;
  } catch {
    // Best-effort during cleanup.
    return false;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

/** 先等待 agent 空闲（带超时），再执行 flushPendingToolResults；超时且 clearPendingOnTimeout 时可清空待处理结果 */
export async function flushPendingToolResultsAfterIdle(opts: {
  agent: IdleAwareAgent | null | undefined;
  sessionManager: ToolResultFlushManager | null | undefined;
  timeoutMs?: number;
  clearPendingOnTimeout?: boolean;
}): Promise<void> {
  const timedOut = await waitForAgentIdleBestEffort(
    opts.agent,
    opts.timeoutMs ?? DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS,
  );
  if (timedOut && opts.clearPendingOnTimeout && opts.sessionManager?.clearPendingToolResults) {
    opts.sessionManager.clearPendingToolResults();
    return;
  }
  opts.sessionManager?.flushPendingToolResults?.();
}
