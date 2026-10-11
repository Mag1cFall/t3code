import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ThreadId, type ProviderReplayTranscript } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as Orchestrator from "../Orchestrator.ts";
import { runOrchestratorV2Scenario } from "./OrchestratorScenario.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import {
  makeOmpRestartReplayHarness,
  OmpOrchestratorReplayHarness,
  OMP_BACKGROUND_REPLAY_GATE,
} from "../Adapters/OmpAdapterV2.testkit.ts";
import { materializeFixtureInput } from "./fixtures/shared.ts";
import {
  runOrchestratorV2ProviderReplayScenario,
  layerProviderReplay,
  type OrchestratorV2ProviderReplayHarness,
  type OrchestratorV2ProviderReplayScenario,
} from "./ProviderReplayHarness.ts";

// materializeOmpFixture 为原生分叉和紧邻停止保留共享命令生成规则
export const materializeOmpFixture = (input: Parameters<typeof materializeFixtureInput>[0]) =>
  Effect.gen(function* () {
    const materialized = yield* materializeFixtureInput(input);
    const steps = [...materialized.steps];
    if (input.scenario === "omp_default_restart") {
      let messages = 0;
      for (let index = 0; index < steps.length; index++) {
        const step = steps[index]!;
        if (
          step.type === "dispatch" &&
          step.command.type === "message.dispatch" &&
          ++messages === 2
        ) {
          steps[index] = {
            ...step,
            command: {
              ...step.command,
              modelSelection: {
                instanceId: input.modelSelection.instanceId,
                model: "openai-codex/gpt-5.6-luna",
                options: [{ id: "thinking", value: "low" }],
              },
            },
          };
        }
      }
    }
    if (input.scenario === "omp_background_exit")
      steps.push({
        type: "await_no_background_work",
        threadId: materialized.projectionThreadIds[0]!,
      });
    if (input.scenario === "omp_steer_then_stop") {
      const steer = steps.findIndex(
        (step) =>
          step.type === "dispatch" &&
          step.command.type === "message.dispatch" &&
          step.command.dispatchMode.type === "steer_active",
      );
      const interrupt = steps.findIndex(
        (step) => step.type === "dispatch" && step.command.type === "run.interrupt",
      );
      for (let index = interrupt - 1; index > steer; index--) {
        if (
          steps[index]?.type === "await_thread_idle" ||
          steps[index]?.type === "await" ||
          steps[index]?.type === "advance_clock"
        )
          steps.splice(index, 1);
      }
    }
    if (!input.scenario.startsWith("thread_fork_native"))
      return {
        ...materialized,
        steps,
        commands: steps.flatMap((step) => (step.type === "dispatch" ? [step.command] : [])),
      };
    const ids = yield* IdAllocator.IdAllocatorV2;
    const sourceThreadId = materialized.projectionThreadIds[0]!;
    const targetThreadId = ThreadId.make(`${sourceThreadId}:fork`);
    const prior = input.scenario === "thread_fork_native_prior_turn";
    let idleCount = 0;
    const split =
      steps.findIndex(
        (step) => step.type === "await_thread_idle" && ++idleCount === (prior ? 2 : 1),
      ) + 1;
    const following = steps.slice(split).map((step) => {
      if (step.type === "dispatch" && step.command.type === "message.dispatch")
        return { ...step, command: { ...step.command, threadId: targetThreadId } };
      if (step.type === "await_thread_idle") return { ...step, threadId: targetThreadId };
      return step;
    });
    const fork = {
      type: "dispatch" as const,
      command: {
        type: "thread.fork" as const,
        commandId: CommandId.make(`${input.scenario}:fork`),
        sourceThreadId,
        targetThreadId,
        sourcePoint: {
          type: "run" as const,
          runId: ids.derive.run({ threadId: sourceThreadId, ordinal: 1 }),
        },
        createdBy: "user" as const,
        creationSource: "web" as const,
      },
    };
    const forkSteps = [...steps.slice(0, split), fork, ...following];
    return {
      commands: forkSteps.flatMap((step) => (step.type === "dispatch" ? [step.command] : [])),
      steps: forkSteps,
      projectionThreadIds: [sourceThreadId, targetThreadId],
    };
  });

