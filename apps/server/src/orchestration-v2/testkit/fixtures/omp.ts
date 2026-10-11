import { assert } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "./index.ts";
import { OMP_BACKGROUND_REPLAY_GATE } from "../../Adapters/OmpAdapterV2.testkit.ts";
import { assertSimpleOutput } from "./simple/codex_output.ts";
import { assertMultiTurnOutput } from "./multi_turn/codex_output.ts";
import { assertQueuedTurnOutput } from "./queued_turn/codex_output.ts";
import { TOOL_CALL_DENIED_WRITE_TARGET } from "./tool_call_denied_write/input.ts";
import {
  assertOmpApprovalOutput,
  assertOmpCommandOutput,
  assertOmpCompactionOutput,
  assertOmpInterruptOutput,
  assertOmpQuestionOutput,
  assertOmpRollbackOutput,
  assertOmpSteeringOutput,
  assertOmpTodoOutput,
  assertOmpSteerStopOutput,
  assertOmpSubagentOutput,
  assertOmpExitOutput,
  assertOmpForkOutput,
} from "./omp_output.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
  PROVIDER_THREAD_RESUME_FIRST_PROMPT,
  PROVIDER_THREAD_RESUME_SECOND_PROMPT,
  MESSAGE_STEERING_STEER_PROMPT,
  TURN_INTERRUPT_MID_TOOL_PROMPT,
  MULTI_TURN_FIRST_PROMPT,
  MULTI_TURN_SECOND_PROMPT,
  THREAD_FORK_NATIVE_SOURCE_PROMPT,
  THREAD_FORK_NATIVE_TARGET_PROMPT,
  THREAD_FORK_NATIVE_CONTINUE_SOURCE_PROMPT,
  THREAD_FORK_NATIVE_CONTINUE_FIRST_PROMPT,
  THREAD_FORK_NATIVE_CONTINUE_SECOND_PROMPT,
  THREAD_FORK_NATIVE_PRIOR_TURN_ALPHA_PROMPT,
  THREAD_FORK_NATIVE_PRIOR_TURN_BETA_PROMPT,
  THREAD_FORK_NATIVE_PRIOR_TURN_REPEAT_PROMPT,
  type OrchestratorReplayFixture,
  type OrchestratorFixtureInput,
  type ProviderOrchestratorReplayVariant,
} from "./shared.ts";

const OMP_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("omp"),
  model: "openai-codex/gpt-5.6-sol",
};

