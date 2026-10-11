import type {
  ChatAttachment,
  ModelSelection,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2ProviderTurnTokenUsage,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import { IdAllocatorV2 } from "@t3tools/provider-core/server/IdAllocator";
import { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import {
  ProviderContinuationRequests,
  type ProviderContinuationRequest,
} from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
} from "@t3tools/provider-core/server/adapterDriver";
import { withAgentDeviceEnvironment } from "@t3tools/provider-core/server/mcpSession";
import {
  isProviderNativeImageAttachment,
  providerMessageTextWithAttachmentPaths,
} from "@t3tools/provider-core/server/attachmentPrompt";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import {
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
  t3OrchestrationSystemPrompt,
} from "@t3tools/provider-core/server/orchestrationInstructions";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import { OmpSettings } from "../settings.ts";
import { OMP_CAPABILITIES, OMP_PROVIDER } from "./capabilities.ts";
import { OmpCompletion, ompFailure } from "./completion.ts";
import { makeOmpHistory, ompRef, readOmpMessages, type OmpHistorySnapshot } from "./history.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { ompLaunchArgs } from "./launch.ts";
import { makeOmpMcpPlugin } from "./mcp.ts";
import { makeOmpProjection, type OmpProjectionError, type OmpTurn } from "./projection.ts";
import { makeOmpRpcConnection, type OmpRpcError } from "./rpc.ts";
import { makeOmpRuntimeRequests } from "./runtimeRequests.ts";
import { makeOmpSubagents } from "./subagents.ts";
import { contentText, field, number, splitModel, text, type OmpRecord } from "./wire.ts";

const isProtocolError = Schema.is(Adapter.ProviderAdapterProtocolError);
const decodeOmpSettings = Schema.decodeSync(OmpSettings);

export interface OmpAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: OmpSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly continuationRequests?: {
    readonly offer: (request: ProviderContinuationRequest) => Effect.Effect<void>;
  };
}

interface ActiveTurn extends OmpTurn {
  readonly completion: OmpCompletion;
  finalizing: boolean;
  yieldedToBackground: boolean;
  finalSnapshot?: { readonly history: OmpHistorySnapshot; readonly state: unknown };
  readonly usage: Map<string, unknown>;
  readonly steeredMessages: Array<{
    readonly message: Adapter.ProviderAdapterV2TurnMessage;
    readonly nativeText: string;
  }>;
  hasSubagents: boolean;
}

interface NativeWake {
  readonly thread: OrchestrationV2ProviderThread;
  readonly messageId: Adapter.ProviderAdapterV2TurnMessage["messageId"];
  readonly events: OmpRecord[];
  offered: boolean;
}

