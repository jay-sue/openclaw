import { coerceSecretRef, normalizeSecretInputString } from "../../config/types.secrets.js";
import type { AuthProfileCredential } from "./types.js";

/**
 * 认证 profile 排序/冷却逻辑使用的标准原因码。
 * 这里的枚举值需要保持稳定，便于上层按固定字面量做分支判断。
 */
export type AuthCredentialReasonCode =
  | "ok"
  | "missing_credential"
  | "invalid_expires"
  | "expired"
  | "unresolved_ref";

/**
 * Token 过期状态分类。
 * - missing: 未提供过期时间（按“无过期信息”处理）
 * - valid: 过期时间是未来时刻
 * - expired: 过期时间已到或已过
 * - invalid_expires: 过期时间格式非法
 */
export type TokenExpiryState = "missing" | "valid" | "expired" | "invalid_expires";

/**
 * 将原始 `expires` 值归一化为确定的状态。
 * 这里故意采用严格校验：只接受“正的有限数值”时间戳。
 */
export function resolveTokenExpiryState(expires: unknown, now = Date.now()): TokenExpiryState {
  if (expires === undefined) {
    return "missing";
  }
  if (typeof expires !== "number") {
    return "invalid_expires";
  }
  if (!Number.isFinite(expires) || expires <= 0) {
    return "invalid_expires";
  }
  return now >= expires ? "expired" : "valid";
}

/**
 * 当值在语法上是合法 SecretRef 时返回 true
 * （例如 `${secrets.MY_KEY}`），此处不要求已完成解引用。
 */
function hasConfiguredSecretRef(value: unknown): boolean {
  return coerceSecretRef(value) !== null;
}

/**
 * 当值可被归一化为非空密钥输入时返回 true。
 * 空字符串或非字符串值统一视为“未配置”。
 */
function hasConfiguredSecretString(value: unknown): boolean {
  return normalizeSecretInputString(value) !== undefined;
}

/**
 * 评估存储凭据是否可参与 profile 选择。
 *
 * 说明：
 * - 这里只检查“配置层”可用性。
 * - 不做 SecretRef 解引用，也不做网络/Provider 侧有效性校验。
 * - OAuth 凭据只要 access/refresh 任一存在即视为可用，
 *   以避免把仍可刷新令牌的 profile 过早剔除。
 */
export function evaluateStoredCredentialEligibility(params: {
  credential: AuthProfileCredential;
  now?: number;
}): { eligible: boolean; reasonCode: AuthCredentialReasonCode } {
  const now = params.now ?? Date.now();
  const credential = params.credential;

  if (credential.type === "api_key") {
    const hasKey = hasConfiguredSecretString(credential.key);
    const hasKeyRef = hasConfiguredSecretRef(credential.keyRef);
    if (!hasKey && !hasKeyRef) {
      return { eligible: false, reasonCode: "missing_credential" };
    }
    return { eligible: true, reasonCode: "ok" };
  }

  if (credential.type === "token") {
    const hasToken = hasConfiguredSecretString(credential.token);
    const hasTokenRef = hasConfiguredSecretRef(credential.tokenRef);
    if (!hasToken && !hasTokenRef) {
      return { eligible: false, reasonCode: "missing_credential" };
    }

    const expiryState = resolveTokenExpiryState(credential.expires, now);
    if (expiryState === "invalid_expires") {
      return { eligible: false, reasonCode: "invalid_expires" };
    }
    if (expiryState === "expired") {
      return { eligible: false, reasonCode: "expired" };
    }
    return { eligible: true, reasonCode: "ok" };
  }

  // OAuth 分支：只要有可直接使用的 access，或可换取新 access 的 refresh，
  // 就保留该 profile 参与后续选择。
  if (
    normalizeSecretInputString(credential.access) === undefined &&
    normalizeSecretInputString(credential.refresh) === undefined
  ) {
    return { eligible: false, reasonCode: "missing_credential" };
  }
  return { eligible: true, reasonCode: "ok" };
}
