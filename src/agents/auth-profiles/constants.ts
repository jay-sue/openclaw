/**
 * 认证 Profile 模块常量
 *
 * 存储版本与文件名、外部 CLI profile ID、文件锁重试配置、
 * 外部 CLI 同步 TTL 及子系统日志实例。
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";

/** 认证存储结构版本号 */
export const AUTH_STORE_VERSION = 1;
/** 当前认证存储文件名 */
export const AUTH_PROFILE_FILENAME = "auth-profiles.json";
/** 旧版认证存储文件名（迁移用） */
export const LEGACY_AUTH_FILENAME = "auth.json";

/** 外部 Claude CLI 的 profile ID */
export const CLAUDE_CLI_PROFILE_ID = "anthropic:claude-cli";
/** 外部 Codex CLI 的 profile ID */
export const CODEX_CLI_PROFILE_ID = "openai-codex:codex-cli";
/** 外部 Qwen CLI 的 profile ID */
export const QWEN_CLI_PROFILE_ID = "qwen-portal:qwen-cli";
/** 外部 MiniMax CLI 的 profile ID */
export const MINIMAX_CLI_PROFILE_ID = "minimax-portal:minimax-cli";

/** 存储文件锁选项：重试次数与退避、锁过期视为 stale 的毫秒数 */
export const AUTH_STORE_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 30_000,
} as const;

/** 外部 CLI 同步结果缓存 TTL：15 分钟 */
export const EXTERNAL_CLI_SYNC_TTL_MS = 15 * 60 * 1000;
/** 视为“临近过期”的阈值：10 分钟 */
export const EXTERNAL_CLI_NEAR_EXPIRY_MS = 10 * 60 * 1000;

/** 本子系统日志实例 */
export const log = createSubsystemLogger("agents/auth-profiles");
