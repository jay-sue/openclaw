/**
 * 根据单次 attempt 的结果（assistantTexts、toolMetas、lastAssistant、lastToolError 等）
 * 构建对外的 payload 列表：文本、媒体、错误、reasoning、静默回复与工具错误策略。
 */
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { parseReplyDirectives } from "../../../auto-reply/reply/reply-directives.js";
import type { ReasoningLevel, VerboseLevel } from "../../../auto-reply/thinking.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { formatToolAggregate } from "../../../auto-reply/tool-meta.js";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  BILLING_ERROR_USER_MESSAGE,
  formatAssistantErrorText,
  formatRawAssistantErrorForUi,
  getApiErrorPayloadFingerprint,
  isRawApiErrorPayload,
  normalizeTextForComparison,
} from "../../pi-embedded-helpers.js";
import type { ToolResultFormat } from "../../pi-embedded-subscribe.js";
import {
  extractAssistantText,
  extractAssistantThinking,
  formatReasoningMessage,
} from "../../pi-embedded-utils.js";
import { isLikelyMutatingToolName } from "../../tool-mutation.js";

/** 单条工具元信息：工具名 + 可选 meta 描述 */
type ToolMetaEntry = { toolName: string; meta?: string };
/** 最后一次工具调用的错误信息，用于决定是否展示警告 payload */
type LastToolError = {
  toolName: string;
  meta?: string;
  error?: string;
  mutatingAction?: boolean;
  actionFingerprint?: string;
};
/** 是否展示工具错误警告及是否包含错误详情 */
type ToolErrorWarningPolicy = {
  showWarning: boolean;
  includeDetails: boolean;
};

/** 若错误信息包含这些关键词，视为「可恢复」错误，在已有用户可见回复时不单独展示警告 */
const RECOVERABLE_TOOL_ERROR_KEYWORDS = [
  "required",
  "missing",
  "invalid",
  "must be",
  "must have",
  "needs",
  "requires",
] as const;

/** 根据错误字符串是否包含可恢复关键词，判断是否为可恢复类工具错误 */
function isRecoverableToolError(error: string | undefined): boolean {
  const errorLower = (error ?? "").toLowerCase();
  return RECOVERABLE_TOOL_ERROR_KEYWORDS.some((keyword) => errorLower.includes(keyword));
}

/** 是否开启详细工具输出（on 或 full 时在工具错误中附带 error 详情） */
function isVerboseToolDetailEnabled(level?: VerboseLevel): boolean {
  return level === "on" || level === "full";
}

/** 根据 lastToolError、是否有用户可见回复、config 与 suppress 开关，决定是否展示工具错误警告及是否带详情 */
function resolveToolErrorWarningPolicy(params: {
  lastToolError: LastToolError;
  hasUserFacingReply: boolean;
  suppressToolErrors: boolean;
  suppressToolErrorWarnings?: boolean;
  verboseLevel?: VerboseLevel;
}): ToolErrorWarningPolicy {
  const includeDetails = isVerboseToolDetailEnabled(params.verboseLevel);
  if (params.suppressToolErrorWarnings) {
    return { showWarning: false, includeDetails };
  }
  const normalizedToolName = params.lastToolError.toolName.trim().toLowerCase();
  // exec/bash 在非 verbose 下不展示警告，避免刷屏
  if ((normalizedToolName === "exec" || normalizedToolName === "bash") && !includeDetails) {
    return { showWarning: false, includeDetails };
  }
  // sessions_send 为跨会话通信，错误可能仍已送达，不展示原始错误到聊天面
  if (normalizedToolName === "sessions_send") {
    return { showWarning: false, includeDetails };
  }
  const isMutatingToolError =
    params.lastToolError.mutatingAction ?? isLikelyMutatingToolName(params.lastToolError.toolName);
  if (isMutatingToolError) {
    return { showWarning: true, includeDetails };
  }
  if (params.suppressToolErrors) {
    return { showWarning: false, includeDetails };
  }
  // 无用户可见回复且非可恢复错误时才展示警告
  return {
    showWarning: !params.hasUserFacingReply && !isRecoverableToolError(params.lastToolError.error),
    includeDetails,
  };
}