const outputs: Readonly<Record<string, ProviderOrchestratorReplayVariant["assertOutput"]>> = {
  simple: assertSimpleOutput,
  multi_turn: assertMultiTurnOutput,
  multi_turn_restart: assertMultiTurnOutput,
  omp_default_restart: (result, transcript) => {
    assertBaseProjection({
      result,
      transcript,
      runCount: 3,
      runStatuses: ["completed", "completed", "completed"],
    });
    const projection = projectionFor(result, transcript.scenario);
    assertSemanticProjectionIntegrity(projection);
    for (const text of ["DEFAULT_A", "EXPLICIT_B", "DEFAULT_RESTORED"])
      assertAssistantTextIncludes(projection, text);
    const levels = transcript.entries.flatMap((entry) => {
      if (
        entry.type !== "expect_outbound" ||
        typeof entry.frame !== "object" ||
        entry.frame === null
      )
        return [];
      const frame = entry.frame as Record<string, unknown>;
      return frame.type === "set_thinking_level" ? [frame.level] : [];
    });
    assert.deepEqual(levels, ["low", "high"]);
    const models = transcript.entries.flatMap((entry) => {
      if (
        entry.type !== "expect_outbound" ||
        typeof entry.frame !== "object" ||
        entry.frame === null
      )
        return [];
      const frame = entry.frame as Record<string, unknown>;
      return frame.type === "set_model" ? [frame.modelId] : [];
    });
    assert.deepEqual(models, ["gpt-5.6-luna", "gpt-5.6-sol"]);
  },
  queued_turn: assertQueuedTurnOutput,
  message_steering: assertOmpSteeringOutput,
  turn_interrupt: assertOmpInterruptOutput,
  turn_interrupt_mid_tool: assertOmpInterruptOutput,
  thread_rollback: assertOmpRollbackOutput,
  thread_rollback_after_stop: assertOmpRollbackOutput,
  thread_rollback_after_restart: assertOmpRollbackOutput,
  tool_call_restricted_granular: assertOmpApprovalOutput,
  tool_call_denied_write: assertOmpApprovalOutput,
  todo_list: assertOmpTodoOutput,
  omp_questions: assertOmpQuestionOutput,
  omp_questions_cancel: assertOmpQuestionOutput,
  omp_compaction: assertOmpCompactionOutput,
  omp_command: assertOmpCommandOutput,
  omp_steer_then_stop: assertOmpSteerStopOutput,
  omp_process_exit: assertOmpExitOutput,
  subagent_v2: assertOmpSubagentOutput,
  subagent_v2_nested: assertOmpSubagentOutput,
  subagent_v2_approval: assertOmpSubagentOutput,
  omp_background_subagent: assertOmpSubagentOutput,
  omp_subagent_stop: assertOmpSubagentOutput,
  omp_background_exit: (result, transcript) => {
    assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
    const projection = projectionFor(result, transcript.scenario);
    assertSemanticProjectionIntegrity(projection);
    assertAssistantTextIncludes(projection, "PARENT_OK");
    assert.lengthOf(projection.subagents, 1);
    const subagent = projection.subagents[0]!;
    assert.equal(subagent.status, "failed");
    const child = result.projections.get(subagent.childThreadId!);
    assert.isDefined(child);
    assert.lengthOf(child.runs, 0);
    assert.isNotEmpty(child.providerTurns);
    assert.isTrue(child.providerTurns.every((turn) => turn.status === "failed"));
    assert.isTrue(
      transcript.entries.some((entry) => entry.type === "runtime_exit" && entry.status === "error"),
    );
  },
  thread_fork_native: assertOmpForkOutput,
  thread_fork_native_prior_turn: assertOmpForkOutput,
  thread_fork_native_continue: assertOmpForkOutput,
  provider_thread_resume: (result, transcript) => {
    assertBaseProjection({
      result,
      transcript,
      runCount: 2,
      runStatuses: ["completed", "completed"],
    });
    const projection = projectionFor(result, transcript.scenario);
    assertSemanticProjectionIntegrity(projection);
    assertUserMessagesInclude(projection, [
      PROVIDER_THREAD_RESUME_FIRST_PROMPT,
      PROVIDER_THREAD_RESUME_SECOND_PROMPT,
    ]);
    assertAssistantTextIncludes(projection, "provider thread resume fixture first turn complete");
    assertAssistantTextIncludes(projection, "provider thread resume fixture second turn complete");
    assert.lengthOf(projection.providerThreads, 1);
  },
  omp_tools: (result, transcript) => {
    assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
    const projection = projectionFor(result, transcript.scenario);
    assertSemanticProjectionIntegrity(projection);
    const expected = new Map([
      ["read", "dynamic_tool"],
      ["grep", "dynamic_tool"],
      ["glob", "dynamic_tool"],
      ["bash", "command_execution"],
      ["write", "file_change"],
      ["edit", "file_change"],
      ["ast_edit", "file_change"],
      ["web_search", "web_search"],
    ]);
    const starts = transcript.entries.flatMap((entry) => {
      if (entry.type !== "emit_inbound" || typeof entry.frame !== "object" || entry.frame === null)
        return [];
      const frame = entry.frame as Record<string, unknown>;
      return frame.type === "tool_execution_start" ? [frame] : [];
    });
    for (const [name, type] of expected) {
      const call = starts.find((frame) =>
        name === "ast_edit"
          ? frame.toolName === "write" && (frame.args as { path?: string }).path === "xd://ast_edit"
          : frame.toolName === name,
      );
      assert.isDefined(call, `${name} must execute in the native recording`);
      const items = projection.turnItems.filter((item) =>
        item.nativeItemRef?.nativeId?.endsWith(`:tool:${String(call.toolCallId)}`),
      );
      assert.lengthOf(items, 1, `${name} must produce one card`);
      assert.equal(items[0]?.type, type);
      assert.isNull(items[0]?.title);
      assert.equal(items[0]?.status, "completed");
    }
  },
};

