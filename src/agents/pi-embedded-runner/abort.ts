/**
 * 运行器中止判断：识别 AbortError 或 message 含 "aborted" 的错误。
 * 比核心 isAbortError 更宽松，以兼容多种中止信号来源。
 */
export function isRunnerAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const name = "name" in err ? String(err.name) : "";
  if (name === "AbortError") {
    return true;
  }
  const message =
    "message" in err && typeof err.message === "string" ? err.message.toLowerCase() : "";
  return message.includes("aborted");
}
