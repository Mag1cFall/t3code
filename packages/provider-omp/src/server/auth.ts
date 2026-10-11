import {
  ProviderSetupError,
  type ProviderAuthMethod,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import type { OmpSettings } from "../settings.ts";
import { ompProbeArgs, ompProfileArgs } from "./launch.ts";
import { makeOmpRpcConnection, type OmpRpcConnection } from "./rpc.ts";
import { field, text, type OmpRecord } from "./wire.ts";

// ompLoginProviders 读取原生可用登录方式而不接触凭证内容
function ompLoginProviders(
  data: unknown,
): ReadonlyArray<{ id: string; name: string; authenticated: boolean }> {
  const providers = field(data, "providers");
  if (!Array.isArray(providers)) return [];
  return providers.flatMap((provider) => {
    const id = text(provider, "id");
    const name = text(provider, "name");
    return id && name && field(provider, "available") === true
      ? [{ id, name, authenticated: field(provider, "authenticated") === true }]
      : [];
  });
}

// handleOmpLoginInteraction 将原生浏览器及非机密输入交给共享认证界面
const handleOmpLoginInteraction = Effect.fn("handleOmpLoginInteraction")(function* (
  event: OmpRecord,
  connection: OmpRpcConnection,
  context: ProviderAuthFlow.ProviderAuthFlowContext,
  instanceId: ProviderInstanceId,
) {
  if (event.type !== "extension_ui_request") return;
  const id = text(event, "id");
  if (!id) return;
  if (event.method === "open_url") {
    const url = text(event, "launchUrl") ?? text(event, "url");
    if (!url || !/^https?:\/\//i.test(url))
      return yield* new ProviderSetupError({
        instanceId,
        operation: "start",
        detail: "OMP returned an invalid sign-in URL.",
      });
    const userCode = /^Enter code:\s*(\S+)/.exec(text(event, "instructions") ?? "")?.[1];
    if (userCode) {
      yield* context.setInteraction({ type: "deviceCode", id, url, userCode });
      return;
    }
    const opened = yield* Deferred.make<boolean>();
    yield* context.setInteraction(
      { type: "browser", id, url, requiresConsent: true },
      (response) =>
        response.type === "browser"
          ? Deferred.succeed(opened, response.action === "accept").pipe(Effect.asVoid)
          : Effect.void,
    );
    if (!(yield* Deferred.await(opened)))
      return yield* new ProviderSetupError({
        instanceId,
        operation: "start",
        detail: "OMP browser sign-in was cancelled.",
      });
  } else if (event.method === "input") {
    yield* context.setInteraction(
      {
        type: "credentials",
        id,
        fields: [
          {
            name: "value",
            label: text(event, "title") ?? "Authorization code or callback URL",
            secret: false,
          },
        ],
      },
      (response) =>
        response.type === "credentials"
          ? connection
              .send({ type: "extension_ui_response", id, value: response.values.value ?? "" })
              .pipe(
                Effect.mapError(
                  () =>
                    new ProviderSetupError({
                      instanceId,
                      operation: "respond",
                      detail: "Failed to submit the authorization response to OMP.",
                    }),
                ),
              )
          : Effect.void,
    );
  }
});

// makeOmpAuth 使用 OMP 自有凭证存储及 ProviderAuthFlow 生命周期
export const makeOmpAuth = Effect.fn("makeOmpAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: OmpSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly credentialKey: string;
  readonly onChanged: Effect.Effect<void>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
  const platform = yield* HostProcess.Platform;
  const failure = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail });
  const connect = makeOmpRpcConnection({
    command: options.settings.binaryPath,
    args: ompProbeArgs(options.settings),
    cwd: options.cwd,
    env: options.environment,
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
  let discovered: Result.Result<
    ReturnType<typeof ompLoginProviders>,
    ProviderSetupError
  > = Result.succeed([]);
  const discover = Effect.gen(function* () {
    const connection = yield* connect;
    yield* Stream.fromQueue(connection.events).pipe(
      Stream.runDrain,
      Effect.ignore,
      Effect.forkScoped,
    );
    return ompLoginProviders(yield* connection.request({ type: "get_login_providers" }));
  }).pipe(
    Effect.scoped,
    Effect.mapError(() =>
      failure("methods", "Failed to read sign-in methods for this OMP profile."),
    ),
    Effect.tap((providers) =>
      Effect.sync(() => {
        discovered = Result.succeed(providers);
      }),
    ),
  );
  const methods: Effect.Effect<ReadonlyArray<ProviderAuthMethod>, ProviderSetupError> = options
    .settings.enabled
    ? Effect.suspend(() => Effect.fromResult(discovered)).pipe(
        Effect.map((providers) => [
          ...providers
            .slice(0, Option.isSome(pty) ? 31 : 32)
            .map((provider): ProviderAuthMethod => ({
              id: provider.id,
              name: provider.name,
              description: provider.authenticated ? "Native credentials configured" : null,
              type: "agent",
            })),
          ...(Option.isSome(pty)
            ? [
                {
                  id: "terminal",
                  name: "Sign in with OMP",
                  description: "Choose a provider and complete sign-in in the terminal.",
                  type: "terminal" as const,
                },
              ]
            : []),
        ]),
      )
    : Effect.succeed([]);

  const runTerminal = Effect.fnUntraced(function* (
    providerId: string | undefined,
    context: ProviderAuthFlow.ProviderAuthFlowContext,
  ) {
    if (Option.isNone(pty))
      return yield* failure("start", "A sign-in terminal is unavailable in this environment.");
    const nativeArgs = [
      ...ompProfileArgs(options.settings),
      "login",
      ...(providerId ? [providerId] : []),
    ];
    const launch = yield* resolveSpawnCommand(options.settings.binaryPath, nativeArgs, {
      env: options.environment,
    }).pipe(Effect.mapError(() => failure("start", "Failed to resolve the OMP sign-in command.")));
    const script = `& ${[options.settings.binaryPath, ...nativeArgs].map((arg) => `'${arg.replaceAll("'", "''")}'`).join(" ")}; exit $LASTEXITCODE`;
    const process = yield* pty.value
      .spawn({
        shell: platform === "win32" ? "powershell.exe" : launch.command,
        args:
          platform === "win32"
            ? [
                "-NoLogo",
                "-NoProfile",
                "-EncodedCommand",
                Buffer.from(script, "utf16le").toString("base64"),
              ]
            : [...launch.args],
        cwd: options.cwd,
        cols: 80,
        rows: 24,
        env: options.environment,
      })
      .pipe(Effect.mapError(() => failure("start", "Failed to start the OMP sign-in terminal.")));
    const exited = yield* Deferred.make<number>();
    const output = yield* Queue.sliding<string>(64);
    let loginOutput = "";
    let loginConfirmed = false;
    const detachData = process.onData((data) => {
      loginOutput = (loginOutput + data).slice(-16_384);
      if (loginOutput.includes("Logged in to ")) loginConfirmed = true;
      Queue.offerUnsafe(output, data);
    });
    const detachExit = process.onExit(({ exitCode }) => {
      Deferred.doneUnsafe(exited, Effect.succeed(exitCode));
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        detachData();
        detachExit();
      }).pipe(Effect.andThen(Effect.try(() => process.kill()).pipe(Effect.ignore))),
    );
    let transcript = "";
    let outputOffset = 0;
    const update = () =>
      context.setInteraction(
        { type: "terminal", id: "terminal", output: transcript, outputOffset },
        (response) =>
          response.type === "terminal"
            ? Effect.try({
                try: () => {
                  if (response.size) process.resize(response.size.cols, response.size.rows);
                  if (response.data) process.write(response.data);
                },
                catch: () => failure("respond", "The OMP sign-in terminal has closed."),
              })
            : Effect.void,
      );
    yield* update();
    yield* Queue.take(output).pipe(
      Effect.flatMap((data) => {
        outputOffset += data.length;
        transcript = (transcript + data).slice(-16_384);
        return update();
      }),
      Effect.forever,
      Effect.forkScoped,
    );
    if ((yield* Deferred.await(exited)) !== 0 || !loginConfirmed)
      return yield* failure("start", "OMP did not confirm that sign-in credentials were saved.");
  });

  const authenticate = (methodId: string, context: ProviderAuthFlow.ProviderAuthFlowContext) =>
    Effect.gen(function* () {
      if (!options.settings.enabled)
        return yield* failure("start", "Enable OMP before signing in.");
      if (methodId === "terminal") {
        yield* runTerminal(undefined, context).pipe(Effect.scoped);
      } else {
        const providers = yield* discover;
        if (!providers.some((provider) => provider.id === methodId))
          return yield* failure(
            "start",
            "This sign-in method is unavailable in the selected OMP profile.",
          );
        const requiresTerminal = yield* Effect.gen(function* () {
          const connection = yield* connect;
          const login = connection.request({ type: "login", providerId: methodId }, 0);
          const interactions = Queue.take(connection.events).pipe(
            Effect.flatMap((event) =>
              handleOmpLoginInteraction(event, connection, context, options.instanceId),
            ),
            Effect.forever,
          );
          return yield* Effect.raceFirst(login, interactions).pipe(
            Effect.as(false),
            Effect.catch((cause) => {
              const detail = "detail" in cause ? String(cause.detail) : "";
              if (/requires (secret input|interactive prompts)/.test(detail))
                return Effect.succeed(true);
              return Effect.fail(
                failure(
                  "start",
                  "OMP sign-in failed. Check the provider response in the sign-in terminal.",
                ),
              );
            }),
          );
        }).pipe(
          Effect.scoped,
          Effect.mapError(() => failure("start", "OMP sign-in failed.")),
        );
        if (requiresTerminal) yield* runTerminal(methodId, context).pipe(Effect.scoped);
      }
      yield* context.verifying;
      const verified = yield* discover;
      if (
        !verified.some(
          (provider) =>
            provider.authenticated && (methodId === "terminal" || provider.id === methodId),
        )
      )
        return yield* failure(
          "verify",
          "OMP did not confirm credentials for the selected profile.",
        );
      yield* options.onChanged;
    });
  const controller = yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "provider", key: options.credentialKey },
    methods,
    refreshMethodsAfterAuth: true,
    authenticate,
    logout: Effect.fail(failure("logout", "Use /logout in OMP to choose the account to sign out.")),
  });
  return {
    ...controller,
    refreshMethods: discover.pipe(
      Effect.result,
      Effect.flatMap((result) => {
        discovered = result;
        return controller.refreshMethods!;
      }),
    ),
  };
});
