/**
 * 收集本次运行允许的工具名集合（来自 AgentTool 与 clientTools），供工具名规范化与分发时校验。
 */
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ClientToolDefinition } from "./run/params.js";

function addName(names: Set<string>, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (trimmed) {
    names.add(trimmed);
  }
}

/** 从 tools 与 clientTools 中收集所有工具名称，返回去重后的 Set */
export function collectAllowedToolNames(params: {
  tools: AgentTool[];
  clientTools?: ClientToolDefinition[];
}): Set<string> {
  const names = new Set<string>();
  for (const tool of params.tools) {
    addName(names, tool.name);
  }
  for (const tool of params.clientTools ?? []) {
    addName(names, tool.function?.name);
  }
  return names;
}
