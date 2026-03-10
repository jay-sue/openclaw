/**
 * 认证 Profile 显示辅助
 *
 * 根据配置与存储中的 email 信息生成可读的 profile 标签（如 `profileId (email)`）。
 */
import type { OpenClawConfig } from "../../config/config.js";
import type { AuthProfileStore } from "./types.js";

/**
 * 解析某 profile 的展示标签：优先用配置中的 email，否则用存储中 profile 的 email；无 email 则仅返回 profileId。
 */
export function resolveAuthProfileDisplayLabel(params: {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  profileId: string;
}): string {
  const { cfg, store, profileId } = params;
  const profile = store.profiles[profileId];
  const configEmail = cfg?.auth?.profiles?.[profileId]?.email?.trim();
  const email = configEmail || (profile && "email" in profile ? profile.email?.trim() : undefined);
  if (email) {
    return `${profileId} (${email})`;
  }
  return profileId;
}
