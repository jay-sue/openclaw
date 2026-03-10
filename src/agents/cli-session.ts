/**
 * CLI 会话 ID 读写
 *
 * 从 SessionEntry 按 provider 读取/写入 CLI 侧会话 ID（如 Claude CLI session），
 * 兼容旧版 claudeCliSessionId 字段。
 */
import type { SessionEntry } from "../config/sessions.js";
import { normalizeProviderId } from "./model-selection.js";

/** 从会话条目中按 provider 取 CLI 会话 ID；claude-cli 会回退到 legacy 字段 */
export function getCliSessionId(
  entry: SessionEntry | undefined,
  provider: string,
): string | undefined {
  if (!entry) {
    return undefined;
  }
  const normalized = normalizeProviderId(provider);
  const fromMap = entry.cliSessionIds?.[normalized];
  if (fromMap?.trim()) {
    return fromMap.trim();
  }
  if (normalized === "claude-cli") {
    const legacy = entry.claudeCliSessionId?.trim();
    if (legacy) {
      return legacy;
    }
  }
  return undefined;
}

/** 将会话条目中该 provider 的 CLI 会话 ID 写入；claude-cli 时同时写 legacy 字段 */
export function setCliSessionId(entry: SessionEntry, provider: string, sessionId: string): void {
  const normalized = normalizeProviderId(provider);
  const trimmed = sessionId.trim();
  if (!trimmed) {
    return;
  }
  const existing = entry.cliSessionIds ?? {};
  entry.cliSessionIds = { ...existing };
  entry.cliSessionIds[normalized] = trimmed;
  if (normalized === "claude-cli") {
    entry.claudeCliSessionId = trimmed;
  }
}
