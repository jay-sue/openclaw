/**
 * 认证存储核心读写层
 *
 * 负责加载/解析/保存 auth-profiles.json，兼容旧版 auth.json 自动迁移，
 * 运行时内存快照、主代理与子代理存储合并、带文件锁的原子更新；
 * 保存时自动清除明文密钥（仅保留 keyRef/tokenRef）。
 */
import fs from "node:fs";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { resolveOAuthPath } from "../../config/paths.js";
import { withFileLock } from "../../infra/file-lock.js";
import { loadJsonFile, saveJsonFile } from "../../infra/json-file.js";
import { AUTH_STORE_LOCK_OPTIONS, AUTH_STORE_VERSION, log } from "./constants.js";
import { syncExternalCliCredentials } from "./external-cli-sync.js";
import { ensureAuthStoreFile, resolveAuthStorePath, resolveLegacyAuthStorePath } from "./paths.js";
import type { AuthProfileCredential, AuthProfileStore, ProfileUsageStats } from "./types.js";

/** 旧版 auth.json 的存储结构：key -> 凭据 */
type LegacyAuthStore = Record<string, AuthProfileCredential>;
/** 解析凭据条目时的拒绝原因 */
type CredentialRejectReason = "non_object" | "invalid_type" | "missing_provider";
type RejectedCredentialEntry = { key: string; reason: CredentialRejectReason };
type LoadAuthProfileStoreOptions = {
  allowKeychainPrompt?: boolean;
  readOnly?: boolean;
};

const AUTH_PROFILE_TYPES = new Set<AuthProfileCredential["type"]>(["api_key", "oauth", "token"]);

/** 运行时内存中的存储快照（按 agentDir 对应路径为 key） */
const runtimeAuthStoreSnapshots = new Map<string, AuthProfileStore>();

function resolveRuntimeStoreKey(agentDir?: string): string {
  return resolveAuthStorePath(agentDir);
}

function cloneAuthProfileStore(store: AuthProfileStore): AuthProfileStore {
  return structuredClone(store);
}

/**
 * 从运行时快照解析存储：无 agentDir 或与主代理同路径时返回主快照；
 * 否则合并主代理与子代理存储（子代理覆盖主代理同 key）。
 */
function resolveRuntimeAuthProfileStore(agentDir?: string): AuthProfileStore | null {
  if (runtimeAuthStoreSnapshots.size === 0) {
    return null;
  }

  const mainKey = resolveRuntimeStoreKey(undefined);
  const requestedKey = resolveRuntimeStoreKey(agentDir);
  const mainStore = runtimeAuthStoreSnapshots.get(mainKey);
  const requestedStore = runtimeAuthStoreSnapshots.get(requestedKey);

  if (!agentDir || requestedKey === mainKey) {
    if (!mainStore) {
      return null;
    }
    return cloneAuthProfileStore(mainStore);
  }

  if (mainStore && requestedStore) {
    return mergeAuthProfileStores(
      cloneAuthProfileStore(mainStore),
      cloneAuthProfileStore(requestedStore),
    );
  }
  if (requestedStore) {
    return cloneAuthProfileStore(requestedStore);
  }
  if (mainStore) {
    return cloneAuthProfileStore(mainStore);
  }

  return null;
}

/** 用给定条目替换运行时存储快照（用于测试或一次性注入） */
export function replaceRuntimeAuthProfileStoreSnapshots(
  entries: Array<{ agentDir?: string; store: AuthProfileStore }>,
): void {
  runtimeAuthStoreSnapshots.clear();
  for (const entry of entries) {
    runtimeAuthStoreSnapshots.set(
      resolveRuntimeStoreKey(entry.agentDir),
      cloneAuthProfileStore(entry.store),
    );
  }
}

/** 清空运行时存储快照 */
export function clearRuntimeAuthProfileStoreSnapshots(): void {
  runtimeAuthStoreSnapshots.clear();
}

/** 在文件锁下执行 store 更新：若 updater 返回 true 则写回磁盘，返回更新后的 store 或 null */
export async function updateAuthProfileStoreWithLock(params: {
  agentDir?: string;
  updater: (store: AuthProfileStore) => boolean;
}): Promise<AuthProfileStore | null> {
  const authPath = resolveAuthStorePath(params.agentDir);
  ensureAuthStoreFile(authPath);

  try {
    return await withFileLock(authPath, AUTH_STORE_LOCK_OPTIONS, async () => {
      const store = ensureAuthProfileStore(params.agentDir);
      const shouldSave = params.updater(store);
      if (shouldSave) {
        saveAuthProfileStore(store, params.agentDir);
      }
      return store;
    });
  } catch {
    return null;
  }
}

