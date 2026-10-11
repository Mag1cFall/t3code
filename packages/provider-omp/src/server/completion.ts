import * as DateTime from "effect/DateTime";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { field, number, text, type OmpRecord } from "./wire.ts";

export interface OmpCompletionResult {
  readonly status: "completed" | "interrupted" | "failed";
  readonly error?: unknown;
  readonly yieldedToBackground?: true;
}

// ompFailure 将原生助手错误和 RpcPromptError 归入共享失败类型
export function ompFailure(error: unknown, nowMs: number) {
  const message =
    (typeof error === "string" ? error : (text(error, "errorMessage") ?? text(error, "message"))) ??
    "OMP request failed";
  const classification = text(error, "errorClassificationMessage") ?? message;
  const errorId = number(error, "errorId") ?? 0;
  const status = number(error, "errorStatus") ?? number(error, "httpStatus");
  const limited =
    (errorId & 0x0008_0000) !== 0 ||
    status === 429 ||
    /\b(?:usage[ _-]limit(?:[ _-]reached)?|usage_not_included|rate[ _-]?limit(?:[ _-](?:error|exceeded|reached))?|too many requests|insufficient[ _-]quota|quota[ _-](?:exceeded|exhausted)|exceeded your current quota)\b/i.test(
      classification,
    );
  const resetsAt = /"resets_at"\s*:\s*(\d+(?:\.\d+)?)/u.exec(classification);
  const retryAfter = /\bretry-after-ms=(\d+(?:\.\d+)?)/u.exec(message);
  const resetMs = resetsAt
    ? Number(resetsAt[1]) * 1000
    : retryAfter
      ? nowMs + Number(retryAfter[1])
      : undefined;
  const retryable = field(error, "retryable");
  return makeProviderFailure({
    message,
    class: limited ? "usage_limit" : "provider_error",
    retryable:
      typeof retryable === "boolean" ? retryable : (errorId & 0x0002_0000) !== 0 ? true : null,
    ...(limited && resetMs !== undefined
      ? { resetAt: DateTime.formatIso(DateTime.makeUnsafe(resetMs)) }
      : {}),
  });
}

// OmpCompletion 区分命令接受、原生让出和整个会话真正结束
export class OmpCompletion {
  private result: OmpCompletionResult | undefined;
  private settled = false;
  private finished = false;
  private agentInvoked = false;
  private awaitingAsyncWork = false;
  readonly promptId: string;
  readonly kind: "prompt" | "compact" | "continuation";

  constructor(promptId: string, kind: "prompt" | "compact" | "continuation") {
    this.promptId = promptId;
    this.kind = kind;
    if (kind === "continuation") this.result = { status: "completed" };
  }

  resume(): void {
    this.settled = false;
    this.finished = false;
    this.awaitingAsyncWork = false;
  }

  observe(event: OmpRecord): OmpCompletionResult | undefined {
    if (this.finished) return undefined;
    if (event.type === "agent_start") {
      this.agentInvoked = true;
      this.settled = false;
      this.awaitingAsyncWork = false;
    }
    if (event.type === "agent_end") {
      this.awaitingAsyncWork = event.yielded === true && event.awaitingAsyncWork === true;
      if (this.kind === "continuation" && this.awaitingAsyncWork) {
        this.result = { status: "completed", yieldedToBackground: true };
        this.settled = true;
      }
    }
    if (event.type === "session_settled") this.settled = true;
    if (event.type === "response" && event.id === this.promptId) {
      if (event.success === false) {
        this.result = { status: "failed", error: event.error ?? "OMP rejected the command" };
        if (this.kind === "compact" || !this.agentInvoked) this.settled = true;
      } else if (this.kind === "compact" || field(event.data, "agentInvoked") === false) {
        this.result = { status: "completed" };
        if (this.kind === "compact" || !this.agentInvoked) this.settled = true;
      }
    }
    if (event.type === "prompt_result" && event.id === this.promptId) {
      const status = event.status;
      this.result =
        status === "error"
          ? { status: "failed", error: event.error ?? "OMP turn failed" }
          : { status: status === "aborted" ? "interrupted" : "completed" };
      if (event.agentInvoked === false && event.sessionSettled === true) this.settled = true;
      if (status === "completed" && this.awaitingAsyncWork && event.sessionSettled === false) {
        this.result = { status: "completed", yieldedToBackground: true };
        this.settled = true;
      }
    }
    if (
      event.type === "t3.abort_settled" &&
      event.id === this.promptId &&
      event.isSettled === true
    ) {
      this.result = { status: "interrupted" };
      this.settled = true;
    }
    if (!this.settled || this.result === undefined) return undefined;
    this.finished = true;
    return this.result;
  }
}
