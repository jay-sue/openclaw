/**
 * 命令队列 lane 解析：会话 lane 用于保证同一会话串行；全局 lane 用于跨会话并发控制。
 */
import { CommandLane } from "../../process/lanes.js";

/** 将会话 key 解析为 session:${key} 形式的 lane，供 command-queue 入队 */
export function resolveSessionLane(key: string) {
  const cleaned = key.trim() || CommandLane.Main;
  return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
}

/** 解析全局 lane，未指定时使用 Main */
export function resolveGlobalLane(lane?: string) {
  const cleaned = lane?.trim();
  return cleaned ? cleaned : CommandLane.Main;
}

/** 与 resolveSessionLane 一致，供外部统一调用 */
export function resolveEmbeddedSessionLane(key: string) {
  return resolveSessionLane(key);
}
