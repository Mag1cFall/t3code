import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import { T3_MCP_TOOL_NAMES } from "@t3tools/shared/t3McpToolPresentation";

const T3_MCP_NAME = "t3-code";
const OMP_T3_MCP_SERVER_NAME = `${T3_MCP_NAME}:${T3_MCP_NAME}`;
const OMP_T3_MCP_TOOL_PREFIX = `mcp__${OMP_T3_MCP_SERVER_NAME.replace(/[^a-z0-9_]+/gu, "_")}_`;

// ompT3McpToolName 将注入插件的原生工具身份映射为共享 T3 MCP 标识
export function ompT3McpToolName(
  nativeName: string,
  serverName?: string,
  mcpToolName?: string,
): string | undefined {
  const tool =
    serverName === undefined
      ? nativeName.startsWith(OMP_T3_MCP_TOOL_PREFIX)
        ? nativeName.slice(OMP_T3_MCP_TOOL_PREFIX.length)
        : undefined
      : serverName === OMP_T3_MCP_SERVER_NAME
        ? mcpToolName
        : undefined;
  return tool !== undefined && T3_MCP_TOOL_NAMES.has(tool)
    ? `mcp__${T3_MCP_NAME}__${tool}`
    : undefined;
}

const encodePlugin = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      $schema: Schema.String,
      name: Schema.String,
      version: Schema.String,
    }),
  ),
);
const encodeMcp = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      $schema: Schema.String,
      mcpServers: Schema.Struct({
        [T3_MCP_NAME]: Schema.Struct({
          type: Schema.Literal("streamable-http"),
          url: Schema.String,
          headers: Schema.Struct({ Authorization: Schema.String }),
        }),
      }),
    }),
  ),
);

// makeOmpMcpPlugin 为单个会话提供 OMP 原生读取的 MCP 插件目录
export const makeOmpMcpPlugin = Effect.fn("makeOmpMcpPlugin")(function* (
  cacheDir: string,
  session: McpProviderSessionConfig,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(cacheDir, { recursive: true });
  const directory = yield* fs.makeTempDirectoryScoped({ directory: cacheDir, prefix: "omp-mcp-" });
  yield* fs.writeFileString(
    path.join(directory, "plugin.json"),
    yield* encodePlugin({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: T3_MCP_NAME,
      version: "1.0.0",
    }),
  );
  yield* fs.writeFileString(
    path.join(directory, "mcp.json"),
    yield* encodeMcp({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        [T3_MCP_NAME]: {
          type: "streamable-http",
          url: session.endpoint,
          headers: { Authorization: session.authorizationHeader },
        },
      },
    }),
  );
  return directory;
});
