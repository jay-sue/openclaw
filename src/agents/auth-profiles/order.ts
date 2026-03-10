/**
 * 认证 Profile 排序与轮询
 *
 * 按配置/存储的显式排序或自动发现确定使用顺序；支持 eligibility 过滤、
 * 冷却 profile 排末尾、round-robin（类型优先级 oauth > token > api_key，同类型按 lastUsed 最旧优先）、
 * preferredProfile 优先。
 */
import type { OpenClawConfig } from "../../config/config.js";
import {
  findNormalizedProviderValue,
  normalizeProviderId,
  normalizeProviderIdForAuth,
} from "../model-selection.js";
import {
  evaluateStoredCredentialEligibility,
  type AuthCredentialReasonCode,
} from "./credential-state.js";
import { dedupeProfileIds, listProfilesForProvider } from "./profiles.js";
import type { AuthProfileStore } from "./types.js";
import {
  clearExpiredCooldowns,
  isProfileInCooldown,
  resolveProfileUnusableUntil,
} from "./usage.js";

export type AuthProfileEligibilityReasonCode =
  | AuthCredentialReasonCode
  | "profile_missing"
  | "provider_mismatch"
  | "mode_mismatch";

export type AuthProfileEligibility = {
  eligible: boolean;
  reasonCode: AuthProfileEligibilityReasonCode;
};

/** 判断某 profile 对某 provider 是否可用：profile 存在、provider 一致、配置 mode 与凭据 type 兼容、凭据本身 eligible */
export function resolveAuthProfileEligibility(params: {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  profileId: string;
  now?: number;
}): AuthProfileEligibility {
  const providerAuthKey = normalizeProviderIdForAuth(params.provider);
  const cred = params.store.profiles[params.profileId];
  if (!cred) {
    return { eligible: false, reasonCode: "profile_missing" };
  }
  if (normalizeProviderIdForAuth(cred.provider) !== providerAuthKey) {
    return { eligible: false, reasonCode: "provider_mismatch" };
  }
  const profileConfig = params.cfg?.auth?.profiles?.[params.profileId];
  if (profileConfig) {
    if (normalizeProviderIdForAuth(profileConfig.provider) !== providerAuthKey) {
      return { eligible: false, reasonCode: "provider_mismatch" };
    }
    if (profileConfig.mode !== cred.type) {
      const oauthCompatible = profileConfig.mode === "oauth" && cred.type === "token";
      if (!oauthCompatible) {
        return { eligible: false, reasonCode: "mode_mismatch" };
      }
    }
  }
  const credentialEligibility = evaluateStoredCredentialEligibility({
    credential: cred,
    now: params.now,
  });
  return {
    eligible: credentialEligibility.eligible,
    reasonCode: credentialEligibility.reasonCode,
  };
}

/**
 * 解析某 provider 的 profile 使用顺序：先清过期冷却，再取显式排序或自动发现，过滤 eligible，冷却排末尾，支持 preferredProfile 置顶。
 */
export function resolveAuthProfileOrder(params: {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  preferredProfile?: string;
}): string[] {
  const { cfg, store, provider, preferredProfile } = params;
  const providerKey = normalizeProviderId(provider);
  const providerAuthKey = normalizeProviderIdForAuth(provider);
  const now = Date.now();

  clearExpiredCooldowns(store, now);
  const storedOrder = findNormalizedProviderValue(store.order, providerKey);
  const configuredOrder = findNormalizedProviderValue(cfg?.auth?.order, providerKey);
  const explicitOrder = storedOrder ?? configuredOrder;
  const explicitProfiles = cfg?.auth?.profiles
    ? Object.entries(cfg.auth.profiles)
        .filter(([, profile]) => normalizeProviderIdForAuth(profile.provider) === providerAuthKey)
        .map(([profileId]) => profileId)
    : [];
  const baseOrder =
    explicitOrder ??
    (explicitProfiles.length > 0 ? explicitProfiles : listProfilesForProvider(store, provider));
  if (baseOrder.length === 0) {
    return [];
  }

  const isValidProfile = (profileId: string): boolean =>
    resolveAuthProfileEligibility({
      cfg,
      store,
      provider: providerAuthKey,
      profileId,
      now,
    }).eligible;
  let filtered = baseOrder.filter(isValidProfile);

  // 配置中的 profileId 在 store 中不存在时，用该 provider 下存储的合法 profile 补全（修复旧引导流程漂移）
  const allBaseProfilesMissing = baseOrder.every((profileId) => !store.profiles[profileId]);
  if (filtered.length === 0 && explicitProfiles.length > 0 && allBaseProfilesMissing) {
    const storeProfiles = listProfilesForProvider(store, provider);
    filtered = storeProfiles.filter(isValidProfile);
  }

  const deduped = dedupeProfileIds(filtered);

  if (explicitOrder && explicitOrder.length > 0) {
    const available: string[] = [];
    const inCooldown: Array<{ profileId: string; cooldownUntil: number }> = [];

    for (const profileId of deduped) {
      if (isProfileInCooldown(store, profileId)) {
        const cooldownUntil =
          resolveProfileUnusableUntil(store.usageStats?.[profileId] ?? {}) ?? now;
        inCooldown.push({ profileId, cooldownUntil });
      } else {
        available.push(profileId);
      }
    }

    const cooldownSorted = inCooldown
      .toSorted((a, b) => a.cooldownUntil - b.cooldownUntil)
      .map((entry) => entry.profileId);

    const ordered = [...available, ...cooldownSorted];

    if (preferredProfile && ordered.includes(preferredProfile)) {
      return [preferredProfile, ...ordered.filter((e) => e !== preferredProfile)];
    }
    return ordered;
  }

  const sorted = orderProfilesByMode(deduped, store);

  if (preferredProfile && sorted.includes(preferredProfile)) {
    return [preferredProfile, ...sorted.filter((e) => e !== preferredProfile)];
  }

  return sorted;
}

/** 按类型偏好（oauth > token > api_key）与 lastUsed 最旧优先排序，冷却中的排到末尾并按冷却到期时间排序 */
function orderProfilesByMode(order: string[], store: AuthProfileStore): string[] {
  const now = Date.now();

  const available: string[] = [];
  const inCooldown: string[] = [];

  for (const profileId of order) {
    if (isProfileInCooldown(store, profileId)) {
      inCooldown.push(profileId);
    } else {
      available.push(profileId);
    }
  }

  const scored = available.map((profileId) => {
    const type = store.profiles[profileId]?.type;
    const typeScore = type === "oauth" ? 0 : type === "token" ? 1 : type === "api_key" ? 2 : 3;
    const lastUsed = store.usageStats?.[profileId]?.lastUsed ?? 0;
    return { profileId, typeScore, lastUsed };
  });

  const sorted = scored
    .toSorted((a, b) => {
      if (a.typeScore !== b.typeScore) {
        return a.typeScore - b.typeScore;
      }
      return a.lastUsed - b.lastUsed;
    })
    .map((entry) => entry.profileId);

  const cooldownSorted = inCooldown
    .map((profileId) => ({
      profileId,
      cooldownUntil: resolveProfileUnusableUntil(store.usageStats?.[profileId] ?? {}) ?? now,
    }))
    .toSorted((a, b) => a.cooldownUntil - b.cooldownUntil)
    .map((entry) => entry.profileId);

  return [...sorted, ...cooldownSorted];
}
