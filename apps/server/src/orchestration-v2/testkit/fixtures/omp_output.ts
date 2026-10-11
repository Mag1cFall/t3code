import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";
import type { OrchestratorV2ScenarioResult } from "../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessageInputIntents,
  assertUserMessagesInclude,
  assertVisibleUserMessagesExclude,
  assertVisibleUserMessagesInclude,
  MESSAGE_STEERING_INITIAL_PROMPT,
  MESSAGE_STEERING_STEER_PROMPT,
  THREAD_ROLLBACK_AFTER_PROMPT,
  THREAD_ROLLBACK_FIRST_PROMPT,
  THREAD_ROLLBACK_SECOND_PROMPT,
  TURN_INTERRUPT_MID_TOOL_PROMPT,
  TURN_INTERRUPT_PROMPT,
  projectionFor,
} from "./shared.ts";

export function assertOmpSteeringOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertTurnItemTypes(projection, ["user_message", "assistant_message"]);
  assertUserMessagesInclude(projection, [
    MESSAGE_STEERING_INITIAL_PROMPT,
    MESSAGE_STEERING_STEER_PROMPT,
  ]);
  assertUserMessageInputIntents(projection, ["turn_start", "steer"]);
  assertAssistantTextIncludes(projection, "steering fixture observed");
  assert.lengthOf(projection.providerTurns, 1);
}

export function assertOmpInterruptOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["interrupted"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertTurnItemTypes(projection, [
    "user_message",
    "run_interrupt_request",
    "run_interrupt_result",
  ]);
  const midTool = transcript.scenario === "turn_interrupt_mid_tool";
  assertUserMessagesInclude(projection, [
    midTool ? TURN_INTERRUPT_MID_TOOL_PROMPT : TURN_INTERRUPT_PROMPT,
  ]);
  const request = projection.turnItems.find((item) => item.type === "run_interrupt_request");
  const response = projection.turnItems.find((item) => item.type === "run_interrupt_result");
  assert.equal(request?.status, "completed");
  assert.equal(response?.status, "interrupted");
  assert.equal(response?.parentItemId, request?.id);
  assert.deepEqual(
    projection.attempts.map((attempt) => attempt.status),
    ["interrupted"],
  );
  assert.equal(projection.providerTurns[0]?.status, "interrupted");
  if (midTool) {
    const command = projection.turnItems.find((item) => item.type === "command_execution");
    assert.isDefined(command);
    assert.equal(command.status, "interrupted");
    assert.include(command.input, "node -e");
  }
}