/**
 * 归一化原始 auth-profiles.json 中的凭据条目。
 * 官方格式使用 type 与 key；用户常误写成 openclaw.json 里的 mode / apiKey，此处兼容两种写法。
 */
function normalizeRawCredentialEntry(raw: Record<string, unknown>): Partial<AuthProfileCredential> {
  const entry = { ...raw } as Record<string, unknown>;
  if (!("type" in entry) && typeof entry["mode"] === "string") {
    entry["type"] = entry["mode"];
  }
  if (!("key" in entry) && typeof entry["apiKey"] === "string") {
    entry["key"] = entry["apiKey"];
  }
  return entry as Partial<AuthProfileCredential>;
}

function parseCredentialEntry(
  raw: unknown,
  fallbackProvider?: string,
): { ok: true; credential: AuthProfileCredential } | { ok: false; reason: CredentialRejectReason } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "non_object" };
  }
  const typed = normalizeRawCredentialEntry(raw as Record<string, unknown>);
  if (!AUTH_PROFILE_TYPES.has(typed.type as AuthProfileCredential["type"])) {
    return { ok: false, reason: "invalid_type" };
  }
  const provider = typed.provider ?? fallbackProvider;
  if (typeof provider !== "string" || provider.trim().length === 0) {
    return { ok: false, reason: "missing_provider" };
  }
  return {
    ok: true,
    credential: {
      ...typed,
      provider,
    } as AuthProfileCredential,
  };
}

function warnRejectedCredentialEntries(source: string, rejected: RejectedCredentialEntry[]): void {
  if (rejected.length === 0) {
    return;
  }
  const reasons = rejected.reduce(
    (acc, current) => {
      acc[current.reason] = (acc[current.reason] ?? 0) + 1;
      return acc;
    },
    {} as Partial<Record<CredentialRejectReason, number>>,
  );
  log.warn("ignored invalid auth profile entries during store load", {
    source,
    dropped: rejected.length,
    reasons,
    keys: rejected.slice(0, 10).map((entry) => entry.key),
  });
}

/** 将旧版 auth.json 原始内容强制解析为 LegacyAuthStore；若已是新格式（含 profiles）则返回 null */
function coerceLegacyStore(raw: unknown): LegacyAuthStore | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if ("profiles" in record) {
    return null;
  }
  const entries: LegacyAuthStore = {};
  const rejected: RejectedCredentialEntry[] = [];
  for (const [key, value] of Object.entries(record)) {
    const parsed = parseCredentialEntry(value, key);
    if (!parsed.ok) {
      rejected.push({ key, reason: parsed.reason });
      continue;
    }
    entries[key] = parsed.credential;
  }
  warnRejectedCredentialEntries("auth.json", rejected);
  return Object.keys(entries).length > 0 ? entries : null;
}

function coerceAuthStore(raw: unknown): AuthProfileStore | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (!record.profiles || typeof record.profiles !== "object") {
    return null;
  }
  const profiles = record.profiles as Record<string, unknown>;
  const normalized: Record<string, AuthProfileCredential> = {};
  const rejected: RejectedCredentialEntry[] = [];
  for (const [key, value] of Object.entries(profiles)) {
    const parsed = parseCredentialEntry(value);
    if (!parsed.ok) {
      rejected.push({ key, reason: parsed.reason });
      continue;
    }
    normalized[key] = parsed.credential;
  }
  warnRejectedCredentialEntries("auth-profiles.json", rejected);
  const order =
    record.order && typeof record.order === "object"
      ? Object.entries(record.order as Record<string, unknown>).reduce(
          (acc, [provider, value]) => {
            if (!Array.isArray(value)) {
              return acc;
            }
            const list = value
              .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
              .filter(Boolean);
            if (list.length === 0) {
              return acc;
            }
            acc[provider] = list;
            return acc;
          },
          {} as Record<string, string[]>,
        )
      : undefined;
  return {
    version: Number(record.version ?? AUTH_STORE_VERSION),
    profiles: normalized,
    order,
    lastGood:
      record.lastGood && typeof record.lastGood === "object"
        ? (record.lastGood as Record<string, string>)
        : undefined,
    usageStats:
      record.usageStats && typeof record.usageStats === "object"
        ? (record.usageStats as Record<string, ProfileUsageStats>)
        : undefined,
  };
}

function mergeRecord<T>(
  base?: Record<string, T>,
  override?: Record<string, T>,
): Record<string, T> | undefined {
  if (!base && !override) {
    return undefined;
  }
  if (!base) {
    return { ...override };
  }
  if (!override) {
    return { ...base };
  }
  return { ...base, ...override };
}

