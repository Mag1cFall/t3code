import { describe, expect, it } from "vite-plus/test";
import { ompUsageFormat, parseOmpUsage } from "./usage.ts";

const timestamp = "2026-10-12T12:00:00.000Z";
const usage = {
  input: 10,
  output: 20,
  cacheRead: 30,
  cacheWrite: 40,
  reasoningTokens: 7,
  cost: { total: 0.125 },
};

describe("OMP 用量消费", () => {
  it("分别累计输入缓存和输出，推理只作为输出子集", () => {
    const state = { sessionId: "" };
    ompUsageFormat.parseLine(JSON.stringify({ type: "session", id: "native-session" }), state);
    const [record] = parseOmpUsage(
      {
        type: "message",
        id: "entry",
        timestamp,
        message: {
          role: "assistant",
          provider: "vendor",
          model: "alias",
          upstreamModel: "actual",
          usage,
        },
      },
      state,
    );
    expect(record).toMatchObject({
      provider: "omp",
      sessionId: "native-session",
      model: "vendor/alias",
      rateModel: "actual",
      reportedCostUsd: 0.125,
      totals: {
        uncachedInputTokens: 10,
        cachedInputTokens: 30,
        cacheCreationTokens: 40,
        outputTokens: 20,
        reasoningTokens: 7,
      },
    });
  });

  it("保留标题及压缩等会话外模型调用，并对分叉副本稳定去重", () => {
    const entry = {
      type: "model_usage",
      id: "usage-entry",
      timestamp,
      purpose: "compaction",
      provider: "vendor",
      model: "model",
      usage,
    };
    const [original] = parseOmpUsage(entry, { sessionId: "original" });
    const [fork] = parseOmpUsage(entry, { sessionId: "fork" });
    expect(original?.dedupeKey).toBe(fork?.dedupeKey);
    expect(original?.reportedCostUsd).toBe(0.125);
  });

  it("不重复统计压缩显示条目或损坏日志", () => {
    expect(
      parseOmpUsage(
        { type: "compaction", id: "summary", timestamp, provider: "vendor", model: "model", usage },
        { sessionId: "s" },
      ),
    ).toEqual([]);
    expect(ompUsageFormat.parseLine("{unfinished", { sessionId: "s" })).toEqual([]);
  });

  it("大日志字段投影与常规 JSONL 读取一致", () => {
    const entry = {
      type: "message",
      id: "entry",
      timestamp,
      message: {
        role: "assistant",
        provider: "vendor",
        model: "model",
        usage: { ...usage, reasoningTokens: 99 },
      },
    };
    const projected = ompUsageFormat.parseProjected(entry, { sessionId: "s" });
    expect(projected).toEqual(ompUsageFormat.parseLine(JSON.stringify(entry), { sessionId: "s" }));
    expect(projected[0]?.totals.reasoningTokens).toBe(20);
  });
});