// makeOmpAdapterV2 将原生 OMP 进程绑定到 T3 的持久会话及回合
const makeOmpAdapterV2 = Effect.fn("makeOmpAdapterV2")(function* (options: OmpAdapterV2Options) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const ids = yield* IdAllocatorV2;
  const host = yield* ProviderHost;
  const mcpSessions = yield* McpProviderSessions;
  const agentScope = yield* AgentScope;
  const protocol = (detail: string, cause?: unknown) =>
    new Adapter.ProviderAdapterProtocolError({ driver: OMP_PROVIDER, detail, cause });
  const mapped = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, Adapter.ProviderAdapterV2Error, R> =>
    effect.pipe(
      Effect.mapError((cause) =>
        isProtocolError(cause) ? cause : protocol("OMP native operation failed", cause),
      ),
    );

  const launch = (
    threadId: ThreadId,
    policy: Adapter.ProviderAdapterV2RuntimePolicy,
    forkSource?: string,
  ) =>
    Effect.gen(function* () {
      const directory = path.join(
        host.paths.stateDir,
        "omp",
        encodeURIComponent(options.instanceId),
      );
      yield* fs.makeDirectory(directory, { recursive: true });
      const mcp = yield* mcpSessions.read(threadId);
      const args = [
        ...ompLaunchArgs(options.settings, policy.runtimeMode),
        "--session-dir",
        directory,
      ];
      if (forkSource !== undefined) args.push("--fork", forkSource);
      if (mcp !== undefined) args.push("--plugin-dir", yield* makeOmpMcpPlugin(directory, mcp));
      const instructions = [
        buildRuntimeInstructions({ harness: "OMP" }),
        t3OrchestrationSystemPrompt(mcp !== undefined),
        mcp?.browserToolsAvailable ? T3_CODE_BROWSER_TOOL_INSTRUCTIONS : undefined,
      ]
        .filter((part) => part !== undefined)
        .join("\n\n");
      const instructionsFile = yield* fs.makeTempFileScoped({
        directory,
        prefix: "omp-instructions-",
        suffix: ".md",
      });
      yield* fs.writeFileString(instructionsFile, instructions);
      args.push("--append-system-prompt", instructionsFile);
      const env = withAgentDeviceEnvironment(options.environment, mcp);
      const scoped = yield* agentScope.wrap({
        command: options.settings.binaryPath || "omp",
        args,
        name: "omp",
        threadId,
        env,
      });
      return yield* makeOmpRpcConnection({
        command: scoped.command,
        args: scoped.args,
        cwd: policy.cwd ?? host.paths.cwd,
        env,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  return Adapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: OMP_PROVIDER,
    getCapabilities: () => Effect.succeed(OMP_CAPABILITIES),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: (input) =>
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const connection = yield* launch(input.threadId, input.runtimePolicy);
        const queue = yield* Queue.unbounded<
          Adapter.ProviderAdapterV2Event,
          Adapter.ProviderAdapterV2Error | Cause.Done
        >();
        const eventPermit = yield* Semaphore.make(1);
        const operationPermit = yield* Semaphore.make(1);
        const serialize = eventPermit.withPermits(1);
        const emit = (event: Adapter.ProviderAdapterV2Event) =>
          Queue.offer(queue, event).pipe(Effect.asVoid);
        const now = yield* DateTime.now;
        let session: OrchestrationV2ProviderSession = {
          id: input.providerSessionId,
          driver: OMP_PROVIDER,
          providerInstanceId: options.instanceId,
          status: "ready",
          cwd: input.runtimePolicy.cwd ?? host.paths.cwd,
          model: input.modelSelection.model,
          capabilities: OMP_CAPABILITIES,
          createdAt: input.resumeFromSession?.createdAt ?? now,
          updatedAt: now,
          lastError: null,
        };
        let thread: OrchestrationV2ProviderThread | null = null;
        let active: ActiveTurn | null = null;
        let wake: NativeWake | null = null;
        let nativeBackgroundPending = false;
        let closed = false;
        let disconnected = false;
        let initialized = false;
        let transitioning = false;
        let nativeFile: string | undefined;
        let baselineModel: { provider: string; modelId: string } | undefined;
        let baselineThinking: string | undefined;
        let selectedModel: string | undefined;
        let selectedThinking: string | undefined;
        let selectedPolicy = input.runtimePolicy;
        let selection = input.modelSelection;
        let stopRequested = false;
        const modelWindows = new Map<string, number>();
        const knownTurns = new Map<string, OrchestrationV2ProviderTurn>();
        const history = makeOmpHistory(connection);
        const projection = makeOmpProjection(ids, emit);
        const subagents = makeOmpSubagents({
          ids,
          instanceId: options.instanceId,
          sessionId: input.providerSessionId,
          emit,
          projection,
          connection,
        });
        const updateSession = (
          status: OrchestrationV2ProviderSession["status"],
          lastError: string | null = null,
        ) =>
          Effect.gen(function* () {
            session = {
              ...session,
              status,
              lastError,
              model: selection.model,
              updatedAt: yield* DateTime.now,
            };
            yield* emit({
              type: "provider_session.updated",
              driver: OMP_PROVIDER,
              providerSession: session,
            });
          });
        const requests = makeOmpRuntimeRequests({
          ids,
          sessionId: input.providerSessionId,
          emit,
          serialize,
          waiting: (waiting) =>
            updateSession(waiting ? "waiting" : active !== null ? "running" : "ready"),
        });
        const publishThread = () =>
          thread === null
            ? Effect.void
            : emit({
                type: "provider_thread.updated",
                driver: OMP_PROVIDER,
                providerThread: thread,
              });
        const request = (record: OmpRecord, timeout?: number) =>
          connection.request(record, timeout);
        const live = () =>
          Effect.gen(function* () {
            if (closed || disconnected) return yield* protocol("OMP session process disconnected");
          });
        const owned = (value: OrchestrationV2ProviderThread) =>
          Effect.gen(function* () {
            yield* live();
            if (
              thread === null ||
              value.nativeThreadRef?.nativeId !== thread.nativeThreadRef?.nativeId
            )
              return yield* protocol("OMP operation does not belong to this session thread");
          });
        const idle = () =>
          Effect.gen(function* () {
            yield* live();
            if (active !== null || wake !== null)
              return yield* protocol(
                "OMP session still has an active turn or pending background work",
              );
            const state = yield* request({ type: "get_state" });
            if (field(state, "isSettled") !== true)
              return yield* protocol("OMP native background work has not settled");
          });
        const rememberModel = (model: unknown) => {
          const provider = text(model, "provider");
          const id = text(model, "id");
          const window = number(model, "contextWindow");
          if (provider !== undefined && id !== undefined && window !== undefined)
            modelWindows.set(`${provider}/${id}`, window);
        };
        const readState = () =>
          request({ type: "get_state" }).pipe(
            Effect.tap((state) =>
              Effect.sync(() => {
                const file = text(state, "sessionFile");
                if (file !== undefined && file !== nativeFile) {
                  history.reset();
                  nativeFile = file;
                }
                rememberModel(field(state, "model"));
                const provider = text(field(state, "model"), "provider");
                const modelId = text(field(state, "model"), "id");
                selectedModel =
                  provider === undefined || modelId === undefined
                    ? undefined
                    : `${provider}/${modelId}`;
                selectedThinking = text(state, "thinkingLevel");
              }),
            ),
          );
        const initialize = (resume?: string | null) =>
          Effect.gen(function* () {
            if (initialized) return;
            yield* request({ type: "set_ask_dialog", enabled: true });
            yield* request({ type: "set_subagent_subscription", level: "events" });
            yield* request({ type: "set_event_filter", events: null, messageUpdates: "delta" });
            const defaults = resume == null ? undefined : yield* request({ type: "get_state" });
            const result = yield* request(
              resume == null
                ? { type: "new_session" }
                : { type: "switch_session", sessionPath: resume },
              0,
            );
            if (field(result, "cancelled") === true)
              return yield* protocol("An OMP extension cancelled session initialization");
            const state = yield* readState();
            const model = field(defaults ?? state, "model");
            const provider = text(model, "provider");
            const modelId = text(model, "id");
            if (provider !== undefined && modelId !== undefined)
              baselineModel = { provider, modelId };
            baselineThinking = text(defaults ?? state, "thinkingLevel");
            rememberModel(model);
            const catalog = yield* request({ type: "get_available_models" });
            const models = field(catalog, "models");
            if (Array.isArray(models)) for (const entry of models) rememberModel(entry);
            initialized = true;
          });
        const applySelection = (
          next: ModelSelection,
          policy: Adapter.ProviderAdapterV2RuntimePolicy,
        ) =>
          Effect.gen(function* () {
            if (
              policy.runtimeMode !== input.runtimePolicy.runtimeMode ||
              (policy.cwd ?? host.paths.cwd) !== session.cwd
            )
              return yield* protocol(
                "Changing OMP permissions or working directory requires a new session",
              );
            const desiredModel =
              next.model === "default"
                ? baselineModel
                : yield* Effect.try({
                    try: () => splitModel(next.model),
                    catch: (cause) => protocol("Invalid OMP model identifier", cause),
                  });
            if (desiredModel !== undefined) {
              const slug = `${desiredModel.provider}/${desiredModel.modelId}`;
              if (selectedModel !== slug) {
                const model = yield* request({ type: "set_model", ...desiredModel }, 0);
                rememberModel(model);
                selectedModel = slug;
                selectedThinking = undefined;
              }
            }
            const explicitThinking =
              getModelSelectionStringOptionValue(next, "thinking") ?? policy.reasoningEffort;
            const levelsData = yield* request({ type: "get_available_thinking_levels" });
            const levels = field(levelsData, "levels");
            const desiredThinking =
              explicitThinking ?? (next.model === "default" ? baselineThinking : undefined);
            if (desiredThinking !== undefined && desiredThinking !== selectedThinking) {
              if (!Array.isArray(levels) || !levels.includes(desiredThinking))
                return yield* protocol(
                  `OMP model does not support thinking level ${desiredThinking}`,
                );
              yield* request({ type: "set_thinking_level", level: desiredThinking });
              selectedThinking = desiredThinking;
            } else if (selectedThinking === undefined) {
              selectedThinking = text(yield* readState(), "thinkingLevel");
            }
            selection = next;
            selectedPolicy = policy;
          });
        const payload = (message: string, attachments: ReadonlyArray<ChatAttachment>) =>
          Effect.gen(function* () {
            const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
            for (const attachment of attachments) {
              const file = host.resolveAttachmentPath(attachment);
              if (file === null) return yield* protocol("OMP attachment has no stored file");
              if (isProviderNativeImageAttachment(attachment)) {
                const bytes = yield* fs.readFile(file);
                images.push({
                  type: "image",
                  data: Buffer.from(bytes).toString("base64"),
                  mimeType: attachment.mimeType,
                });
              }
            }
            return {
              message: providerMessageTextWithAttachmentPaths({
                text: message,
                attachments,
                resolveAttachmentPath: host.resolveAttachmentPath,
              }),
              ...(images.length === 0 ? {} : { images }),
            };
          });
        const tokenUsage = (
          state: unknown,
          at: DateTime.Utc,
        ): OrchestrationV2ProviderTurnTokenUsage | undefined => {
          const usage = field(state, "contextUsage");
          const usedTokens = number(usage, "tokens");
          const maxTokens = number(usage, "contextWindow");
          return usedTokens === undefined
            ? undefined
            : {
                usedTokens,
                ...(maxTokens === undefined ? {} : { maxTokens }),
                updatedAt: DateTime.formatIso(at),
              };
        };
        const offerWake = () =>
          Effect.gen(function* () {
            const current = wake;
            if (current === null || current.offered || active !== null) return;
            if (
              options.continuationRequests === undefined ||
              stopRequested ||
              transitioning ||
              current.thread.appThreadId === null
            ) {
              return yield* protocol("OMP background work has no T3 turn available for adoption");
            }
            current.offered = true;
            yield* options.continuationRequests.offer({
              driver: OMP_PROVIDER,
              threadId: current.thread.appThreadId,
              providerThreadId: current.thread.id,
              detail: null,
              delivery: "adapter_buffered",
              messageId: current.messageId,
              dispatchIfCurrent: (dispatch) =>
                serialize(
                  Effect.suspend(() =>
                    wake === current && !closed && !stopRequested
                      ? dispatch.pipe(Effect.asSome)
                      : Effect.succeedNone,
                  ),
                ),
              clearIfCurrent: () =>
                operationPermit.withPermits(1)(
                  Effect.gen(function* () {
                    const clear = yield* serialize(
                      Effect.sync(() => {
                        if (wake !== current) return false;
                        wake = null;
                        stopRequested = true;
                        return true;
                      }),
                    );
                    if (clear)
                      yield* connection
                        .request({ type: "abort_and_restore_queue" }, 0)
                        .pipe(Effect.catch(() => connection.terminate));
                  }),
                ),
            });
          });
        const finish = (
          turn: ActiveTurn,
          broken: boolean,
          snapshot?: OmpHistorySnapshot,
          state?: unknown,
        ) =>
          Effect.gen(function* () {
            if (active !== turn) return;
            const completedAt = yield* DateTime.now;
            yield* requests.cancel(turn);
            if (broken || turn.interrupted || turn.failure !== null) yield* subagents.close(turn);
            yield* projection.close(turn);
            const usage =
              state === undefined ? turn.entity.tokenUsage : tokenUsage(state, completedAt);
            let inputTokens = 0;
            let outputTokens = 0;
            let cacheRead = 0;
            let cacheWrite = 0;
            for (const value of turn.usage.values()) {
              inputTokens +=
                (number(value, "input") ?? 0) +
                (number(value, "cacheRead") ?? 0) +
                (number(value, "cacheWrite") ?? 0);
              outputTokens += number(value, "output") ?? 0;
              cacheRead += number(value, "cacheRead") ?? 0;
              cacheWrite += number(value, "cacheWrite") ?? 0;
            }
            const failure = turn.failure;
            const status =
              failure !== null ? "failed" : turn.interrupted ? "interrupted" : "completed";
            turn.entity = {
              ...turn.entity,
              status,
              completedAt,
              ...(snapshot === undefined
                ? {}
                : {
                    nativeTurnRef: snapshot.messageId === null ? null : ompRef(snapshot.messageId),
                  }),
              ...(usage === undefined ? {} : { tokenUsage: usage }),
              turnTokenUsage:
                turn.usage.size === 0
                  ? {
                      usageScope: "main_agent",
                      usageStatus: "unavailable",
                      hasSubagents: turn.hasSubagents,
                    }
                  : {
                      usageScope: "main_agent",
                      usageStatus: "complete",
                      inputTokens,
                      outputTokens,
                      cachedInputTokens: cacheRead,
                      cacheCreationTokens: cacheWrite,
                      hasSubagents: turn.hasSubagents,
                    },
            };
            knownTurns.set(turn.entity.id, turn.entity);
            yield* emit({
              type: "provider_turn.updated",
              driver: OMP_PROVIDER,
              threadId: turn.input.threadId,
              providerTurn: turn.entity,
            });
            if (thread !== null) {
              thread = {
                ...thread,
                status: broken ? "error" : "idle",
                updatedAt: completedAt,
                ...(nativeFile === undefined ? {} : { nativeThreadRef: ompRef(nativeFile) }),
                ...(snapshot === undefined
                  ? {}
                  : {
                      nativeConversationHeadRef:
                        snapshot.leafId === null ? null : ompRef(snapshot.leafId),
                    }),
                ...(usage === undefined
                  ? {}
                  : {
                      contextUsage: {
                        usedTokens: usage.usedTokens,
                        ...(usage.maxTokens == null || usage.maxTokens <= 0
                          ? {}
                          : { maxTokens: usage.maxTokens }),
                      },
                    }),
              };
              yield* publishThread();
            }
            active = null;
            yield* updateSession(
              broken || failure !== null ? "error" : "ready",
              failure?.message ?? null,
            );
            const terminalBase = {
              driver: OMP_PROVIDER,
              providerThreadId: turn.input.providerThread.id,
              providerTurnId: turn.entity.id,
              runOrdinal: turn.input.runOrdinal,
              threadDisposition: broken ? ("broken" as const) : ("reusable" as const),
            };
            if (failure !== null) {
              const base = projection.base(turn, "terminal-failure", completedAt, completedAt);
              yield* projection.item(
                turn,
                "terminal-failure",
                { ...base, type: "error", failure, status: "failed", title: null, completedAt },
                "system",
              );
              yield* emit({
                type: "turn.terminal",
                ...terminalBase,
                status: "failed",
                failure,
                failureItemOrdinal: base.ordinal,
              });
            } else {
              yield* emit({
                type: "turn.terminal",
                ...terminalBase,
                status: turn.interrupted ? "interrupted" : "completed",
                failure: null,
              });
            }
            if (!broken) yield* offerWake();
          });
        const failConnection = (cause: unknown) =>
          serialize(
            Effect.gen(function* () {
              if (closed || disconnected) return;
              disconnected = true;
              nativeBackgroundPending = false;
              wake = null;
              const failure = makeProviderFailure({
                cause,
                message: text(cause, "detail") ?? "OMP native process or event stream disconnected",
                class: "transport_error",
              });
              yield* subagents.disconnect(failure);
              if (active !== null) {
                active.failure = failure;
                yield* finish(active, true);
              }
              yield* requests.cancel();
              yield* updateSession("error", "OMP native process or event stream disconnected");
              yield* Queue.fail(
                queue,
                new Adapter.ProviderAdapterEventStreamError({
                  driver: OMP_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  cause,
                }),
              );
            }),
          ).pipe(Effect.ensuring(connection.terminate));
        const scheduleFinish = (turn: ActiveTurn) =>
          Effect.gen(function* () {
            if (turn.finalizing) return;
            turn.finalizing = true;
            yield* Effect.gen(function* () {
              const state = yield* readState();
              const snapshot = yield* history.sync;
              turn.finalSnapshot = { history: snapshot, state };
              yield* Queue.offer(connection.events, { type: "t3.finalize", id: turn.promptId });
            }).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause) ? Effect.void : failConnection(cause),
              ),
              Effect.forkIn(scope),
            );
          });
        const bufferWake = (event: OmpRecord) =>
          Effect.gen(function* () {
            if (thread === null)
              return yield* protocol("OMP started a native turn without a bound thread");
            if (wake === null) {
              const messageId = yield* ids.allocate.message({
                threadId: input.threadId,
                ordinal: (thread.lastRunOrdinal ?? 0) + 1,
              });
              wake = { thread, messageId, events: [], offered: false };
            }
            wake.events.push(event);
            yield* offerWake();
          });
        const handle = (
          event: OmpRecord,
        ): Effect.Effect<
          void,
          Adapter.ProviderAdapterProtocolError | OmpRpcError | OmpProjectionError
        > =>
          Effect.gen(function* () {
            if (closed || disconnected) return;
            if (event.type === "session_settled") nativeBackgroundPending = false;
            if (event.type === "extension_ui_request") {
              if (event.method === "notify" || event.method === "open_url") {
                const output = text(event, "message") ?? text(event, "url") ?? "";
                if (active !== null)
                  yield* projection.notice(active, text(event, "title") ?? "OMP", output);
                else yield* Effect.logInfo(output);
              } else {
                yield* requests.handle(event, {
                  connection,
                  threadId: input.threadId,
                  providerThread: thread,
                  turn: active?.finalizing ? null : active,
                });
              }
              return;
            }
            const turn = active;
            if (event.type === "t3.finalize") {
              if (turn === null || event.id !== turn.promptId || turn.finalSnapshot === undefined)
                return;
              const snapshot = turn.finalSnapshot;
              delete turn.finalSnapshot;
              const buffered = wake;
              if (
                !turn.yieldedToBackground &&
                (buffered !== null || field(snapshot.state, "isSettled") === false)
              ) {
                wake = null;
                turn.finalizing = false;
                turn.completion.resume();
                if (buffered !== null)
                  for (const pending of buffered.events) yield* handle(pending);
              } else {
                yield* finish(turn, false, snapshot.history, snapshot.state);
              }
              return;
            }
            if (String(event.type).startsWith("subagent_")) {
              if (turn !== null) turn.hasSubagents = true;
              yield* subagents.handle(event, turn?.finalizing ? null : turn);
              return;
            }
            if (wake !== null && (turn === null || turn.finalizing)) {
              yield* bufferWake(event);
              return;
            }
            if (event.type === "agent_start" && (turn === null || turn.finalizing)) {
              yield* bufferWake(event);
              return;
            }
            if (turn === null || turn.finalizing) return;
            switch (event.type) {
              case "message_start":
              case "message_update":
              case "message_end": {
                yield* projection.message(turn, event);
                if (event.type === "message_end" && text(event.message, "role") === "assistant") {
                  const usage = field(event.message, "usage");
                  if (usage !== undefined) {
                    turn.usage.set(text(event, "messageId") ?? String(turn.messageOrdinal), usage);
                    const usedTokens =
                      (number(usage, "input") ?? 0) +
                      (number(usage, "cacheRead") ?? 0) +
                      (number(usage, "cacheWrite") ?? 0) +
                      (number(usage, "output") ?? 0);
                    const model =
                      selectedModel === undefined ? undefined : modelWindows.get(selectedModel);
                    turn.entity = {
                      ...turn.entity,
                      tokenUsage: {
                        usedTokens,
                        ...(model === undefined ? {} : { maxTokens: model }),
                        updatedAt: DateTime.formatIso(yield* DateTime.now),
                      },
                    };
                    yield* emit({
                      type: "provider_turn.updated",
                      driver: OMP_PROVIDER,
                      threadId: turn.input.threadId,
                      providerTurn: turn.entity,
                    });
                  }
                }
                break;
              }
              case "tool_execution_start":
              case "tool_execution_update":
              case "tool_execution_end":
              case "tool_stream_update":
                yield* subagents.handle(event, turn);
                yield* projection.tool(turn, event);
                break;
              case "auto_compaction_start":
              case "auto_compaction_end":
                yield* projection.compaction(turn, event);
                break;
              case "auto_retry_start":
              case "auto_retry_end":
                yield* projection.retry(turn, event);
                break;
              case "todo_update":
                yield* projection.todos(turn, event.phases ?? event.todoPhases);
                break;
              case "command_output":
                yield* projection.notice(turn, "Command output", text(event, "text") ?? "");
                break;
              case "notice":
                yield* projection.notice(turn, "OMP notice", text(event, "message") ?? "");
                break;
              case "extension_error":
                yield* projection.notice(
                  turn,
                  "OMP extension error",
                  text(event, "error") ?? "Extension execution failed",
                );
                break;
              case "response":
                if (event.id === turn.promptId && turn.completion.kind === "compact")
                  yield* projection.compaction(turn, {
                    type: "auto_compaction_end",
                    result: event.data,
                    aborted: turn.interrupted,
                    ...(event.success === false && !turn.interrupted
                      ? { errorMessage: text(event, "error") ?? "Compaction failed" }
                      : {}),
                  });
                break;
            }
            const result = turn.completion.observe(event);
            if (result !== undefined) {
              if (result.yieldedToBackground === true) {
                turn.yieldedToBackground = true;
                nativeBackgroundPending = true;
              }
              if (
                result.status === "failed" &&
                !(turn.interrupted && turn.completion.kind === "compact")
              )
                turn.failure ??= ompFailure(
                  result.error,
                  DateTime.toEpochMillis(yield* DateTime.now),
                );
              if (result.status === "interrupted") turn.interrupted = true;
              yield* scheduleFinish(turn);
            }
          });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed = true;
            wake = null;
          }),
        );
        yield* Effect.gen(function* () {
          while (true) {
            const event = yield* Queue.take(connection.events);
            yield* serialize(handle(event));
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : failConnection(cause),
          ),
          Effect.forkIn(scope),
        );

        const register = (value: Adapter.ProviderAdapterV2EnsureThreadInput) =>
          Effect.gen(function* () {
            yield* live();
            if (value.threadId !== input.threadId)
              return yield* protocol("Each OMP process can bind only one T3 thread");
            if (active !== null)
              return yield* protocol("Cannot switch OMP threads during an active turn");
            if (wake !== null) {
              if (
                thread === null ||
                (value.existingProviderThread !== undefined &&
                  value.existingProviderThread.id !== thread.id)
              )
                return yield* protocol("OMP pending background work belongs to another thread");
              return thread;
            }
            const existing = value.existingProviderThread;
            const resume = existing?.nativeThreadRef?.nativeId ?? input.initialNativeThreadId;
            yield* initialize(resume);
            if (resume != null && resume !== nativeFile) {
              const switched = yield* request({ type: "switch_session", sessionPath: resume }, 0);
              if (field(switched, "cancelled") === true)
                return yield* protocol("An OMP extension cancelled session resume");
              history.reset();
              selectedModel = undefined;
              selectedThinking = undefined;
              yield* readState();
            }
            if (nativeFile === undefined)
              return yield* protocol("OMP did not provide a persistent session file");
            const snapshot = yield* history.sync;
            const at = yield* DateTime.now;
            const next: OrchestrationV2ProviderThread =
              existing !== undefined
                ? {
                    ...existing,
                    providerSessionId: input.providerSessionId,
                    appThreadId: value.threadId,
                    nativeThreadRef: ompRef(nativeFile),
                    nativeConversationHeadRef:
                      snapshot.leafId === null ? null : ompRef(snapshot.leafId),
                    status: "idle",
                    updatedAt: at,
                  }
                : (thread ?? {
                    id: ids.derive.providerThread({
                      driver: OMP_PROVIDER,
                      nativeThreadId: nativeFile,
                      providerInstanceId: options.instanceId,
                    }),
                    driver: OMP_PROVIDER,
                    providerInstanceId: options.instanceId,
                    providerSessionId: input.providerSessionId,
                    appThreadId: value.threadId,
                    ownerNodeId: null,
                    nativeThreadRef: ompRef(nativeFile),
                    nativeConversationHeadRef:
                      snapshot.leafId === null ? null : ompRef(snapshot.leafId),
                    status: "idle",
                    firstRunOrdinal: null,
                    lastRunOrdinal: null,
                    handoffIds: [],
                    forkedFrom: null,
                    pendingBackgroundTasks: [],
                    nativeMetadata: { itemIdentityVersion: 2 },
                    createdAt: at,
                    updatedAt: at,
                  });
            yield* serialize(
              Effect.sync(() => {
                thread = next;
              }),
            );
            yield* applySelection(value.modelSelection, value.runtimePolicy);
            if (value.title?.trim())
              yield* request({ type: "set_session_name", name: value.title });
            yield* publishThread();
            return next;
          });
        const start = (turnInput: Adapter.ProviderAdapterV2TurnInput, compact: boolean) =>
          operationPermit.withPermits(1)(
            Effect.gen(function* () {
              yield* owned(turnInput.providerThread);
              if (active !== null || transitioning)
                return yield* protocol("OMP already has an active turn");
              const continuation =
                turnInput.message.createdBy === "agent" &&
                turnInput.message.creationSource === "provider";
              if (continuation && (wake === null || wake.messageId !== turnInput.message.messageId))
                return yield* protocol("OMP continuation message has no corresponding native work");
              if (!continuation)
                yield* applySelection(turnInput.modelSelection, turnInput.runtimePolicy);
              const prompt =
                continuation || compact
                  ? undefined
                  : yield* payload(turnInput.message.text, turnInput.message.attachments);
              const at = yield* DateTime.now;
              const promptId = `turn:${options.instanceId}:${turnInput.attemptId}`;
              const entity: OrchestrationV2ProviderTurn = {
                id: ids.derive.providerTurn({ driver: OMP_PROVIDER, nativeTurnId: promptId }),
                providerThreadId: turnInput.providerThread.id,
                nodeId: turnInput.rootNodeId,
                runAttemptId: turnInput.attemptId,
                nativeTurnRef: ompRef(promptId, "weak"),
                ordinal: turnInput.providerTurnOrdinal,
                status: "running",
                startedAt: at,
                completedAt: null,
              };
              const turn: ActiveTurn = {
                input: turnInput,
                entity,
                promptId,
                completion: new OmpCompletion(
                  promptId,
                  compact ? "compact" : continuation ? "continuation" : "prompt",
                ),
                ordinals: new Map(),
                streams: new Map(),
                tools: new Map(),
                openItems: new Map(),
                nextOrdinal: 1,
                messageOrdinal: 0,
                interrupted: false,
                failure: null,
                finalizing: false,
                usage: new Map(),
                yieldedToBackground: false,
                steeredMessages: [],
                hasSubagents: false,
              };
              yield* serialize(
                Effect.gen(function* () {
                  yield* owned(turnInput.providerThread);
                  if (active !== null)
                    return yield* protocol("OMP turn ownership changed before startup");
                  const buffered = wake;
                  wake = null;
                  active = turn;
                  stopRequested = false;
                  thread = {
                    ...turnInput.providerThread,
                    providerSessionId: input.providerSessionId,
                    nativeThreadRef:
                      nativeFile === undefined
                        ? turnInput.providerThread.nativeThreadRef
                        : ompRef(nativeFile),
                    status: "active",
                    firstRunOrdinal:
                      turnInput.providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
                    lastRunOrdinal: turnInput.runOrdinal,
                    updatedAt: at,
                  };
                  yield* emit({
                    type: "provider_turn.updated",
                    driver: OMP_PROVIDER,
                    threadId: turnInput.threadId,
                    providerTurn: entity,
                  });
                  yield* publishThread();
                  yield* updateSession("running");
                  if (compact) {
                    yield* projection.compaction(turn, {
                      type: "auto_compaction_start",
                      reason: "manual",
                    });
                    const customInstructions = turnInput.message.text
                      .replace(/^\s*\/compact\b\s*/u, "")
                      .trim();
                    yield* connection.send({
                      type: "compact",
                      id: promptId,
                      ...(customInstructions ? { customInstructions } : {}),
                    });
                  } else if (prompt !== undefined) {
                    yield* connection.send({
                      type: "prompt",
                      id: promptId,
                      ...prompt,
                      ...(buffered === null ? {} : { streamingBehavior: "steer" }),
                    });
                  }
                  if (buffered !== null)
                    for (const event of buffered.events) {
                      if (
                        !continuation &&
                        (event.type === "session_settled" ||
                          event.type === "prompt_result" ||
                          event.type === "response")
                      )
                        continue;
                      yield* handle(event);
                    }
                }),
              ).pipe(Effect.tapCause(failConnection));
            }),
          );
        const snapshot = (
          providerThread: OrchestrationV2ProviderThread,
          turns: ReadonlyArray<OrchestrationV2ProviderTurn>,
        ) =>
          Effect.gen(function* () {
            const state = yield* readState();
            if (field(state, "isStreaming") === true || field(state, "isCompacting") === true)
              return yield* protocol(
                "Cannot read a stable history snapshot from an active OMP session",
              );
            const tree = yield* history.sync;
            const nativeMessages = yield* readOmpMessages(connection);
            const at = yield* DateTime.now;
            const messages: OrchestrationV2ConversationMessage[] = [];
            for (const [index, message] of nativeMessages.entries()) {
              const role = text(message, "role");
              if (role !== "user" && role !== "assistant") continue;
              const value = contentText(field(message, "content"));
              if (!value) continue;
              const nativeItemId = `${providerThread.id}:history:${index}`;
              const timestamp = number(message, "timestamp");
              const time = timestamp === undefined ? at : DateTime.makeUnsafe(timestamp);
              messages.push({
                id: ids.derive.messageFromProviderItem({ driver: OMP_PROVIDER, nativeItemId }),
                threadId: providerThread.appThreadId ?? input.threadId,
                runId: null,
                nodeId: null,
                role,
                text: value,
                attachments: [],
                streaming: false,
                createdBy: role === "user" ? "user" : "agent",
                creationSource: "provider",
                createdAt: time,
                updatedAt: time,
              });
            }
            const resultThread = {
              ...providerThread,
              nativeThreadRef:
                nativeFile === undefined ? providerThread.nativeThreadRef : ompRef(nativeFile),
              nativeConversationHeadRef: tree.leafId === null ? null : ompRef(tree.leafId),
              updatedAt: at,
            };
            return {
              providerThread: resultThread,
              providerTurns: turns,
              messages,
              runtimeRequests: requests.snapshot(),
              providerPayload: { messages: nativeMessages, entries: tree.branch },
            } satisfies Adapter.ProviderAdapterV2ThreadSnapshot;
          });
        const nativeChange = (command: OmpRecord) =>
          Effect.gen(function* () {
            const response = yield* request(command, 0);
            if (field(response, "cancelled") === true)
              return yield* protocol("An OMP extension cancelled the session operation");
            history.reset();
            yield* readState();
            if (nativeFile === undefined)
              return yield* protocol("OMP session operation did not return a persistent file");
          });
        const runtime: Adapter.ProviderAdapterV2SessionRuntime = {
          instanceId: options.instanceId,
          driver: OMP_PROVIDER,
          providerSessionId: input.providerSessionId,
          get providerSession() {
            return session;
          },
          events: Stream.fromQueue(queue),
          hasPendingBackgroundWork: Effect.sync(
            () => nativeBackgroundPending || wake !== null || active !== null,
          ),
          hasPendingBackgroundWorkForThread: (value) =>
            Effect.sync(
              () =>
                value.id === thread?.id &&
                (nativeBackgroundPending || wake !== null || active !== null),
            ),
          getModelContextWindow: (value) =>
            value.model === "default"
              ? baselineModel === undefined
                ? undefined
                : modelWindows.get(`${baselineModel.provider}/${baselineModel.modelId}`)
              : modelWindows.get(value.model),
          canReuseContextUsage: (previous, next) =>
            previous.instanceId === next.instanceId && previous.model === next.model,
          ensureThread: (value) => mapped(operationPermit.withPermits(1)(register(value))),
          resumeThread: (value) =>
            mapped(
              operationPermit.withPermits(1)(
                register({
                  threadId: value.threadId ?? value.providerThread.appThreadId ?? input.threadId,
                  existingProviderThread: value.providerThread,
                  modelSelection: value.modelSelection ?? selection,
                  runtimePolicy: value.runtimePolicy ?? selectedPolicy,
                }),
              ),
            ),
          injectHistory: () => Effect.succeed(false),
          startTurn: (value) =>
            mapped(start(value, /^\s*\/compact(?:\s|$)/u.test(value.message.text))),
          compactThread: (value) => mapped(start(value, true)),
          steerTurn: (value) =>
            mapped(
              operationPermit.withPermits(1)(
                Effect.gen(function* () {
                  yield* owned(value.providerThread);
                  const turn = active;
                  if (
                    turn === null ||
                    turn.entity.id !== value.providerTurnId ||
                    turn.input.runId !== value.runId ||
                    turn.finalizing
                  )
                    return yield* protocol("OMP steering target is not the active turn");
                  const prompt = yield* payload(value.message.text, value.message.attachments);
                  if (active !== turn || turn.finalizing)
                    return yield* protocol("OMP steering target has already ended");
                  yield* request({ type: "steer", ...prompt }, 0);
                  turn.steeredMessages.push({ message: value.message, nativeText: prompt.message });
                }),
              ),
            ),
          interruptTurn: (value) =>
            mapped(
              operationPermit.withPermits(1)(
                serialize(
                  Effect.gen(function* () {
                    yield* owned(value.providerThread);
                    const turn = active;
                    if (turn === null || turn.entity.id !== value.providerTurnId)
                      return yield* protocol("OMP interrupt target is not the active turn");
                    turn.interrupted = true;
                    stopRequested = true;
                    const restored = yield* request({ type: "abort_and_restore_queue" }, 0);
                    for (const queueName of ["steering", "followUp"]) {
                      const messages = field(restored, queueName);
                      if (!Array.isArray(messages)) continue;
                      for (const message of messages) {
                        const nativeText = text(message, "text") ?? "";
                        const original = turn.steeredMessages.findLast(
                          (candidate) => candidate.nativeText === nativeText,
                        );
                        yield* projection.notice(
                          turn,
                          "Message not sent",
                          `OMP stopped before consuming this message. Send it again to continue.\n\n${original?.message.text ?? nativeText}`,
                        );
                      }
                    }
                    const state = yield* readState();
                    yield* Queue.offer(connection.events, {
                      type: "t3.abort_settled",
                      id: turn.promptId,
                      isSettled: field(state, "isSettled"),
                    });
                  }),
                ),
              ),
            ),
          stopSubagent: (value) =>
            mapped(
              Effect.gen(function* () {
                yield* owned(value.providerThread);
                const response = yield* request(
                  { type: "cancel_subagent", subagentId: value.nativeTaskId },
                  0,
                );
                if (field(response, "cancelled") !== true)
                  return yield* protocol(
                    "OMP subagent has ended or does not belong to this session",
                  );
              }),
            ),
          respondToRuntimeRequest: (value) => mapped(requests.respond(value)),
          readThreadSnapshot: (value) =>
            mapped(
              operationPermit.withPermits(1)(
                Effect.gen(function* () {
                  yield* owned(value.providerThread);
                  yield* idle();
                  return yield* snapshot(thread!, [...knownTurns.values()]);
                }),
              ),
            ),
          rollbackThread: (value) =>
            mapped(
              operationPermit.withPermits(1)(
                Effect.gen(function* () {
                  if (thread === null)
                    yield* register({
                      threadId: input.threadId,
                      existingProviderThread: value.providerThread,
                      modelSelection: selection,
                      runtimePolicy: selectedPolicy,
                    });
                  yield* owned(value.providerThread);
                  yield* idle();
                  transitioning = true;
                  return yield* Effect.gen(function* () {
                    const target = value.target;
                    const ref =
                      target.type === "provider_turn" ? target.providerTurn.nativeTurnRef : null;
                    if (ref !== null && ref.strength !== "strong")
                      return yield* protocol(
                        "OMP rollback target has no persistent message boundary",
                      );
                    yield* nativeChange(
                      ref?.nativeId == null
                        ? { type: "new_session" }
                        : { type: "fork", entryId: ref.nativeId },
                    );
                    const retained =
                      target.type === "thread_start"
                        ? []
                        : value.providerThreadTurns.filter(
                            (turn) => turn.ordinal <= target.providerTurn.ordinal,
                          );
                    knownTurns.clear();
                    for (const turn of retained) knownTurns.set(turn.id, turn);
                    const result = yield* snapshot(
                      {
                        ...thread!,
                        nativeThreadRef: ompRef(nativeFile!),
                        status: "idle",
                        contextUsage: null,
                      },
                      retained,
                    );
                    thread = result.providerThread;
                    yield* publishThread();
                    return result;
                  }).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        transitioning = false;
                      }),
                    ),
                  );
                }),
              ),
            ),
          forkThread: (value) =>
            mapped(
              operationPermit.withPermits(1)(
                Effect.gen(function* () {
                  yield* live();
                  if (value.sourceProviderThread.id === thread?.id) yield* idle();
                  const sourceFile = value.sourceProviderThread.nativeThreadRef?.nativeId;
                  if (sourceFile == null)
                    return yield* protocol("OMP fork source has no native session file");
                  const sourceTurn =
                    value.providerTurnId === undefined
                      ? undefined
                      : (value.sourceProviderTurns?.find(
                          (turn) => turn.id === value.providerTurnId,
                        ) ?? knownTurns.get(value.providerTurnId));
                  if (value.providerTurnId !== undefined && sourceTurn === undefined)
                    return yield* protocol("OMP fork target turn does not exist");
                  if (
                    sourceTurn?.nativeTurnRef != null &&
                    sourceTurn.nativeTurnRef.strength !== "strong"
                  )
                    return yield* protocol("OMP fork target has no persistent message boundary");
                  const forked = yield* Effect.scoped(
                    Effect.gen(function* () {
                      const helperScope = yield* Effect.scope;
                      const helper = yield* launch(
                        value.targetThreadId,
                        value.runtimePolicy ?? selectedPolicy,
                        sourceFile,
                      );
                      yield* Effect.gen(function* () {
                        while (true) {
                          const event = yield* Queue.take(helper.events);
                          if (event.type === "extension_ui_request")
                            yield* serialize(
                              requests.handle(event, {
                                connection: helper,
                                threadId: value.targetThreadId,
                                providerThread: null,
                                turn: null,
                              }),
                            );
                          else if (event.type === "agent_start") yield* helper.terminate;
                        }
                      }).pipe(
                        Effect.catchCause((cause) =>
                          Cause.hasInterruptsOnly(cause) ? Effect.void : helper.terminate,
                        ),
                        Effect.forkIn(helperScope),
                      );
                      if (sourceTurn !== undefined) {
                        const ref = sourceTurn.nativeTurnRef;
                        const result = yield* helper.request(
                          ref?.nativeId == null
                            ? { type: "new_session" }
                            : { type: "fork", entryId: ref.nativeId },
                          0,
                        );
                        if (field(result, "cancelled") === true)
                          return yield* protocol("An OMP extension cancelled the fork");
                      }
                      const state = yield* helper.request({ type: "get_state" });
                      const file = text(state, "sessionFile");
                      if (file === undefined || file === sourceFile)
                        return yield* protocol("OMP did not create an independent fork session");
                      const tree = yield* makeOmpHistory(helper).sync;
                      const at = yield* DateTime.now;
                      return {
                        id: ids.derive.providerThread({
                          driver: OMP_PROVIDER,
                          nativeThreadId: file,
                          providerInstanceId: options.instanceId,
                        }),
                        driver: OMP_PROVIDER,
                        providerInstanceId: options.instanceId,
                        providerSessionId: null,
                        appThreadId: value.targetThreadId,
                        ownerNodeId: value.ownerNodeId ?? null,
                        nativeThreadRef: ompRef(file),
                        nativeConversationHeadRef:
                          tree.leafId === null ? null : ompRef(tree.leafId),
                        status: "not_loaded",
                        firstRunOrdinal: null,
                        lastRunOrdinal: null,
                        handoffIds: [],
                        forkedFrom: {
                          providerThreadId: value.sourceProviderThread.id,
                          ...(value.providerTurnId === undefined
                            ? {}
                            : { providerTurnId: value.providerTurnId }),
                        },
                        pendingBackgroundTasks: [],
                        nativeMetadata: { itemIdentityVersion: 2 },
                        createdAt: at,
                        updatedAt: at,
                      } satisfies OrchestrationV2ProviderThread;
                    }),
                  );
                  return yield* register({
                    threadId: value.targetThreadId,
                    existingProviderThread: forked,
                    modelSelection: value.modelSelection ?? selection,
                    runtimePolicy: value.runtimePolicy ?? selectedPolicy,
                  });
                }),
              ),
            ),
        };
        return runtime;
      }).pipe(
        Effect.mapError(
          (cause) =>
            new Adapter.ProviderAdapterOpenSessionError({
              driver: OMP_PROVIDER,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      ),
  });
});

export type OmpAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | IdAllocatorV2
  | McpProviderSessions
  | ProviderHost;

export const OmpAdapterV2Driver: ProviderAdapterDriver<OmpSettings, OmpAdapterV2DriverEnv> = {
  driverKind: OMP_PROVIDER,
  configSchema: OmpSettings,
  defaultConfig: () => decodeOmpSettings({}),
  create: (input) =>
    Effect.gen(function* () {
      const environment = yield* HostProcess.Environment;
      const continuationRequests = yield* ProviderContinuationRequests;
      return yield* makeOmpAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, environment),
        continuationRequests,
      });
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterDriverCreateError({
            driver: OMP_PROVIDER,
            instanceId: input.instanceId,
            detail: "Failed to create the native OMP adapter",
            cause,
          }),
      ),
    ),
};
