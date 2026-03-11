/**
 * 历史图片裁剪：对已有 assistant 回复的 user 轮次中的图片块替换为占位文本，节省上下文且幂等。
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";

/** 替换已处理图片时的占位文本，供模型与下游识别为「已移除的图片」 */
export const PRUNED_HISTORY_IMAGE_MARKER = "[image data removed - already processed by model]";

/** 对消息列表中「已有 assistant 回复」的 user 消息内的 image 块做占位替换，返回是否发生变更；仅处理最后一条 assistant 之前的 user，避免动到未回复的轮次 */
export function pruneProcessedHistoryImages(messages: AgentMessage[]): boolean {
  // 从后往前找最后一条 assistant 的下标
  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }
  if (lastAssistantIndex < 0) {
    return false;
  }

  let didMutate = false;
  // 只遍历最后一条 assistant 之前的消息（即已「被回复过」的 user 等）
  for (let i = 0; i < lastAssistantIndex; i++) {
    const message = messages[i];
    if (!message || message.role !== "user" || !Array.isArray(message.content)) {
      continue;
    }
    for (let j = 0; j < message.content.length; j++) {
      const block = message.content[j];
      if (!block || typeof block !== "object") {
        continue;
      }
      if ((block as { type?: string }).type !== "image") {
        continue;
      }
      // 将 image 块替换为占位文本，保持 content 数组结构
      message.content[j] = {
        type: "text",
        text: PRUNED_HISTORY_IMAGE_MARKER,
      } as (typeof message.content)[number];
      didMutate = true;
    }
  }

  return didMutate;
}
