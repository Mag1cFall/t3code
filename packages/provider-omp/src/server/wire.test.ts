import { assert, describe, it } from "@effect/vitest";
import { OmpFrameDecoder, splitModel } from "./wire.ts";

// chunkFrames 按字节边界生成原生分块帧
function chunkFrames(value: unknown, boundaries: number[]): string[] {
  const bytes = Buffer.from(JSON.stringify(value));
  const ends = [...boundaries, bytes.length];
  return ends.map((end, index) =>
    JSON.stringify({
      type: "rpc_chunk",
      chunkId: "response-1",
      index,
      count: ends.length,
      byteLength: bytes.length,
      data: bytes.subarray(index === 0 ? 0 : ends[index - 1], end).toString("base64"),
    }),
  );
}

describe("OMP RPC 分块消息", () => {
  it("保留跨 UTF-8 字符边界的大型最终回复", () => {
    const value = {
      type: "message_end",
      messageId: "m-1",
      message: { role: "assistant", content: [{ type: "text", text: "中文🙂".repeat(110_000) }] },
    };
    const bytes = Buffer.from(JSON.stringify(value));
    const split = bytes.indexOf(Buffer.from("中文🙂")) + 1;
    const frames = chunkFrames(value, [split, 700_000]);
    const decoder = new OmpFrameDecoder();
    assert.isUndefined(decoder.decode(frames[0]!));
    assert.isUndefined(decoder.decode(frames[1]!));
    assert.deepEqual(decoder.decode(frames[2]!), value);
    decoder.finish();
    assert.deepEqual(decoder.decode('{"type":"session_settled"}'), { type: "session_settled" });
  });

  it("在缺块时拒绝提前结束回合", () => {
    const decoder = new OmpFrameDecoder();
    const [first] = chunkFrames({ type: "message_end", text: "未接收完整" }, [12]);
    decoder.decode(first!);
    assert.throws(() => decoder.decode('{"type":"session_settled"}'));
    assert.throws(() => decoder.finish());
  });

  it("拒绝重复块和截断的内容长度", () => {
    const frames = chunkFrames({ type: "response", data: "回复" }, [15]);
    const repeated = new OmpFrameDecoder();
    repeated.decode(frames[0]!);
    assert.throws(() => repeated.decode(frames[0]!));
    const truncated = new OmpFrameDecoder();
    truncated.decode(frames[0]!);
    const last = JSON.parse(frames[1]!);
    last.data = Buffer.from(last.data, "base64").subarray(0, -1).toString("base64");
    assert.throws(() => truncated.decode(JSON.stringify(last)));
  });
});

describe("OMP 模型标识", () => {
  it("在模型名称包含斜杠时保持完整原生 ID", () => {
    assert.deepEqual(splitModel("provider/models/reasoner"), {
      provider: "provider",
      modelId: "models/reasoner",
    });
    assert.throws(() => splitModel("reasoner"));
  });
});
