import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// OmpSettings 定义 OMP 实例的可执行文件与配置档案
export const OmpSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("omp").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the OMP coding agent binary.",
        providerSettingsForm: { placeholder: "omp", clearWhenEmpty: "omit" },
      }),
    ),
    profile: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Profile",
        description: "OMP profile name. Leave empty to use the default profile.",
        providerSettingsForm: { clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  { order: ["binaryPath", "profile"] },
);
export type OmpSettings = typeof OmpSettings.Type;
