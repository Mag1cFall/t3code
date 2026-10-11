import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";
import { OmpOrchestratorReplayHarness } from "../Adapters/OmpAdapterV2.testkit.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { OMP_REPLAY_FIXTURES } from "./fixtures/omp.ts";
import { assertProviderNativeSubagentRootTurns } from "./fixtures/shared.ts";
import { materializeOmpFixture, runOmpReplayScenario } from "./OmpReplayScenario.testkit.ts";

describe("OMP native RPC orchestration replay", () => {
  it.effect.each(OMP_REPLAY_FIXTURES.map((fixture) => [fixture.name, fixture] as const))(
    "%s preserves shared run, node, turn, checkpoint and terminal semantics",
    ([, fixture]) =>
      Effect.gen(function* () {
        const variant = fixture.providers[0]!;
        const transcript = yield* OmpOrchestratorReplayHarness.decodeTranscript(
          yield* readProviderReplayTranscript(variant.transcriptFile),
        );
        const input = fixture.buildInput();
        const workspace = yield* checkpointWorkspace(`omp-${fixture.name}`, input.workspaceFiles);
        const materialized = yield* materializeOmpFixture({
          scenario: fixture.name,
          fixtureInput: input,
          driver: variant.driver,
          modelSelection: variant.modelSelection,
        }).pipe(Effect.provide(IdAllocator.layer));
        const result = yield* runOmpReplayScenario(
          {
            name: `${fixture.name}/omp`,
            transcript,
            commands: materialized.commands,
            steps: materialized.steps,
            projectionThreadIds: materialized.projectionThreadIds,
            runtimePolicyOverride: { ...variant.runtimePolicyOverride, cwd: workspace },
          },
          OmpOrchestratorReplayHarness,
          variant.runContinuationWorker === true ? { runContinuationWorker: true } : {},
        );
        variant.assertOutput(result, transcript);
        assertProviderNativeSubagentRootTurns(result);
        for (const projection of result.projections.values()) {
          for (const run of projection.runs) {
            assert.notEqual(run.status, "running");
            assert.notEqual(run.status, "queued");
            assert.isTrue(projection.nodes.some((node) => node.id === run.rootNodeId));
            if (run.status === "completed") {
              assert.isTrue(
                projection.checkpoints.some(
                  (checkpoint) => checkpoint.runId === run.id && checkpoint.status === "ready",
                ),
              );
            }
          }
          assert.isFalse(
            projection.runtimeRequests.some((request) => request.status === "pending"),
          );
          assert.isFalse(projection.nodes.some((node) => isOrchestrationV2WorkActive(node.status)));
          assert.isFalse(
            projection.providerTurns.some((turn) => isOrchestrationV2WorkActive(turn.status)),
          );
        }
      }).pipe(Effect.scoped, provideDeterministicTestRuntime, Effect.provide(NodeServices.layer)),
  );
});
