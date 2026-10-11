import * as Predicate from "effect/Predicate";

export type OmpRecord = Record<string, unknown>;

// field 读取协议对象中的字段
export const field = (value: unknown, key: string): unknown =>
  Predicate.isObject(value) ? value[key] : undefined;

// text 读取协议中的字符串字段
export const text = (value: unknown, key: string): string | undefined => {
  const result = field(value, key);
  return typeof result === "string" ? result : undefined;
};

// number 读取协议中的数值字段
export const number = (value: unknown, key: string): number | undefined => {
  const result = field(value, key);
  return typeof result === "number" ? result : undefined;
};

// contentText 拼接模型内容块中的文本
export const contentText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const value = text(block, "text");
    if (value !== undefined) parts.push(value);
  }
  return parts.join("\n");
};

// splitModel 将 OMP 模型标识拆为供应商与模型名称
export function splitModel(slug: string): { provider: string; modelId: string } {
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1) {
    throw new Error(`OMP models must use the provider/model format: ${slug}`);
  }
  return { provider: slug.slice(0, separator), modelId: slug.slice(separator + 1) };
}

// OmpFrameDecoder 按 OMP v2 顺序重组分块消息
export class OmpFrameDecoder {
  private pending: {
    id: string;
    count: number;
    size: number;
    chunks: Buffer[];
    received: number;
  } | null = null;

  decode(line: string): OmpRecord | undefined {
    const record: unknown = JSON.parse(line);
    if (!Predicate.isObject(record)) throw new Error("OMP protocol frames must be objects.");
    if (record.type !== "rpc_chunk") {
      if (this.pending !== null)
        throw new Error("An OMP chunked message was interrupted by another message.");
      return record;
    }
    const { chunkId, count, byteLength, index, data } = record;
    if (
      typeof chunkId !== "string" ||
      typeof data !== "string" ||
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count < 1 ||
      typeof byteLength !== "number" ||
      !Number.isInteger(byteLength) ||
      byteLength < 1 ||
      byteLength > 64 * 1024 * 1024 ||
      typeof index !== "number" ||
      !Number.isInteger(index)
    )
      throw new Error("Invalid OMP chunk metadata.");
    if (this.pending === null) {
      if (index !== 0) throw new Error("The first OMP message chunk is missing.");
      this.pending = { id: chunkId, count, size: byteLength, chunks: [], received: 0 };
    }
    const pending = this.pending;
    if (
      chunkId !== pending.id ||
      count !== pending.count ||
      byteLength !== pending.size ||
      index !== pending.chunks.length
    ) {
      throw new Error("OMP message chunks arrived out of order.");
    }
    const chunk = Buffer.from(data, "base64");
    pending.chunks.push(chunk);
    pending.received += chunk.length;
    if (pending.received > pending.size)
      throw new Error("OMP message chunks exceed the declared length.");
    if (pending.chunks.length < pending.count) return undefined;
    if (pending.received !== pending.size)
      throw new Error("OMP message chunk length does not match.");
    this.pending = null;
    const decoded: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.chunks, pending.size)),
    );
    if (!Predicate.isObject(decoded)) throw new Error("OMP logical messages must be objects.");
    return decoded;
  }

  finish(): void {
    if (this.pending !== null)
      throw new Error("OMP output ended before the chunked message completed.");
  }
}
