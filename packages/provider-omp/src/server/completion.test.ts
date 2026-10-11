import { describe, expect, it } from "@effect/vitest";
import { ompFailure } from "./completion.ts";

const now = Date.parse("2026-10-12T12:00:00.000Z");

describe("OMP 原生失败分类", () => {
  it("保留助手错误的用量标记和原生重试时间", () => {
    expect(
      ompFailure(
        {
          errorId: 0x0008_0000,
          errorStatus: 403,
          errorMessage: "Account limit reached retry-after-ms=120000",
        },
        now,
      ),
    ).toMatchObject({
      class: "usage_limit",
      resetAt: "2026-10-12T12:02:00.000Z",
    });
  });

  it("将RpcPromptError限流状态归为用量限额并保留retryable", () => {
    expect(
      ompFailure({ message: "Too many requests", httpStatus: 429, retryable: true }, now),
    ).toMatchObject({ class: "usage_limit", retryable: true });
  });

  it("保留原生错误正文中的绝对重置时间", () => {
    expect(
      ompFailure(
        {
          errorMessage: '429 {"error":{"type":"usage_limit_reached","resets_at":1791806700}}',
        },
        now,
      ),
    ).toMatchObject({ class: "usage_limit", resetAt: "2026-10-12T12:05:00.000Z" });
  });

  it("识别没有HTTP状态的原生配额错误", () => {
    expect(
      ompFailure(
        {
          message: "You exceeded your current quota, please check your plan and billing details.",
          retryable: false,
        },
        now,
      ),
    ).toMatchObject({ class: "usage_limit", retryable: false });
  });

  it("普通失败和瞬时网络错误不变成限额", () => {
    const failure = ompFailure(
      { errorMessage: "Connection reset retry-after-ms=1000", errorId: 0x0002_0000 },
      now,
    );
    expect(failure).toMatchObject({ class: "provider_error", retryable: true });
    expect(failure).not.toHaveProperty("resetAt");
    expect(ompFailure("Invalid tool parameters schema", now).class).toBe("provider_error");
  });
});
