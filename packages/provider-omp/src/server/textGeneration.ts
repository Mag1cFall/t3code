import { TextGenerationError } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import type { OmpSettings } from "../settings.ts";
import { ompProbeArgs } from "./launch.ts";
import { makeOmpRpcConnection, OmpRpcError, type OmpRpcConnection } from "./rpc.ts";
import { field, splitModel, text, type OmpRecord } from "./wire.ts";

const isTextGenerationError = Schema.is(TextGenerationError);

// runOmpTextPrompt 等待当前请求及后台工作全部完成后读取最终文本
const runOmpTextPrompt = Effect.fn("runOmpTextPrompt")(function* (
  connection: OmpRpcConnection,
  prompt: string,
  images: ReadonlyArray<OmpRecord> = [],
) {
  const id = "t3-text-generation";
  yield* connection.request(
    { id, type: "prompt", message: prompt, ...(images.length ? { images } : {}) },
    0,
  );
  let completed = false;
  while (true) {
    const event = yield* Queue.take(connection.events);
    if (event.type === "extension_ui_request") {
      const method = text(event, "method");
      if (
        method === "select" ||
        method === "confirm" ||
        method === "input" ||
        method === "editor" ||
        method === "ask"
      ) {
        yield* connection.send({ type: "extension_ui_response", id: event.id, cancelled: true });
        return yield* new OmpRpcError({
          operation: "prompt",
          detail: "Background text generation requires interactive input.",
        });
      }
    }
    if (event.type === "prompt_result" && event.id === id) {
      if (event.status !== "completed")
        return yield* new OmpRpcError({
          operation: "prompt",
          detail: text(field(event, "error"), "message") ?? "OMP text generation did not complete.",
        });
      completed = true;
      if (event.sessionSettled === true) break;
    }
    if (event.type === "session_settled" && completed) break;
  }
  const response = yield* connection.request({ type: "get_last_assistant_text" });
  const reply = text(response, "text")?.trim();
  if (!reply)
    return yield* new OmpRpcError({
      operation: "prompt",
      detail: "OMP returned an empty response.",
    });
  return reply;
});

// makeOmpTextGeneration 通过原生无工具会话生成标题及版本控制内容
export const makeOmpTextGeneration = Effect.fn("makeOmpTextGeneration")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const host = yield* ProviderHost.ProviderHost;
  const run: TextGenerationOperations.Runner = (request) =>
    Effect.gen(function* () {
      if (!settings.enabled)
        return yield* new TextGenerationError({
          operation: request.operation,
          detail: "Enable OMP before generating text.",
        });
      const connection = yield* makeOmpRpcConnection({
        command: settings.binaryPath,
        args: ompProbeArgs(settings),
        env: environment,
        cwd: request.cwd,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      if (request.modelSelection.model !== "default") {
        const model = yield* Effect.try({
          try: () => splitModel(request.modelSelection.model),
          catch: () =>
            new TextGenerationError({
              operation: request.operation,
              detail: "OMP models must use the provider/model format.",
            }),
        });
        yield* connection.request({ type: "set_model", ...model });
      }
      const thinking = getModelSelectionStringOptionValue(request.modelSelection, "thinking");
      if (thinking !== undefined)
        yield* connection.request({ type: "set_thinking_level", level: thinking });
      const images: OmpRecord[] = [];
      for (const attachment of request.attachments ?? []) {
        if (attachment.type !== "image") continue;
        const path = host.resolveAttachmentPath(attachment);
        if (path === null)
          return yield* new TextGenerationError({
            operation: request.operation,
            detail: "Failed to read an image attachment for text generation.",
          });
        const bytes = yield* fs.readFile(path);
        images.push({
          type: "image",
          data: Buffer.from(bytes).toString("base64"),
          mimeType: attachment.mimeType,
        });
      }
      const reply = yield* runOmpTextPrompt(connection, request.prompt, images);
      return yield* TextGenerationOperations.decodeJsonReply(request, "OMP", reply);
    }).pipe(
      Effect.timeoutOrElse({
        duration: "180 seconds",
        orElse: () =>
          Effect.fail(
            new TextGenerationError({
              operation: request.operation,
              detail: "OMP text generation timed out.",
            }),
          ),
      }),
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation: request.operation,
              detail: "OMP text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );
  return TextGenerationOperations.fromRunner(
    "OmpTextGeneration",
    TextGenerationOperations.withoutInvestigation("OMP", run),
  );
});
