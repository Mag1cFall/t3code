import type {
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import type { OmpSettings } from "../settings.ts";
import { makeOmpRpcConnection, OmpRpcError } from "./rpc.ts";
import { ompLaunchArgs, ompProfileArgs } from "./launch.ts";
import { field, text } from "./wire.ts";

const decodeCatalogJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const isOmpRpcError = Schema.is(OmpRpcError);

const PRESENTATION = {
  displayName: "OMP",
  showInteractionModeToggle: false,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  reportsContextWindow: true,
  requiresNewThreadForModelChange: false,
} as const;
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const DEFAULT_MODEL: ServerProviderModel = {
  slug: "default",
  name: "OMP default",
  isCustom: false,
  isDefault: true,
  capabilities: EMPTY_CAPABILITIES,
};
const MINIMUM_OMP_VERSION = "18.8.5";

const THINKING_LABELS: Readonly<Record<string, string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

// ompModels 将原生推理等级映射到共享选择器
export function ompModels(data: unknown, state: unknown): ServerProviderModel[] {
  const models = field(data, "models");
  if (!Array.isArray(models)) return [];
  const active = field(state, "model");
  return models.flatMap((model: unknown) => {
    const provider = text(model, "provider");
    const id = text(model, "id");
    if (!provider || !id) return [];
    const thinking = field(model, "thinking");
    const advertised = Array.isArray(thinking) ? thinking : field(thinking, "efforts");
    const efforts =
      field(model, "reasoning") === false || !Array.isArray(advertised)
        ? []
        : advertised.filter(
            (value): value is string => typeof value === "string" && value !== "off",
          );
    const activeModel = provider === text(active, "provider") && id === text(active, "id");
    const defaultLevel = activeModel
      ? text(state, "thinkingLevel")
      : text(thinking, "defaultLevel");
    const levels =
      efforts.length === 0
        ? []
        : Array.isArray(thinking) ||
            (field(thinking, "requiresEffort") === true &&
              field(thinking, "suppressWhenOff") !== true)
          ? efforts
          : ["off", ...efforts];
    const capabilities = createModelCapabilities({
      optionDescriptors:
        levels.length === 0
          ? []
          : [
              {
                id: "thinking",
                label: "Thinking",
                type: "select",
                options: levels.map((level) => ({
                  id: level,
                  label: THINKING_LABELS[level] ?? level,
                  ...(level === defaultLevel ? { isDefault: true } : {}),
                })),
              },
            ],
    });
    return [
      {
        slug: `${provider}/${id}`,
        name: text(model, "name") ?? id,
        subProvider: provider,
        isCustom: false,
        capabilities,
      },
    ];
  });
}

// ompCommands 保留原生命令与技能的逻辑标识
export function ompCommands(data: unknown): {
  slashCommands: ServerProviderSlashCommand[];
  skills: ServerProviderSkill[];
} {
  const entries = field(data, "commands");
  const slashCommands: ServerProviderSlashCommand[] = [];
  const skills: ServerProviderSkill[] = [];
  if (!Array.isArray(entries)) return { slashCommands, skills };
  for (const entry of entries) {
    const name = text(entry, "name");
    if (!name) continue;
    const description = text(entry, "description");
    if (text(entry, "source") === "skill") {
      const skillName = name.replace(/^skill:/, "");
      skills.push({
        name: skillName,
        path: `omp:skill:${skillName}`,
        enabled: true,
        ...(description === undefined ? {} : { description }),
      });
      continue;
    }
    const hint = text(field(entry, "input"), "hint") ?? text(entry, "inlineHint");
    slashCommands.push({
      name,
      ...(description === undefined ? {} : { description }),
      ...(hint === undefined ? {} : { input: { hint } }),
    });
  }
  return { slashCommands, skills };
}

// ompAuthStatus 只将原生凭证探测确认的账号标记为已认证
export function ompAuthStatus(data: unknown, profile: string): ServerProviderAuth {
  const providers = field(data, "providers");
  const authenticated = Array.isArray(providers)
    ? providers.filter((provider) => field(provider, "authenticated") === true)
    : [];
  return {
    status: authenticated.length > 0 ? "authenticated" : "unknown",
    ...(authenticated.length > 0
      ? {
          label: authenticated
            .map((provider) => text(provider, "name") ?? text(provider, "id"))
            .filter(Boolean)
            .join(", "),
          type: "native",
        }
      : {}),
    ...(profile ? { profileId: profile } : {}),
    canLogout: false,
  };
}

// discoverOmp 在显式刷新时读取包含扩展的原生目录
export const discoverOmp = Effect.fn("discoverOmp")(function* (
  settings: OmpSettings,
  env: NodeJS.ProcessEnv,
  cwd?: string,
) {
  const connection = yield* makeOmpRpcConnection({
    command: settings.binaryPath,
    args: [...ompLaunchArgs(settings), "--no-session", "--no-tools", "--no-lsp"],
    env,
    ...(cwd === undefined ? {} : { cwd }),
  });
  yield* Stream.fromQueue(connection.events).pipe(
    Stream.runDrain,
    Effect.ignore,
    Effect.forkScoped,
  );
  const state = yield* connection.request({ type: "get_state" });
  const models = ompModels(yield* connection.request({ type: "get_available_models" }), state);
  const commands = ompCommands(yield* connection.request({ type: "get_available_commands" }));
  const auth = ompAuthStatus(
    yield* connection.request({ type: "get_login_providers" }),
    settings.profile || (env.OMP_PROFILE ?? env.PI_PROFILE ?? ""),
  );
  const active = field(state, "model");
  const selected = models.find(
    (model) => model.slug === `${text(active, "provider")}/${text(active, "id")}`,
  );
  return {
    models: [
      {
        ...DEFAULT_MODEL,
        ...(selected
          ? { name: `OMP default (${selected.name})`, capabilities: selected.capabilities }
          : {}),
      },
      ...models,
    ],
    availableModelCount: models.length,
    auth,
    ...commands,
  };
}, Effect.scoped);

export type OmpDiscovery = Effect.Success<ReturnType<typeof discoverOmp>>;

// readOmpCatalogCommand 通过无会话原生命令读取 JSON 目录
const readOmpCatalogCommand = Effect.fnUntraced(function* (
  settings: OmpSettings,
  env: NodeJS.ProcessEnv,
  args: ReadonlyArray<string>,
  cwd?: string,
) {
  const spawn = yield* resolveSpawnCommand(
    settings.binaryPath,
    [...ompProfileArgs(settings), ...args],
    { env },
  );
  const result = yield* spawnAndCollect(
    settings.binaryPath,
    ChildProcess.make(spawn.command, spawn.args, {
      env,
      extendEnv: false,
      shell: spawn.shell,
      ...(cwd === undefined ? {} : { cwd }),
    }),
  );
  if (result.code !== 0)
    return yield* new OmpRpcError({
      operation: args[0]!,
      detail: result.stderr.trim() || `OMP ${args[0]} failed.`,
    });
  return yield* decodeCatalogJson(result.stdout).pipe(
    Effect.mapError(
      (cause) =>
        new OmpRpcError({ operation: args[0]!, detail: `Invalid OMP ${args[0]} response.`, cause }),
    ),
  );
});

// discoverOmpSkills 仅读取原生技能清单，不初始化会话与扩展代码
export const discoverOmpSkills = Effect.fn("discoverOmpSkills")(function* (
  settings: OmpSettings,
  env: NodeJS.ProcessEnv,
  cwd?: string,
) {
  const data = yield* readOmpCatalogCommand(settings, env, ["skill", "list", "--json"], cwd);
  const skills = field(data, "skills");
  if (!Array.isArray(skills)) return [];
  return skills.flatMap((skill: unknown) => {
    const name = text(skill, "name");
    if (!name) return [];
    const description = text(skill, "description");
    return [
      {
        name,
        path: `omp:skill:${name}`,
        enabled: true,
        ...(description === undefined ? {} : { description }),
      },
    ];
  });
});

// discoverOmpWithoutSession 在后台读取原生模型和技能并保留未知认证状态
const discoverOmpWithoutSession = Effect.fnUntraced(function* (
  settings: OmpSettings,
  env: NodeJS.ProcessEnv,
  cwd?: string,
) {
  const models = ompModels(
    yield* readOmpCatalogCommand(settings, env, ["models", "--json", "--no-extensions"], cwd),
    undefined,
  );
  return {
    models: [DEFAULT_MODEL, ...models],
    availableModelCount: models.length,
    auth: ompAuthStatus(undefined, settings.profile || (env.OMP_PROFILE ?? env.PI_PROFILE ?? "")),
    slashCommands: [],
    skills: yield* discoverOmpSkills(settings, env, cwd),
  } satisfies OmpDiscovery;
});

// initialOmpSnapshot 提供异步探测前的 Provider 状态
export const initialOmpSnapshot = (settings: OmpSettings): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      models: providerModelsFromSettings(
        [DEFAULT_MODEL],
        settings.customModels,
        EMPTY_CAPABILITIES,
      ),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown", canLogout: false },
        message: settings.enabled ? "Checking OMP..." : "OMP is disabled.",
      },
    });
  });

