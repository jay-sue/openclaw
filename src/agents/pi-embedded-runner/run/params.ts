/**
 * 嵌入式 Pi 运行参数：RunEmbeddedPiAgentParams 定义单次 runEmbeddedPiAgent 的完整入参
 * （会话/通道、workspace、prompt、provider/model、回调、超时等）。
 */
import type { ImageContent } from "@mariozechner/pi-ai";
import type { ReasoningLevel, ThinkLevel, VerboseLevel } from "../../../auto-reply/thinking.js";
import type { ReplyPayload } from "../../../auto-reply/types.js";
import type { AgentStreamParams } from "../../../commands/agent/types.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { enqueueCommand } from "../../../process/command-queue.js";
import type { InputProvenance } from "../../../sessions/input-provenance.js";
import type { ExecElevatedDefaults, ExecToolDefaults } from "../../bash-tools.js";
import type { BlockReplyPayload } from "../../pi-embedded-payloads.js";
import type { BlockReplyChunking, ToolResultFormat } from "../../pi-embedded-subscribe.js";
import type { SkillSnapshot } from "../../skills.js";

/** 客户端提供的工具定义（如 OpenResponses 托管工具）的简化结构 */
export type ClientToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

/** 单次嵌入式 Pi 代理运行的完整入参 */
export type RunEmbeddedPiAgentParams = {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  messageChannel?: string;
  messageProvider?: string;
  agentAccountId?: string;
  /** 本次运行的触发来源："user" | "heartbeat" | "cron" | "memory" */
  trigger?: string;
  /** 由 memory 触发时允许追加写入的 workspace 相对路径 */
  memoryFlushWritePath?: string;
  /** 投递目标（如 telegram:group:123:topic:456），用于话题/线程路由 */
  messageTo?: string;
  /** 话题/线程标识，用于将回复路由到发起线程 */
  messageThreadId?: string | number;
  /** 群组 id，用于按通道解析工具策略 */
  groupId?: string | null;
  /** 群组通道标签（如 #general），用于按通道解析工具策略 */
  groupChannel?: string | null;
  /** 群组空间标识（如 guild/team id），用于按通道解析工具策略 */
  groupSpace?: string | null;
  /** 父会话 key，用于子代理策略继承 */
  spawnedBy?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  /** 发送方是否为 owner（仅 owner 可用的工具会据此判断） */
  senderIsOwner?: boolean;
  /** 当前通道 ID，用于 Slack 自动建线程 */
  currentChannelId?: string;
  /** 当前线程时间戳，用于 Slack 自动建线程 */
  currentThreadTs?: string;
  /** 当前入站消息 id，用于回退操作（如 Telegram 回帖/反应） */
  currentMessageId?: string | number;
  /** Slack 自动建线程的回复模式 */
  replyToMode?: "off" | "first" | "all";
  /** 可变 ref，用于在 "first" 模式下记录是否已发送过回复 */
  hasRepliedRef?: { value: boolean };
  /** 是否要求消息工具必须指定目标（禁止隐式沿用上次路由） */
  requireExplicitMessageTarget?: boolean;
  /** 为 true 时从工具列表中移除消息工具 */
  disableMessageTool?: boolean;
  sessionFile: string;
  workspaceDir: string;
  agentDir?: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
  prompt: string;
  images?: ImageContent[];
  /** 可选的客户端提供工具（如 OpenResponses 托管工具） */
  clientTools?: ClientToolDefinition[];
  /** 本次运行是否禁用内置工具（仅 LLM 模式） */
  disableTools?: boolean;
  provider?: string;
  model?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  thinkLevel?: ThinkLevel;
  verboseLevel?: VerboseLevel;
  reasoningLevel?: ReasoningLevel;
  toolResultFormat?: ToolResultFormat;
  /** 为 true 时本次运行不展示工具错误警告 payload（含可变操作） */
  suppressToolErrorWarnings?: boolean;
  /** Bootstrap 上下文模式：注入到 workspace 的文件范围 */
  bootstrapContextMode?: "full" | "lightweight";
  /** 运行类型提示，用于上下文模式行为（如 heartbeat/cron 精简） */
  bootstrapContextRunKind?: "default" | "heartbeat" | "cron";
  /** 本会话已出现过的 bootstrap 截断警告签名，用于按模式去重 */
  bootstrapPromptWarningSignaturesSeen?: string[];
  /** 本会话最近一次展示的 bootstrap 截断警告签名 */
  bootstrapPromptWarningSignature?: string;
  execOverrides?: Pick<ExecToolDefaults, "host" | "security" | "ask" | "node">;
  bashElevated?: ExecElevatedDefaults;
  timeoutMs: number;
  runId: string;
  abortSignal?: AbortSignal;
  shouldEmitToolResult?: () => boolean;
  shouldEmitToolOutput?: () => boolean;
  onPartialReply?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onAssistantMessageStart?: () => void | Promise<void>;
  onBlockReply?: (payload: BlockReplyPayload) => void | Promise<void>;
  onBlockReplyFlush?: () => void | Promise<void>;
  blockReplyBreak?: "text_end" | "message_end";
  blockReplyChunking?: BlockReplyChunking;
  onReasoningStream?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onReasoningEnd?: () => void | Promise<void>;
  onToolResult?: (payload: ReplyPayload) => void | Promise<void>;
  onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
  lane?: string;
  enqueue?: typeof enqueueCommand;
  extraSystemPrompt?: string;
  inputProvenance?: InputProvenance;
  streamParams?: AgentStreamParams;
  ownerNumbers?: string[];
  enforceFinalTag?: boolean;
  /**
   * 当所有 auth profile 处于冷却时仍允许尝试一次运行，仅针对推断为短暂冷却的原因（如 rate_limit、overloaded）。
   * 用于 model fallback 在同类 provider 上尝试兄弟模型时，因短暂压力常按模型维度生效。
   */
  allowTransientCooldownProbe?: boolean;
};