export function assertOmpRollbackOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const stopped = transcript.scenario === "thread_rollback_after_stop";
  assertBaseProjection({
    result,
    transcript,
    runCount: stopped ? 4 : 3,
    runStatuses: stopped
      ? ["completed", "rolled_back", "rolled_back", "completed"]
      : ["completed", "rolled_back", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleUserMessagesInclude(projection, [
    THREAD_ROLLBACK_FIRST_PROMPT,
    THREAD_ROLLBACK_AFTER_PROMPT,
  ]);
  assertVisibleUserMessagesExclude(projection, [
    THREAD_ROLLBACK_SECOND_PROMPT,
    ...(stopped ? [TURN_INTERRUPT_MID_TOOL_PROMPT] : []),
  ]);
  const recall = projection.turnItems.findLast((item) => item.type === "assistant_message");
  assert.include(recall?.type === "assistant_message" ? recall.text : "", "first turn complete");
  assert.notInclude(recall?.type === "assistant_message" ? recall.text : "", "second turn");
  assert.isAtLeast(projection.checkpoints.length, 2);
  assert.isTrue(
    projection.providerTurns.every((turn) => turn.nativeTurnRef?.strength === "strong"),
  );
}

export function assertOmpApprovalOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assert.isAtLeast(projection.runtimeRequests.length, 1);
  assert.isTrue(projection.runtimeRequests.every((request) => request.status !== "pending"));
  assertTurnItemTypes(projection, ["user_message", "approval_request"]);
  const denied = transcript.scenario === "tool_call_denied_write";
  assert.isTrue(
    projection.runtimeRequests.some(
      (request) => request.decision === (denied ? "decline" : "accept"),
    ),
  );
  const tools = projection.turnItems.filter(
    (item) => item.type === "file_change" || item.type === "command_execution",
  );
  assert.isAtLeast(tools.length, 1);
  assert.isTrue(tools.every((item) => item.status !== "running"));
}

export function assertOmpQuestionOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const cancelled = transcript.scenario === "omp_questions_cancel";
  assertBaseProjection({
    result,
    transcript,
    runCount: 1,
    runStatuses: [cancelled ? "interrupted" : "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertTurnItemTypes(projection, ["user_message", "user_input_request"]);
  const request = projection.turnItems.find((item) => item.type === "user_input_request");
  assert.isDefined(request);
  assert.deepEqual(
    request.questions.map((question) => question.id),
    ["color", "letters", "note"],
  );
  assert.isTrue(projection.runtimeRequests.every((entry) => entry.status !== "pending"));
  if (cancelled) {
    assert.isTrue(
      projection.runtimeRequests.every(
        (entry) => entry.status === "resolved" && entry.decision === "decline",
      ),
    );
    assert.isTrue(projection.providerTurns.every((turn) => turn.status === "interrupted"));
  } else {
    assertAssistantTextIncludes(projection, "questions fixture complete");
  }
}

export function assertOmpTodoOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertTurnItemTypes(projection, ["user_message", "todo_list", "assistant_message"]);
  const plans = projection.plans.filter((plan) => plan.kind === "todo_list");
  assert.isAtLeast(plans.length, 1);
  assert.deepEqual(
    plans.at(-1)?.steps.map((step) => step.status),
    ["completed", "completed", "completed"],
  );
  assertAssistantTextIncludes(projection, "todo list fixture complete");
}

export function assertOmpCompactionOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 4,
    runStatuses: ["completed", "completed", "completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  const items = projection.turnItems.filter((item) => item.type === "compaction");
  assert.lengthOf(items, 1);
  assert.equal(items[0]?.status, "completed");
  assert.isNotEmpty(items[0]?.summary ?? "");
  assert.equal(items[0]?.runId, projection.runs[2]?.id);
  assertAssistantTextIncludes(projection, "PAPAYA");
}

export function assertOmpCommandOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, ["/session info"]);
  assert.isFalse(projection.turnItems.some((item) => item.type === "assistant_message"));
  assert.isFalse(
    transcript.entries.some(
      (entry) =>
        entry.type === "emit_inbound" &&
        typeof entry.frame === "object" &&
        entry.frame !== null &&
        "type" in entry.frame &&
        entry.frame.type === "agent_start",
    ),
  );
  const outputs = transcript.entries.flatMap((entry) => {
    if (entry.type !== "emit_inbound" || typeof entry.frame !== "object" || entry.frame === null)
      return [];
    const frame = entry.frame as Record<string, unknown>;
    return frame.type === "command_output" && typeof frame.text === "string" ? [frame.text] : [];
  });
  assert.isNotEmpty(outputs);
  for (const output of outputs) {
    assert.isTrue(
      projection.turnItems.some(
        (item) =>
          item.type === "system_notice" && item.message === output && item.status === "completed",
      ),
    );
  }
}

export function assertOmpSteerStopOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["interrupted"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  const messages = projection.turnItems.filter((item) => item.type === "user_message");
  assert.lengthOf(messages, 2);
  assert.deepEqual(
    messages.map((message) => message.inputIntent),
    ["turn_start", "steer"],
  );
  assert.isTrue(messages.every((message) => message.runId === projection.runs[0]?.id));
  assert.equal(messages[1]?.text, MESSAGE_STEERING_STEER_PROMPT);
  assert.equal(new Set(messages.map((message) => message.messageId)).size, 2);
  assert.equal(projection.providerTurns[0]?.status, "interrupted");
}

export function assertOmpExitOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["failed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertTurnItemTypes(projection, ["user_message", "command_execution", "error"]);
  assert.isTrue(projection.nodes.every((node) => node.status !== "running"));
  assert.isTrue(projection.providerTurns.every((turn) => turn.status === "failed"));
  assert.isTrue(
    transcript.entries.some((entry) => entry.type === "runtime_exit" && entry.status === "error"),
  );
}

