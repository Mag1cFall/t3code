import type {
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderThread,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2TurnItem,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { IdAllocatorV2 } from "@t3tools/provider-core/server/IdAllocator";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2RuntimeRequestResponseInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { OMP_PROVIDER } from "./capabilities.ts";
import { ompApprovalKind, ompDialogResponse, ompIsApproval, ompQuestions } from "./dialogs.ts";
import { ompRef } from "./history.ts";
import type { OmpTurn } from "./projection.ts";
import { OmpRpcError, type OmpRpcConnection } from "./rpc.ts";
import { number, text, type OmpRecord } from "./wire.ts";

export interface OmpDialogContext {
  readonly connection: OmpRpcConnection;
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread | null;
  readonly turn: OmpTurn | null;
}

interface PendingDialog {
  readonly event: OmpRecord;
  readonly context: OmpDialogContext;
  request: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly item: OrchestrationV2TurnItem;
}

export interface OmpRuntimeRequests {
  readonly handle: (
    event: OmpRecord,
    context: OmpDialogContext,
  ) => Effect.Effect<void, ProviderAdapterProtocolError | OmpRpcError>;
  readonly respond: (
    input: ProviderAdapterV2RuntimeRequestResponseInput,
  ) => Effect.Effect<void, ProviderAdapterProtocolError | OmpRpcError>;
  readonly cancel: (turn?: OmpTurn) => Effect.Effect<void>;
  readonly snapshot: () => ReadonlyArray<OrchestrationV2RuntimeRequest>;
}

export interface OmpRuntimeRequestsOptions {
  readonly ids: IdAllocatorV2["Service"];
  readonly sessionId: ProviderSessionId;
  readonly emit: (event: ProviderAdapterV2Event) => Effect.Effect<void>;
  readonly serialize: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly waiting: (waiting: boolean) => Effect.Effect<void>;
}

// makeOmpRuntimeRequests 串行发布原生审批问答及其解析状态
export function makeOmpRuntimeRequests(options: OmpRuntimeRequestsOptions): OmpRuntimeRequests {
  const pending = new Map<RuntimeRequestId, PendingDialog>();
  const error = (detail: string, cause?: unknown) =>
    new ProviderAdapterProtocolError({ driver: OMP_PROVIDER, detail, cause });
  const publish = (dialog: PendingDialog) =>
    Effect.gen(function* () {
      yield* options.emit({
        type: "runtime_request.updated",
        driver: OMP_PROVIDER,
        threadId: dialog.node.threadId,
        runtimeRequest: dialog.request,
      });
      yield* options.emit({ type: "node.updated", driver: OMP_PROVIDER, node: dialog.node });
      yield* options.emit({
        type: "turn_item.updated",
        driver: OMP_PROVIDER,
        turnItem: dialog.item,
      });
    });
  const resolve = (
    dialog: PendingDialog,
    status: "resolved" | "expired" | "cancelled",
    response?: ProviderAdapterV2RuntimeRequestResponseInput,
  ) =>
    Effect.gen(function* () {
      pending.delete(dialog.request.id);
      const now = yield* DateTime.now;
      dialog.request = {
        ...dialog.request,
        status,
        resolvedAt: now,
        ...(response?.decision === undefined ? {} : { decision: response.decision }),
        ...(response?.answers === undefined ? {} : { answers: response.answers }),
      };
      const nodeStatus = status === "resolved" ? "completed" : "cancelled";
      yield* publish({
        ...dialog,
        node: { ...dialog.node, status: nodeStatus, completedAt: now },
        item: { ...dialog.item, status: nodeStatus, completedAt: now, updatedAt: now },
      });
      yield* options.waiting(pending.size > 0);
    });
  return {
    handle: (event, context) =>
      Effect.gen(function* () {
        const method = text(event, "method");
        if (method === "cancel") {
          const target = text(event, "targetId");
          for (const dialog of Array.from(pending.values())) {
            if (dialog.context.connection !== context.connection || dialog.event.id !== target)
              continue;
            const timeout = number(dialog.event, "timeout");
            const now = yield* DateTime.now;
            const expired =
              timeout !== undefined &&
              timeout !== 0 &&
              DateTime.toEpochMillis(now) >=
                DateTime.toEpochMillis(dialog.request.createdAt) + Math.max(0, timeout);
            yield* resolve(dialog, expired ? "expired" : "cancelled");
          }
          return;
        }
        if (
          method !== "confirm" &&
          method !== "select" &&
          method !== "input" &&
          method !== "editor" &&
          method !== "ask"
        )
          return;
        const nativeId = text(event, "id");
        if (nativeId === undefined)
          return yield* error("OMP interaction request is missing an ID.");
        const { turn, providerThread, threadId } = context;
        const requestId = yield* options.ids.allocate
          .runtimeRequest({
            driver: OMP_PROVIDER,
            nativeRequestId: nativeId,
            ...(turn === null ? {} : { providerTurnId: turn.entity.id }),
          })
          .pipe(Effect.mapError((cause) => error("Failed to allocate an OMP request ID.", cause)));
        const nodeId = options.ids.derive.approvalNode({ requestId });
        const now = yield* DateTime.now;
        const approval = ompIsApproval(event);
        const title = text(event, "title") ?? "OMP";
        const request: OrchestrationV2RuntimeRequest = {
          id: requestId,
          nodeId,
          providerTurnId: turn?.entity.id ?? null,
          nativeRequestRef: ompRef(nativeId),
          kind: approval ? ompApprovalKind(event) : "user_input",
          status: "pending",
          responseCapability: { type: "live", providerSessionId: options.sessionId },
          createdAt: now,
          resolvedAt: null,
        };
        const node: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId,
          runId: turn?.input.runId ?? null,
          parentNodeId: turn?.input.rootNodeId ?? null,
          rootNodeId: turn?.input.rootNodeId ?? nodeId,
          kind: approval ? "approval_request" : "user_input_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId: providerThread?.id ?? null,
          providerTurnId: turn?.entity.id ?? null,
          nativeItemRef: ompRef(nativeId),
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        };
        const base = {
          id: options.ids.derive.approvalTurnItem({ requestId }),
          threadId,
          runId: node.runId,
          nodeId,
          providerThreadId: node.providerThreadId,
          providerTurnId: node.providerTurnId,
          nativeItemRef: ompRef(nativeId),
          parentItemId: null,
          ordinal: turn === null ? 0 : turn.nextOrdinal++,
          status: "waiting" as const,
          title,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        };
        const item: OrchestrationV2TurnItem = approval
          ? {
              ...base,
              type: "approval_request",
              requestId,
              requestKind: ompApprovalKind(event),
              prompt: text(event, "message") ?? title,
              options: [
                { decision: "accept", label: "Allow" },
                { decision: "decline", label: "Deny" },
              ],
            }
          : { ...base, type: "user_input_request", requestId, questions: ompQuestions(event) };
        const dialog: PendingDialog = { event, context, request, node, item };
        pending.set(requestId, dialog);
        yield* publish(dialog);
        yield* options.waiting(true);
      }),
    respond: (response) =>
      options.serialize(
        Effect.gen(function* () {
          const dialog = pending.get(response.requestId);
          if (dialog === undefined)
            return yield* error("OMP request has ended or does not belong to this session.");
          if (
            ompIsApproval(dialog.event) &&
            response.decision !== "accept" &&
            response.decision !== "decline" &&
            response.decision !== "cancel"
          )
            return yield* error(
              "OMP approvals only support allowing, denying, or cancelling this request.",
            );
          const nativeResponse = yield* Effect.try({
            try: () => ompDialogResponse(dialog.event, response.decision, response.answers),
            catch: (cause) => error("Invalid OMP question answer.", cause),
          });
          yield* dialog.context.connection.send(nativeResponse);
          yield* resolve(
            dialog,
            nativeResponse.cancelled === true || response.decision === "cancel"
              ? "cancelled"
              : "resolved",
            response,
          );
        }),
      ),
    cancel: (turn) =>
      Effect.gen(function* () {
        for (const dialog of Array.from(pending.values())) {
          if (turn !== undefined && dialog.context.turn !== turn) continue;
          yield* resolve(dialog, "cancelled");
        }
      }),
    snapshot: () => [...pending.values()].map((dialog) => dialog.request),
  };
}
