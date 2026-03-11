/**
 * 压缩超时信号与快照选择：在 attempt 超时且发生在压缩期间时，决定使用压缩前还是当前消息快照返回。
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type CompactionTimeoutSignal = {
  isTimeout: boolean;
  isCompactionPendingOrRetrying: boolean;
  isCompactionInFlight: boolean;
};

/** 是否应视为「压缩导致的超时」（用于 timedOutDuringCompaction 等） */
export function shouldFlagCompactionTimeout(signal: CompactionTimeoutSignal): boolean {
  if (!signal.isTimeout) {
    return false;
  }
  return signal.isCompactionPendingOrRetrying || signal.isCompactionInFlight;
}

export type SnapshotSelectionParams = {
  timedOutDuringCompaction: boolean;
  preCompactionSnapshot: AgentMessage[] | null;
  preCompactionSessionId: string;
  currentSnapshot: AgentMessage[];
  currentSessionId: string;
};

export type SnapshotSelection = {
  messagesSnapshot: AgentMessage[];
  sessionIdUsed: string;
  source: "pre-compaction" | "current";
};

/** 根据是否在压缩期间超时及是否有压缩前快照，选择返回的消息快照与 sessionId */
export function selectCompactionTimeoutSnapshot(
  params: SnapshotSelectionParams,
): SnapshotSelection {
  if (!params.timedOutDuringCompaction) {
    return {
      messagesSnapshot: params.currentSnapshot,
      sessionIdUsed: params.currentSessionId,
      source: "current",
    };
  }

  if (params.preCompactionSnapshot) {
    return {
      messagesSnapshot: params.preCompactionSnapshot,
      sessionIdUsed: params.preCompactionSessionId,
      source: "pre-compaction",
    };
  }

  return {
    messagesSnapshot: params.currentSnapshot,
    sessionIdUsed: params.currentSessionId,
    source: "current",
  };
}
