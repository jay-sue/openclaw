/**
 * 上下文引擎测试套件。
 *
 * 测试覆盖范围：
 * 1. 引擎契约测试 - 验证 ContextEngine 接口实现
 * 2. 注册表测试 - 验证注册、查找、列表功能
 * 3. 默认引擎选择 - 验证解析逻辑
 * 4. 无效引擎 fallback - 验证错误处理
 * 5. LegacyContextEngine 一致性 - 验证 legacy 引擎行为
 * 6. 初始化守卫 - 验证幂等初始化
 * 7. Bundle chunk 隔离 - 验证跨 chunk 注册共享 (#40096)
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, beforeEach } from "vitest";
// ---------------------------------------------------------------------------
// 动态导入注册表，以便在需要时为每个测试组获取新的模块。
// 对于大多数组，我们直接使用共享的单例。
// ---------------------------------------------------------------------------
import { LegacyContextEngine, registerLegacyContextEngine } from "./legacy.js";
import {
  registerContextEngine,
  getContextEngineFactory,
  listContextEngineIds,
  resolveContextEngine,
} from "./registry.js";
import type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  IngestResult,
} from "./types.js";

// ===========================================================================
// 辅助函数
// ===========================================================================

/**
 * 构建包含 contextEngine 插槽的配置对象，用于测试。
 *
 * @param engineId - 引擎 ID
 * @returns 模拟配置对象
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function configWithSlot(engineId: string): any {
  return { plugins: { slots: { contextEngine: engineId } } };
}

/**
 * 创建模拟消息。
 *
 * @param role - 消息角色（user 或 assistant）
 * @param text - 消息内容
 * @returns AgentMessage 对象
 */
function makeMockMessage(role: "user" | "assistant" = "user", text = "hello"): AgentMessage {
  return { role, content: text, timestamp: Date.now() } as AgentMessage;
}

/**
 * 满足 ContextEngine 接口的最小模拟引擎。
 *
 * 用于测试注册表和接口契约，不依赖真实的存储或压缩逻辑。
 */
class MockContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "mock",
    name: "Mock Engine",
    version: "0.0.1",
  };

  async ingest(_params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    return { ingested: true };
  }

  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    return {
      messages: params.messages,
      estimatedTokens: 42,
      systemPromptAddition: "mock system addition",
    };
  }

  async compact(_params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: Record<string, unknown>;
  }): Promise<CompactResult> {
    return {
      ok: true,
      compacted: true,
      reason: "mock compaction",
      result: {
        summary: "mock summary",
        tokensBefore: 100,
        tokensAfter: 50,
      },
    };
  }

  async dispose(): Promise<void> {
    // no-op
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. 引擎契约测试
// ═══════════════════════════════════════════════════════════════════════════

describe("Engine contract tests", () => {
  /**
   * 验证实现 ContextEngine 接口的模拟引擎可以被注册和解析。
   */
  it("a mock engine implementing ContextEngine can be registered and resolved", async () => {
    const factory = () => new MockContextEngine();
    registerContextEngine("mock", factory);

    const resolved = getContextEngineFactory("mock");
    expect(resolved).toBe(factory);

    const engine = await resolved!();
    expect(engine).toBeInstanceOf(MockContextEngine);
    expect(engine.info.id).toBe("mock");
  });

  /**
   * 验证 ingest() 返回包含 ingested 布尔值的 IngestResult。
   */
  it("ingest() returns IngestResult with ingested boolean", async () => {
    const engine = new MockContextEngine();
    const result = await engine.ingest({
      sessionId: "s1",
      message: makeMockMessage(),
    });

    expect(result).toHaveProperty("ingested");
    expect(typeof result.ingested).toBe("boolean");
    expect(result.ingested).toBe(true);
  });

  /**
   * 验证 assemble() 返回包含 messages 数组和 estimatedTokens 的 AssembleResult。
   */
  it("assemble() returns AssembleResult with messages array and estimatedTokens", async () => {
    const engine = new MockContextEngine();
    const msgs = [makeMockMessage(), makeMockMessage("assistant", "world")];
    const result = await engine.assemble({
      sessionId: "s1",
      messages: msgs,
    });

    expect(Array.isArray(result.messages)).toBe(true);
    expect(result.messages).toHaveLength(2);
    expect(typeof result.estimatedTokens).toBe("number");
    expect(result.estimatedTokens).toBe(42);
    expect(result.systemPromptAddition).toBe("mock system addition");
  });

  /**
   * 验证 compact() 返回包含 ok, compacted, reason, result 字段的 CompactResult。
   */
  it("compact() returns CompactResult with ok, compacted, reason, result fields", async () => {
    const engine = new MockContextEngine();
    const result = await engine.compact({
      sessionId: "s1",
      sessionFile: "/tmp/session.json",
    });

    expect(typeof result.ok).toBe("boolean");
    expect(typeof result.compacted).toBe("boolean");
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.reason).toBe("mock compaction");
    expect(result.result).toBeDefined();
    expect(result.result!.summary).toBe("mock summary");
    expect(result.result!.tokensBefore).toBe(100);
    expect(result.result!.tokensAfter).toBe(50);
  });

  /**
   * 验证 dispose() 是可调用的（可选方法）。
   */
  it("dispose() is callable (optional method)", async () => {
    const engine = new MockContextEngine();
    // 应该无错误完成
    await expect(engine.dispose()).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. 注册表测试
// ═══════════════════════════════════════════════════════════════════════════

describe("Registry tests", () => {
  /**
   * 验证 registerContextEngine() 存储工厂函数。
   */
  it("registerContextEngine() stores a factory", () => {
    const factory = () => new MockContextEngine();
    registerContextEngine("reg-test-1", factory);

    expect(getContextEngineFactory("reg-test-1")).toBe(factory);
  });

  /**
   * 验证 getContextEngineFactory() 返回工厂函数。
   */
  it("getContextEngineFactory() returns the factory", () => {
    const factory = () => new MockContextEngine();
    registerContextEngine("reg-test-2", factory);

    const retrieved = getContextEngineFactory("reg-test-2");
    expect(retrieved).toBe(factory);
    expect(typeof retrieved).toBe("function");
  });

  /**
   * 验证 listContextEngineIds() 返回所有已注册的 ID。
   */
  it("listContextEngineIds() returns all registered ids", () => {
    // 确保至少存在我们的测试条目
    registerContextEngine("reg-test-a", () => new MockContextEngine());
    registerContextEngine("reg-test-b", () => new MockContextEngine());

    const ids = listContextEngineIds();
    expect(ids).toContain("reg-test-a");
    expect(ids).toContain("reg-test-b");
    expect(Array.isArray(ids)).toBe(true);
  });

  /**
   * 验证注册相同 ID 会覆盖之前的工厂。
   */
  it("registering the same id overwrites the previous factory", () => {
    const factory1 = () => new MockContextEngine();
    const factory2 = () => new MockContextEngine();

    registerContextEngine("reg-overwrite", factory1);
    expect(getContextEngineFactory("reg-overwrite")).toBe(factory1);

    registerContextEngine("reg-overwrite", factory2);
    expect(getContextEngineFactory("reg-overwrite")).toBe(factory2);
    expect(getContextEngineFactory("reg-overwrite")).not.toBe(factory1);
  });

  /**
   * 验证跨重复模块副本共享已注册的引擎。
   *
   * 这测试了 Symbol.for() 机制确保全局单例性。
   */
  it("shares registered engines across duplicate module copies", async () => {
    const registryUrl = new URL("./registry.ts", import.meta.url).href;
    const suffix = Date.now().toString(36);
    const first = await import(/* @vite-ignore */ `${registryUrl}?copy=${suffix}-a`);
    const second = await import(/* @vite-ignore */ `${registryUrl}?copy=${suffix}-b`);

    const engineId = `dup-copy-${suffix}`;
    const factory = () => new MockContextEngine();
    first.registerContextEngine(engineId, factory);

    expect(second.getContextEngineFactory(engineId)).toBe(factory);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. 默认引擎选择
// ═══════════════════════════════════════════════════════════════════════════

describe("Default engine selection", () => {
  // 确保在这些测试之前注册了 legacy 和自定义测试引擎
  beforeEach(() => {
    // 注册是幂等的（Map.set），所以再次调用是安全的
    registerLegacyContextEngine();
    // 注册一个轻量级自定义存根，这样我们不需要外部资源
    registerContextEngine("test-engine", () => {
      const engine: ContextEngine = {
        info: { id: "test-engine", name: "Custom Test Engine", version: "0.0.0" },
        async ingest() {
          return { ingested: true };
        },
        async assemble({ messages }) {
          return { messages, estimatedTokens: 0 };
        },
        async compact() {
          return { ok: true, compacted: false };
        },
      };
      return engine;
    });
  });

  /**
   * 验证无配置时 resolveContextEngine() 返回默认（'legacy'）引擎。
   */
  it("resolveContextEngine() with no config returns the default ('legacy') engine", async () => {
    const engine = await resolveContextEngine();
    expect(engine.info.id).toBe("legacy");
  });

  /**
   * 验证配置 contextEngine='legacy' 时返回 legacy 引擎。
   */
  it("resolveContextEngine() with config contextEngine='legacy' returns legacy engine", async () => {
    const engine = await resolveContextEngine(configWithSlot("legacy"));
    expect(engine.info.id).toBe("legacy");
  });

  /**
   * 验证配置 contextEngine='test-engine' 时返回自定义引擎。
   */
  it("resolveContextEngine() with config contextEngine='test-engine' returns the custom engine", async () => {
    const engine = await resolveContextEngine(configWithSlot("test-engine"));
    expect(engine.info.id).toBe("test-engine");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. 无效引擎 fallback
// ═══════════════════════════════════════════════════════════════════════════

describe("Invalid engine fallback", () => {
  /**
   * 验证配置指向未注册引擎时 resolveContextEngine() 抛出有用的错误。
   */
  it("resolveContextEngine() with config pointing to unregistered engine throws with helpful error", async () => {
    await expect(resolveContextEngine(configWithSlot("nonexistent-engine"))).rejects.toThrow(
      /nonexistent-engine/,
    );
  });

  /**
   * 验证错误消息包含请求的 ID 和可用的 ID 列表。
   */
  it("error message includes the requested id and available ids", async () => {
    // 确保至少注册了 legacy，这样我们可以在可用列表中看到它
    registerLegacyContextEngine();

    try {
      await resolveContextEngine(configWithSlot("does-not-exist"));
      // 不应该到达这里
      expect.unreachable("Expected resolveContextEngine to throw");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("does-not-exist");
      expect(message).toContain("not registered");
      // 应该提及可用引擎
      expect(message).toMatch(/Available engines:/);
      // 至少 "legacy" 应该列为可用
      expect(message).toContain("legacy");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. LegacyContextEngine 一致性
// ═══════════════════════════════════════════════════════════════════════════

describe("LegacyContextEngine parity", () => {
  /**
   * 验证 ingest() 返回 { ingested: false }（no-op）。
   *
   * Legacy 引擎不处理消息摄入，由 SessionManager 负责。
   */
  it("ingest() returns { ingested: false } (no-op)", async () => {
    const engine = new LegacyContextEngine();
    const result = await engine.ingest({
      sessionId: "s1",
      message: makeMockMessage(),
    });

    expect(result).toEqual({ ingested: false });
  });

  /**
   * 验证 assemble() 原样返回消息（pass-through）。
   *
   * Legacy 引擎不处理上下文组装，由 attempt.ts 的管道负责。
   */
  it("assemble() returns messages as-is (pass-through)", async () => {
    const engine = new LegacyContextEngine();
    const messages = [
      makeMockMessage("user", "first"),
      makeMockMessage("assistant", "second"),
      makeMockMessage("user", "third"),
    ];

    const result = await engine.assemble({
      sessionId: "s1",
      messages,
    });

    // 消息应该是完全相同的数组引用（pass-through）
    expect(result.messages).toBe(messages);
    expect(result.messages).toHaveLength(3);
    expect(result.estimatedTokens).toBe(0);
    expect(result.systemPromptAddition).toBeUndefined();
  });

  /**
   * 验证 dispose() 无错误完成。
   */
  it("dispose() completes without error", async () => {
    const engine = new LegacyContextEngine();
    await expect(engine.dispose()).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. 初始化守卫
// ═══════════════════════════════════════════════════════════════════════════

describe("Initialization guard", () => {
  /**
   * 验证 ensureContextEnginesInitialized() 是幂等的（调用两次不会抛出）。
   */
  it("ensureContextEnginesInitialized() is idempotent (calling twice does not throw)", async () => {
    const { ensureContextEnginesInitialized } = await import("./init.js");

    expect(() => ensureContextEnginesInitialized()).not.toThrow();
    expect(() => ensureContextEnginesInitialized()).not.toThrow();
  });

  /**
   * 验证初始化后 'legacy' 引擎已注册。
   */
  it("after init, 'legacy' engine is registered", async () => {
    const { ensureContextEnginesInitialized } = await import("./init.js");
    ensureContextEnginesInitialized();

    const ids = listContextEngineIds();
    expect(ids).toContain("legacy");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Bundle chunk 隔离 (#40096)
//
// 发布构建可能将 context-engine 注册表分割到多个输出 chunk 中。
// Symbol.for() 键控的全局确保从 chunk A 调用 registerContextEngine()
// 的插件对从 chunk B 导入的 resolveContextEngine() 可见。
//
// 这些测试验证了在 2026.3.7 失败的不变量，当时 lossless-claw
// 注册成功但解析找不到它。
// ═══════════════════════════════════════════════════════════════════════════

describe("Bundle chunk isolation (#40096)", () => {
  /**
   * 验证 Symbol.for 键在独立加载的模块之间是稳定的。
   *
   * 通过使用不同查询字符串加载注册表模块两次来模拟两个不同的 bundle chunk
   * （在 Vite/esbuild 中强制分离模块实例，但共享 globalThis）。
   */
  it("Symbol.for key is stable across independently loaded modules", async () => {
    const ts = Date.now().toString(36);
    const registryUrl = new URL("./registry.ts", import.meta.url).href;

    const chunkA = await import(/* @vite-ignore */ `${registryUrl}?chunk=a-${ts}`);
    const chunkB = await import(/* @vite-ignore */ `${registryUrl}?chunk=b-${ts}`);

    // Chunk A 注册一个引擎
    const engineId = `cross-chunk-${ts}`;
    chunkA.registerContextEngine(engineId, () => new MockContextEngine());

    // Chunk B 必须能看到它
    expect(chunkB.getContextEngineFactory(engineId)).toBeDefined();
    expect(chunkB.listContextEngineIds()).toContain(engineId);
  });

  /**
   * 验证从 chunk B 的 resolveContextEngine 能找到在 chunk A 注册的引擎。
   */
  it("resolveContextEngine from chunk B finds engine registered in chunk A", async () => {
    const ts = Date.now().toString(36);
    const registryUrl = new URL("./registry.ts", import.meta.url).href;

    const chunkA = await import(/* @vite-ignore */ `${registryUrl}?chunk=resolve-a-${ts}`);
    const chunkB = await import(/* @vite-ignore */ `${registryUrl}?chunk=resolve-b-${ts}`);

    const engineId = `resolve-cross-${ts}`;
    chunkA.registerContextEngine(engineId, () => ({
      info: { id: engineId, name: "Cross-chunk Engine", version: "0.0.1" },
      async ingest() {
        return { ingested: true };
      },
      async assemble({ messages }: { messages: AgentMessage[] }) {
        return { messages, estimatedTokens: 0 };
      },
      async compact() {
        return { ok: true, compacted: false };
      },
    }));

    // 使用指向此引擎的配置从 chunk B 解析
    const engine = await chunkB.resolveContextEngine(configWithSlot(engineId));
    expect(engine.info.id).toBe(engineId);
  });

  /**
   * 验证 plugin-sdk 导出路径与直接导入共享相同的全局注册表。
   *
   * plugin-sdk 重新导出 registerContextEngine。验证重新导出
   * 写入与直接导入相同的全局符号。
   */
  it("plugin-sdk export path shares the same global registry", async () => {
    const ts = Date.now().toString(36);
    const engineId = `sdk-path-${ts}`;

    // 直接注册表导入
    registerContextEngine(engineId, () => new MockContextEngine());

    // Plugin-sdk 导入（发布 bundle 中的不同 chunk 路径）
    const sdkUrl = new URL("../plugin-sdk/index.ts", import.meta.url).href;
    const sdk = await import(/* @vite-ignore */ `${sdkUrl}?sdk-${ts}`);

    // SDK 导出应该能看到我们刚注册的引擎
    const factory = getContextEngineFactory(engineId);
    expect(factory).toBeDefined();

    // 从 SDK 路径注册也应该从直接路径可见
    const sdkEngineId = `sdk-registered-${ts}`;
    sdk.registerContextEngine(sdkEngineId, () => new MockContextEngine());
    expect(getContextEngineFactory(sdkEngineId)).toBeDefined();
  });

  /**
   * 验证从多个 chunk 并发注册不会丢失条目。
   */
  it("concurrent registration from multiple chunks does not lose entries", async () => {
    const ts = Date.now().toString(36);
    const registryUrl = new URL("./registry.ts", import.meta.url).href;
    let releaseRegistrations: (() => void) | undefined;
    const registrationStart = new Promise<void>((resolve) => {
      releaseRegistrations = resolve;
    });

    // 并行加载 5 个 "chunk"
    const chunks = await Promise.all(
      Array.from(
        { length: 5 },
        (_, i) => import(/* @vite-ignore */ `${registryUrl}?concurrent-${ts}-${i}`),
      ),
    );

    const ids = chunks.map((_, i) => `concurrent-${ts}-${i}`);
    const registrationTasks = chunks.map(async (chunk, i) => {
      const id = `concurrent-${ts}-${i}`;
      await registrationStart;
      chunk.registerContextEngine(id, () => new MockContextEngine());
    });
    releaseRegistrations?.();
    await Promise.all(registrationTasks);

    // 所有 5 个引擎必须从任何 chunk 可见
    const allIds = chunks[0].listContextEngineIds();
    for (const id of ids) {
      expect(allIds).toContain(id);
    }
  });
});
