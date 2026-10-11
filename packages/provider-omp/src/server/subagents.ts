import type {
  OrchestrationV2AppThread,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Subagent,
  ProviderInstanceId,
  ProviderSessionId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type { IdAllocatorV2 } from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
} from "@t3tools/provider-core/server/subagentProjection";
import { OMP_PROVIDER } from "./capabilities.ts";
import { ompRef } from "./history.ts";
import type { OmpContent, OmpProjection, OmpProjectionError, OmpTurn } from "./projection.ts";
import type { OmpRpcError, OmpRpcConnection } from "./rpc.ts";
import { contentText, field, number, text, type OmpRecord } from "./wire.ts";

interface Child {
  readonly nativeId: string;
  readonly owner: OmpTurn;
  readonly scope: OmpContent;
  readonly parent: Child | undefined;
  readonly parentToolCallId: string | undefined;
  readonly key: string;
  entity: OrchestrationV2Subagent;
  thread?: OrchestrationV2AppThread;
  providerThread?: OrchestrationV2ProviderThread;
  providerTurn?: OrchestrationV2ProviderTurn;
  content?: OmpContent;
  sessionFile?: string;
  nextByte: number;
  lastAssistantText?: string;
  readonly messages: Set<string>;
  readonly resultSections: Map<string, string>;
  readonly pending: OmpRecord[];
  lastPublishedAt: number;
}

interface ToolOwner {
  readonly owner: OmpTurn;
  readonly child?: Child;
}

export interface OmpSubagents {
  readonly handle: (
    event: OmpRecord,
    active: OmpTurn | null,
  ) => Effect.Effect<void, OmpRpcError | OmpProjectionError>;
  readonly close: (owner: OmpTurn) => Effect.Effect<void>;
  readonly disconnect: (failure: OrchestrationV2ProviderFailure) => Effect.Effect<void>;
}

export interface OmpSubagentsOptions {
  readonly ids: IdAllocatorV2["Service"];
  readonly instanceId: ProviderInstanceId;
  readonly sessionId: ProviderSessionId;
  readonly connection: OmpRpcConnection;
  readonly emit: (event: ProviderAdapterV2Event) => Effect.Effect<void>;
  readonly projection: OmpProjection;
}

// ompSubagentResult 从原生消息协议提取未截断的子代理输出
function ompSubagentResult(message: unknown, lastAssistantText?: string): string | undefined {
  if (text(message, "role") === "assistant") {
    const output = contentText(field(message, "content"));
    return output.length > 0 ? output : undefined;
  }
  if (
    text(message, "role") !== "toolResult" ||
    text(message, "toolName") !== "yield" ||
    field(message, "isError") === true
  )
    return undefined;
  const details = field(message, "details");
  if (text(details, "status") !== "success") return undefined;
  const data = field(details, "data");
  if (
    field(details, "useLastTurn") === true ||
    (data === undefined && Array.isArray(field(details, "type")))
  )
    return lastAssistantText;
  return typeof data === "string"
    ? data
    : data === undefined
      ? undefined
      : JSON.stringify(data, null, 2);
}

// nativeMessageKey 使用原生时间戳把实时消息与持久化消息关联
function nativeMessageKey(message: unknown): string | undefined {
  const timestamp = number(message, "timestamp");
  const role = text(message, "role");
  if (role === "toolResult") return text(message, "toolCallId");
  return timestamp === undefined || role === undefined ? undefined : `${role}:${timestamp}`;
}

// bufferedEvent 丢弃增量事件中的累计快照而保留真实增量和消息身份
function bufferedEvent(event: OmpRecord): OmpRecord {
  if (event.type !== "message_update") return event;
  const update = field(event, "assistantMessageEvent");
  if (typeof update !== "object" || update === null || Array.isArray(update)) return event;
  const { partial: _partial, ...delta } = update as OmpRecord;
  const messageId = text(event, "messageId") ?? nativeMessageKey(event.message);
  return { type: event.type, ...(messageId ? { messageId } : {}), assistantMessageEvent: delta };
}

