/**
 * 认证 Profile 核心类型定义
 *
 * 本模块定义多认证 profile 的凭据类型、存储结构及失败原因枚举，
 * 供存储层、OAuth 解析、轮询排序与诊断修复使用。
 */
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import type { SecretRef } from "../../config/types.secrets.js";

/** API Key 凭据：静态密钥或 SecretRef 引用 */
export type ApiKeyCredential = {
  type: "api_key";
  provider: string;
  key?: string;
  keyRef?: SecretRef;
  email?: string;
  /** 可选：provider 专属元数据（如 account ID、gateway ID） */
  metadata?: Record<string, string>;
};

/** Token 凭据：静态 bearer token（如 OAuth access token / PAT），OpenClaw 不负责刷新，与 oauth 类型区分 */
export type TokenCredential = {
  type: "token";
  provider: string;
  token?: string;
  tokenRef?: SecretRef;
  /** 可选：过期时间戳（毫秒，自 epoch） */
  expires?: number;
  email?: string;
};

/** OAuth 凭据：可刷新的 OAuth，继承 pi-ai 的 OAuthCredentials */
export type OAuthCredential = OAuthCredentials & {
  type: "oauth";
  provider: string;
  clientId?: string;
  email?: string;
};

/** 认证 profile 凭据联合类型 */
export type AuthProfileCredential = ApiKeyCredential | TokenCredential | OAuthCredential;

/** 认证失败原因码，用于冷却/禁用分类与诊断 */
export type AuthProfileFailureReason =
  | "auth"
  | "auth_permanent"
  | "format"
  | "overloaded"
  | "rate_limit"
  | "billing"
  | "timeout"
  | "model_not_found"
  | "session_expired"
  | "unknown";

/** 单 profile 使用统计：用于轮询与冷却追踪（上次使用、冷却/禁用截止、错误计数等） */
export type ProfileUsageStats = {
  lastUsed?: number;
  cooldownUntil?: number;
  disabledUntil?: number;
  disabledReason?: AuthProfileFailureReason;
  errorCount?: number;
  failureCounts?: Partial<Record<AuthProfileFailureReason, number>>;
  lastFailureAt?: number;
};

/** 认证存储根结构：版本、profiles 表、可选按 agent 的排序覆盖与使用统计 */
export type AuthProfileStore = {
  version: number;
  profiles: Record<string, AuthProfileCredential>;
  /** 可选：按 agent 的 profile 排序覆盖，用于在不改全局配置下锁定/覆盖某 agent 的认证轮询 */
  order?: Record<string, string[]>;
  lastGood?: Record<string, string>;
  /** 各 profile 的使用统计，用于 round-robin 轮询 */
  usageStats?: Record<string, ProfileUsageStats>;
};

/** Profile ID 修复结果：迁移后的配置、变更描述、是否发生迁移、迁移前后 profileId */
export type AuthProfileIdRepairResult = {
  config: OpenClawConfig;
  changes: string[];
  migrated: boolean;
  fromProfileId?: string;
  toProfileId?: string;
};
