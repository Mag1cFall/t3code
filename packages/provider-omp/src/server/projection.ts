import type {
  NodeId,
  OrchestrationV2ExecutionNode,
  OrchestrationV2PlanStep,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderRef,
  OrchestrationV2ProviderTurn,
  OrchestrationV2TurnItem,
  PlanId,
  ProviderThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { IdAllocatorV2, IdAllocatorV2Error } from "@t3tools/provider-core/server/IdAllocator";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";
import { formatSearchToolLabel } from "@t3tools/shared/toolActivity";
import { readToolOutputImage } from "@t3tools/shared/toolOutput";
import { OMP_PROVIDER } from "./capabilities.ts";
import { ompFailure } from "./completion.ts";
import { ompRef } from "./history.ts";
import { ompT3McpToolName } from "./mcp.ts";
import { contentText, field, number, text, type OmpRecord } from "./wire.ts";

export interface OmpStreamItem {
  text: string;
  readonly pending: string[];
  readonly kind: "assistant_message" | "reasoning";
  readonly startedAt: DateTime.Utc;
  lastEmittedAt: number;
  completed: boolean;
}

export interface OmpToolItem {
  name: string;
  args: unknown;
  readonly startedAt: DateTime.Utc;
  result?: unknown;
  preview?: unknown;
  lastEmittedAt: number;
  completed: boolean;
  closed?: boolean;
  isError: boolean;
}

export type OmpProjectedItem = OrchestrationV2TurnItem & {
  readonly providerThreadId: ProviderThreadId | null;
};

export interface OmpContent {
  readonly input: Pick<ProviderAdapterV2TurnInput, "threadId" | "rootNodeId" | "providerThread"> & {
    readonly runId: ProviderAdapterV2TurnInput["runId"] | null;
  };
  readonly entity: {
    readonly id: OrchestrationV2ProviderTurn["id"] | null;
    readonly startedAt: DateTime.Utc | null;
  };
  readonly ordinals: Map<string, number>;
  readonly streams: Map<string, OmpStreamItem>;
  readonly tools: Map<string, OmpToolItem>;
  readonly openItems: Map<string, OmpProjectedItem>;
  nextOrdinal: number;
  messageOrdinal: number;
  interrupted: boolean;
  failure: OrchestrationV2ProviderFailure | null;
  planId?: PlanId;
}

export interface OmpTurn extends OmpContent {
  readonly input: ProviderAdapterV2TurnInput;
  entity: OrchestrationV2ProviderTurn;
  readonly promptId: string;
}

export interface OmpItemBase extends Pick<
  OmpProjectedItem,
  | "id"
  | "threadId"
  | "runId"
  | "providerThreadId"
  | "providerTurnId"
  | "parentItemId"
  | "ordinal"
  | "startedAt"
  | "updatedAt"
> {
  readonly nodeId: NodeId;
  readonly nativeItemRef: OrchestrationV2ProviderRef & { readonly nativeId: string };
}

export type OmpProjectionError = IdAllocatorV2Error;

export interface OmpProjection {
  readonly base: (
    turn: OmpContent,
    key: string,
    startedAt: DateTime.Utc | null,
    updatedAt: DateTime.Utc,
  ) => OmpItemBase;
  readonly item: (
    turn: OmpContent,
    key: string,
    value: OmpProjectedItem,
    kind: OrchestrationV2ExecutionNode["kind"],
    parentNodeId?: NodeId,
  ) => Effect.Effect<void>;
  readonly message: (turn: OmpContent, event: OmpRecord) => Effect.Effect<void>;
  readonly tool: (turn: OmpContent, event: OmpRecord) => Effect.Effect<void, OmpProjectionError>;
  readonly notice: (turn: OmpContent, title: string, output: string) => Effect.Effect<void>;
  readonly todos: (turn: OmpContent, phases: unknown) => Effect.Effect<void, OmpProjectionError>;
  readonly compaction: (turn: OmpContent, event: OmpRecord) => Effect.Effect<void>;
  readonly retry: (turn: OmpContent, event: OmpRecord) => Effect.Effect<void>;
  readonly flush: (turn: OmpContent) => Effect.Effect<void>;
  readonly close: (turn: OmpContent) => Effect.Effect<void>;
}

interface MessageState {
  readonly prefix: string;
  readonly keys: Set<string>;
  completed: boolean;
  finalized?: boolean;
}

interface ContentState {
  readonly messages: Map<string, MessageState>;
  current?: MessageState;
  compaction?: { readonly key: string; readonly startedAt: DateTime.Utc };
  retry?: { readonly key: string; readonly item: Extract<OmpProjectedItem, { type: "error" }> };
}

const EMIT_INTERVAL_MS = 50;

// makeOmpProjection 把原生内容投影为共享消息、工具、压缩和计划事件
export function makeOmpProjection(
  ids: IdAllocatorV2["Service"],
  emit: (event: ProviderAdapterV2Event) => Effect.Effect<void>,
): OmpProjection {
  const states = new WeakMap<OmpContent, ContentState>();
  const stateFor = (turn: OmpContent): ContentState => {
    let state = states.get(turn);
    if (state === undefined) {
      state = { messages: new Map() };
      states.set(turn, state);
    }
    return state;
  };

  const base: OmpProjection["base"] = (turn, key, startedAt, updatedAt) => {
    const nativeItemId = `${turn.entity.id ?? turn.input.providerThread.id}:${key}`;
    let ordinal = turn.ordinals.get(key);
    if (ordinal === undefined) {
      ordinal = turn.nextOrdinal++;
      turn.ordinals.set(key, ordinal);
    }
    return {
      id: ids.derive.turnItemFromProviderItem({ driver: OMP_PROVIDER, nativeItemId }),
      threadId: turn.input.threadId,
      runId: turn.input.runId,
      nodeId: ids.derive.nodeFromProviderItem({ driver: OMP_PROVIDER, nativeItemId }),
      providerThreadId: turn.input.providerThread.id,
      providerTurnId: turn.entity.id,
      nativeItemRef: { ...ompRef(nativeItemId), nativeId: nativeItemId },
      parentItemId: null,
      ordinal,
      startedAt,
      updatedAt,
    };
  };

  const item: OmpProjection["item"] = Effect.fnUntraced(function* (
    turn: OmpContent,
    key: string,
    value: OmpProjectedItem,
    kind: OrchestrationV2ExecutionNode["kind"],
    parentNodeId?: NodeId,
  ) {
    if (value.completedAt === null) turn.openItems.set(key, value);
    else turn.openItems.delete(key);
    if (value.nodeId !== null) {
      yield* emit({
        type: "node.updated",
        driver: OMP_PROVIDER,
        node: {
          id: value.nodeId,
          threadId: value.threadId,
          runId: value.runId,
          parentNodeId: parentNodeId ?? turn.input.rootNodeId,
          rootNodeId: turn.input.rootNodeId,
          kind,
          status: value.status,
          countsForRun: false,
          providerThreadId: value.providerThreadId,
          providerTurnId: value.providerTurnId,
          nativeItemRef: value.nativeItemRef,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: value.startedAt,
          completedAt: value.completedAt,
        },
      });
    }
    yield* emit({ type: "turn_item.updated", driver: OMP_PROVIDER, turnItem: value });
  });

  const stream = Effect.fnUntraced(function* (
    turn: OmpContent,
    key: string,
    value: OmpStreamItem,
    completed: boolean,
    force = false,
  ) {
    const now = yield* DateTime.now;
    const millis = DateTime.toEpochMillis(now);
    if (!completed && !force && millis - value.lastEmittedAt < EMIT_INTERVAL_MS) return;
    if (value.pending.length > 0) {
      value.text += value.pending.join("");
      value.pending.length = 0;
    }
    value.lastEmittedAt = millis;
    value.completed = completed;
    const status = completed
      ? turn.interrupted
        ? "interrupted"
        : turn.failure !== null
          ? "failed"
          : "completed"
      : "running";
    const shared = {
      ...base(turn, key, value.startedAt, now),
      status,
      title: null,
      completedAt: completed ? now : null,
      text: value.text,
      streaming: !completed,
    } as const;
    if (value.kind === "reasoning") {
      yield* item(turn, key, { ...shared, type: "reasoning" }, "reasoning");
    } else {
      const messageId = ids.derive.messageFromProviderItem({
        driver: OMP_PROVIDER,
        nativeItemId: shared.nativeItemRef.nativeId,
      });
      yield* item(
        turn,
        key,
        { ...shared, type: "assistant_message", messageId },
        "assistant_message",
      );
      yield* emit({
        type: "message.updated",
        driver: OMP_PROVIDER,
        message: {
          id: messageId,
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          nodeId: shared.nodeId,
          role: "assistant",
          text: value.text,
          attachments: [],
          streaming: !completed,
          createdBy: "agent",
          creationSource: "provider",
          createdAt: value.startedAt,
          updatedAt: now,
        },
      });
    }
  });

  const message: OmpProjection["message"] = Effect.fnUntraced(function* (
    turn: OmpContent,
    event: OmpRecord,
  ) {
    const nativeMessage = field(event, "message");
    const role = text(nativeMessage, "role");
    if (role !== undefined && role !== "assistant") return;
    const delta = field(event, "assistantMessageEvent");
    if (role === undefined && event.type !== "message_update" && event.type !== "message_end")
      return;
    const state = stateFor(turn);
    const messageId = text(event, "messageId");
    let messageState = messageId === undefined ? state.current : state.messages.get(messageId);
    if (event.type === "message_start" && messageId === undefined) messageState = undefined;
    if (messageState === undefined) {
      messageState = {
        prefix: messageId ?? `ordinal:${++turn.messageOrdinal}`,
        keys: new Set(),
        completed: false,
      };
      state.messages.set(messageState.prefix, messageState);
      state.current = messageState;
    }
    if (messageState.completed && (event.type !== "message_end" || messageState.finalized)) return;
    const now = yield* DateTime.now;
    const block = (index: number, kind: OmpStreamItem["kind"]): [string, OmpStreamItem] => {
      const key = `message:${messageState.prefix}:${index}`;
      let value = turn.streams.get(key);
      if (value === undefined) {
        value = {
          text: "",
          pending: [],
          kind,
          startedAt: now,
          lastEmittedAt: -Infinity,
          completed: false,
        };
        turn.streams.set(key, value);
        messageState.keys.add(key);
      }
      return [key, value];
    };
    if (event.type === "message_update") {
      const kind = text(delta, "type");
      if (kind === "text_delta" || kind === "thinking_delta") {
        const [key, value] = block(
          number(delta, "contentIndex") ?? 0,
          kind === "text_delta" ? "assistant_message" : "reasoning",
        );
        if (value.completed) return;
        const chunk = text(delta, "delta");
        if (chunk === undefined || chunk.length === 0) return;
        value.pending.push(chunk);
        yield* stream(turn, key, value, false);
        return;
      }
      if (kind === "text_end" || kind === "thinking_end") {
        const [key, value] = block(
          number(delta, "contentIndex") ?? 0,
          kind === "text_end" ? "assistant_message" : "reasoning",
        );
        if (value.completed) return;
        const content = text(delta, "content");
        if (content !== undefined) {
          value.text = content;
          value.pending.length = 0;
        }
        yield* stream(turn, key, value, true);
      }
      return;
    }
    if (event.type !== "message_end") return;
    const stopReason = text(nativeMessage, "stopReason");
    const error = text(nativeMessage, "errorMessage");
    if (stopReason === "aborted") turn.interrupted = true;
    if (stopReason === "error" && error)
      turn.failure = ompFailure(nativeMessage, DateTime.toEpochMillis(now));
    const content = field(nativeMessage, "content");
    if (Array.isArray(content)) {
      for (const [index, part] of content.entries()) {
        const kind = text(part, "type");
        if (kind !== "text" && kind !== "thinking") continue;
        const [key, value] = block(index, kind === "text" ? "assistant_message" : "reasoning");
        const finalText = text(part, kind === "text" ? "text" : "thinking");
        const unchanged = value.completed && (finalText === undefined || finalText === value.text);
        if (finalText !== undefined) {
          value.text = finalText;
          value.pending.length = 0;
        }
        if (!unchanged || stopReason === "error" || stopReason === "aborted")
          yield* stream(turn, key, value, true);
      }
    }
    for (const key of messageState.keys) {
      const value = turn.streams.get(key)!;
      if (!value.completed) yield* stream(turn, key, value, true);
    }
    messageState.completed = true;
    messageState.finalized = true;
    if (error && (stopReason === "error" || stopReason === "aborted")) {
      const key = `message:${messageState.prefix}:error`;
      yield* item(
        turn,
        key,
        {
          ...base(turn, key, now, now),
          type: "error",
          title: "OMP",
          status: stopReason === "aborted" ? "interrupted" : "failed",
          completedAt: now,
          failure: ompFailure(nativeMessage, DateTime.toEpochMillis(now)),
        },
        "system",
      );
    }
  });

  const presentTool = Effect.fnUntraced(function* (
    turn: OmpContent,
    nativeId: string,
    value: OmpToolItem,
    force = false,
  ) {
    const now = yield* DateTime.now;
    const millis = DateTime.toEpochMillis(now);
    if (!value.completed && !force && millis - value.lastEmittedAt < EMIT_INTERVAL_MS) return;
    value.lastEmittedAt = millis;
    let { name, args } = value;
    const { result, preview } = value;
    const output = result ?? preview;
    let details = field(output, "details");
    const device = field(details, "xdev");
    if (name === "write" && text(device, "mode") === "execute") {
      name = text(device, "tool") ?? name;
      args = field(device, "args") ?? args;
      details = field(device, "inner");
      if (name === "resolve" && text(details, "action") === "apply") {
        name = text(details, "sourceToolName") ?? name;
        details = field(details, "sourceResultDetails");
      }
    }
    const devicePath = text(value.args, "path");
    const toolDocumentation =
      (value.name === "read" && devicePath?.startsWith("xd://") === true) ||
      (value.name === "write" && text(device, "mode") === "help");
    const t3ToolName = toolDocumentation
      ? undefined
      : ompT3McpToolName(
          name === "write" && devicePath?.startsWith("xd://")
            ? devicePath.slice("xd://".length)
            : name,
          text(details, "serverName"),
          text(details, "mcpToolName"),
        );
    if (toolDocumentation) name = "tool_search";
    else if (t3ToolName !== undefined) name = t3ToolName;
    const key = `tool:${nativeId}`;
    const status = value.completed
      ? value.isError
        ? turn.interrupted
          ? "interrupted"
          : "failed"
        : "completed"
      : "running";
    const shared = {
      ...base(turn, key, value.startedAt, now),
      status,
      title: null,
      completedAt: value.completed ? now : null,
    } as const;
    const rawContent = field(output, "content");
    const outputText = contentText(rawContent);
    const hasImages =
      Array.isArray(rawContent) &&
      rawContent.some((part: unknown) => readToolOutputImage(part) !== null);
    if (name === "bash" && !hasImages) {
      const exitCode = number(details, "exitCode");
      yield* item(
        turn,
        key,
        {
          ...shared,
          type: "command_execution",
          input: text(args, "command") ?? "",
          output: outputText,
          outputIndicatesFailure: value.isError,
          ...(exitCode === undefined ? {} : { exitCode }),
        },
        "tool_call",
      );
      return;
    }
    const perFile = field(details, "perFileResults");
    const astFiles = field(details, "fileReplacements");
    const previewFiles = field(preview, "files");
    const files: unknown[] = Array.isArray(perFile)
      ? perFile
      : Array.isArray(astFiles)
        ? astFiles
        : text(details, "path") !== undefined
          ? [details]
          : !value.completed && Array.isArray(previewFiles)
            ? previewFiles
            : [];
    const paths = field(args, "paths");
    const path =
      text(details, "path") ??
      text(files[0], "path") ??
      text(args, "path") ??
      (Array.isArray(paths) && typeof paths[0] === "string" ? paths[0] : undefined);
    const isFileChange =
      name === "edit" ||
      name === "ast_edit" ||
      (name === "write" && (text(details, "resolvedPath") !== undefined || !path?.includes("://")));
    if (isFileChange && path && !hasImages) {
      const diff =
        text(details, "diff") ??
        (files.length > 0 ? files.map((file) => text(file, "diff") ?? "").join("\n") : "");
      const diffStr =
        diff && outputText && !outputText.includes(diff)
          ? `${diff}\n${outputText}`
          : outputText || diff;
      const oldStr = text(details, "oldText");
      const newStr =
        text(details, "newText") ?? (name === "write" ? text(args, "content") : undefined);
      const changes = files.flatMap((file) => {
        const filePath = text(file, "path");
        if (!filePath) return [];
        const oldPath = text(file, "sourcePath");
        return [
          {
            path: filePath,
            operation: text(file, "op") ?? "update",
            ...(oldPath ? { oldPath } : {}),
          },
        ];
      });
      yield* item(
        turn,
        key,
        {
          ...shared,
          type: "file_change",
          fileName: path,
          ...(diffStr ? { diffStr } : {}),
          ...(oldStr === undefined ? {} : { oldStr }),
          ...(newStr === undefined ? {} : { newStr }),
          ...(changes.length === 0 ? {} : { changes }),
        },
        "tool_call",
      );
      return;
    }
    if (name === "web_search" && !hasImages) {
      const query = text(args, "query");
      const sources = field(field(details, "response"), "sources");
      const results = Array.isArray(sources)
        ? sources.map((source: unknown) => ({
            ...(text(source, "title") === undefined ? {} : { title: text(source, "title")! }),
            ...(text(source, "url") ? { url: text(source, "url")! } : {}),
            ...(text(source, "snippet") === undefined ? {} : { snippet: text(source, "snippet")! }),
          }))
        : [];
      yield* item(
        turn,
        key,
        {
          ...shared,
          type: "web_search",
          ...(query === undefined ? {} : { patterns: [query] }),
          results: [...(outputText ? [{ snippet: outputText }] : []), ...results],
        },
        "tool_call",
      );
      return;
    }
    yield* item(
      turn,
      key,
      {
        ...shared,
        type: "dynamic_tool",
        ...(name === "bash" ? { title: "Ran command" } : {}),
        ...(toolDocumentation ? { title: "Read tool documentation" } : {}),
        ...(name === "ast_grep"
          ? {
              title:
                formatSearchToolLabel({ pattern: text(args, "pat"), path: text(args, "path") }) ??
                "Searched files",
            }
          : {}),
        ...mcpToolPresentation({
          toolName: t3ToolName ?? text(details, "mcpToolName") ?? name,
          serverName: t3ToolName === undefined ? text(details, "serverName") : "t3-code",
        }),
        toolName: name,
        input: args ?? {},
        ...(output === undefined ? {} : { output }),
      },
      "tool_call",
    );
  });

  const tool: OmpProjection["tool"] = Effect.fnUntraced(function* (
    turn: OmpContent,
    event: OmpRecord,
  ) {
    const nativeId = text(event, "toolCallId");
    if (nativeId === undefined) return;
    let value = turn.tools.get(nativeId);
    if (value?.completed) return;
    if (value?.closed && event.type !== "tool_execution_end") return;
    if (value === undefined) {
      value = {
        name: text(event, "toolName") ?? "tool",
        args: event.args,
        startedAt: yield* DateTime.now,
        lastEmittedAt: -Infinity,
        completed: false,
        isError: false,
      };
      turn.tools.set(nativeId, value);
    }
    value.name = text(event, "toolName") ?? value.name;
    if (event.args !== undefined) value.args = event.args;
    if (event.type === "tool_stream_update") value.preview = event.update;
    else if (event.type === "tool_execution_end") {
      value.completed = true;
      value.isError = event.isError === true || field(event.result, "isError") === true;
      if (event.result !== undefined) value.result = event.result;
    } else if (event.partialResult !== undefined) value.result = event.partialResult;
    yield* presentTool(turn, nativeId, value);
    if (value.name === "todo" && value.result !== undefined)
      yield* todos(turn, field(field(value.result, "details"), "phases"));
  });

  const notice: OmpProjection["notice"] = Effect.fnUntraced(function* (
    turn: OmpContent,
    title: string,
    output: string,
  ) {
    const now = yield* DateTime.now;
    const key = `notice:${turn.nextOrdinal}`;
    yield* item(
      turn,
      key,
      {
        ...base(turn, key, now, now),
        status: "completed",
        completedAt: now,
        title,
        type: "system_notice",
        message: output,
      },
      "system",
    );
  });

  const todos: OmpProjection["todos"] = Effect.fnUntraced(function* (
    turn: OmpContent,
    phases: unknown,
  ) {
    if (!Array.isArray(phases)) return;
    const steps: OrchestrationV2PlanStep[] = [];
    for (const [phaseIndex, phase] of phases.entries()) {
      const tasks = field(phase, "tasks");
      if (!Array.isArray(tasks)) continue;
      for (const [taskIndex, task] of tasks.entries()) {
        const content = text(task, "content");
        if (!content?.trim()) continue;
        const status = text(task, "status");
        const blocker = text(task, "blocker");
        steps.push({
          id: `${phaseIndex}:${taskIndex}`,
          text: `${text(phase, "name") ? `${text(phase, "name")}: ` : ""}${content}${status === "abandoned" ? " (abandoned)" : status === "blocked" ? ` (blocked${blocker ? `: ${blocker}` : ""})` : ""}`,
          status:
            status === "completed" || status === "abandoned"
              ? "completed"
              : status === "in_progress"
                ? "running"
                : "pending",
        });
      }
    }
    if (turn.planId === undefined)
      turn.planId = yield* ids.allocate.plan({
        driver: OMP_PROVIDER,
        threadId: turn.input.threadId,
        ...(turn.input.runId === null ? {} : { runId: turn.input.runId }),
      });
    const now = yield* DateTime.now;
    const completed = steps.every((step) => step.status === "completed");
    const baseFields = base(turn, "todos", turn.entity.startedAt, now);
    yield* emit({
      type: "plan.updated",
      driver: OMP_PROVIDER,
      plan: {
        id: turn.planId,
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        nodeId: baseFields.nodeId,
        status: completed ? "completed" : "active",
        kind: "todo_list",
        steps,
      },
    });
    yield* item(
      turn,
      "todos",
      {
        ...baseFields,
        type: "todo_list",
        planId: turn.planId,
        steps,
        title: null,
        status: completed ? "completed" : "running",
        completedAt: completed ? now : null,
      },
      "system",
    );
  });

  const compaction: OmpProjection["compaction"] = Effect.fnUntraced(function* (
    turn: OmpContent,
    event: OmpRecord,
  ) {
    const state = stateFor(turn);
    const now = yield* DateTime.now;
    const current = state.compaction ?? { key: `compaction:${turn.nextOrdinal}`, startedAt: now };
    state.compaction = current;
    const complete = event.type === "auto_compaction_end";
    const error = text(event, "errorMessage");
    const status = !complete
      ? "running"
      : event.aborted === true
        ? "interrupted"
        : error
          ? "failed"
          : "completed";
    const summary = text(event.result, "summary") ?? error;
    const beforeTokenCount = number(event.result, "tokensBefore");
    yield* item(
      turn,
      current.key,
      {
        ...base(turn, current.key, current.startedAt, now),
        type: "compaction",
        driver: OMP_PROVIDER,
        title: event.skipped === true ? "Context compaction skipped" : "Context compaction",
        status,
        completedAt: complete ? now : null,
        ...(summary === undefined ? {} : { summary }),
        ...(beforeTokenCount === undefined ? {} : { beforeTokenCount }),
      },
      "system",
    );
    if (complete) delete state.compaction;
  });

  const retry: OmpProjection["retry"] = Effect.fnUntraced(function* (
    turn: OmpContent,
    event: OmpRecord,
  ) {
    const state = stateFor(turn);
    const now = yield* DateTime.now;
    if (event.type === "auto_retry_start") {
      turn.failure = null;
      const key = `retry:${turn.nextOrdinal}`;
      const value: Extract<OmpProjectedItem, { type: "error" }> = {
        ...base(turn, key, now, now),
        type: "error",
        title: "OMP retrying",
        status: "running",
        completedAt: null,
        failure: { ...ompFailure(event, DateTime.toEpochMillis(now)), retryable: true },
        retry: {
          attempt: Math.max(1, number(event, "attempt") ?? 1),
          maxAttempts: number(event, "maxAttempts") ?? null,
          retryDelayMs: number(event, "delayMs") ?? null,
        },
      };
      if (state.retry !== undefined)
        yield* item(
          turn,
          state.retry.key,
          {
            ...state.retry.item,
            status: "completed",
            completedAt: now,
            updatedAt: now,
          },
          "system",
        );
      state.retry = { key, item: value };
      yield* item(turn, key, value, "system");
    } else {
      const success = event.success === true;
      const failure = {
        ...ompFailure(
          {
            ...event,
            errorMessage: text(event, "finalError") ?? state.retry?.item.failure.message,
          },
          DateTime.toEpochMillis(now),
        ),
        retryable: false,
      };
      turn.failure = success ? null : failure;
      if (state.retry === undefined && success) return;
      const key = state.retry?.key ?? `retry:${turn.nextOrdinal}`;
      yield* item(
        turn,
        key,
        {
          ...(state.retry?.item ?? {
            ...base(turn, key, now, now),
            type: "error" as const,
            title: "OMP retrying",
          }),
          failure: success ? state.retry!.item.failure : failure,
          status: success ? "completed" : turn.interrupted ? "interrupted" : "failed",
          completedAt: now,
          updatedAt: now,
        },
        "system",
      );
      delete state.retry;
    }
  });

  const flush: OmpProjection["flush"] = Effect.fnUntraced(function* (turn: OmpContent) {
    for (const [key, value] of turn.streams) {
      if (!value.completed && value.pending.length > 0)
        yield* stream(turn, key, value, false, true);
    }
    for (const [nativeId, value] of turn.tools) {
      if (!value.completed) yield* presentTool(turn, nativeId, value, true);
    }
  });

  const close: OmpProjection["close"] = Effect.fnUntraced(function* (turn: OmpContent) {
    for (const [key, value] of turn.streams)
      if (!value.completed) yield* stream(turn, key, value, true);
    for (const message of stateFor(turn).messages.values()) message.completed = true;
    for (const [nativeId, value] of turn.tools) {
      if (!value.completed && !value.closed) {
        yield* presentTool(turn, nativeId, value, true);
        value.closed = true;
      }
    }
    const now = yield* DateTime.now;
    for (const [key, value] of turn.openItems) {
      if (value.type === "subagent") continue;
      const status = turn.interrupted
        ? "interrupted"
        : turn.failure !== null
          ? "failed"
          : value.type === "todo_list"
            ? "idle"
            : "completed";
      const kind =
        value.type === "todo_list" || value.type === "compaction" || value.type === "error"
          ? "system"
          : "tool_call";
      yield* item(turn, key, { ...value, status, completedAt: now, updatedAt: now }, kind);
    }
  });
  return { base, item, message, tool, notice, todos, compaction, retry, flush, close };
}
