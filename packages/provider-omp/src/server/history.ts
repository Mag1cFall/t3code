import type { OrchestrationV2ProviderRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { OMP_PROVIDER } from "./capabilities.ts";
import { OmpRpcError, type OmpRpcConnection } from "./rpc.ts";
import { field, text, type OmpRecord } from "./wire.ts";

// ompRef 标识属于 OMP 的原生会话、消息或请求
export const ompRef = (
  nativeId: string,
  strength: "strong" | "weak" = "strong",
): OrchestrationV2ProviderRef => ({ driver: OMP_PROVIDER, nativeId, strength });

export interface OmpHistorySnapshot {
  readonly leafId: string | null;
  readonly messageId: string | null;
  readonly branch: ReadonlyArray<OmpRecord>;
}

export interface OmpHistory {
  readonly reset: () => void;
  readonly sync: Effect.Effect<OmpHistorySnapshot, OmpRpcError>;
}

// makeOmpHistory 用追加游标读取原生树并沿活动分支寻找最后保留消息
export function makeOmpHistory(connection: OmpRpcConnection): OmpHistory {
  const entries = new Map<string, OmpRecord>();
  let cursor: string | undefined;
  return {
    reset: () => {
      entries.clear();
      cursor = undefined;
    },
    sync: Effect.gen(function* () {
      const data = yield* connection.request({
        type: "get_entries",
        ...(cursor === undefined ? {} : { since: cursor }),
      });
      const incoming = field(data, "entries");
      if (!Array.isArray(incoming))
        return yield* new OmpRpcError({
          operation: "get_entries",
          detail: "OMP did not return a session tree",
        });
      for (const value of incoming) {
        const id = text(value, "id");
        if (id === undefined)
          return yield* new OmpRpcError({
            operation: "get_entries",
            detail: "OMP session entry has no identity",
          });
        entries.set(id, value as OmpRecord);
        cursor = id;
      }
      const leafId = text(data, "leafId") ?? null;
      const branch: OmpRecord[] = [];
      const seen = new Set<string>();
      let current = leafId;
      let messageId: string | null = null;
      while (current !== null) {
        const entry = entries.get(current);
        if (entry === undefined || seen.has(current))
          return yield* new OmpRpcError({
            operation: "get_entries",
            detail: "OMP active branch has an incomplete parent chain",
          });
        seen.add(current);
        branch.push(entry);
        if (messageId === null && entry.type === "message") messageId = current;
        current = text(entry, "parentId") ?? null;
      }
      branch.reverse();
      return { leafId, messageId, branch };
    }),
  };
}

// readOmpMessages 按稳定游标读取空闲会话的当前分支
export const readOmpMessages = Effect.fn("readOmpMessages")(function* (
  connection: OmpRpcConnection,
) {
  const messages: unknown[] = [];
  let cursor: string | undefined;
  do {
    const page = yield* connection.request({
      type: "get_messages_page",
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const values = field(page, "messages");
    if (!Array.isArray(values))
      return yield* new OmpRpcError({
        operation: "get_messages_page",
        detail: "OMP did not return a history page",
      });
    messages.push(...values);
    cursor = text(page, "nextCursor");
  } while (cursor !== undefined);
  return messages;
});