// runOmpReplayScenario 通过关闭外层编排作用域和重开同一数据库验证真实重启
export function runOmpReplayScenario<T extends ProviderReplayTranscript, E>(
  scenario: OrchestratorV2ProviderReplayScenario<T>,
  harness: OrchestratorV2ProviderReplayHarness<T, E>,
  options: {
    readonly runContinuationWorker?: boolean;
    readonly onParentCompleted?: Effect.Effect<void, PlatformError.PlatformError>;
  } = {},
) {
  if (
    scenario.transcript.scenario === "omp_background_subagent" &&
    scenario.transcript.entries.length === 0
  ) {
    scenario = {
      ...scenario,
      steps: scenario.steps!.filter((step) => step.type !== "release_replay_gate"),
    };
  }
  if (
    scenario.transcript.scenario === "omp_background_subagent" &&
    scenario.transcript.entries.length > 0
  ) {
    let yielded = false;
    let boundary = -1;
    for (const [index, entry] of scenario.transcript.entries.entries()) {
      if (entry.type !== "emit_inbound" || typeof entry.frame !== "object" || entry.frame === null)
        continue;
      const frame = entry.frame as Record<string, unknown>;
      if (frame.type === "prompt_result" && frame.sessionSettled === false) yielded = true;
      if (yielded && frame.command === "get_entries") {
        boundary = index + 1;
        break;
      }
    }
    scenario = {
      ...scenario,
      transcript: {
        ...scenario.transcript,
        entries: scenario.transcript.entries.map((entry, index) =>
          index === boundary && entry.type === "emit_inbound"
            ? { ...entry, label: OMP_BACKGROUND_REPLAY_GATE }
            : entry,
        ),
      },
    };
  }
  if (
    scenario.transcript.scenario === "omp_subagent_stop" ||
    scenario.transcript.scenario === "omp_background_exit"
  ) {
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = scenario.projectionThreadIds![0]!;
      if (scenario.transcript.scenario === "omp_background_exit") {
        const onParentCompleted = options.onParentCompleted;
        if (onParentCompleted !== undefined) {
          yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "run.updated" &&
                event.threadId === threadId &&
                event.payload.status === "completed",
            ),
            Stream.take(1),
            Stream.runForEach(() => onParentCompleted),
            Effect.forkScoped,
          );
        }
        return yield* runOrchestratorV2Scenario(scenario);
      }
      let stopped = false;
      yield* orchestrator.streamDomainEvents.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (stopped || event.type !== "subagent.updated") return;
            const projection = yield* orchestrator.getThreadProjection(threadId);
            const running = projection.subagents.filter((child) => child.status === "running");
            if (running.length !== 2) return;
            const child = running.find((entry) => entry.nativeTaskRef?.nativeId === "StopMe");
            if (child?.runId === null || child === undefined) return;
            stopped = true;
            yield* orchestrator.dispatch({
              type: "subagent.stop",
              commandId: CommandId.make("omp:stop-one-child"),
              threadId,
              runId: child.runId,
              subagentId: child.id,
            });
          }),
        ),
        Effect.forkScoped,
      );
      return yield* runOrchestratorV2Scenario(scenario);
    }).pipe(Effect.provide(layerProviderReplay(scenario, harness, options)));
  }
  const restart = [
    "multi_turn_restart",
    "thread_rollback_after_restart",
    "omp_default_restart",
  ].includes(scenario.transcript.scenario);
  if (!restart) return runOrchestratorV2ProviderReplayScenario(scenario, harness, options);
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const databaseDir = yield* fs.makeTempDirectoryScoped({ prefix: "omp-replay-restart-" });
    const databaseLayer = SqlitePersistence.layerFromPath(
      path.join(databaseDir, "state.sqlite"),
    ).pipe(Layer.provide(NodeServices.layer));
    const steps = scenario.steps ?? [];
    const idleTarget = scenario.transcript.scenario === "multi_turn_restart" ? 1 : 2;
    let idleCount = 0;
    const split =
      steps.findIndex((step) => step.type === "await_thread_idle" && ++idleCount === idleTarget) +
      1;
    const phase1 = steps.slice(0, split);
    const phase2 = steps
      .slice(split)
      .filter((step) => !(step.type === "advance_clock" && step.duration === "31 minutes"));
    const runPhases = <U extends ProviderReplayTranscript, F>(
      selected: OrchestratorV2ProviderReplayHarness<U, F>,
      transcript: U,
    ) =>
      Effect.gen(function* () {
        yield* runOrchestratorV2ProviderReplayScenario(
          {
            ...scenario,
            transcript,
            steps: phase1,
            commands: phase1.flatMap((step) => (step.type === "dispatch" ? [step.command] : [])),
          },
          selected,
          { ...options, databaseLayer },
        ).pipe(Effect.scoped);
        const second = yield* runOrchestratorV2ProviderReplayScenario(
          {
            ...scenario,
            transcript,
            steps: phase2,
            commands: phase2.flatMap((step) => (step.type === "dispatch" ? [step.command] : [])),
          },
          selected,
          { ...options, databaseLayer, recoverOnStartup: true },
        ).pipe(Effect.scoped);
        return { ...second, domainEvents: second.storedEvents.map((event) => event.event) };
      });
    if (scenario.transcript.entries.length === 0)
      return yield* runPhases(harness, scenario.transcript);
    const transcript = yield* OmpOrchestratorReplayHarness.decodeTranscript(scenario.transcript);
    return yield* runPhases(yield* makeOmpRestartReplayHarness(transcript), transcript);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
}
