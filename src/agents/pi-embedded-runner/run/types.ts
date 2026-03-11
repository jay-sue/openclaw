/**
 * 单次尝试 (attempt) 的类型：EmbeddedRunAttemptParams 为 runEmbeddedAttempt 的入参，
 * EmbeddedRunAttemptResult 为返回（aborted、timedOut、assistantTexts、toolMetas、lastAssistant 等）。
 */
// 会话消息类型（pi-agent-core）
import type { AgentMessage } from "@mariozechner/pi-agent-core";
// 模型 API、助手消息、模型定义（pi-ai）
import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";
// 认证存储与模型注册表（pi-coding-agent）
import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
// 思考级别（off/adaptive/low/medium/high/xhigh）
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
// 系统提示报告（用于会话元数据）
import type { SessionSystemPromptReport } from "../../../config/sessions/types.js";
// 上下文引擎（ingest/assemble/compact）
import type { ContextEngine } from "../../../context-engine/types.js";
// 插件 before_agent_start 的返回（可覆盖 provider/model）
import type { PluginHookBeforeAgentStartResult } from "../../../plugins/types.js";
// 消息工具发送记录（通道、目标等）
import type { MessagingToolSend } from "../../pi-embedded-messaging.js";
// 归一化后的 token 用量
import type { NormalizedUsage } from "../../usage.js";
// 运行入参（本文件在其基础上扩展 attempt 专用字段）
import type { RunEmbeddedPiAgentParams } from "./params.js";

/** 从 RunEmbeddedPiAgentParams 去掉由 run 层注入的 provider/model/auth/thinkLevel/lane/enqueue，作为 attempt 的基类入参 */
type EmbeddedRunAttemptBase = Omit<
  RunEmbeddedPiAgentParams,
  "provider" | "model" | "authProfileId" | "authProfileIdSource" | "thinkLevel" | "lane" | "enqueue"
>;

/** 单次 runEmbeddedAttempt 的完整入参：基类 + 本层解析的 provider/model/auth/context 等 */
export type EmbeddedRunAttemptParams = EmbeddedRunAttemptBase & {
  /** 可插拔的上下文引擎，用于 ingest/assemble/compact 生命周期 */
  contextEngine?: ContextEngine;
  /** 已解析的模型上下文窗口（token 数），用于 assemble/compact 预算 */
  contextTokenBudget?: number;
  /** 本轮 attempt 使用的 auth profile id */
  authProfileId?: string;
  /** auth profile 来源：用户锁定或自动选择 */
  authProfileIdSource?: "auto" | "user";
  /** 当前使用的 provider 标识 */
  provider: string;
  /** 当前使用的模型 id */
  modelId: string;
  /** 已解析的 Model 实例（含 api、baseUrl、contextWindow 等） */
  model: Model<Api>;
  /** 认证存储，用于运行时 API key 注入 */
  authStorage: AuthStorage;
  /** 模型注册表，用于后续解析或扩展 */
  modelRegistry: ModelRegistry;
  /** 本轮使用的思考级别 */
  thinkLevel: ThinkLevel;
  /** 插件 before_agent_start 的返回，可含覆盖后的 systemPrompt 等 */
  legacyBeforeAgentStartResult?: PluginHookBeforeAgentStartResult;
};

/** 单次 runEmbeddedAttempt 的返回结构，供 run.ts 判断重试、overflow、failover 并组装最终结果 */
export type EmbeddedRunAttemptResult = {
  /** 是否被用户或外部中止 */
  aborted: boolean;
  /** 是否因超时结束 */
  timedOut: boolean;
  /** 超时是否发生在压缩进行中或等待压缩重试时（用于区分是否使用压缩前快照） */
  timedOutDuringCompaction: boolean;
  /** 构建或提交 prompt 时的错误（若有） */
  promptError: unknown;
  /** 实际使用的 sessionId（可能与入参一致或来自会话头） */
  sessionIdUsed: string;
  /** 本会话已出现过的 bootstrap 截断警告签名，用于去重 */
  bootstrapPromptWarningSignaturesSeen?: string[];
  /** 最近一次展示的 bootstrap 截断警告签名 */
  bootstrapPromptWarningSignature?: string;
  /** 系统提示报告（token/长度等），用于会话元数据 */
  systemPromptReport?: SessionSystemPromptReport;
  /** 本次 attempt 结束时的消息快照（用于 overflow 后压缩或返回） */
  messagesSnapshot: AgentMessage[];
  /** 助手回复的文本片段列表（可能多条，如多块 text） */
  assistantTexts: string[];
  /** 本轮调用的工具及元信息（用于 payload 与诊断） */
  toolMetas: Array<{ toolName: string; meta?: string }>;
  /** 最后一则助手消息（含 stopReason、usage、errorMessage 等） */
  lastAssistant: AssistantMessage | undefined;
  /** 最后一次工具调用的错误信息（若有），用于决定是否展示错误 payload */
  lastToolError?: {
    toolName: string;
    meta?: string;
    error?: string;
    mutatingAction?: boolean;
    actionFingerprint?: string;
  };
  /** 是否通过消息类工具（telegram/whatsapp/discord/sessions_send 等）成功发出过消息 */
  didSendViaMessagingTool: boolean;
  /** 是否发送过确定性审批类提示（用于抑制重复确认文案） */
  didSendDeterministicApprovalPrompt?: boolean;
  /** 通过消息工具成功发送的文本列表 */
  messagingToolSentTexts: string[];
  /** 通过消息工具成功发送的媒体 URL 列表 */
  messagingToolSentMediaUrls: string[];
  /** 消息工具发送目标列表（通道、会话等） */
  messagingToolSentTargets: MessagingToolSend[];
  /** 本轮成功添加的 cron 数量 */
  successfulCronAdds?: number;
  /** 是否出现 Cloud Code Assist 格式错误（需在重试时清洗 tool call id） */
  cloudCodeAssistFormatError: boolean;
  /** 本轮 attempt 的 token 用量（若 API 有返回） */
  attemptUsage?: NormalizedUsage;
  /** 本轮内发生的压缩次数（SDK 自动压缩） */
  compactionCount?: number;
  /** 若以 client tool call 结束（如 OpenResponses 托管工具），则记录 name 与 params */
  clientToolCall?: { name: string; params: Record<string, unknown> };
};