const questionsPrompt =
  'Use the ask tool exactly once to ask all three questions together: id "color", question "Which color?", options Red and Blue; id "letters", question "Which letters?", options A, B and C, multi true; id "note", question "Add a note?", options empty. Wait for my answers. If cancelled, reply exactly: questions cancelled. Otherwise reply exactly: questions fixture complete';
const exclusiveInputs: Readonly<Record<string, () => OrchestratorFixtureInput>> = {
  multi_turn_restart: () => ({
    steps: [
      { type: "message", text: MULTI_TURN_FIRST_PROMPT },
      { type: "message", text: MULTI_TURN_SECOND_PROMPT },
    ],
  }),
  omp_default_restart: () => ({
    steps: [
      { type: "message", text: "Respond exactly DEFAULT_A." },
      { type: "message", text: "Respond exactly EXPLICIT_B." },
      { type: "message", text: "Respond exactly DEFAULT_RESTORED." },
    ],
  }),
  omp_steer_then_stop: () => ({
    steps: [
      { type: "message", text: TURN_INTERRUPT_MID_TOOL_PROMPT },
      { type: "steer", targetRunIndex: 1, text: MESSAGE_STEERING_STEER_PROMPT },
      { type: "interrupt", targetRunIndex: 1 },
    ],
  }),
  omp_process_exit: () => ({ steps: [{ type: "message", text: TURN_INTERRUPT_MID_TOOL_PROMPT }] }),
  omp_background_subagent: () => ({
    steps: [
      {
        type: "message",
        text: 'Spawn exactly one task subagent named Background whose task is: run node -e "setTimeout(() => console.log(\\\"CHILD_OK\\\"), 15000)" then yield CHILD_OK. After the task tool returns the agent id, do not wait and do not call any other tools. End your own turn immediately with exactly PARENT_OK. When the child reports later, acknowledge CHILD_OK.',
      },
      { type: "await_run_status", targetRunIndex: 1, status: "completed" },
      { type: "release_replay_gate", label: OMP_BACKGROUND_REPLAY_GATE },
      { type: "await_run_status", targetRunIndex: 2, status: "completed" },
    ],
  }),
  omp_background_exit: () => ({
    steps: [
      {
        type: "message",
        text: 'Spawn exactly one task subagent named Background whose task is: run node -e "setTimeout(() => {}, 30000)" then yield CHILD_OK. After the task tool returns the agent id, do not wait and do not call any other tools. End your own turn immediately with exactly PARENT_OK.',
      },
    ],
  }),
  omp_subagent_stop: () => ({
    steps: [
      {
        type: "message",
        text: 'Spawn two task subagents named StopMe and Sibling. Both must run node -e "setTimeout(() => {}, 20000)" first. StopMe then yields STOP_ME_FINISHED, Sibling yields SIBLING_OK. Wait for both agents. If one is cancelled, do not replace or restart it; wait for the other, then reply with exactly SIBLING_OK.',
      },
    ],
  }),
  thread_fork_native: () => ({
    steps: [
      { type: "message", text: THREAD_FORK_NATIVE_SOURCE_PROMPT },
      { type: "message", text: THREAD_FORK_NATIVE_TARGET_PROMPT },
    ],
  }),
  thread_fork_native_prior_turn: () => ({
    steps: [
      { type: "message", text: THREAD_FORK_NATIVE_PRIOR_TURN_ALPHA_PROMPT },
      { type: "message", text: THREAD_FORK_NATIVE_PRIOR_TURN_BETA_PROMPT },
      { type: "message", text: THREAD_FORK_NATIVE_PRIOR_TURN_REPEAT_PROMPT },
    ],
  }),
  thread_fork_native_continue: () => ({
    steps: [
      { type: "message", text: THREAD_FORK_NATIVE_CONTINUE_SOURCE_PROMPT },
      { type: "message", text: THREAD_FORK_NATIVE_CONTINUE_FIRST_PROMPT },
      { type: "message", text: THREAD_FORK_NATIVE_CONTINUE_SECOND_PROMPT },
    ],
  }),
  omp_questions: () => ({
    steps: [
      { type: "message", text: questionsPrompt },
      {
        type: "answer_next_user_input_request",
        answers: { color: "Red", letters: ["A", "C"], note: "fixture note" },
      },
    ],
  }),
  omp_questions_cancel: () => ({
    steps: [
      { type: "message", text: questionsPrompt },
      { type: "approve_next_runtime_request", decision: "decline" },
    ],
  }),
  omp_compaction: () => ({
    steps: [
      {
        type: "message",
        text: "Remember the opaque codeword PAPAYA. Explain why deterministic replay tests are useful in about 300 words.",
      },
      {
        type: "message",
        text: "Explain process-boundary replay and checkpoint semantics in about 300 words. Keep remembering the codeword.",
      },
      {
        type: "message",
        text: "/compact Keep the opaque codeword and summarize the conversation.",
      },
      { type: "message", text: "What was the codeword? Reply with that word only." },
    ],
  }),
  omp_tools: () => ({
    workspaceFiles: { "fixture.ts": "export const answer = 1;\n" },
    steps: [
      {
        type: "message",
        text: "Exercise each requested native tool once, without delegation or eval: read fixture.ts; grep for answer in fixture.ts; glob for *.ts; bash echo OMP_TOOL_OK; write note.txt with hello; edit note.txt to world; ast_edit to change the literal 1 to 2 in fixture.ts; web_search for the official TypeScript documentation. Use those exact tools, not shell substitutes. Then reply exactly: tools fixture complete.",
      },
    ],
  }),
  omp_command: () => ({ steps: [{ type: "message", text: "/session info" }] }),
};

