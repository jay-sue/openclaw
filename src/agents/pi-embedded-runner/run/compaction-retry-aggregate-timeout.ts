/**
 * 在聚合超时内等待压缩重试完成，避免重试卡住时长期占用会话 lane。
 */
export async function waitForCompactionRetryWithAggregateTimeout(params: {
  /** 返回在压缩重试完成时 resolve 的 Promise */
  waitForCompactionRetry: () => Promise<void>;
  /** 包装 Promise，支持外部 abort（如 session 取消） */
  abortable: <T>(promise: Promise<T>) => Promise<T>;
  /** 单轮等待的超时毫秒数，超时后若压缩仍在进行则重试等待 */
  aggregateTimeoutMs: number;
  /** 最终判定为聚合超时时的回调（如打日志、释放资源） */
  onTimeout?: () => void;
  /** 当前是否仍在压缩中；为 true 时会继续循环等待而不触发 onTimeout */
  isCompactionStillInFlight?: () => boolean;
}): Promise<{ timedOut: boolean }> {
  // 规范化超时值：非有限数时用 1ms，否则至少 1ms
  const timeoutMsRaw = params.aggregateTimeoutMs;
  const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(1, Math.floor(timeoutMsRaw)) : 1;

  let timedOut = false;
  // 压缩重试完成时 resolve 为 "done"
  const waitPromise = params.waitForCompactionRetry().then(() => "done" as const);

  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // 在「等待完成」与「单轮超时」之间 race，并支持 abort
      const result = await params.abortable(
        Promise.race([
          waitPromise,
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), timeoutMs);
          }),
        ]),
      );

      if (result === "done") {
        break;
      }

      // 若本轮超时但压缩仍在进行，则不清 timer（在 finally 里清），继续下一轮等待，避免在压缩进行中误判为聚合超时
      if (params.isCompactionStillInFlight?.()) {
        continue;
      }

      timedOut = true;
      params.onTimeout?.();
      break;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  return { timedOut };
}
