/**
 * 内容块工具
 *
 * 从模型/API 返回的 content 数组中抽取 type===text 的文本块，用于拼接或展示。
 */
export function collectTextContentBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as { type?: unknown; text?: unknown };
    if (rec.type === "text" && typeof rec.text === "string") {
      parts.push(rec.text);
    }
  }
  return parts;
}