function mergeAuthProfileStores(
  base: AuthProfileStore,
  override: AuthProfileStore,
): AuthProfileStore {
  if (
    Object.keys(override.profiles).length === 0 &&
    !override.order &&
    !override.lastGood &&
    !override.usageStats
  ) {
    return base;
  }
  return {
    version: Math.max(base.version, override.version ?? base.version),
    profiles: { ...base.profiles, ...override.profiles },
    order: mergeRecord(base.order, override.order),
    lastGood: mergeRecord(base.lastGood, override.lastGood),
    usageStats: mergeRecord(base.usageStats, override.usageStats),
  };
}

/** 将独立 OAuth 文件中的凭据合并进 store，仅当 profileId 不存在时写入；返回是否有变更 */
function mergeOAuthFileIntoStore(store: AuthProfileStore): boolean {
  const oauthPath = resolveOAuthPath();
  const oauthRaw = loadJsonFile(oauthPath);
  if (!oauthRaw || typeof oauthRaw !== "object") {
    return false;
  }
  const oauthEntries = oauthRaw as Record<string, OAuthCredentials>;
  let mutated = false;
  for (const [provider, creds] of Object.entries(oauthEntries)) {
    if (!creds || typeof creds !== "object") {
      continue;
    }
    const profileId = `${provider}:default`;
    if (store.profiles[profileId]) {
      continue;
    }
    store.profiles[profileId] = {
      type: "oauth",
      provider,
      ...creds,
    };
    mutated = true;
  }
  return mutated;
}

/** 将旧版 auth.json 解析结果应用到 store，按 provider 生成 profileId `${provider}:default` */
function applyLegacyStore(store: AuthProfileStore, legacy: LegacyAuthStore): void {
  for (const [provider, cred] of Object.entries(legacy)) {
    const profileId = `${provider}:default`;
    if (cred.type === "api_key") {
      store.profiles[profileId] = {
        type: "api_key",
        provider: String(cred.provider ?? provider),
        key: cred.key,
        ...(cred.email ? { email: cred.email } : {}),
      };
      continue;
    }
    if (cred.type === "token") {
      store.profiles[profileId] = {
        type: "token",
        provider: String(cred.provider ?? provider),
        token: cred.token,
        ...(typeof cred.expires === "number" ? { expires: cred.expires } : {}),
        ...(cred.email ? { email: cred.email } : {}),
      };
      continue;
    }
    store.profiles[profileId] = {
      type: "oauth",
      provider: String(cred.provider ?? provider),
      access: cred.access,
      refresh: cred.refresh,
      expires: cred.expires,
      ...(cred.enterpriseUrl ? { enterpriseUrl: cred.enterpriseUrl } : {}),
      ...(cred.projectId ? { projectId: cred.projectId } : {}),
      ...(cred.accountId ? { accountId: cred.accountId } : {}),
      ...(cred.email ? { email: cred.email } : {}),
    };
  }
}

function loadCoercedStore(authPath: string): AuthProfileStore | null {
  const raw = loadJsonFile(authPath);
  return coerceAuthStore(raw);
}

/** 加载主代理认证存储：优先新格式，否则从 auth.json 迁移并写回；每次加载都会尝试同步外部 CLI 凭据 */
export function loadAuthProfileStore(): AuthProfileStore {
  const authPath = resolveAuthStorePath();
  const asStore = loadCoercedStore(authPath);
  if (asStore) {
    const synced = syncExternalCliCredentials(asStore);
    if (synced) {
      saveJsonFile(authPath, asStore);
    }
    return asStore;
  }
  const legacyRaw = loadJsonFile(resolveLegacyAuthStorePath());
  const legacy = coerceLegacyStore(legacyRaw);
  if (legacy) {
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {},
    };
    applyLegacyStore(store, legacy);
    syncExternalCliCredentials(store);
    return store;
  }

  const store: AuthProfileStore = { version: AUTH_STORE_VERSION, profiles: {} };
  syncExternalCliCredentials(store);
  return store;
}

