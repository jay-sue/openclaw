/**
 * 压缩安全超时：对 compact 操作包一层超时，防止压缩卡死导致会话锁长期占用。
 */
import { withTimeout } from "../../node-host/with-timeout.js";

/** 嵌入式压缩默认超时（5 分钟） */
export const EMBEDDED_COMPACTION_TIMEOUT_MS = 300_000;

/** 在指定超时内执行 compact，超时抛出；用于 compact.ts 等调用方 */
export async function compactWithSafetyTimeout<T>(
  compact: () => Promise<T>,
  timeoutMs: number = EMBEDDED_COMPACTION_TIMEOUT_MS,
): Promise<T> {
  return await withTimeout(() => compact(), timeoutMs, "Compaction");
}
