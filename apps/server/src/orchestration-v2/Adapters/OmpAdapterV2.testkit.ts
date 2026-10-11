// OmpOrchestratorReplayHarness 在真实进程边界回放原生 RPC 行并保留多进程顺序
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderReplayEntry,
  type ProviderInstanceEnvironment,
  type ProviderReplayTranscript,
  type ProviderReplayEntry as ProviderReplayEntryType,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import type { ProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import { ProviderAdapterDriverCreateError } from "@t3tools/provider-core/server/adapterDriver";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import { OMP_PROVIDER, OmpAdapterV2Driver, OmpFrameDecoder } from "@t3tools/provider-omp/testing";

export const OMP_RPC_REPLAY_PROTOCOL = "omp.rpc-ui-jsonl-v2";
const OMP_REPLAY_ANY = "<any>";
export const OMP_BACKGROUND_REPLAY_GATE = "omp:background-after-parent";

const OmpRpcReplayTranscript = Schema.Struct({
  provider: Schema.Literal(OMP_PROVIDER),
  protocol: Schema.Literal(OMP_RPC_REPLAY_PROTOCOL),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(ProviderReplayEntry),
});
export type OmpRpcReplayTranscript = typeof OmpRpcReplayTranscript.Type;
const decodeOmpRpcReplayTranscript = Schema.decodeUnknownEffect(OmpRpcReplayTranscript);

class OmpReplayTranscriptDecodeError extends Schema.TaggedError<OmpReplayTranscriptDecodeError>()(
  "OmpReplayTranscriptDecodeError",
  {
    driver: Schema.optional(Schema.String),
    protocol: Schema.optional(Schema.String),
    scenario: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode Omp RPC replay transcript for scenario ${this.scenario ?? "<unknown>"}.`;
  }
}

class OmpReplayMismatchError extends Schema.TaggedError<OmpReplayMismatchError>()(
  "OmpReplayMismatchError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    process: Schema.Number,
    label: Schema.optional(Schema.String),
    actualType: Schema.optional(Schema.String),
    expected: Schema.Unknown,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Omp replay frame mismatch at cursor ${this.cursor} (expected ${this.label ?? "<none>"}, received ${this.actualType ?? "<untyped>"} from process ${this.process}) in scenario ${this.scenario}.`;
  }
}

class OmpReplayIncompleteError extends Schema.TaggedError<OmpReplayIncompleteError>()(
  "OmpReplayIncompleteError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    remaining: Schema.Number,
    nextLabel: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Omp replay ended with ${this.remaining} unconsumed entries at cursor ${this.cursor} (next ${this.nextLabel ?? "<none>"}) in scenario ${this.scenario}.`;
  }
}

function entryLabel(entry: ProviderReplayEntryType | undefined): string | undefined {
  if (entry === undefined) return undefined;
  return entry.type === "runtime_exit" ? "runtime_exit" : (entry.label ?? entry.type);
}

const OmpOrchestratorReplayHarnessError = Schema.Union([
  OmpReplayTranscriptDecodeError,
  ProviderAdapterDriverCreateError,
]);
type OmpOrchestratorReplayHarnessError = typeof OmpOrchestratorReplayHarnessError.Type;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function replayValueMatches(expected: unknown, actual: unknown): boolean {
  if (expected === OMP_REPLAY_ANY) return true;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((entry, index) => replayValueMatches(entry, actual[index]))
    );
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...keys].every((key) => replayValueMatches(expected[key], actual[key]));
  }
  return Object.is(expected, actual);
}

const ADAPTER_REQUEST_ID = /^(?:t3-omp-\d+|turn:.*)$/u;

function adapterRequestId(frame: unknown): string | undefined {
  const id = isRecord(frame) ? frame.id : undefined;
  return typeof id === "string" && ADAPTER_REQUEST_ID.test(id) ? id : undefined;
}

function withRequestId(expected: unknown, actual: unknown): unknown {
  const actualId = adapterRequestId(actual);
  return isRecord(expected) && adapterRequestId(expected) !== undefined && actualId !== undefined
    ? { ...expected, id: actualId }
    : expected;
}

function startsTurn(entry: ProviderReplayEntryType): boolean {
  if (entry.type !== "expect_outbound") return false;
  const type = isRecord(entry.frame) ? entry.frame.type : undefined;
  return type === "prompt" || type === "compact" || type === "process_start";
}

function processStartFrame(command: ChildProcess.Command) {
  const args = ChildProcess.isStandardCommand(command)
    ? command.args.map((arg) =>
        arg.startsWith('^"') && arg.endsWith('^"')
          ? arg.slice(2, -2).replace(/\^(.)/gu, "$1")
          : arg,
      )
    : [];
  return {
    type: "process_start",
    args: args.map((arg, index) =>
      ["--session-dir", "--append-system-prompt", "--plugin-dir"].includes(args[index - 1] ?? "")
        ? OMP_REPLAY_ANY
        : arg,
    ),
  };
}

function entryProcess(entry: ProviderReplayEntryType): number {
  const label = entry.type === "runtime_exit" ? undefined : entry.label;
  const match = label === undefined ? null : /@p(\d+)$/u.exec(label);
  return match === null ? 1 : Number(match[1]);
}

function recordLabel(frame: unknown, process: number): string | undefined {
  const base = !isRecord(frame)
    ? undefined
    : frame.type === "response" && typeof frame.command === "string"
      ? `response:${frame.command}`
      : typeof frame.type === "string"
        ? frame.type
        : undefined;
  if (base === undefined || process === 1) return base;
  return `${base}@p${process}`;
}

const decodeJsonLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function makeLineSplitter() {
  let buffer = "";
  const decoder = new TextDecoder();
  return (chunk: Uint8Array): ReadonlyArray<string> => {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    return lines.map((line) => line.replace(/\r$/u, "")).filter((line) => line.length > 0);
  };
}

// mapOmpReplayFrames 脱敏逻辑消息后重新分块并保留原始行位置和分块关联
export function mapOmpReplayFrames(
  entries: ReadonlyArray<ProviderReplayEntryType>,
  transform: (frame: unknown) => unknown,
): ReadonlyArray<ProviderReplayEntryType> {
  const result = [...entries];
  const pending = new Map<number, { decoder: OmpFrameDecoder; indices: number[] }>();
  for (const [index, entry] of entries.entries()) {
    if (entry.type === "runtime_exit") continue;
    if (!isRecord(entry.frame) || entry.frame.type !== "rpc_chunk") {
      result[index] = { ...entry, frame: transform(entry.frame) };
      continue;
    }
    const ordinal = entryProcess(entry);
    let group = pending.get(ordinal);
    if (group === undefined) {
      group = { decoder: new OmpFrameDecoder(), indices: [] };
      pending.set(ordinal, group);
    }
    group.indices.push(index);
    const logical = group.decoder.decode(encodeJsonLine(entry.frame));
    if (logical === undefined) continue;
    const bytes = Buffer.from(encodeJsonLine(transform(logical)));
    for (const [chunkIndex, entryIndex] of group.indices.entries()) {
      const original = entries[entryIndex]!;
      if (original.type === "runtime_exit" || !isRecord(original.frame)) continue;
      const start = Math.floor((bytes.length * chunkIndex) / group.indices.length);
      const end = Math.floor((bytes.length * (chunkIndex + 1)) / group.indices.length);
      result[entryIndex] = {
        ...original,
        frame: {
          ...original.frame,
          byteLength: bytes.length,
          data: bytes.subarray(start, end).toString("base64"),
        },
      };
    }
    pending.delete(ordinal);
  }
  for (const group of pending.values()) group.decoder.finish();
  return result;
}

interface OmpReplayProcess {
  readonly ordinal: number;
  readonly stdout: Queue.Queue<Uint8Array, Cause.Done>;

  readonly ids: Map<string, string>;
  readonly exit: Deferred.Deferred<ChildProcessSpawner.ExitCode>;
  open: boolean;
}

class OmpReplayController {
  private cursor = 0;
  private failure: unknown = null;
  private readonly consumed = new Set<number>();
  private readonly held: Array<{ readonly process: OmpReplayProcess; readonly actual: unknown }> =
    [];
  private readonly processes: Array<OmpReplayProcess> = [];
  private readonly transcript: OmpRpcReplayTranscript;
  private readonly reboundChunks = new Map<number, unknown>();
  private readonly replayGate: ProviderReplayGate | undefined;
  private backgroundWaiting = false;
  private backgroundReleased = false;

  constructor(transcript: OmpRpcReplayTranscript, replayGate?: ProviderReplayGate) {
    this.transcript = transcript;
    this.replayGate = replayGate;
  }

  spawn(
    command: ChildProcess.Command,
    stdout: Queue.Queue<Uint8Array, Cause.Done>,
  ): OmpReplayProcess {
    const process: OmpReplayProcess = {
      ordinal: this.processes.length + 1,
      stdout,
      ids: new Map(),
      exit: Deferred.makeUnsafe<ChildProcessSpawner.ExitCode>(),
      open: true,
    };
    this.processes.push(process);
    this.receive(process, processStartFrame(command));
    return process;
  }

  receive(process: OmpReplayProcess, actual: unknown): void {
    if (this.failure !== null) return;
    const entries = this.transcript.entries;
    let possible = false;
    for (let index = this.cursor; index < entries.length && !possible; index += 1) {
      const entry = entries[index]!;
      const pending = entry.type === "expect_outbound" && !this.consumed.has(index);
      possible =
        pending &&
        entryProcess(entry) === process.ordinal &&
        replayValueMatches(withRequestId(entry.frame, actual), actual);
      if (!possible && pending && startsTurn(entry)) break;
    }
    if (!possible) {
      const expected = entries[this.cursor];
      const label = entryLabel(expected);
      const actualType = isRecord(actual) ? actual.type : undefined;
      this.fail(
        new OmpReplayMismatchError({
          scenario: this.transcript.scenario,
          cursor: this.cursor,
          process: process.ordinal,
          ...(label === undefined ? {} : { label }),
          ...(typeof actualType === "string" ? { actualType } : {}),
          expected: expected ?? null,
          actual,
        }),
      );
      return;
    }
    this.held.push({ process, actual });
    this.advance();
  }

  close(process: OmpReplayProcess): void {
    process.open = false;
    Queue.endUnsafe(process.stdout);
    Deferred.doneUnsafe(process.exit, Effect.succeed(ChildProcessSpawner.ExitCode(0)));
  }

  endInput(process: OmpReplayProcess): void {
    this.close(process);
    this.advance();
  }

  assertComplete(): void {
    if (this.failure !== null) throw this.failure;
    if (this.cursor !== this.transcript.entries.length || this.held.length > 0) {
      const nextLabel = entryLabel(this.transcript.entries[this.cursor]);
      throw new OmpReplayIncompleteError({
        scenario: this.transcript.scenario,
        cursor: this.cursor,
        remaining: this.transcript.entries.length - this.cursor,
        ...(nextLabel === undefined ? {} : { nextLabel }),
      });
    }
  }

  private advance(): void {
    let progressed = true;
    while (progressed && this.failure === null) {
      progressed = this.drainInbound();
      for (const [heldIndex, write] of this.held.entries()) {
        if (this.consumePending(write.process, write.actual)) {
          this.held.splice(heldIndex, 1);
          progressed = true;
          break;
        }
      }
    }
  }

  private consumePending(process: OmpReplayProcess, actual: unknown): boolean {
    const entries = this.transcript.entries;
    for (let index = this.cursor; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (entry.type !== "expect_outbound") return false;
      if (this.consumed.has(index) || entryProcess(entry) !== process.ordinal) continue;
      if (!replayValueMatches(withRequestId(entry.frame, actual), actual)) continue;
      const recordedId = adapterRequestId(entry.frame);
      const actualId = adapterRequestId(actual);
      if (recordedId !== undefined && actualId !== undefined) {
        process.ids.set(recordedId, actualId);
      }
      this.consumed.add(index);
      while (this.consumed.has(this.cursor)) this.cursor += 1;
      return true;
    }
    return false;
  }

  private drainInbound(): boolean {
    let emitted = false;
    while (this.failure === null) {
      const entry = this.transcript.entries[this.cursor];
      if (entry?.type === "runtime_exit") {
        const ordinal = isRecord(entry.error) ? entry.error.process : undefined;
        const exiting =
          typeof ordinal === "number" ? this.processes[ordinal - 1] : this.processes.at(-1);
        if (entry.status === "cancelled" && exiting?.open) return emitted;
        this.cursor += 1;
        emitted = true;
        const process =
          typeof ordinal === "number" ? this.processes[ordinal - 1] : this.processes.at(-1);
        if (process !== undefined) this.close(process);
        continue;
      }
      if (entry?.type !== "emit_inbound") return emitted;
      const process = this.processes[entryProcess(entry) - 1];
      if (process === undefined) return emitted;
      if (
        entry.label === OMP_BACKGROUND_REPLAY_GATE &&
        this.replayGate !== undefined &&
        !this.backgroundReleased
      ) {
        if (!this.backgroundWaiting) {
          this.backgroundWaiting = true;
          void this.replayGate.beforeEmit(entry.label).then(() => {
            this.backgroundReleased = true;
            this.advance();
          });
        }
        return emitted;
      }
      this.cursor += 1;
      emitted = true;
      if (!process.open) continue;
      const rebind = (frame: unknown): unknown => {
        const recordedId = isRecord(frame) ? frame.id : undefined;
        const reboundId = typeof recordedId === "string" ? process.ids.get(recordedId) : undefined;
        return isRecord(frame) && reboundId !== undefined ? { ...frame, id: reboundId } : frame;
      };
      let rebound: unknown;
      if (isRecord(entry.frame) && entry.frame.type === "rpc_chunk") {
        const start = this.cursor - 1;
        if (!this.reboundChunks.has(start)) {
          const indices: number[] = [];
          for (let index = start; index < this.transcript.entries.length; index++) {
            const candidate = this.transcript.entries[index]!;
            if (candidate.type !== "emit_inbound" || entryProcess(candidate) !== process.ordinal)
              continue;
            indices.push(index);
            if (indices.length === entry.frame.count) break;
          }
          const transformed = mapOmpReplayFrames(
            indices.map((index) => this.transcript.entries[index]!),
            rebind,
          );
          transformed.forEach((candidate, index) => {
            if (candidate.type !== "runtime_exit")
              this.reboundChunks.set(indices[index]!, candidate.frame);
          });
        }
        rebound = this.reboundChunks.get(start);
        this.reboundChunks.delete(start);
      } else {
        rebound = rebind(entry.frame);
      }
      Queue.offerUnsafe(process.stdout, new TextEncoder().encode(`${encodeJsonLine(rebound)}\n`));
    }
    return emitted;
  }

  private fail(cause: unknown): void {
    if (this.failure !== null) return;
    this.failure = cause;
    for (const process of this.processes) this.close(process);
  }
}

const REPLAY_PID = 999_999_999;

function makeOmpReplaySpawner(
  controller: OmpReplayController,
): ChildProcessSpawner.ChildProcessSpawner["Service"] {
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const terminating = ChildProcess.isStandardCommand(command) && command.command === "taskkill";
      const process = terminating
        ? undefined
        : controller.spawn(command, yield* Queue.unbounded<Uint8Array, Cause.Done>());
      if (process !== undefined)
        yield* Effect.addFinalizer(() => Effect.sync(() => controller.close(process)));
      const split = makeLineSplitter();
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(REPLAY_PID),
        exitCode:
          process === undefined
            ? Effect.succeed(ChildProcessSpawner.ExitCode(0))
            : Deferred.await(process.exit),
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.sync(() => {
            if (process !== undefined)
              for (const line of split(chunk)) controller.receive(process, decodeJsonLine(line));
          }),
        ).pipe(
          Sink.ensuring(
            Effect.sync(() => {
              if (process !== undefined) controller.endInput(process);
            }),
          ),
        ),
        stdout: process === undefined ? Stream.empty : Stream.fromQueue(process.stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
}

export function layer<E, R>(input: {
  readonly scenario: string;
  readonly spawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner, E, R>;
  readonly binaryPath: string;
  readonly host?: Layer.Layer<ProviderHost | TestProviderHost.TestProviderHostSettings>;
  readonly environment?: ProviderInstanceEnvironment;
}) {
  return ProviderAdapterRegistry.layerFromDrivers({
    drivers: [OmpAdapterV2Driver],
    configMap: {
      [OMP_PROVIDER]: {
        driver: OMP_PROVIDER,
        enabled: true,
        config: { binaryPath: input.binaryPath },
        ...(input.environment === undefined ? {} : { environment: input.environment }),
      },
    },
  }).pipe(
    Layer.provide(input.spawner),
    Layer.provide(
      Layer.mergeAll(
        input.host ?? TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
        NodeServices.layer,
        IdAllocator.layer,
      ),
    ),
  );
}

export const OmpOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  OmpRpcReplayTranscript,
  OmpOrchestratorReplayHarnessError
> = {
  driver: OMP_PROVIDER,
  decodeTranscript: (transcript: ProviderReplayTranscript) =>
    decodeOmpRpcReplayTranscript(transcript).pipe(
      Effect.mapError(
        (cause) =>
          new OmpReplayTranscriptDecodeError({
            driver: transcript.provider,
            protocol: transcript.protocol,
            scenario: transcript.scenario,
            cause,
          }),
      ),
    ),
  makeProviderAdapterRegistryLayer: (transcript, options) =>
    layer({
      scenario: transcript.scenario,
      binaryPath: "omp",
      spawner: Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.gen(function* () {
          const controller = new OmpReplayController(transcript, options?.replayGate);
          yield* Effect.addFinalizer(() => Effect.sync(() => controller.assertComplete()));
          return makeOmpReplaySpawner(controller);
        }),
      ),
    }),
};

// makeOmpRestartReplayHarness 让重建后的真实编排器共享同一录制进程游标
export const makeOmpRestartReplayHarness = (transcript: OmpRpcReplayTranscript) =>
  Effect.gen(function* () {
    const controller = new OmpReplayController(transcript);
    const host = Layer.succeedContext(
      yield* Layer.build(TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer))),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => controller.assertComplete()));
    return {
      ...OmpOrchestratorReplayHarness,
      makeProviderAdapterRegistryLayer: () =>
        layer({
          scenario: transcript.scenario,
          binaryPath: "omp",
          host,
          spawner: Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            makeOmpReplaySpawner(controller),
          ),
        }),
    };
  });

export function makeOmpRecordingSpawner(
  live: ChildProcessSpawner.ChildProcessSpawner["Service"],
  entries: Array<ProviderReplayEntryType>,
  options: {
    readonly launchArgs: ReadonlyArray<string>;
    readonly environment: NodeJS.ProcessEnv;
    readonly processIds: number[];
    readonly onFrame?: (
      frame: unknown,
      handle: ChildProcessSpawner.ChildProcessHandle,
    ) => Effect.Effect<void, PlatformError.PlatformError>;
  },
): ChildProcessSpawner.ChildProcessSpawner["Service"] {
  let spawned = 0;
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command) || command.command === "taskkill")
        return yield* live.spawn(command);
      const handle = yield* live.spawn(
        ChildProcess.make(command.command, [...command.args, ...options.launchArgs], {
          ...command.options,
          env: options.environment,
          extendEnv: false,
        }),
      );
      const process = ++spawned;
      options.processIds.push(Number(handle.pid));
      const record = (type: "expect_outbound" | "emit_inbound", frame: unknown) => {
        const label = recordLabel(frame, process);
        entries.push({ type, ...(label === undefined ? {} : { label }), frame });
      };
      const recordLines = (
        type: "expect_outbound" | "emit_inbound",
        lines: ReadonlyArray<string>,
      ) => {
        for (const line of lines) record(type, decodeJsonLine(line));
      };
      record("expect_outbound", processStartFrame(command));
      const splitIn = makeLineSplitter();
      const splitOut = makeLineSplitter();
      let closing = false;
      const decoder = new OmpFrameDecoder();
      return ChildProcessSpawner.makeHandle({
        ...handle,
        stdin: handle.stdin
          .pipe(
            Sink.mapInput((chunk: Uint8Array) => {
              recordLines("expect_outbound", splitIn(chunk));
              return chunk;
            }),
          )
          .pipe(
            Sink.ensuring(
              Effect.sync(() => {
                closing = true;
              }),
            ),
          ),
        stdout: handle.stdout.pipe(
          Stream.tap((chunk) =>
            Effect.gen(function* () {
              for (const line of splitOut(chunk)) {
                const frame = decodeJsonLine(line);
                record("emit_inbound", frame);
                const logical = decoder.decode(line);
                if (logical !== undefined && options.onFrame !== undefined)
                  yield* options.onFrame(logical, handle);
              }
            }),
          ),
          Stream.concat(
            Stream.fromEffect(
              Effect.sync(() => {
                entries.push({
                  type: "runtime_exit",
                  status: closing ? "cancelled" : "error",
                  error: { process },
                });
              }),
            ).pipe(Stream.drain),
          ),
        ),
      });
    }),
  );
}