/** 根据 attempt 结果组装对外 payload 列表：顺序为错误 → 内联工具结果 → reasoning → 助手正文 → 工具错误警告；并过滤静默回复与空项 */
export function buildEmbeddedRunPayloads(params: {
  assistantTexts: string[];
  toolMetas: ToolMetaEntry[];
  lastAssistant: AssistantMessage | undefined;
  lastToolError?: LastToolError;
  config?: OpenClawConfig;
  sessionKey: string;
  provider?: string;
  model?: string;
  verboseLevel?: VerboseLevel;
  reasoningLevel?: ReasoningLevel;
  toolResultFormat?: ToolResultFormat;
  suppressToolErrorWarnings?: boolean;
  inlineToolResultsAllowed: boolean;
  didSendViaMessagingTool?: boolean;
  didSendDeterministicApprovalPrompt?: boolean;
}): Array<{
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  isError?: boolean;
  isReasoning?: boolean;
  audioAsVoice?: boolean;
  replyToTag?: boolean;
  replyToCurrent?: boolean;
}> {
  const replyItems: Array<{
    text: string;
    media?: string[];
    isError?: boolean;
    isReasoning?: boolean;
    audioAsVoice?: boolean;
    replyToId?: string;
    replyToTag?: boolean;
    replyToCurrent?: boolean;
  }> = [];

  const useMarkdown = params.toolResultFormat === "markdown";
  const suppressAssistantArtifacts = params.didSendDeterministicApprovalPrompt === true;
  const lastAssistantErrored = params.lastAssistant?.stopReason === "error";
  // 格式化后的助手错误文案（用于展示与去重）
  const errorText = params.lastAssistant
    ? suppressAssistantArtifacts
      ? undefined
      : formatAssistantErrorText(params.lastAssistant, {
          cfg: params.config,
          sessionKey: params.sessionKey,
          provider: params.provider,
          model: params.model,
        })
    : undefined;
  const rawErrorMessage = lastAssistantErrored
    ? params.lastAssistant?.errorMessage?.trim() || undefined
    : undefined;
  const rawErrorFingerprint = rawErrorMessage
    ? getApiErrorPayloadFingerprint(rawErrorMessage)
    : null;
  const formattedRawErrorMessage = rawErrorMessage
    ? formatRawAssistantErrorForUi(rawErrorMessage)
    : null;
  const normalizedFormattedRawErrorMessage = formattedRawErrorMessage
    ? normalizeTextForComparison(formattedRawErrorMessage)
    : null;
  const normalizedRawErrorText = rawErrorMessage
    ? normalizeTextForComparison(rawErrorMessage)
    : null;
  const normalizedErrorText = errorText ? normalizeTextForComparison(errorText) : null;
  const normalizedGenericBillingErrorText = normalizeTextForComparison(BILLING_ERROR_USER_MESSAGE);
  const genericErrorText = "The AI service returned an error. Please try again.";
  if (errorText) {
    replyItems.push({ text: errorText, isError: true });
  }

  // 若允许内联工具结果且非 off 且有 toolMetas，则每条工具 meta 格式化为一条 payload（含 parseReplyDirectives）
  const inlineToolResults =
    params.inlineToolResultsAllowed && params.verboseLevel !== "off" && params.toolMetas.length > 0;
  if (inlineToolResults) {
    for (const { toolName, meta } of params.toolMetas) {
      const agg = formatToolAggregate(toolName, meta ? [meta] : [], {
        markdown: useMarkdown,
      });
      const {
        text: cleanedText,
        mediaUrls,
        audioAsVoice,
        replyToId,
        replyToTag,
        replyToCurrent,
      } = parseReplyDirectives(agg);
      if (cleanedText) {
        replyItems.push({
          text: cleanedText,
          media: mediaUrls,
          audioAsVoice,
          replyToId,
          replyToTag,
          replyToCurrent,
        });
      }
    }
  }

  // reasoning 仅在 reasoningLevel===on 且未抑制时从 lastAssistant 抽取并格式化
  const reasoningText = suppressAssistantArtifacts
    ? ""
    : params.lastAssistant && params.reasoningLevel === "on"
      ? formatReasoningMessage(extractAssistantThinking(params.lastAssistant))
      : "";
  if (reasoningText) {
    replyItems.push({ text: reasoningText, isReasoning: true });
  }

  const fallbackAnswerText = params.lastAssistant ? extractAssistantText(params.lastAssistant) : "";
  /** 判断某段正文是否应视为「原始错误文案」而不再重复展示（与 errorText/rawError/通用 billing 等做规范化比较） */
  const shouldSuppressRawErrorText = (text: string) => {
    if (!lastAssistantErrored) {
      return false;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }
    if (errorText) {
      const normalized = normalizeTextForComparison(trimmed);
      if (normalized && normalizedErrorText && normalized === normalizedErrorText) {
        return true;
      }
      if (trimmed === genericErrorText) {
        return true;
      }
      if (
        normalized &&
        normalizedGenericBillingErrorText &&
        normalized === normalizedGenericBillingErrorText
      ) {
        return true;
      }
    }
    if (rawErrorMessage && trimmed === rawErrorMessage) {
      return true;
    }
    if (formattedRawErrorMessage && trimmed === formattedRawErrorMessage) {
      return true;
    }
    if (normalizedRawErrorText) {
      const normalized = normalizeTextForComparison(trimmed);
      if (normalized && normalized === normalizedRawErrorText) {
        return true;
      }
    }
    if (normalizedFormattedRawErrorMessage) {
      const normalized = normalizeTextForComparison(trimmed);
      if (normalized && normalized === normalizedFormattedRawErrorMessage) {
        return true;
      }
    }
    if (rawErrorFingerprint) {
      const fingerprint = getApiErrorPayloadFingerprint(trimmed);
      if (fingerprint && fingerprint === rawErrorFingerprint) {
        return true;
      }
    }
    return isRawApiErrorPayload(trimmed);
  };
  // 助手正文：优先用 assistantTexts，否则用从 lastAssistant 抽取的 fallbackAnswerText；再过滤掉与错误重复的文案
  const answerTexts = suppressAssistantArtifacts
    ? []
    : (params.assistantTexts.length
        ? params.assistantTexts
        : fallbackAnswerText
          ? [fallbackAnswerText]
          : []
      ).filter((text) => !shouldSuppressRawErrorText(text));

  let hasUserFacingAssistantReply = false;
  for (const text of answerTexts) {
    const {
      text: cleanedText,
      mediaUrls,
      audioAsVoice,
      replyToId,
      replyToTag,
      replyToCurrent,
    } = parseReplyDirectives(text);
    if (!cleanedText && (!mediaUrls || mediaUrls.length === 0) && !audioAsVoice) {
      continue;
    }
    replyItems.push({
      text: cleanedText,
      media: mediaUrls,
      audioAsVoice,
      replyToId,
      replyToTag,
      replyToCurrent,
    });
    hasUserFacingAssistantReply = true;
  }

  // 若有 lastToolError 且策略允许，追加一条工具错误警告 payload（可变操作必展示；非可变且无回复且非可恢复时才展示）
  if (params.lastToolError) {
    const warningPolicy = resolveToolErrorWarningPolicy({
      lastToolError: params.lastToolError,
      hasUserFacingReply: hasUserFacingAssistantReply,
      suppressToolErrors: Boolean(params.config?.messages?.suppressToolErrors),
      suppressToolErrorWarnings: params.suppressToolErrorWarnings,
      verboseLevel: params.verboseLevel,
    });

    if (warningPolicy.showWarning) {
      const toolSummary = formatToolAggregate(
        params.lastToolError.toolName,
        params.lastToolError.meta ? [params.lastToolError.meta] : undefined,
        { markdown: useMarkdown },
      );
      const errorSuffix =
        warningPolicy.includeDetails && params.lastToolError.error
          ? `: ${params.lastToolError.error}`
          : "";
      const warningText = `⚠️ ${toolSummary} failed${errorSuffix}`;
      const normalizedWarning = normalizeTextForComparison(warningText);
      // 与已有 replyItems 去重，避免同一条警告重复出现
      const duplicateWarning = normalizedWarning
        ? replyItems.some((item) => {
            if (!item.text) {
              return false;
            }
            const normalizedExisting = normalizeTextForComparison(item.text);
            return normalizedExisting.length > 0 && normalizedExisting === normalizedWarning;
          })
        : false;
      if (!duplicateWarning) {
        replyItems.push({
          text: warningText,
          isError: true,
        });
      }
    }
  }

  // 若任一项带 audioAsVoice，则对带 media 的项也标记 audioAsVoice，便于前端统一按语音处理
  const hasAudioAsVoiceTag = replyItems.some((item) => item.audioAsVoice);
  return replyItems
    .map((item) => ({
      text: item.text?.trim() ? item.text.trim() : undefined,
      mediaUrls: item.media?.length ? item.media : undefined,
      mediaUrl: item.media?.[0],
      isError: item.isError,
      replyToId: item.replyToId,
      replyToTag: item.replyToTag,
      replyToCurrent: item.replyToCurrent,
      audioAsVoice: item.audioAsVoice || Boolean(hasAudioAsVoiceTag && item.media?.length),
    }))
    .filter((p) => {
      if (!p.text && !p.mediaUrl && (!p.mediaUrls || p.mediaUrls.length === 0)) {
        return false;
      }
      if (p.text && isSilentReplyText(p.text, SILENT_REPLY_TOKEN)) {
        return false;
      }
      return true;
    });
}
