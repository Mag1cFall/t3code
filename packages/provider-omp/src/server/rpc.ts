import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import { OmpFrameDecoder, type OmpRecord } from "./wire.ts";

// OmpRpcError 表示 OMP 命令或进程通信失败
export class OmpRpcError extends Schema.TaggedError<OmpRpcError>()("OmpRpcError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export interface OmpRpcOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface OmpRpcConnection {
  readonly send: (record: OmpRecord) => Effect.Effect<void, OmpRpcError>;
  readonly request: (record: OmpRecord, timeoutMs?: number) => Effect.Effect<unknown, OmpRpcError>;
  readonly events: Queue.Queue<OmpRecord, OmpRpcError>;
  readonly terminate: Effect.Effect<void>;
}

const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

// makeOmpRpcConnection 启动独立 OMP 进程并协商无损 JSONL v2 通信
export const makeOmpRpcConnection = Effect.fn("makeOmpRpcConnection")(function* (
  options: OmpRpcOptions,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const scope = yield* Effect.scope;
  const launch = yield* resolveSpawnCommand(options.command, [...options.args], {
    env: options.env,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new OmpRpcError({
          operation: "spawn",
          detail: "Failed to resolve the OMP command.",
          cause,
        }),
    ),
  );
  const child = yield* spawner
    .spawn(
      ChildProcess.make(launch.command, launch.args, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: options.env,
        extendEnv: false,
        shell: launch.shell,
        detached: platform !== "win32",
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) => new OmpRpcError({ operation: "spawn", detail: "Failed to start OMP.", cause }),
      ),
    );
  const events = yield* Queue.unbounded<OmpRecord, OmpRpcError>();
  const outgoing = yield* Queue.unbounded<Uint8Array, OmpRpcError | Cause.Done>();
  const ready = yield* Deferred.make<OmpRecord, OmpRpcError>();
  const down = yield* Deferred.make<never, OmpRpcError>();
  const pending = new Map<string, Deferred.Deferred<unknown, OmpRpcError>>();
  let nextId = 0;
  let exited = false;
  let closing = false;
  let stderr = "";

  const fail = (error: OmpRpcError) =>
    Effect.gen(function* () {
      if (!(yield* Deferred.fail(down, error))) return;
      yield* Deferred.fail(ready, error);
      for (const waiter of pending.values()) yield* Deferred.fail(waiter, error);
      pending.clear();
      yield* Queue.fail(events, error);
      yield* Queue.fail(outgoing, error);
    });

  const terminate = Effect.gen(function* () {
    if (exited) return;
    if (platform === "win32") {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const killer = yield* spawner.spawn(
            ChildProcess.make("taskkill", ["/PID", String(child.pid), "/T", "/F"]),
          );
          yield* killer.exitCode;
        }),
      );
    } else {
      yield* Effect.sync(() => signalProcessGroup(Number(child.pid), "SIGTERM"));
      const result = yield* child.exitCode.pipe(Effect.timeoutOption(1_000));
      if (Option.isNone(result) && !exited)
        yield* Effect.sync(() => signalProcessGroup(Number(child.pid), "SIGKILL"));
    }
  }).pipe(Effect.ignore, Effect.uninterruptible);
  yield* Effect.addFinalizer(() => terminate);

  const route = (record: OmpRecord) =>
    Effect.gen(function* () {
      if (record.type === "ready") {
        yield* Deferred.succeed(ready, record);
      } else if (
        record.type === "response" &&
        typeof record.id === "string" &&
        pending.has(record.id)
      ) {
        const waiter = pending.get(record.id)!;
        pending.delete(record.id);
        if (record.success === true) yield* Deferred.succeed(waiter, record.data);
        else
          yield* Deferred.fail(
            waiter,
            new OmpRpcError({
              operation: String(record.command),
              detail: String(record.error),
              cause: record,
            }),
          );
      } else {
        yield* Queue.offer(events, record);
      }
    });

  yield* child.exitCode.pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        exited = true;
      }),
    ),
    Effect.ignore,
    Effect.forkIn(scope),
  );
  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        stderr = (stderr + chunk).slice(-8_192);
      }),
    ),
    Effect.ignore,
    Effect.forkIn(scope),
  );
  yield* Effect.gen(function* () {
    const decoder = new OmpFrameDecoder();
    let buffer = "";
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          buffer += chunk;
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, "");
            buffer = buffer.slice(newline + 1);
            if (line.length === 0) continue;
            const record = yield* Effect.try({
              try: () => decoder.decode(line),
              catch: (cause) =>
                new OmpRpcError({
                  operation: "decode",
                  detail: "Invalid OMP protocol frame.",
                  cause,
                }),
            });
            if (record !== undefined) yield* route(record);
          }
        }),
      ),
    );
    yield* Effect.try({
      try: () => {
        decoder.finish();
        if (buffer.length > 0) throw new Error("Incomplete OMP JSONL frame.");
      },
      catch: (cause) =>
        new OmpRpcError({
          operation: "decode",
          detail: "OMP output ended during a message.",
          cause,
        }),
    });
    if (!closing)
      yield* fail(
        new OmpRpcError({
          operation: "exit",
          detail: `OMP exited${stderr.trim() ? `: ${stderr.trim()}` : "."}`,
        }),
      );
  }).pipe(
    Effect.catchCause((cause) =>
      fail(new OmpRpcError({ operation: "read", detail: "Failed to read OMP output.", cause })),
    ),
    Effect.forkIn(scope),
  );
  yield* Stream.fromQueue(outgoing).pipe(
    Stream.run(child.stdin),
    Effect.catchCause((cause) =>
      closing
        ? Effect.void
        : fail(new OmpRpcError({ operation: "write", detail: "Failed to write to OMP.", cause })),
    ),
    Effect.forkIn(scope),
  );

  const send = (record: OmpRecord): Effect.Effect<void, OmpRpcError> =>
    Effect.gen(function* () {
      const json = yield* encodeRecord(record).pipe(
        Effect.mapError(
          (cause) =>
            new OmpRpcError({
              operation: "encode",
              detail: "Failed to encode an OMP command.",
              cause,
            }),
        ),
      );
      const encoded = Buffer.from(`${json}\n`);
      if (!(yield* Queue.offer(outgoing, encoded))) return yield* Deferred.await(down);
    });
  const request = (record: OmpRecord, timeoutMs = 30_000): Effect.Effect<unknown, OmpRpcError> =>
    Effect.gen(function* () {
      const id = typeof record.id === "string" ? record.id : `t3-omp-${++nextId}`;
      const waiter = yield* Deferred.make<unknown, OmpRpcError>();
      pending.set(id, waiter);
      const response = Effect.gen(function* () {
        yield* send({ ...record, id });
        return yield* Effect.raceFirst(Deferred.await(waiter), Deferred.await(down));
      });
      return yield* (
        timeoutMs === 0
          ? response
          : response.pipe(
              Effect.timeoutOrElse({
                duration: timeoutMs,
                orElse: () =>
                  Effect.fail(
                    new OmpRpcError({
                      operation: String(record.type),
                      detail: `OMP command timed out after ${timeoutMs} ms.`,
                    }),
                  ),
              }),
            )
      ).pipe(Effect.ensuring(Effect.sync(() => pending.delete(id))));
    });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closing = true;
      yield* Queue.end(outgoing);
      const result = yield* child.exitCode.pipe(Effect.timeoutOption(2_000));
      if (Option.isNone(result)) yield* terminate;
    }).pipe(Effect.ignore, Effect.uninterruptible),
  );
  const greeting = yield* Deferred.await(ready).pipe(
    Effect.timeoutOrElse({
      duration: 30_000,
      orElse: () =>
        Effect.fail(
          new OmpRpcError({ operation: "ready", detail: "OMP did not send its ready message." }),
        ),
    }),
  );
  if (
    !Array.isArray(greeting.supportedProtocolVersions) ||
    !greeting.supportedProtocolVersions.includes(2)
  ) {
    return yield* new OmpRpcError({
      operation: "negotiate",
      detail: "OMP 18.8.5 or newer with RPC v2 support is required.",
    });
  }
  yield* request({ type: "negotiate_protocol", protocolVersion: 2 });
  return {
    send,
    request,
    events,
    terminate: fail(new OmpRpcError({ operation: "terminate", detail: "OMP has stopped." })).pipe(
      Effect.andThen(terminate),
      Effect.ignore,
    ),
  } satisfies OmpRpcConnection;
});
