import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProviderReplayEntry, ProviderReplayTranscript } from "@t3tools/contracts";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";
import * as Console from "effect/Console";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { OMP_PROVIDER } from "@t3tools/provider-omp/server";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import {
  makeOmpRecordingSpawner,
  mapOmpReplayFrames,
  OMP_RPC_REPLAY_PROTOCOL,
  OmpOrchestratorReplayHarness,
  layer as ompLayer,
} from "../src/orchestration-v2/Adapters/OmpAdapterV2.testkit.ts";
import { provideDeterministicTestRuntime } from "../src/orchestration-v2/testkit/DeterministicRuntime.ts";
import { OMP_REPLAY_FIXTURES } from "../src/orchestration-v2/testkit/fixtures/omp.ts";
import {
  materializeOmpFixture,
  runOmpReplayScenario,
} from "../src/orchestration-v2/testkit/OmpReplayScenario.testkit.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

const HERMETIC_ARGS = ["--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-title"];
const CLOCK_TICK = Duration.millis(20);
const root = NodeURL.fileURLToPath(new URL("../../../.t3/omp-recordings/", import.meta.url));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

class OmpFixtureRecordingError extends Schema.TaggedError<OmpFixtureRecordingError>()(
  "OmpFixtureRecordingError",
  { message: Schema.String },
) {}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// normalizeEntries 同时脱敏普通行及 JSONL v2 分块中的逻辑消息
function normalizeEntries(
  entries: ReadonlyArray<ProviderReplayEntry>,
  workspace: string,
  model: string,
) {
  const sessions = new Map<string, string>();
  const sessionPath = /(?:[A-Za-z]:[\\/]|\/)[^\s"<>]*?\.jsonl/gu;
  const replacements = [
    [workspace, "<workspace>"],
    [root, "<recording>"],
    [process.env.TEMP ?? "\0", "/replay-temp"],
    [NodeOS.homedir(), "<home>"],
    [NodeURL.fileURLToPath(new URL("../../../", import.meta.url)), "<repository>/"],
  ] as const;
  const normalizeString = (input: string) => {
    let text = input.replace(sessionPath, (file) => {
      const key = file.replaceAll("\\", "/");
      const existing = sessions.get(key);
      if (existing !== undefined) return existing;
      const next = `/omp-sessions/session-${sessions.size + 1}.jsonl`;
      sessions.set(key, next);
      return next;
    });
    for (const [source, replacement] of replacements) {
      text = text
        .replaceAll(source, replacement)
        .replaceAll(source.replaceAll("\\", "/"), replacement)
        .replaceAll(source.replaceAll("\\", "\\\\"), replacement);
    }
    let encodingDepth = 0;
    for (const match of text.matchAll(/%(?:25)*/gu))
      encodingDepth = Math.max(encodingDepth, (match[0].length + 1) / 2);
    for (const [file, replacement] of sessions) {
      for (const source of [file, file.replaceAll("/", "\\")]) {
        let encodedSource = source;
        let encodedReplacement = replacement;
        for (let depth = 0; depth < encodingDepth; depth++) {
          encodedSource = encodeURIComponent(encodedSource);
          encodedReplacement = encodeURIComponent(encodedReplacement);
          text = text.replaceAll(encodedSource, encodedReplacement);
        }
      }
    }
    return text;
  };
  const normalize = (value: unknown): unknown => {
    if (typeof value === "string") return normalizeString(value);
    if (Array.isArray(value)) return value.map(normalize);
    if (!isRecord(value)) return value;
    if (value.role === "system" && isRecord(value.sections)) {
      return {
        ...value,
        sections: Object.fromEntries(
          Object.keys(value.sections).map((key) => [key, "<system-prompt-section>"]),
        ),
      };
    }
    if (
      value.command === "get_available_models" &&
      isRecord(value.data) &&
      Array.isArray(value.data.models)
    ) {
      return normalize({
        ...value,
        command: "get_available_models:normalized",
        data: {
          ...value.data,
          models: value.data.models.filter(
            (item) =>
              isRecord(item) &&
              (model === "default"
                ? item.provider === "openai-codex" &&
                  (item.id === "gpt-5.6-sol" || item.id === "gpt-5.6-luna")
                : `${item.provider}/${item.id}` === model),
          ),
        },
      });
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === "command" && item === "get_available_models:normalized"
          ? "get_available_models"
          : /^(?:systemPrompt|appendSystemPrompt|systemPromptTemplate|thinkingSignature|textSignature|encrypted_content|accountAccess|credentialId|apiKey|accessToken|refreshToken|authorization)$/iu.test(
                key,
              )
            ? "<redacted>"
            : normalize(item),
      ]),
    );
  };
  return mapOmpReplayFrames(entries, normalize);
}

