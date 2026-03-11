/**
 * 根据沙箱上下文与 exec 提权配置构建 EmbeddedSandboxInfo，供 system prompt 与工具使用（工作区路径、浏览器/VNC、提权策略等）。
 */
import type { ExecElevatedDefaults } from "../bash-tools.js";
import type { resolveSandboxContext } from "../sandbox.js";
import type { EmbeddedSandboxInfo } from "./types.js";

/** 从 resolveSandboxContext 与 execElevated 构建嵌入式运行所需的沙箱信息 */
export function buildEmbeddedSandboxInfo(
  sandbox?: Awaited<ReturnType<typeof resolveSandboxContext>>,
  execElevated?: ExecElevatedDefaults,
): EmbeddedSandboxInfo | undefined {
  if (!sandbox?.enabled) {
    return undefined;
  }
  const elevatedAllowed = Boolean(execElevated?.enabled && execElevated.allowed);
  return {
    enabled: true,
    workspaceDir: sandbox.workspaceDir,
    containerWorkspaceDir: sandbox.containerWorkdir,
    workspaceAccess: sandbox.workspaceAccess,
    agentWorkspaceMount: sandbox.workspaceAccess === "ro" ? "/agent" : undefined,
    browserBridgeUrl: sandbox.browser?.bridgeUrl,
    browserNoVncUrl: sandbox.browser?.noVncUrl,
    hostBrowserAllowed: sandbox.browserAllowHostControl,
    ...(elevatedAllowed
      ? {
          elevated: {
            allowed: true,
            defaultLevel: execElevated?.defaultLevel ?? "off",
          },
        }
      : {}),
  };
}
