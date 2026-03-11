/**
 * 压缩超时信号与快照选择：在 attempt 超时且发生在压缩期间时，决定使用压缩前还是当前消息快照返回。
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";

/** 压缩超时相关信号，由 attempt 层在超时与压缩状态变化时维护 */
export type CompactionTimeoutSignal = {
  /** 本次 attempt 是否因超时结束 */
  isTimeout: boolean;
  /** 是否正在等待压缩重试或处于重试中 */
  isCompactionPendingOrRetrying: boolean;
  /** 压缩是否正在执行中 */
  isCompactionInFlight: boolean;
};

/** 是否应视为「压缩导致的超时」：仅当已超时且（正在等待/重试压缩 或 压缩进行中）时返回 true，用于设置 timedOutDuringCompaction */
export function shouldFlagCompactionTimeout(signal: CompactionTimeoutSignal): boolean {
  if (!signal.isTimeout) {
    return false;
  }
  return signal.isCompactionPendingOrRetrying || signal.isCompactionInFlight;
}

/** 选择快照时的入参：超时是否在压缩期间、压缩前快照（若有）、当前快照及对应 sessionId */
export type SnapshotSelectionParams = {
  timedOutDuringCompaction: boolean;
  preCompactionSnapshot: AgentMessage[] | null;
  preCompactionSessionId: string;
  currentSnapshot: AgentMessage[];
  currentSessionId: string;
};

/** 选出的快照结果：消息列表、使用的 sessionId、来源标记 */
export type SnapshotSelection = {
  messagesSnapshot: AgentMessage[];
  sessionIdUsed: string;
  source: "pre-compaction" | "current";
};

/** 根据是否在压缩期间超时及是否有压缩前快照，选择返回的消息快照与 sessionId；非压缩超时时一律用当前快照 */
export function selectCompactionTimeoutSnapshot(
  params: SnapshotSelectionParams,
): SnapshotSelection {
  // 非压缩期间超时：直接使用当前快照
  if (!params.timedOutDuringCompaction) {
    return {
      messagesSnapshot: params.currentSnapshot,
      sessionIdUsed: params.currentSessionId,
      source: "current",
    };
  }

  // 压缩期间超时且存在压缩前快照：优先返回压缩前快照，便于上层重试或一致性
  if (params.preCompactionSnapshot) {
    return {
      messagesSnapshot: params.preCompactionSnapshot,
      sessionIdUsed: params.preCompactionSessionId,
      source: "pre-compaction",
    };
  }

  // 无压缩前快照时退回当前快照
  return {
    messagesSnapshot: params.currentSnapshot,
    sessionIdUsed: params.currentSessionId,
    source: "current",
  };
}
