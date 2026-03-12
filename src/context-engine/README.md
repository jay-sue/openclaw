# context-engine 模块

可插拔的上下文管理引擎，用于 AI 代理的会话上下文管理。

## 概述

`context-engine` 模块提供了一套标准化的接口，用于管理 AI 代理与模型交互时的上下文。支持自定义引擎实现（如 LosslessClaw）替换默认的 legacy 引擎。

### 核心职责

- **消息摄入 (Ingest)**：将对话消息持久化到引擎存储
- **上下文组装 (Assemble)**：在 token 预算内组装供模型使用的上下文
- **上下文压缩 (Compact)**：通过摘要、修剪等策略减少 token 使用
- **生命周期管理**：会话初始化、轮次后处理、资源释放

## 架构

```
context-engine/
├── index.ts          # 公共 API 入口，统一导出
├── types.ts          # 核心接口和类型定义
├── registry.ts       # 引擎注册表（全局单例）
├── init.ts           # 初始化守卫（确保内置引擎注册）
├── legacy.ts         # Legacy 引擎实现（默认 fallback）
└── context-engine.test.ts  # 测试套件
```

## 核心概念

### ContextEngine 接口

所有上下文引擎必须实现 `ContextEngine` 接口：

```typescript
interface ContextEngine {
  // 元数据
  readonly info: ContextEngineInfo;

  // 必需方法
  ingest(params): Promise<IngestResult>; // 摄入单条消息
  assemble(params): Promise<AssembleResult>; // 组装上下文
  compact(params): Promise<CompactResult>; // 压缩上下文

  // 可选方法
  bootstrap?(params): Promise<BootstrapResult>; // 会话初始化
  ingestBatch?(params): Promise<IngestBatchResult>; // 批量摄入
  afterTurn?(params): Promise<void>; // 轮次后处理
  prepareSubagentSpawn?(params): Promise<SubagentSpawnPreparation | undefined>;
  onSubagentEnded?(params): Promise<void>;
  dispose?(): Promise<void>; // 资源释放
}
```

### 注册表

引擎通过全局注册表管理：

```typescript
// 注册引擎
registerContextEngine("my-engine", () => new MyContextEngine());

// 解析引擎（根据配置）
const engine = await resolveContextEngine(config);

// 列出所有已注册引擎
const ids = listContextEngineIds(); // ["legacy", "my-engine", ...]
```

### Legacy 引擎

默认的 `LegacyContextEngine` 保持与现有压缩行为的 100% 向后兼容：

| 方法       | 行为         | 说明                                  |
| ---------- | ------------ | ------------------------------------- |
| `ingest`   | no-op        | SessionManager 处理消息持久化         |
| `assemble` | pass-through | attempt.ts 管道处理上下文组装         |
| `compact`  | 委托         | 委托给 compactEmbeddedPiSessionDirect |

## 使用方式

### 基本使用

```typescript
import { ensureContextEnginesInitialized, resolveContextEngine } from "./context-engine";

// 1. 确保内置引擎已注册
ensureContextEnginesInitialized();

// 2. 根据配置解析引擎
const engine = await resolveContextEngine(config);

// 3. 使用引擎方法
await engine.ingest({ sessionId, message });

const { messages, estimatedTokens } = await engine.assemble({
  sessionId,
  messages: currentMessages,
  tokenBudget: 100000,
});

const compactResult = await engine.compact({
  sessionId,
  sessionFile,
  tokenBudget: 100000,
  force: true,
});

// 4. 运行结束时释放资源
await engine.dispose?.();
```

### 配置指定引擎

在 OpenClaw 配置中指定使用的引擎：

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "lossless-claw"
    }
  }
}
```

### 实现自定义引擎

```typescript
import type { ContextEngine, ContextEngineInfo } from "./types.js";
import { registerContextEngine } from "./registry.js";

class MyContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "my-engine",
    name: "My Custom Engine",
    version: "1.0.0",
    ownsCompaction: true, // 引擎管理自己的压缩
  };

  async ingest({ sessionId, message }) {
    // 持久化消息到自定义存储
    await this.db.saveMessage(sessionId, message);
    return { ingested: true };
  }

  async assemble({ sessionId, messages, tokenBudget }) {
    // 智能检索和排序消息
    const optimized = await this.optimize(messages, tokenBudget);
    return {
      messages: optimized,
      estimatedTokens: this.estimateTokens(optimized),
      systemPromptAddition: "Custom context instructions...",
    };
  }

  async compact({ sessionId, sessionFile, tokenBudget }) {
    // 执行自定义压缩策略
    const result = await this.performCompaction(sessionId, tokenBudget);
    return {
      ok: true,
      compacted: result.didCompact,
      result: {
        summary: result.summary,
        tokensBefore: result.before,
        tokensAfter: result.after,
      },
    };
  }

  async dispose() {
    await this.db.close();
  }
}

// 注册引擎
registerContextEngine("my-engine", () => new MyContextEngine());
```

## 解析顺序

`resolveContextEngine()` 按以下顺序解析引擎：

1. `config.plugins.slots.contextEngine`（显式配置）
2. 默认插槽值 `"legacy"`

如果解析的引擎 ID 未注册，会抛出包含可用引擎列表的错误。

## 全局单例保证

注册表使用 `Symbol.for()` 确保跨 bundle chunk 的单例性，解决了 #40096 问题：

```typescript
const CONTEXT_ENGINE_REGISTRY_STATE = Symbol.for("openclaw.contextEngineRegistryState");
```

这确保：

- 从 chunk A 注册的引擎对 chunk B 的 `resolveContextEngine()` 可见
- plugin-sdk 重新导出与直接导入共享同一注册表
- 并发注册不会丢失条目

## 结果类型

### AssembleResult

```typescript
type AssembleResult = {
  messages: AgentMessage[]; // 组装后的消息列表
  estimatedTokens: number; // 估计的 token 数
  systemPromptAddition?: string; // 可选的系统提示附加内容
};
```

### CompactResult

```typescript
type CompactResult = {
  ok: boolean; // 操作是否成功
  compacted: boolean; // 是否实际执行了压缩
  reason?: string; // 跳过/失败原因
  result?: {
    summary?: string; // 生成的摘要
    firstKeptEntryId?: string; // 保留的第一条消息 ID
    tokensBefore: number; // 压缩前 token 数
    tokensAfter?: number; // 压缩后 token 数
    details?: unknown;
  };
};
```

### IngestResult

```typescript
type IngestResult = {
  ingested: boolean; // 是否成功摄入
};
```

## 测试

测试套件覆盖：

1. **引擎契约测试** - 验证接口实现
2. **注册表测试** - 注册、查找、列表、覆盖
3. **默认引擎选择** - 无配置/显式配置解析
4. **无效引擎处理** - 错误消息质量
5. **Legacy 引擎一致性** - no-op 和 pass-through 行为
6. **初始化守卫** - 幂等性
7. **Bundle chunk 隔离** - 跨 chunk 共享 (#40096)

运行测试：

```bash
pnpm test src/context-engine
```

## 相关模块

- `src/agents/pi-embedded-runner/run.ts` - 主要调用点
- `src/agents/pi-embedded-runner/compact.runtime.ts` - Legacy 压缩实现
- `src/plugins/slots.ts` - 插槽默认值配置
- `extensions/lossless-claw/` - LosslessClaw 引擎实现
