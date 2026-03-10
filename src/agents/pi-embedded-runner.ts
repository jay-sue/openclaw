/**
 * 嵌入式 Pi 代理运行公共 API
 *
 * 本文件仅做 pi-embedded-runner 子模块的聚合导出，供上层调用：
 * - 会话压缩(compact)、历史限制(history)、车道(lanes)
 * - 单次运行(run)、运行队列与状态(runs)、中止与等待
 * - 沙箱信息、系统提示覆盖、extra 参数、工具拆分
 * - 类型：EmbeddedPiRunMeta、EmbeddedPiCompactResult 等
 */
export type { MessagingToolSend } from "./pi-embedded-messaging.js";
export { compactEmbeddedPiSession } from "./pi-embedded-runner/compact.js";
export { applyExtraParamsToAgent, resolveExtraParams } from "./pi-embedded-runner/extra-params.js";

export { applyGoogleTurnOrderingFix } from "./pi-embedded-runner/google.js";
export {
  getDmHistoryLimitFromSessionKey,
  getHistoryLimitFromSessionKey,
  limitHistoryTurns,
} from "./pi-embedded-runner/history.js";
export { resolveEmbeddedSessionLane } from "./pi-embedded-runner/lanes.js";
export { runEmbeddedPiAgent } from "./pi-embedded-runner/run.js";
export {
  abortEmbeddedPiRun,
  isEmbeddedPiRunActive,
  isEmbeddedPiRunStreaming,
  queueEmbeddedPiMessage,
  waitForEmbeddedPiRunEnd,
} from "./pi-embedded-runner/runs.js";
export { buildEmbeddedSandboxInfo } from "./pi-embedded-runner/sandbox-info.js";
export { createSystemPromptOverride } from "./pi-embedded-runner/system-prompt.js";
export { splitSdkTools } from "./pi-embedded-runner/tool-split.js";
export type {
  EmbeddedPiAgentMeta,
  EmbeddedPiCompactResult,
  EmbeddedPiRunMeta,
  EmbeddedPiRunResult,
} from "./pi-embedded-runner/types.js";
