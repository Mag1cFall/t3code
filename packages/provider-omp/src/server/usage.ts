import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import type { OmpSettings } from "../settings.ts";
import { field, number, text } from "./wire.ts";

const OmpScanState = Schema.Struct({ sessionId: Schema.mutableKey(Schema.String) });
const decodeUsageLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeUsageKey = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Tuple([Schema.Literal("omp"), Schema.String, Schema.Number, Schema.String]),
  ),
);

// ompNativeDirectories 解析原生档案目录及已采用的 XDG 数据目录
export const ompNativeDirectories = Effect.fn("ompNativeDirectories")(function* (
  settings: Pick<OmpSettings, "profile"> | undefined,
  environment: NodeJS.ProcessEnv,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const hostHome = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const home = (platform === "win32" ? environment.USERPROFILE : environment.HOME) || hostHome;
  const selected = settings?.profile || (environment.OMP_PROFILE ?? environment.PI_PROFILE ?? "");
  const profile = selected === "default" ? "" : selected;
  const root = path.join(home, environment.PI_CONFIG_DIR || ".omp");
  const defaultAgent = profile
    ? path.join(root, "profiles", profile, "agent")
    : path.join(root, "agent");
  const agentDir = path.resolve(
    !profile && environment.PI_CODING_AGENT_DIR ? environment.PI_CODING_AGENT_DIR : defaultAgent,
  );
  let dataDir = agentDir;
  if (
    (platform === "linux" || platform === "darwin") &&
    agentDir === path.resolve(defaultAgent) &&
    environment.XDG_DATA_HOME
  ) {
    const xdgRoot = profile
      ? path.join(environment.XDG_DATA_HOME, "omp", "profiles", profile)
      : path.join(environment.XDG_DATA_HOME, "omp");
    if (yield* fs.exists(xdgRoot).pipe(Effect.orElseSucceed(() => false))) dataDir = xdgRoot;
  }
  return { agentDir, sessionDir: path.join(dataDir, "sessions") };
});

// parseOmpUsage 读取原生计费条目并用稳定条目标识去重分叉副本
export function parseOmpUsage(
  entry: unknown,
  state: typeof OmpScanState.Type,
): readonly UsageRecord[] {
  const kind = text(entry, "type");
  if (kind === "session") {
    state.sessionId = text(entry, "id") ?? "";
    return [];
  }
  const source = kind === "message" ? field(entry, "message") : entry;
  if (kind !== "model_usage" && (kind !== "message" || text(source, "role") !== "assistant"))
    return [];
  const timestampMs = parseTimestampMs(text(entry, "timestamp"));
  const id = text(entry, "id");
  const provider = text(source, "provider");
  const modelId = text(source, "model");
  if (timestampMs === null || !id || !provider || !modelId) return [];
  const usage = field(source, "usage");
  const outputTokens = tokenCount(number(usage, "output"));
  const totals = {
    uncachedInputTokens: tokenCount(number(usage, "input")),
    cachedInputTokens: tokenCount(number(usage, "cacheRead")),
    cacheCreationTokens: tokenCount(number(usage, "cacheWrite")),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(number(usage, "reasoningTokens"))),
  };
  const cost = number(field(usage, "cost"), "total");
  const reportedCostUsd = cost !== undefined && Number.isFinite(cost) && cost > 0 ? cost : null;
  if (totalTokens(totals) === 0 && reportedCostUsd === null) return [];
  const model = `${provider}/${modelId}`;
  return [
    {
      provider: "omp",
      timestampMs,
      model,
      rateModel: text(source, "upstreamModel") ?? modelId,
      sessionId: state.sessionId,
      totals,
      reportedCostUsd,
      speed: "standard",
      dedupeKey: encodeUsageKey(["omp", id, timestampMs, model]),
    },
  ];
}

export const ompUsageFormat: TranscriptUsageFormat<typeof OmpScanState.Type> = {
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    provider: true,
    model: true,
    usage: true,
    message: { role: true, provider: true, model: true, upstreamModel: true, usage: true },
  },
  mightCarryUsage: (line) => line.includes('"usage"') || line.includes('"session"'),
  parseLine: (line, state) => {
    const parsed = decodeUsageLine(line);
    return Option.isSome(parsed) ? parseOmpUsage(parsed.value, state) : [];
  },
  parseProjected: parseOmpUsage,
  state: { initial: () => ({ sessionId: "" }), schema: OmpScanState },
  sharedSessionsAcrossFiles: true,
};

export type OmpUsageEnv = Path.Path | FileSystem.FileSystem | ProviderHost.ProviderHost;
export const ompUsageReader: ProviderUsageReader<OmpSettings, OmpUsageEnv> = {
  kind: "transcripts",
  provider: "omp",
  format: ompUsageFormat,
  directories: Effect.fn("ompUsageReader.directories")(function* ({
    instanceId,
    config,
    environment,
  }) {
    const path = yield* Path.Path;
    const host = yield* ProviderHost.ProviderHost;
    const native = yield* ompNativeDirectories(config, environment);
    return [
      { dir: native.sessionDir },
      { dir: path.join(host.paths.stateDir, "omp", encodeURIComponent(instanceId)) },
    ];
  }),
};
