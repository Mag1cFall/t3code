import {
  isActiveSubagentStatus,
  isTerminalSubagentStatus,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { tr } from "~/i18n";

/** Summarize observed states without treating idle or missing agents as completed. */
export function deriveAgentSpawnSummary({
  agents,
  agentCount,
  coordinatorStatus,
}: {
  agents: ReadonlyArray<Pick<RuntimeSubagent, "kind" | "status">>;
  agentCount: number;
  coordinatorStatus?: RuntimeSubagent["status"] | undefined;
}) {
  const working = agents.filter((agent) => isActiveSubagentStatus(agent.status)).length;
  const failed = agents.filter((agent) => agent.status === "failed").length;
  const idle = agents.filter((agent) => agent.status === "idle").length;
  const stopped = agents.filter(
    (agent) => agent.status === "cancelled" || agent.status === "interrupted",
  ).length;
  const batches = agents.filter((agent) => agent.kind === "subagent_batch").length;
  const individuals = agentCount - batches;
  // Workflow coordinators can keep running between dynamic member launches.
  const live =
    coordinatorStatus !== undefined ? !isTerminalSubagentStatus(coordinatorStatus) : working > 0;
  const es = batches === 1 ? "" : "es";
  const subjects =
    [
      individuals > 0
        ? tr("{{count}} subagent{{s}}", { count: individuals, s: individuals === 1 ? "" : "s" })
        : null,
      batches > 0
        ? individuals > 0
          ? tr("{{count}} batch{{es}}", { count: batches, es })
          : tr("{{count}} subagent batch{{es}}", { count: batches, es })
        : null,
    ]
      .filter(Boolean)
      .join(tr(" and ")) || tr("subagents");
  const lead =
    batches > 0
      ? tr("Launched {{subjects}}", { subjects })
      : live
        ? tr("Kicked off {{subjects}}", { subjects })
        : tr("Ran {{subjects}}", { subjects });

  const completedStatus = tr("✓ completed");
  const status = live
    ? working > 0
      ? tr("{{working}} working", { working })
      : tr("working")
    : coordinatorStatus === "failed"
      ? tr("Workflow failed")
      : coordinatorStatus === "cancelled" || coordinatorStatus === "interrupted"
        ? tr("Workflow stopped")
        : failed > 0
          ? tr("{{failed}} failed", { failed })
          : stopped > 0
            ? tr("{{stopped}} stopped", { stopped })
            : idle > 0
              ? tr("{{idle}} idle", { idle })
              : coordinatorStatus !== "completed" &&
                  (agents.length === 0 || agents.length < agentCount)
                ? tr("Status unavailable")
                : completedStatus;
  const tone = live
    ? "working"
    : failed > 0 || coordinatorStatus === "failed"
      ? "failed"
      : status === completedStatus
        ? "completed"
        : "inactive";
  return { live, lead, status, tone };
}
