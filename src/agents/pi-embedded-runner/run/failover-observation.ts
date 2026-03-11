/**
 * Failover 决策观测：创建并调用 failover 决策日志（rotate_profile / fallback_model / surface_error），
 * 用于诊断认证轮换与 model fallback。
 */
import { redactIdentifier } from "../../../logging/redact-identifier.js";
import type { AuthProfileFailureReason } from "../../auth-profiles.js";
import {
  buildApiErrorObservationFields,
  sanitizeForConsole,
} from "../../pi-embedded-error-observation.js";
import type { FailoverReason } from "../../pi-embedded-helpers.js";
import { log } from "../logger.js";

/** 单次 failover 决策日志的完整输入：阶段、决策类型、错误与 provider/model 等 */
export type FailoverDecisionLoggerInput = {
  stage: "prompt" | "assistant";
  decision: "rotate_profile" | "fallback_model" | "surface_error";
  runId?: string;
  rawError?: string;
  failoverReason: FailoverReason | null;
  profileFailureReason?: AuthProfileFailureReason | null;
  provider: string;
  model: string;
  profileId?: string;
  fallbackConfigured: boolean;
  timedOut?: boolean;
  aborted?: boolean;
  status?: number;
};

/** 创建 logger 时的基类入参（不含 decision 与 status，由调用时传入） */
export type FailoverDecisionLoggerBase = Omit<FailoverDecisionLoggerInput, "decision" | "status">;

/** 规范化基类：若未显式给出 failoverReason/profileFailureReason 且 timedOut，则补全为 "timeout" */
export function normalizeFailoverDecisionObservationBase(
  base: FailoverDecisionLoggerBase,
): FailoverDecisionLoggerBase {
  return {
    ...base,
    failoverReason: base.failoverReason ?? (base.timedOut ? "timeout" : null),
    profileFailureReason: base.profileFailureReason ?? (base.timedOut ? "timeout" : null),
  };
}

/** 创建 failover 决策日志函数；返回的函数在调用时写入 warn 日志（含 runId/stage/decision/reason/provider/model），敏感字段已脱敏 */
export function createFailoverDecisionLogger(
  base: FailoverDecisionLoggerBase,
): (
  decision: FailoverDecisionLoggerInput["decision"],
  extra?: Pick<FailoverDecisionLoggerInput, "status">,
) => void {
  const normalizedBase = normalizeFailoverDecisionObservationBase(base);
  // profileId 脱敏，仅保留前 12 字符等
  const safeProfileId = normalizedBase.profileId
    ? redactIdentifier(normalizedBase.profileId, { len: 12 })
    : undefined;
  const safeRunId = sanitizeForConsole(normalizedBase.runId) ?? "-";
  const safeProvider = sanitizeForConsole(normalizedBase.provider) ?? "-";
  const safeModel = sanitizeForConsole(normalizedBase.model) ?? "-";
  const profileText = safeProfileId ?? "-";
  const reasonText = normalizedBase.failoverReason ?? "none";
  return (decision, extra) => {
    const observedError = buildApiErrorObservationFields(normalizedBase.rawError);
    log.warn("embedded run failover decision", {
      event: "embedded_run_failover_decision",
      tags: ["error_handling", "failover", normalizedBase.stage, decision],
      runId: normalizedBase.runId,
      stage: normalizedBase.stage,
      decision,
      failoverReason: normalizedBase.failoverReason,
      profileFailureReason: normalizedBase.profileFailureReason,
      provider: normalizedBase.provider,
      model: normalizedBase.model,
      profileId: safeProfileId,
      fallbackConfigured: normalizedBase.fallbackConfigured,
      timedOut: normalizedBase.timedOut,
      aborted: normalizedBase.aborted,
      status: extra?.status,
      ...observedError,
      consoleMessage:
        `embedded run failover decision: runId=${safeRunId} stage=${normalizedBase.stage} decision=${decision} ` +
        `reason=${reasonText} provider=${safeProvider}/${safeModel} profile=${profileText}`,
    });
  };
}