// OMP_REPLAY_FIXTURES 复用共享输入与提供方无关的最终投影断言
export const OMP_REPLAY_FIXTURES: ReadonlyArray<OrchestratorReplayFixture> = Object.entries(
  outputs,
).map(([name, assertOutput]) => {
  const shared = ORCHESTRATOR_REPLAY_FIXTURES.find((fixture) => fixture.name === name);
  const buildInput = exclusiveInputs[name] ?? shared!.buildInput;
  return {
    name,
    buildInput:
      name === "tool_call_restricted_granular" ||
      name === "tool_call_denied_write" ||
      name === "subagent_v2_approval"
        ? () => ({ ...buildInput(), runtimeMode: "approval-required" })
        : buildInput,
    providers: [
      {
        driver: ProviderDriverKind.make("omp"),
        transcriptFile: new URL(`./${name}/omp_transcript.ndjson`, import.meta.url),
        modelSelection:
          name === "omp_default_restart"
            ? { ...OMP_MODEL_SELECTION, model: "default" }
            : OMP_MODEL_SELECTION,
        ...(name === "omp_background_subagent" ? { runContinuationWorker: true } : {}),
        ...(name === "tool_call_denied_write"
          ? { expectedAbsentWorkspacePaths: [TOOL_CALL_DENIED_WRITE_TARGET] }
          : {}),
        assertOutput,
      },
    ],
  };
});