// makeOmpSubagents 保留原生任务身份、所属回合和独立子会话内容
export function makeOmpSubagents(input: OmpSubagentsOptions): OmpSubagents {
  const { ids, emit, projection, connection } = input;
  const children = new Map<string, Child>();
  const toolOwners = new Map<string, ToolOwner>();
  const pending = new Map<string, OmpRecord[]>();

  const publish = Effect.fnUntraced(function* (child: Child, force = true) {
    const now = yield* DateTime.now;
    const millis = DateTime.toEpochMillis(now);
    if (!force && millis - child.lastPublishedAt < 100) return;
    child.lastPublishedAt = millis;
    const entity = child.entity;
    const scope = child.scope;
    const base = projection.base(scope, child.key, entity.startedAt, now);
    yield* projection.item(
      scope,
      child.key,
      {
        ...base,
        status: entity.status,
        title: entity.title,
        completedAt: entity.completedAt,
        type: "subagent",
        subagentId: entity.id,
        origin: "provider_native",
        driver: OMP_PROVIDER,
        providerInstanceId: input.instanceId,
        childThreadId: entity.childThreadId,
        prompt: entity.prompt,
        result: entity.result,
        ...(entity.progress === undefined ? {} : { progress: entity.progress }),
      },
      "subagent",
      entity.parentNodeId,
    );
    if (child.providerThread !== undefined) {
      const status = entity.completedAt === null ? "active" : "idle";
      if (child.providerThread.status !== status || force) {
        child.providerThread = { ...child.providerThread, status, updatedAt: now };
        yield* emit({
          type: "provider_thread.updated",
          driver: OMP_PROVIDER,
          providerThread: child.providerThread,
        });
      }
    }
    yield* emit({ type: "subagent.updated", driver: OMP_PROVIDER, subagent: entity });
  });

  const publishTurn = Effect.fnUntraced(function* (
    child: Child,
    status: OrchestrationV2ProviderTurn["status"],
  ) {
    const turn = child.providerTurn;
    const content = child.content;
    if (turn === undefined || content === undefined) return;
    const completedAt = status === "running" || status === "pending" ? null : yield* DateTime.now;
    child.providerTurn = {
      ...turn,
      status,
      completedAt,
      nativeTurnRef:
        completedAt === null
          ? turn.nativeTurnRef
          : (child.providerThread?.nativeConversationHeadRef ?? turn.nativeTurnRef),
    };
    yield* emit({
      type: "node.updated",
      driver: OMP_PROVIDER,
      node: {
        id: turn.nodeId,
        threadId: content.input.threadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: turn.nodeId,
        kind: "root_turn",
        status,
        countsForRun: true,
        providerThreadId: turn.providerThreadId,
        providerTurnId: turn.id,
        nativeItemRef: child.providerTurn.nativeTurnRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: turn.startedAt,
        completedAt,
      },
    });
    yield* emit({
      type: "provider_turn.updated",
      driver: OMP_PROVIDER,
      threadId: content.input.threadId,
      providerTurn: child.providerTurn,
    });
  });

  const startTurn = Effect.fnUntraced(function* (child: Child) {
    const providerThread = child.providerThread;
    if (providerThread === undefined || child.thread === undefined) return;
    const now = yield* DateTime.now;
    const ordinal = (child.providerTurn?.ordinal ?? 0) + 1;
    const nativeTurnId = `${providerThread.id}:turn:${ordinal}`;
    const rootNodeId = ids.derive.nodeFromProviderItem({
      driver: OMP_PROVIDER,
      nativeItemId: `${nativeTurnId}:root`,
    });
    child.providerTurn = {
      id: ids.derive.providerTurn({ driver: OMP_PROVIDER, nativeTurnId }),
      providerThreadId: providerThread.id,
      nodeId: rootNodeId,
      runAttemptId: null,
      nativeTurnRef: ompRef(nativeTurnId, "weak"),
      ordinal,
      status: "running",
      startedAt: now,
      completedAt: null,
    };
    child.content = {
      input: {
        threadId: child.thread.id,
        runId: null,
        rootNodeId,
        providerThread,
      },
      entity: { id: child.providerTurn.id, startedAt: now },
      ordinals: new Map(),
      streams: new Map(),
      tools: new Map(),
      openItems: new Map(),
      nextOrdinal: 1,
      messageOrdinal: 0,
      interrupted: false,
      failure: null,
    };
    yield* publishTurn(child, "running");
  });

  const ensureThread = Effect.fnUntraced(function* (child: Child, sessionFile: string) {
    if (child.thread !== undefined) return;
    const now = yield* DateTime.now;
    const providerThreadId = ids.derive.providerThread({
      driver: OMP_PROVIDER,
      nativeThreadId: sessionFile,
      providerInstanceId: input.instanceId,
    });
    const childThreadId = ids.derive.threadFromProviderThread({
      driver: OMP_PROVIDER,
      nativeThreadId: sessionFile,
      providerInstanceId: input.instanceId,
    });
    child.sessionFile = sessionFile;
    child.thread = makeSubagentChildThread({
      parentThread: child.parent?.thread ?? child.owner.input.appThread,
      childThreadId,
      parentNodeId: child.entity.id,
      activeProviderThreadId: providerThreadId,
      providerInstanceId: input.instanceId,
      modelSelection: {
        instanceId: input.instanceId,
        model: child.entity.model ?? child.owner.input.modelSelection.model,
      },
      title: child.entity.title?.trim() || child.nativeId,
      now,
      createdBy: "agent",
      creationSource: "provider",
    });
    child.providerThread = {
      id: providerThreadId,
      driver: OMP_PROVIDER,
      providerInstanceId: input.instanceId,
      providerSessionId: input.sessionId,
      appThreadId: childThreadId,
      ownerNodeId: child.entity.id,
      nativeThreadRef: ompRef(sessionFile),
      nativeConversationHeadRef: null,
      status: child.entity.completedAt === null ? "active" : "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      createdAt: now,
      updatedAt: now,
    };
    child.entity = {
      ...child.entity,
      childThreadId,
      providerThreadId,
      nativeTaskRef: ompRef(child.nativeId),
    };
    yield* emit({ type: "app_thread.created", driver: OMP_PROVIDER, appThread: child.thread });
    yield* emit({
      type: "provider_thread.updated",
      driver: OMP_PROVIDER,
      providerThread: child.providerThread,
    });
    yield* startTurn(child);
  });

  const projectMessage = Effect.fnUntraced(function* (child: Child, event: OmpRecord) {
    const scope = child.content;
    if (scope === undefined) return;
    const nativeMessage = event.message;
    const role = text(nativeMessage, "role");
    const key = nativeMessageKey(nativeMessage) ?? text(event, "messageId");
    if (event.type === "message_end" && key !== undefined && child.messages.has(key)) return;
    if (event.type === "message_end") {
      const output = ompSubagentResult(nativeMessage, child.lastAssistantText);
      if (output !== undefined) {
        if (role === "assistant") child.lastAssistantText = output;
        const details = field(nativeMessage, "details");
        if (role === "toolResult" && Array.isArray(field(details, "type"))) {
          child.resultSections.set(key ?? String(child.resultSections.size), output);
          child.entity = {
            ...child.entity,
            result: [...child.resultSections.values()].join("\n\n"),
          };
        } else if (role === "toolResult") {
          child.resultSections.clear();
          child.resultSections.set(key ?? "result", output);
          child.entity = { ...child.entity, result: output };
        } else if (child.resultSections.size === 0) {
          child.entity = { ...child.entity, result: output };
        }
      }
    }
    if (role === "user" && event.type === "message_end") {
      const now = yield* DateTime.now;
      const itemKey = `user:${key ?? ++scope.messageOrdinal}`;
      const base = projection.base(scope, itemKey, now, now);
      const artifacts = makeSubagentConversationArtifacts({
        messageId: ids.derive.messageFromProviderItem({
          driver: OMP_PROVIDER,
          nativeItemId: base.nativeItemRef.nativeId,
        }),
        turnItemId: base.id,
        threadId: scope.input.threadId,
        rootNodeId: scope.input.rootNodeId,
        providerThreadId: scope.input.providerThread.id,
        providerTurnId: scope.entity.id,
        nativeItemRef: base.nativeItemRef,
        role: "user",
        text: contentText(field(nativeMessage, "content")),
        ordinal: base.ordinal,
        now,
      });
      yield* emit({ type: "message.updated", driver: OMP_PROVIDER, message: artifacts.message });
      yield* emit({
        type: "turn_item.updated",
        driver: OMP_PROVIDER,
        turnItem: artifacts.turnItem,
      });
    } else if (role === "toolResult" && event.type === "message_end") {
      yield* projectTool(child, {
        type: "tool_execution_end",
        toolCallId: text(nativeMessage, "toolCallId"),
        toolName: text(nativeMessage, "toolName"),
        result: nativeMessage,
        isError: field(nativeMessage, "isError"),
      });
    } else if (
      role === "assistant" ||
      (role === undefined && (event.type === "message_update" || event.type === "message_end"))
    ) {
      yield* projection.message(scope, {
        ...event,
        ...(key === undefined ? {} : { messageId: key }),
      });
      if (event.type === "message_end") {
        const content = field(nativeMessage, "content");
        if (Array.isArray(content)) {
          for (const part of content) {
            if (text(part, "type") !== "toolCall") continue;
            yield* projectTool(child, {
              type: "tool_execution_start",
              toolCallId: text(part, "id"),
              toolName: text(part, "name"),
              args: field(part, "arguments"),
            });
          }
        }
      }
    }
    if (event.type === "message_end" && key !== undefined) child.messages.add(key);
  });

  const captureResults = Effect.fnUntraced(function* (event: OmpRecord) {
    const results = field(field(event.result ?? event.partialResult, "details"), "results");
    if (!Array.isArray(results)) return;
    for (const result of results) {
      const id = text(result, "id");
      const child = id === undefined ? undefined : children.get(id);
      if (child === undefined) continue;
      const output = text(result, "output");
      const nativeError =
        text(result, "error") ?? text(result, "stderr") ?? text(result, "abortReason");
      const now = yield* DateTime.now;
      child.entity = {
        ...child.entity,
        result:
          field(result, "truncated") === true
            ? child.entity.result
            : (output ?? child.entity.result),
        ...(nativeError ? { progress: nativeError } : {}),
        updatedAt: now,
      };
      if (child.entity.completedAt !== null) yield* publish(child);
    }
  });

  const projectTool = Effect.fnUntraced(function* (child: Child, event: OmpRecord) {
    const nativeId = text(event, "toolCallId");
    if (nativeId === undefined || child.content === undefined) return;
    toolOwners.set(nativeId, { owner: child.owner, child });
    yield* projection.tool(child.content, event);
    yield* captureResults(event);
  });

  const projectEvent = Effect.fnUntraced(function* (child: Child, event: OmpRecord) {
    if (child.content === undefined) {
      child.pending.push(bufferedEvent(event));
      return;
    }
    if (
      child.entity.completedAt !== null &&
      (event.type === "message_start" ||
        event.type === "message_update" ||
        event.type === "tool_execution_start" ||
        event.type === "tool_execution_update" ||
        event.type === "tool_stream_update")
    )
      return;
    if (typeof event.type === "string" && event.type.startsWith("message_")) {
      yield* projectMessage(child, event);
    } else if (
      typeof event.type === "string" &&
      (event.type.startsWith("tool_execution_") || event.type === "tool_stream_update")
    ) {
      yield* projectTool(child, event);
    } else if (event.type === "auto_compaction_start" || event.type === "auto_compaction_end") {
      yield* projection.compaction(child.content, event);
    } else if (event.type === "auto_retry_start" || event.type === "auto_retry_end") {
      yield* projection.retry(child.content, event);
    } else if (event.type === "notice") {
      yield* projection.notice(child.content, "OMP", text(event, "message") ?? "");
    } else if (event.type === "agent_end") {
      yield* projection.flush(child.content);
    } else if (event.type === "agent_start" && child.entity.completedAt !== null) {
      const now = yield* DateTime.now;
      yield* startTurn(child);
      child.resultSections.clear();
      delete child.lastAssistantText;
      child.entity = {
        ...child.entity,
        status: "running",
        completedAt: null,
        result: null,
        updatedAt: now,
      };
      yield* publish(child);
    }
  });

  const syncTranscript = Effect.fnUntraced(function* (child: Child) {
    if (child.sessionFile === undefined || child.content === undefined) return;
    const page = yield* connection.request({
      type: "get_subagent_messages",
      sessionFile: child.sessionFile,
      fromByte: child.nextByte,
    });
    child.nextByte = number(page, "nextByte") ?? child.nextByte;
    const entries = field(page, "entries");
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (text(entry, "type") !== "message") continue;
      yield* projectMessage(child, { type: "message_end", message: field(entry, "message") });
      const id = text(entry, "id");
      if (id !== undefined && child.providerThread !== undefined) {
        child.providerThread = { ...child.providerThread, nativeConversationHeadRef: ompRef(id) };
      }
    }
  });

  const queue = (id: string, event: OmpRecord) => {
    let events = pending.get(id);
    if (events === undefined) {
      events = [];
      pending.set(id, events);
    }
    if (event.type === "subagent_progress" && events.at(-1)?.type === "subagent_progress") {
      events[events.length - 1] = event;
    } else if (event.type === "subagent_event") {
      const payload = event.payload as OmpRecord;
      events.push({
        ...event,
        payload: { ...payload, event: bufferedEvent(payload.event as OmpRecord) },
      });
    } else events.push(event);
  };

  const consume = Effect.fnUntraced(function* (event: OmpRecord, active: OmpTurn | null) {
    const payload = field(event, "payload");
    const progress = field(payload, "progress");
    const nativeId = text(payload, "id") ?? text(progress, "id");
    if (nativeId === undefined) return true;
    let child = children.get(nativeId);
    if (event.type === "subagent_event") {
      if (child === undefined) return false;
      const nativeEvent = field(payload, "event");
      if (typeof nativeEvent === "object" && nativeEvent !== null && !Array.isArray(nativeEvent)) {
        yield* projectEvent(child, nativeEvent as OmpRecord);
      }
      return true;
    }
    const now = yield* DateTime.now;
    const parentToolCallId = text(payload, "parentToolCallId");
    const toolOwner = parentToolCallId === undefined ? undefined : toolOwners.get(parentToolCallId);
    const sessionFile = text(payload, "sessionFile");
    if (
      child === undefined ||
      (sessionFile !== undefined &&
        child.sessionFile !== undefined &&
        sessionFile !== child.sessionFile)
    ) {
      if (parentToolCallId !== undefined && toolOwner === undefined) return false;
      const owner = toolOwner?.owner ?? active;
      const parent = toolOwner?.child;
      if (owner === null || (parent !== undefined && parent.content === undefined)) return false;
      const scope = parent?.content ?? owner;
      const key = `subagent:${nativeId}:${sessionFile ?? owner.entity.id}`;
      const base = projection.base(scope, key, now, now);
      const status = text(payload, "status") ?? text(progress, "status");
      child = {
        nativeId,
        owner,
        scope,
        parent,
        parentToolCallId,
        key,
        nextByte: 0,
        messages: new Set(),
        resultSections: new Map(),
        pending: [],
        lastPublishedAt: -Infinity,
        entity: {
          id: base.nodeId,
          threadId: scope.input.threadId,
          runId: scope.input.runId,
          parentNodeId: scope.input.rootNodeId,
          origin: "provider_native",
          createdBy: "agent",
          driver: OMP_PROVIDER,
          providerInstanceId: input.instanceId,
          providerThreadId: null,
          childThreadId: null,
          nativeTaskRef: ompRef(nativeId),
          prompt: text(payload, "task") ?? text(payload, "description") ?? nativeId,
          title: text(payload, "description") ?? text(payload, "agent") ?? nativeId,
          model: text(progress, "resolvedModelIdentity") ?? null,
          status: status === "pending" ? "pending" : "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      };
      children.set(nativeId, child);
    }
    if (sessionFile !== undefined && child.thread === undefined) {
      yield* ensureThread(child, sessionFile);
      for (const buffered of child.pending) yield* projectEvent(child, buffered);
      child.pending.length = 0;
      yield* syncTranscript(child);
    }
    if (event.type === "subagent_progress") {
      const progressText =
        text(field(progress, "retryFailure"), "errorMessage") ??
        text(field(progress, "retryState"), "errorMessage") ??
        text(progress, "currentToolIntent") ??
        text(progress, "lastIntent") ??
        text(progress, "currentTool");
      const completion = number(progress, "completionPercent");
      child.entity = {
        ...child.entity,
        prompt: text(payload, "assignment") ?? text(payload, "task") ?? child.entity.prompt,
        model: text(progress, "resolvedModelIdentity") ?? child.entity.model,
        ...(progressText === undefined
          ? {}
          : { progress: `${completion === undefined ? "" : `${completion}% · `}${progressText}` }),
        updatedAt: now,
      };
      yield* publish(child, false);
      return true;
    }
    const status = text(payload, "status");
    if (status === "completed" || status === "failed" || status === "aborted") {
      if (child.content !== undefined) {
        child.content.interrupted = status === "aborted";
        if (status === "failed" && child.content.failure === null) {
          child.content.failure = makeProviderFailure({
            class: "provider_error",
            message: `OMP subagent ${child.nativeId} failed`,
          });
        }
        yield* syncTranscript(child);
        yield* projection.close(child.content);
        yield* publishTurn(child, status === "aborted" ? "interrupted" : status);
      }
      child.entity = {
        ...child.entity,
        status: status === "aborted" ? "interrupted" : status,
        completedAt: child.entity.completedAt ?? now,
        updatedAt: now,
      };
    } else if (child.entity.completedAt === null) {
      child.entity = {
        ...child.entity,
        title: text(payload, "description") ?? child.entity.title,
        updatedAt: now,
      };
    }
    yield* publish(child);
    return true;
  });

  const handle: OmpSubagents["handle"] = Effect.fnUntraced(function* (
    event: OmpRecord,
    active: OmpTurn | null,
  ) {
    if (
      typeof event.type === "string" &&
      (event.type.startsWith("tool_execution_") || event.type === "tool_stream_update")
    ) {
      const toolCallId = text(event, "toolCallId");
      if (toolCallId !== undefined && active !== null && !toolOwners.has(toolCallId))
        toolOwners.set(toolCallId, { owner: active });
      yield* captureResults(event);
    } else {
      const payload = field(event, "payload");
      const nativeId = text(payload, "id") ?? text(field(payload, "progress"), "id");
      if (nativeId !== undefined && !(yield* consume(event, active))) queue(nativeId, event);
    }
    for (const [id, events] of pending) {
      if (!children.has(id)) {
        const lifecycleIndex = events.findIndex((queued) => queued.type !== "subagent_event");
        if (lifecycleIndex >= 0 && (yield* consume(events[lifecycleIndex]!, active)))
          events.splice(lifecycleIndex, 1);
      }
      let consumed = 0;
      for (const queued of events) {
        if (!(yield* consume(queued, active))) break;
        consumed++;
      }
      if (consumed === events.length) pending.delete(id);
      else if (consumed > 0) events.splice(0, consumed);
    }
  });

  const closeChildren = Effect.fnUntraced(function* (
    owner: OmpTurn | null,
    failure: OrchestrationV2ProviderFailure | null,
  ) {
    if (owner !== null && !owner.interrupted && failure === null) return;
    const now = yield* DateTime.now;
    for (const child of children.values()) {
      if ((owner !== null && child.owner !== owner) || child.entity.completedAt !== null) continue;
      if (child.content !== undefined) {
        child.content.interrupted = owner?.interrupted ?? false;
        child.content.failure = failure;
        yield* projection.close(child.content);
        yield* publishTurn(child, owner?.interrupted ? "interrupted" : "failed");
      }
      child.entity = {
        ...child.entity,
        status: owner?.interrupted ? "interrupted" : "failed",
        ...(failure === null ? {} : { progress: failure.message }),
        completedAt: now,
        updatedAt: now,
      };
      yield* publish(child);
    }
  });
  return {
    handle,
    close: (owner) => closeChildren(owner, owner.failure),
    disconnect: (failure) => closeChildren(null, failure),
  };
}