// checkOmpStatus 使用无会话命令探测状态并复用显式刷新的原生目录
export const checkOmpStatus = Effect.fn("checkOmpStatus")(function* (
  settings: OmpSettings,
  env: NodeJS.ProcessEnv,
  cwd?: string,
  cachedDiscovery?: OmpDiscovery,
) {
  if (!settings.enabled) return yield* initialOmpSnapshot(settings);
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  let version: string | null = null;
  return yield* Effect.gen(function* () {
    const command = settings.binaryPath;
    const spawn = yield* resolveSpawnCommand(command, [...ompProfileArgs(settings), "--version"], {
      env,
    });
    const result = yield* spawnAndCollect(
      command,
      ChildProcess.make(spawn.command, spawn.args, { env, shell: spawn.shell }),
    );
    version = parseGenericCliVersion(`${result.stdout}\n${result.stderr}`);
    if (result.code !== 0 || version === null)
      return yield* new OmpRpcError({
        operation: "version",
        detail: "Could not determine the OMP version.",
      });
    if (compareSemverVersions(version, MINIMUM_OMP_VERSION) < 0)
      return yield* new OmpRpcError({
        operation: "version",
        detail: `OMP ${MINIMUM_OMP_VERSION} or newer is required.`,
      });
    const discovery = cachedDiscovery ?? (yield* discoverOmpWithoutSession(settings, env, cwd));
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: providerModelsFromSettings(
        discovery.models,
        settings.customModels,
        EMPTY_CAPABILITIES,
      ),
      slashCommands: discovery.slashCommands,
      skills: discovery.skills,
      probe: {
        installed: true,
        version,
        status: discovery.availableModelCount > 0 ? "ready" : "warning",
        auth: discovery.auth,
        ...(discovery.availableModelCount === 0
          ? { message: "Sign in to an OMP model provider or configure an API key." }
          : {}),
      },
    });
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed(
        buildServerProvider({
          presentation: PRESENTATION,
          enabled: true,
          checkedAt,
          models: providerModelsFromSettings(
            [DEFAULT_MODEL],
            settings.customModels,
            EMPTY_CAPABILITIES,
          ),
          probe: {
            installed: !isCommandMissingCause(cause),
            version,
            status: "error",
            auth: { status: "unknown", canLogout: false },
            message: isOmpRpcError(cause)
              ? cause.detail
              : "Unable to start OMP. Check the binary path.",
          },
        }),
      ),
    ),
  );
});
