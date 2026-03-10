/**
 * Profile ID 漂移修复
 *
 * 当配置仍引用旧版 provider:default 而 store 中已为 OAuth 新 profile 时，
 * 通过 email/lastGood/命名启发式为 legacy 找到新 profileId，并执行配置迁移。
 */
import type { OpenClawConfig } from "../../config/config.js";
import type { AuthProfileConfig } from "../../config/types.js";
import { findNormalizedProviderKey, normalizeProviderId } from "../model-selection.js";
import { dedupeProfileIds, listProfilesForProvider } from "./profiles.js";
import type { AuthProfileIdRepairResult, AuthProfileStore } from "./types.js";

function getProfileSuffix(profileId: string): string {
  const idx = profileId.indexOf(":");
  if (idx < 0) {
    return "";
  }
  return profileId.slice(idx + 1);
}

function isEmailLike(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  return trimmed.includes("@") && trimmed.includes(".");
}

/** 为 legacy profileId（如 anthropic:default）建议一个可用的 OAuth profileId：按 email、lastGood、单候选、email 风格后缀 优先级 */
export function suggestOAuthProfileIdForLegacyDefault(params: {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  legacyProfileId: string;
}): string | null {
  const providerKey = normalizeProviderId(params.provider);
  const legacySuffix = getProfileSuffix(params.legacyProfileId);
  if (legacySuffix !== "default") {
    return null;
  }

  const legacyCfg = params.cfg?.auth?.profiles?.[params.legacyProfileId];
  if (
    legacyCfg &&
    normalizeProviderId(legacyCfg.provider) === providerKey &&
    legacyCfg.mode !== "oauth"
  ) {
    return null;
  }

  const oauthProfiles = listProfilesForProvider(params.store, providerKey).filter(
    (id) => params.store.profiles[id]?.type === "oauth",
  );
  if (oauthProfiles.length === 0) {
    return null;
  }

  const configuredEmail = legacyCfg?.email?.trim();
  if (configuredEmail) {
    const byEmail = oauthProfiles.find((id) => {
      const cred = params.store.profiles[id];
      if (!cred || cred.type !== "oauth") {
        return false;
      }
      const email = cred.email?.trim();
      return email === configuredEmail || id === `${providerKey}:${configuredEmail}`;
    });
    if (byEmail) {
      return byEmail;
    }
  }

  const lastGood = params.store.lastGood?.[providerKey] ?? params.store.lastGood?.[params.provider];
  if (lastGood && oauthProfiles.includes(lastGood)) {
    return lastGood;
  }

  const nonLegacy = oauthProfiles.filter((id) => id !== params.legacyProfileId);
  if (nonLegacy.length === 1) {
    return nonLegacy[0] ?? null;
  }

  const emailLike = nonLegacy.filter((id) => isEmailLike(getProfileSuffix(id)));
  if (emailLike.length === 1) {
    return emailLike[0] ?? null;
  }

  return null;
}

/** 执行 OAuth profile ID 迁移：将配置中 legacyProfileId 替换为建议的新 profileId，并更新 auth.order */
export function repairOAuthProfileIdMismatch(params: {
  cfg: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  legacyProfileId?: string;
}): AuthProfileIdRepairResult {
  const legacyProfileId =
    params.legacyProfileId ?? `${normalizeProviderId(params.provider)}:default`;
  const legacyCfg = params.cfg.auth?.profiles?.[legacyProfileId];
  if (!legacyCfg) {
    return { config: params.cfg, changes: [], migrated: false };
  }
  if (legacyCfg.mode !== "oauth") {
    return { config: params.cfg, changes: [], migrated: false };
  }
  if (normalizeProviderId(legacyCfg.provider) !== normalizeProviderId(params.provider)) {
    return { config: params.cfg, changes: [], migrated: false };
  }

  const toProfileId = suggestOAuthProfileIdForLegacyDefault({
    cfg: params.cfg,
    store: params.store,
    provider: params.provider,
    legacyProfileId,
  });
  if (!toProfileId || toProfileId === legacyProfileId) {
    return { config: params.cfg, changes: [], migrated: false };
  }

  const toCred = params.store.profiles[toProfileId];
  const toEmail = toCred?.type === "oauth" ? toCred.email?.trim() : undefined;

  const nextProfiles = {
    ...params.cfg.auth?.profiles,
  } as Record<string, AuthProfileConfig>;
  delete nextProfiles[legacyProfileId];
  nextProfiles[toProfileId] = {
    ...legacyCfg,
    ...(toEmail ? { email: toEmail } : {}),
  };

  const providerKey = normalizeProviderId(params.provider);
  const nextOrder = (() => {
    const order = params.cfg.auth?.order;
    if (!order) {
      return undefined;
    }
    const resolvedKey = findNormalizedProviderKey(order, providerKey);
    if (!resolvedKey) {
      return order;
    }
    const existing = order[resolvedKey];
    if (!Array.isArray(existing)) {
      return order;
    }
    const replaced = existing
      .map((id) => (id === legacyProfileId ? toProfileId : id))
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0);
    const deduped = dedupeProfileIds(replaced);
    return { ...order, [resolvedKey]: deduped };
  })();

  const nextCfg: OpenClawConfig = {
    ...params.cfg,
    auth: {
      ...params.cfg.auth,
      profiles: nextProfiles,
      ...(nextOrder ? { order: nextOrder } : {}),
    },
  };

  const changes = [`Auth: migrate ${legacyProfileId} → ${toProfileId} (OAuth profile id)`];

  return {
    config: nextCfg,
    changes,
    migrated: true,
    fromProfileId: legacyProfileId,
    toProfileId,
  };
}
