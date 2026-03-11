/**
 * 将 SDK 工具拆分为 builtInTools 与 customTools；当前策略为全部走 customTools，
 * 以保证策略过滤、沙箱与扩展工具集在各 provider 下一致。
 */
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { toToolDefinitions } from "../pi-tool-definition-adapter.js";

type AnyAgentTool = AgentTool;

/** 将传入的 tools 拆为 builtInTools（当前恒为空）与 customTools（toToolDefinitions 结果） */
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }): {
  builtInTools: AnyAgentTool[];
  customTools: ReturnType<typeof toToolDefinitions>;
} {
  const { tools } = options;
  return {
    builtInTools: [],
    customTools: toToolDefinitions(tools),
  };
}
