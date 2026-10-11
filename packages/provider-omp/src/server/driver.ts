import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import { OmpSettings } from "../settings.ts";
import { OmpAdapterV2Driver, type OmpAdapterV2DriverEnv } from "./adapter.ts";
import { makeOmpAuth } from "./auth.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  checkOmpStatus,
  discoverOmp,
  discoverOmpSkills,
  initialOmpSnapshot,
  type OmpDiscovery,
} from "./status.ts";
import { makeOmpTextGeneration } from "./textGeneration.ts";
import { ompNativeDirectories, ompUsageReader, type OmpUsageEnv } from "./usage.ts";

const DRIVER_KIND = ProviderDriverKind.make("omp");
const decodeOmpSettings = Schema.decodeSync(OmpSettings);
const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@oh-my-pi/pi-coding-agent",
  nativeUpdate: { args: ["update"] },
});
export type OmpDriverEnv =
  | OmpAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ProviderLatestVersions.ProviderLatestVersions
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | Crypto.Crypto;

// OmpDriver 组合原生会话认证发现维护文本生成及用量能力
export const OmpDriver: ProviderDriver<OmpSettings, OmpDriverEnv, OmpUsageEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "OMP", supportsMultipleInstances: true },
  configSchema: OmpSettings,
  defaultConfig: () => decodeOmpSettings({}),
  usage: ompUsageReader,
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
      const host = yield* ProviderHost.ProviderHost;
      const processEnv = yield* mergeProviderInstanceEnvironment(environment);
      const settings = { ...config, enabled } satisfies OmpSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stamp = (snapshot: ServerProviderDraft): ServerProvider => ({
        ...snapshot,
        instanceId,
        driver: DRIVER_KIND,
        ...(displayName ? { displayName } : {}),
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
      });
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: settings.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
      );
      const orchestrationAdapter = yield* OmpAdapterV2Driver.create({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to create the OMP session adapter.",
              cause,
            }),
        ),
      );
      const textGeneration = yield* makeOmpTextGeneration(settings, processEnv);
      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(settings);
      const catalogs = new Map<string, OmpDiscovery | undefined>([[host.paths.cwd, undefined]]);
      const invalidateCatalogs = Effect.sync(() => {
        for (const cwd of catalogs.keys()) catalogs.set(cwd, undefined);
      });
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OmpSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (current) => initialOmpSnapshot(current.provider).pipe(Effect.map(stamp)),
        checkProvider: Effect.suspend(() =>
          checkOmpStatus(settings, processEnv, host.paths.cwd, catalogs.get(host.paths.cwd)),
        ).pipe(
          Effect.map(stamp),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
        enrichSnapshot: ({ settings: current, snapshot: value, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenance) =>
              enrichProviderSnapshotWithVersionAdvisory(value, maintenance, {
                enableProviderUpdateChecks: current.enableProviderUpdateChecks,
              }),
            ),
            Effect.flatMap(publishSnapshot),
            Effect.catchCause(() => Effect.logWarning("Failed to check for OMP updates.")),
            Effect.asVoid,
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to create the OMP status manager.",
              cause,
            }),
        ),
      );
      const native = yield* ompNativeDirectories(settings, processEnv);
      const controller = yield* makeOmpAuth({
        instanceId,
        settings,
        environment: processEnv,
        cwd: host.paths.cwd,
        credentialKey: `omp:${processEnv.OMP_AUTH_BROKER_URL || native.agentDir}`,
        onChanged: invalidateCatalogs.pipe(Effect.andThen(snapshot.refresh), Effect.asVoid),
      });
      const auth = {
        ...controller,
        invalidate: controller.invalidate!.pipe(
          Effect.andThen(invalidateCatalogs),
          Effect.andThen(snapshot.refresh),
          Effect.asVoid,
        ),
      };
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        invalidateCaches: invalidateCatalogs,
        refreshModels: () =>
          Effect.forEach(
            catalogs.keys(),
            (cwd) =>
              discoverOmp(settings, processEnv, cwd).pipe(
                Effect.tap((catalog) => Effect.sync(() => catalogs.set(cwd, catalog))),
              ),
            { discard: true },
          ).pipe(
            Effect.tap(() => controller.refreshMethods),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.mapError(
              (cause) =>
                new ProviderDriverError({
                  driver: DRIVER_KIND,
                  instanceId,
                  detail: "Failed to refresh the OMP catalog.",
                  cause,
                }),
            ),
          ),
        snapshotForCwd: (cwd) =>
          !settings.enabled
            ? snapshot.getSnapshot
            : Effect.gen(function* () {
                const current = yield* snapshot.getSnapshot;
                if (!catalogs.has(cwd)) catalogs.set(cwd, undefined);
                const catalog = catalogs.get(cwd);
                const skills =
                  catalog?.skills ?? (yield* discoverOmpSkills(settings, processEnv, cwd));
                return {
                  ...current,
                  slashCommands: catalog?.slashCommands ?? [],
                  skills,
                };
              }).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Effect.mapError(
                  (cause) =>
                    new ProviderDriverError({
                      driver: DRIVER_KIND,
                      instanceId,
                      detail: "Failed to discover OMP workspace skills.",
                      cause,
                    }),
                ),
              ),
        orchestrationAdapter,
        textGeneration,
        auth,
      } satisfies ProviderInstance;
    }),
};
