/**
 * 工作区目录列表
 *
 * 根据配置中的 agents.list 与默认 agent 解析出所有 agent 工作区目录路径（去重）。
 */
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "./agent-scope.js";

/** 列出配置中所有 agent 的工作区目录（含默认 agent），去重后返回路径数组 */
export function listAgentWorkspaceDirs(cfg: OpenClawConfig): string[] {
  const dirs = new Set<string>();
  const list = cfg.agents?.list;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (entry && typeof entry === "object" && typeof entry.id === "string") {
        dirs.add(resolveAgentWorkspaceDir(cfg, entry.id));
      }
    }
  }
  dirs.add(resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)));
  return [...dirs];
}