export function assertOmpSubagentOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const background = transcript.scenario === "omp_background_subagent";
  const stopping = transcript.scenario === "omp_subagent_stop";
  assertBaseProjection({
    result,
    transcript,
    runCount: background ? 2 : 1,
    runStatuses: background ? ["completed", "completed"] : ["completed"],
  });
  const root = projectionFor(result, transcript.scenario);
  const count = transcript.scenario === "subagent_v2_nested" ? 3 : stopping ? 2 : 1;
  const all = [...result.projections.values()];
  assert.lengthOf(all, count + 1);
  const children = all.filter(
    (projection) => projection.thread.lineage.relationshipToParent === "subagent",
  );
  assert.lengthOf(children, count);
  if (transcript.scenario === "subagent_v2_approval") {
    assert.lengthOf(root.runtimeRequests, 1);
    assert.equal(root.runtimeRequests[0]?.decision, "accept");
    assert.isTrue(children.every((child) => child.runtimeRequests.length === 0));
  }
  for (const projection of all) {
    assertSemanticProjectionIntegrity(projection);
    for (const child of projection.subagents) {
      assert.equal(child.origin, "provider_native");
      assert.equal(child.driver, "omp");
      assert.isNotNull(child.childThreadId);
      assert.isNotNull(child.nativeTaskRef);
      const childProjection = result.projections.get(child.childThreadId!);
      assert.isDefined(childProjection);
      assert.equal(childProjection.thread.lineage.parentThreadId, projection.thread.id);
      assert.lengthOf(childProjection.runs, 0);
      assert.isAtLeast(childProjection.providerTurns.length, 1);
      assert.isTrue(
        childProjection.providerTurns.every((turn) =>
          ["completed", "interrupted"].includes(turn.status),
        ),
      );
      assert.equal(
        projection.turnItems.filter(
          (item) => item.type === "subagent" && item.subagentId === child.id,
        ).length,
        1,
      );
    }
  }
  const subagents = all.flatMap((projection) => projection.subagents);
  if (stopping) {
    assert.deepEqual(subagents.map((child) => child.status).toSorted(), [
      "completed",
      "interrupted",
    ]);
    assert.isTrue(
      subagents.some(
        (child) => child.status === "completed" && child.result?.includes("SIBLING_OK"),
      ),
    );
  } else {
    assert.isTrue(subagents.every((child) => child.status === "completed"));
    assert.isTrue(subagents.every((child) => (child.result?.length ?? 0) > 0));
  }
  if (background) {
    const rootEnd = result.domainEvents.findIndex(
      (event) =>
        event.type === "run.updated" &&
        event.runId === root.runs[0]?.id &&
        event.payload.status === "completed",
    );
    const childEnd = result.domainEvents.findIndex(
      (event) => event.type === "subagent.updated" && event.payload.status === "completed",
    );
    assert.isAbove(childEnd, rootEnd);
    assertAssistantTextIncludes(root, "PARENT_OK");
  }
}

export function assertOmpForkOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const root = projectionFor(result, transcript.scenario);
  const fork = [...result.projections.values()].find(
    (projection) => projection.thread.lineage.relationshipToParent === "fork",
  );
  assert.isDefined(fork);
  assertSemanticProjectionIntegrity(root);
  assertSemanticProjectionIntegrity(fork);
  assert.isTrue(root.runs.every((run) => run.status === "completed"));
  assert.isTrue(fork.runs.every((run) => run.status === "completed"));
  assert.isAtLeast(fork.checkpoints.length, 1);
  assert.isNotNull(fork.providerThreads[0]?.forkedFrom);
  assert.notEqual(
    fork.providerThreads[0]?.nativeThreadRef?.nativeId,
    root.providerThreads[0]?.nativeThreadRef?.nativeId,
  );
  assert.isTrue(fork.providerTurns.every((turn) => turn.nativeTurnRef?.strength === "strong"));
  if (transcript.scenario === "thread_fork_native_prior_turn") {
    const recall = fork.turnItems.findLast((item) => item.type === "assistant_message");
    assert.include(recall?.type === "assistant_message" ? recall.text : "", "fork boundary alpha");
    assert.notInclude(
      recall?.type === "assistant_message" ? recall.text : "",
      "fork boundary beta",
    );
  } else if (transcript.scenario === "thread_fork_native_continue") {
    assertAssistantTextIncludes(fork, "source-marker-7Q9V|fork-marker-2K4M");
    assert.lengthOf(fork.runs, 2);
  } else {
    assertAssistantTextIncludes(fork, "fork native ok");
  }
}
