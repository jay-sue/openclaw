/**
 * 认证 Profile 失败状态观测
 *
 * 在 profile 失败状态变更时输出结构化日志（错误计数、冷却/禁用窗口、是否复用已有窗口等），
 * 对 profileId/runId/provider 做脱敏后写入日志。
 */
import { redactIdentifier } from "../../logging/redact-identifier.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { sanitizeForConsole } from "../pi-embedded-error-observation.js";
import type { AuthProfileFailureReason, ProfileUsageStats } from "./types.js";

const observationLog = createSubsystemLogger("agent/embedded");

/**
 * 记录某 profile 失败状态变更：区分冷却(cooldown)与禁用(disabled)，并标记本次是否复用了已有窗口（未延长）。
 */
export function logAuthProfileFailureStateChange(params: {
  runId?: string;
  profileId: string;
  provider: string;
  reason: AuthProfileFailureReason;
  previous: ProfileUsageStats | undefined;
  next: ProfileUsageStats;
  now: number;
}): void {
  // billing / auth_permanent 使用长周期禁用(disabled)，其余为短周期冷却(cooldown)
  const windowType =
    params.reason === "billing" || params.reason === "auth_permanent" ? "disabled" : "cooldown";
  const previousCooldownUntil = params.previous?.cooldownUntil;
  const previousDisabledUntil = params.previous?.disabledUntil;
  // 活跃的冷却/禁用窗口设计上不可变；此处记录本次更新是复用了已有窗口而非延长
  const windowReused =
    windowType === "disabled"
      ? typeof previousDisabledUntil === "number" &&
        Number.isFinite(previousDisabledUntil) &&
        previousDisabledUntil > params.now &&
        previousDisabledUntil === params.next.disabledUntil
      : typeof previousCooldownUntil === "number" &&
        Number.isFinite(previousCooldownUntil) &&
        previousCooldownUntil > params.now &&
        previousCooldownUntil === params.next.cooldownUntil;
  const safeProfileId = redactIdentifier(params.profileId, { len: 12 });
  const safeRunId = sanitizeForConsole(params.runId) ?? "-";
  const safeProvider = sanitizeForConsole(params.provider) ?? "-";

  observationLog.warn("auth profile failure state updated", {
    event: "auth_profile_failure_state_updated",
    tags: ["error_handling", "auth_profiles", windowType],
    runId: params.runId,
    profileId: safeProfileId,
    provider: params.provider,
    reason: params.reason,
    windowType,
    windowReused,
    previousErrorCount: params.previous?.errorCount,
    errorCount: params.next.errorCount,
    previousCooldownUntil,
    cooldownUntil: params.next.cooldownUntil,
    previousDisabledUntil,
    disabledUntil: params.next.disabledUntil,
    previousDisabledReason: params.previous?.disabledReason,
    disabledReason: params.next.disabledReason,
    failureCounts: params.next.failureCounts,
    consoleMessage:
      `auth profile failure state updated: runId=${safeRunId} profile=${safeProfileId} provider=${safeProvider} ` +
      `reason=${params.reason} window=${windowType} reused=${String(windowReused)}`,
  });
}