function loadAuthProfileStoreForAgent(
  agentDir?: string,
  options?: LoadAuthProfileStoreOptions,
): AuthProfileStore {
  const readOnly = options?.readOnly === true;
  const authPath = resolveAuthStorePath(agentDir);
  const asStore = loadCoercedStore(authPath);
  if (asStore) {
    // Runtime secret activation must remain read-only:
    // sync external CLI credentials in-memory, but never persist while readOnly.
    const synced = syncExternalCliCredentials(asStore);
    if (synced && !readOnly) {
      saveJsonFile(authPath, asStore);
    }
    return asStore;
  }

  // 子代理无本地存储时，从主代理继承并写入子代理目录
  if (agentDir && !readOnly) {
    const mainAuthPath = resolveAuthStorePath(); // without agentDir = main
    const mainRaw = loadJsonFile(mainAuthPath);
    const mainStore = coerceAuthStore(mainRaw);
    if (mainStore && Object.keys(mainStore.profiles).length > 0) {
      // Clone main store to subagent directory for auth inheritance
      saveJsonFile(authPath, mainStore);
      log.info("inherited auth-profiles from main agent", { agentDir });
      return mainStore;
    }
  }

  const legacyRaw = loadJsonFile(resolveLegacyAuthStorePath(agentDir));
  const legacy = coerceLegacyStore(legacyRaw);
  const store: AuthProfileStore = {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };
  if (legacy) {
    applyLegacyStore(store, legacy);
  }

  const mergedOAuth = mergeOAuthFileIntoStore(store);
  // Keep external CLI credentials visible in runtime even during read-only loads.
  const syncedCli = syncExternalCliCredentials(store);
  const forceReadOnly = process.env.OPENCLAW_AUTH_STORE_READONLY === "1";
  const shouldWrite = !readOnly && !forceReadOnly && (legacy !== null || mergedOAuth || syncedCli);
  if (shouldWrite) {
    saveJsonFile(authPath, store);
  }

  // 仅在成功写入 auth-profiles.json 后再删除旧版 auth.json，避免其他 agent 目录的旧文件覆盖新 OAuth
  if (shouldWrite && legacy !== null) {
    const legacyPath = resolveLegacyAuthStorePath(agentDir);
    try {
      fs.unlinkSync(legacyPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        log.warn("failed to delete legacy auth.json after migration", {
          err,
          legacyPath,
        });
      }
    }
  }

  return store;
}

/** 加载用于运行时的存储：子代理会与主代理存储合并后返回 */
export function loadAuthProfileStoreForRuntime(
  agentDir?: string,
  options?: LoadAuthProfileStoreOptions,
): AuthProfileStore {
  const store = loadAuthProfileStoreForAgent(agentDir, options);
  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  if (!agentDir || authPath === mainAuthPath) {
    return store;
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, options);
  return mergeAuthProfileStores(mainStore, store);
}

/** 仅用于密钥解析的运行时加载：只读、不触发 keychain 提示 */
export function loadAuthProfileStoreForSecretsRuntime(agentDir?: string): AuthProfileStore {
  return loadAuthProfileStoreForRuntime(agentDir, { readOnly: true, allowKeychainPrompt: false });
}

/** 优先从运行时快照取存储；无快照则从磁盘加载，子代理与主代理合并 */
export function ensureAuthProfileStore(
  agentDir?: string,
  options?: { allowKeychainPrompt?: boolean },
): AuthProfileStore {
  const runtimeStore = resolveRuntimeAuthProfileStore(agentDir);
  if (runtimeStore) {
    return runtimeStore;
  }

  const store = loadAuthProfileStoreForAgent(agentDir, options);
  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  if (!agentDir || authPath === mainAuthPath) {
    return store;
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, options);
  const merged = mergeAuthProfileStores(mainStore, store);

  return merged;
}

/** 将 store 写入磁盘；若同时存在 keyRef/key 或 tokenRef/token 则保存时去掉明文 key/token */
export function saveAuthProfileStore(store: AuthProfileStore, agentDir?: string): void {
  const authPath = resolveAuthStorePath(agentDir);
  const profiles = Object.fromEntries(
    Object.entries(store.profiles).map(([profileId, credential]) => {
      if (credential.type === "api_key" && credential.keyRef && credential.key !== undefined) {
        const sanitized = { ...credential } as Record<string, unknown>;
        delete sanitized.key;
        return [profileId, sanitized];
      }
      if (credential.type === "token" && credential.tokenRef && credential.token !== undefined) {
        const sanitized = { ...credential } as Record<string, unknown>;
        delete sanitized.token;
        return [profileId, sanitized];
      }
      return [profileId, credential];
    }),
  ) as AuthProfileStore["profiles"];
  const payload = {
    version: AUTH_STORE_VERSION,
    profiles,
    order: store.order ?? undefined,
    lastGood: store.lastGood ?? undefined,
    usageStats: store.usageStats ?? undefined,
  } satisfies AuthProfileStore;
  saveJsonFile(authPath, payload);
}