function encodeTranscript(transcript: ProviderReplayTranscript): string {
  const { entries, ...metadata } = transcript;
  return [
    encodeJson({ type: "transcript_start", ...metadata }),
    ...entries.map((entry) => encodeJson(entry)),
    "",
  ].join("\n");
}

const followWallClock = Effect.gen(function* () {
  while (true) {
    yield* TestClock.withLive(Effect.sleep(CLOCK_TICK));
    yield* TestClock.adjust(CLOCK_TICK);
  }
});

const selected = argument("--scenario")?.split(",") ?? [];
const fixtures = OMP_REPLAY_FIXTURES.filter((fixture) => selected.includes(fixture.name));
if (fixtures.length !== selected.length || fixtures.length === 0) {
  throw new Error(
    `Pass --scenario with one or more comma-separated OMP fixtures: ${OMP_REPLAY_FIXTURES.map((fixture) => fixture.name).join(", ")}`,
  );
}
const binary = process.env.T3_OMP_BIN ?? "omp";

const record = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const live = yield* ChildProcessSpawner.ChildProcessSpawner;
  const version = (yield* live.string(
    ChildProcess.make(binary, ["--version"], { shell: (yield* HostProcess.Platform) === "win32" }),
  )).trim();
  yield* fs.makeDirectory(root, { recursive: true });
  const home = yield* fs.makeTempDirectoryScoped({ directory: root, prefix: "home-" });
  const agentDir = path.join(home, ".omp", "agent");
  yield* fs.makeDirectory(agentDir, { recursive: true });
  const source =
    argument("--credentials") ?? path.join(NodeOS.homedir(), ".omp", "agent", "agent.db");
  yield* Effect.sync(() => {
    const database = new NodeSqlite.DatabaseSync(source, { readOnly: true });
    const target = new NodeSqlite.DatabaseSync(path.join(agentDir, "agent.db"));
    try {
      const tables = database
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name LIKE 'auth_%'")
        .all();
      for (const table of tables) {
        target.exec(String(table.sql));
        const rows = database.prepare(`SELECT * FROM "${String(table.name)}"`).all();
        for (const row of rows) {
          const columns = Object.keys(row);
          target
            .prepare(
              `INSERT INTO "${String(table.name)}" (${columns.map((column) => `"${column}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
            )
            .run(...Object.values(row));
        }
      }
    } finally {
      target.close();
      database.close();
    }
  });
  const nativeSettings = [
    "modelRoles:",
    "  default: openai-codex/gpt-5.6-sol",
    "disabledExtensions: [claude, claude-md, agents, agents-md, codex, gemini, github, opencode, cursor, windsurf, cline, vscode, mcp-json, agent-plugins, claude-plugins, skillshare, ssh-json]",
    "skills:",
    "  enabled: false",
    "compaction:",
    "  keepRecentTokens: 50",
    "",
  ].join("\n");
  const environment = [
    { name: "HOME", value: home, sensitive: false },
    { name: "USERPROFILE", value: home, sensitive: false },
    { name: "PI_CODING_AGENT_DIR", value: agentDir, sensitive: false },
    { name: "OMP_PROFILE", value: "", sensitive: false },
    { name: "PI_PROFILE", value: "", sensitive: false },
    { name: "PI_CONFIG_FILES", value: "", sensitive: false },
    { name: "OMP_DAEMON_IDLE_GRACE_MS", value: "0", sensitive: false },
  ];
  const isolatedEnvironment: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(?:path|pathext|systemroot|windir|comspec|temp|tmp|tmpdir|number_of_processors|processor_architecture)$/iu.test(
        key,
      ),
    ),
  );
  for (const variable of environment) isolatedEnvironment[variable.name] = variable.value;
  isolatedEnvironment.APPDATA = path.join(home, "AppData", "Roaming");
  isolatedEnvironment.LOCALAPPDATA = path.join(home, "AppData", "Local");
  const failures: string[] = [];
  for (const fixture of fixtures) {
    yield* Effect.gen(function* () {
      const nested = fixture.name === "subagent_v2_nested";
      yield* fs.writeFileString(
        path.join(agentDir, "config.yml"),
        nativeSettings + (nested ? "task:\n  maxRecursionDepth: 3\n" : ""),
      );
      const variant = fixture.providers[0]!;
      const input = fixture.buildInput();
      const workspace = yield* checkpointWorkspace(
        `omp-record-${fixture.name}`,
        input.workspaceFiles,
      );
      const host = Layer.succeedContext(
        yield* Layer.build(TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer))),
      );
      const entries: ProviderReplayEntry[] = [];
      const processIds: number[] = [];
      const placeholder: ProviderReplayTranscript = {
        provider: OMP_PROVIDER,
        protocol: OMP_RPC_REPLAY_PROTOCOL,
        version,
        scenario: fixture.name,
        entries: [],
      };
      const capturedAt = DateTime.formatIso(yield* DateTime.now);
      const result = yield* Effect.gen(function* () {
        yield* followWallClock.pipe(Effect.forkScoped);
        const materialized = yield* materializeOmpFixture({
          scenario: fixture.name,
          fixtureInput: input,
          driver: OMP_PROVIDER,
          modelSelection: variant.modelSelection,
        }).pipe(Effect.provide(IdAllocator.layer));
        let killed = false;
        let recordedProcess!: ChildProcessSpawner.ChildProcessHandle;
        const terminateRecordedProcess = Effect.gen(function* () {
          if ((yield* HostProcess.Platform) === "win32") {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const killer = yield* live.spawn(
                  ChildProcess.make("taskkill", ["/PID", String(recordedProcess.pid), "/T", "/F"]),
                );
                yield* killer.exitCode;
              }),
            );
          } else {
            yield* recordedProcess.kill({ killSignal: "SIGKILL" });
          }
        });
        const recordingSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          makeOmpRecordingSpawner(live, entries, {
            launchArgs: HERMETIC_ARGS,
            environment: isolatedEnvironment,
            processIds,
            onFrame: (frame, handle) =>
              Effect.gen(function* () {
                recordedProcess = handle;
                if (
                  fixture.name !== "omp_process_exit" ||
                  killed ||
                  !isRecord(frame) ||
                  frame.type !== "tool_execution_start"
                )
                  return;
                killed = true;
                yield* terminateRecordedProcess;
              }),
          }),
        );
        const projection = yield* runOmpReplayScenario(
          {
            name: `${fixture.name}/omp:record`,
            transcript: placeholder,
            commands: materialized.commands,
            steps: materialized.steps,
            projectionThreadIds: materialized.projectionThreadIds,
            waitDeadlineMs: 180_000,
            runtimePolicyOverride: { ...variant.runtimePolicyOverride, cwd: workspace },
          },
          {
            driver: OMP_PROVIDER,
            decodeTranscript: Effect.succeed,
            makeProviderAdapterRegistryLayer: () =>
              ompLayer({
                scenario: fixture.name,
                binaryPath: binary,
                environment,
                host,
                spawner: recordingSpawner,
              }),
          },
          {
            ...(variant.runContinuationWorker === true ? { runContinuationWorker: true } : {}),
            ...(fixture.name === "omp_background_exit"
              ? { onParentCompleted: terminateRecordedProcess }
              : {}),
          },
        );
        yield* fs.writeFileString(
          path.join(root, `${fixture.name}.projection.json`),
          encodeJson({
            projections: [...projection.projections.values()],
            domainEvents: projection.domainEvents,
          }),
        );
        for (const relativePath of variant.expectedAbsentWorkspacePaths ?? []) {
          if (yield* fs.exists(path.join(workspace, relativePath))) {
            return yield* new OmpFixtureRecordingError({
              message: `Denied write created ${relativePath}.`,
            });
          }
        }
        return { projection, workspace };
      }).pipe(Effect.scoped, provideDeterministicTestRuntime, Effect.exit);
      yield* fs.writeFileString(
        path.join(root, `${fixture.name}.raw.ndjson`),
        encodeTranscript({
          ...placeholder,
          metadata: { capturedAt, source: "real-omp-stdio", processIds },
          entries,
        }),
      );
      if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
      const transcript: ProviderReplayTranscript = {
        ...placeholder,
        metadata: {
          generatedBy: "live-omp-recorder",
          capturedAt,
          model: variant.modelSelection.model,
          cwdPolicy: "isolated-git-workspace",
          isolation: "dedicated-home-and-read-only-credential-snapshot",
          launchArgs: HERMETIC_ARGS,
          nativeEnvironment: { OMP_DAEMON_IDLE_GRACE_MS: "0" },
          ...(nested ? { nativeSettings: { task: { maxRecursionDepth: 3 } } } : {}),
        },
        entries: normalizeEntries(entries, result.value.workspace, variant.modelSelection.model),
      };
      yield* fs.writeFileString(
        path.join(root, `${fixture.name}.normalized.ndjson`),
        encodeTranscript(transcript),
      );
      yield* Effect.gen(function* () {
        const workspace = yield* checkpointWorkspace(
          `omp-replay-${fixture.name}`,
          input.workspaceFiles,
        );
        const materialized = yield* materializeOmpFixture({
          scenario: fixture.name,
          fixtureInput: input,
          driver: OMP_PROVIDER,
          modelSelection: variant.modelSelection,
        }).pipe(Effect.provide(IdAllocator.layer));
        const replay = yield* runOmpReplayScenario(
          {
            name: `${fixture.name}/omp:verify`,
            transcript: yield* OmpOrchestratorReplayHarness.decodeTranscript(transcript),
            commands: materialized.commands,
            steps: materialized.steps,
            projectionThreadIds: materialized.projectionThreadIds,
            runtimePolicyOverride: { ...variant.runtimePolicyOverride, cwd: workspace },
          },
          OmpOrchestratorReplayHarness,
          variant.runContinuationWorker === true ? { runContinuationWorker: true } : {},
        );
        variant.assertOutput(replay, transcript);
      }).pipe(Effect.scoped, provideDeterministicTestRuntime);
      const output = argument("--out") ?? NodeURL.fileURLToPath(variant.transcriptFile);
      yield* fs.makeDirectory(path.dirname(output), { recursive: true });
      yield* fs.writeFileString(output, encodeTranscript(transcript));
      yield* Console.log(`Recorded and replayed ${fixture.name}: ${entries.length} stdio records`);
    }).pipe(
      Effect.scoped,
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          failures.push(fixture.name);
          yield* Console.error(`${fixture.name}: ${Cause.pretty(cause)}`);
        }),
      ),
    );
  }
  if (failures.length > 0)
    return yield* new OmpFixtureRecordingError({
      message: `OMP fixtures failed: ${failures.join(", ")}`,
    });
});

await Effect.runPromise(record.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
