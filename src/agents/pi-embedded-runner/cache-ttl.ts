/**
 * Cache TTL：在会话中记录 cache 相关时间戳（custom entry），用于 context-pruning 等扩展判断缓存有效期。
 * 支持原生 provider（anthropic/moonshot/zai）与 OpenRouter/kilocode 下对应模型。
 */
type CustomEntryLike = { type?: unknown; customType?: unknown; data?: unknown };

/** 会话中 cache TTL 自定义条目的类型标识 */
export const CACHE_TTL_CUSTOM_TYPE = "openclaw.cache-ttl";

export type CacheTtlEntryData = {
  timestamp: number;
  provider?: string;
  modelId?: string;
};

const CACHE_TTL_NATIVE_PROVIDERS = new Set(["anthropic", "moonshot", "zai"]);
const OPENROUTER_CACHE_TTL_MODEL_PREFIXES = [
  "anthropic/",
  "moonshot/",
  "moonshotai/",
  "zai/",
] as const;

function isOpenRouterCacheTtlModel(modelId: string): boolean {
  return OPENROUTER_CACHE_TTL_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}

/** 判断当前 provider/modelId 是否支持 cache TTL（可写入/读取 cache-ttl custom entry） */
export function isCacheTtlEligibleProvider(provider: string, modelId: string): boolean {
  const normalizedProvider = provider.toLowerCase();
  const normalizedModelId = modelId.toLowerCase();
  if (CACHE_TTL_NATIVE_PROVIDERS.has(normalizedProvider)) {
    return true;
  }
  if (normalizedProvider === "openrouter" && isOpenRouterCacheTtlModel(normalizedModelId)) {
    return true;
  }
  if (normalizedProvider === "kilocode" && normalizedModelId.startsWith("anthropic/")) {
    return true;
  }
  return false;
}

/** 从 SessionManager 的 entries 中读取最近一次 cache TTL 时间戳 */
export function readLastCacheTtlTimestamp(sessionManager: unknown): number | null {
  const sm = sessionManager as { getEntries?: () => CustomEntryLike[] };
  if (!sm?.getEntries) {
    return null;
  }
  try {
    const entries = sm.getEntries();
    let last: number | null = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.type !== "custom" || entry?.customType !== CACHE_TTL_CUSTOM_TYPE) {
        continue;
      }
      const data = entry?.data as Partial<CacheTtlEntryData> | undefined;
      const ts = typeof data?.timestamp === "number" ? data.timestamp : null;
      if (ts && Number.isFinite(ts)) {
        last = ts;
        break;
      }
    }
    return last;
  } catch {
    return null;
  }
}

/** 向 SessionManager 追加一条 cache TTL custom entry，用于后续 context-pruning 等 */
export function appendCacheTtlTimestamp(sessionManager: unknown, data: CacheTtlEntryData): void {
  const sm = sessionManager as {
    appendCustomEntry?: (customType: string, data: unknown) => void;
  };
  if (!sm?.appendCustomEntry) {
    return;
  }
  try {
    sm.appendCustomEntry(CACHE_TTL_CUSTOM_TYPE, data);
  } catch {
    // ignore persistence failures
  }
}
