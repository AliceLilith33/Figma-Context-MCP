import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FigmaService, type FigmaAuthOptions } from "../services/figma.js";
import { Logger } from "../utils/logger.js";
import { authMode, type AuthMode, type ClientInfo, type Transport } from "~/telemetry/index.js";
import type { OutputFormat } from "~/utils/serialize.js";
import type { OpenApiSource } from "~/services/openapi/load.js";
import type { SpecPolicy } from "~/services/openapi/source.js";
import { installValidationRejectCapture } from "./validation-capture.js";
import type { ToolExtra } from "./progress.js";
import {
  downloadFigmaImagesTool,
  getApiContextTool,
  getFigmaDataTool,
  type DownloadImagesParams,
  type GetApiContextParams,
  type GetFigmaDataParams,
} from "./tools/index.js";
import { implementDesignWithApiPrompt } from "./prompts/implement-design-with-api.js";

const serverInfo = {
  name: "Figma MCP Server",
  version: process.env.NPM_PACKAGE_VERSION ?? "unknown",
  description:
    "Gives AI coding agents access to Figma design data, providing layout, styling, and content information for implementing designs.",
};

type ServerTransport = Extract<Transport, "stdio" | "http">;

export type CreateServerOptions = {
  transport: ServerTransport;
  outputFormat?: OutputFormat;
  skipImageDownloads?: boolean;
  imageDir?: string;
  /** Default OpenAPI spec for get_api_context (calls may name their own; see `openapiAllowDynamic`). */
  openapi?: OpenApiSource;
  /**
   * Let HTTP-mode calls name their own spec. stdio always allows it — see
   * `SpecPolicy.allowPerCall` for why the transports differ.
   */
  openapiAllowDynamic?: boolean;
};

function createServer(
  authOptions: FigmaAuthOptions,
  {
    transport,
    outputFormat = "tree",
    skipImageDownloads = false,
    imageDir,
    openapi,
    openapiAllowDynamic = false,
  }: CreateServerOptions,
) {
  const server = new McpServer(serverInfo);
  const figmaService = new FigmaService(authOptions);
  const mode = authMode(authOptions);

  const getClientInfo = (): ClientInfo | undefined => {
    const info = server.server.getClientVersion();
    if (!info) return undefined;
    return { name: info.name, version: info.version };
  };

  registerTools(server, figmaService, {
    transport,
    authMode: mode,
    outputFormat,
    skipImageDownloads,
    imageDir,
    specPolicy: {
      configured: openapi,
      allowPerCall: transport === "stdio" || openapiAllowDynamic,
    },
    getClientInfo,
  });

  installValidationRejectCapture(server, {
    transport,
    authMode: mode,
    outputFormat,
    getClientInfo,
  });

  Logger.isHTTP = transport !== "stdio";

  return server;
}

type RegisterToolsOptions = {
  transport: ServerTransport;
  authMode: AuthMode;
  outputFormat: OutputFormat;
  skipImageDownloads: boolean;
  imageDir?: string;
  specPolicy: SpecPolicy;
  getClientInfo: () => ClientInfo | undefined;
};

function registerTools(
  server: McpServer,
  figmaService: FigmaService,
  options: RegisterToolsOptions,
): void {
  server.registerTool(
    getFigmaDataTool.name,
    {
      title: "Get Figma Data",
      description: getFigmaDataTool.description,
      inputSchema: getFigmaDataTool.parametersSchema,
      annotations: { readOnlyHint: true },
    },
    (params: GetFigmaDataParams, extra: ToolExtra) =>
      getFigmaDataTool.handler(
        params,
        figmaService,
        options.outputFormat,
        options.transport,
        options.authMode,
        options.getClientInfo(),
        extra,
      ),
  );

  if (!options.skipImageDownloads) {
    server.registerTool(
      downloadFigmaImagesTool.name,
      {
        title: "Download Figma Images",
        description: downloadFigmaImagesTool.getDescription(options.imageDir),
        inputSchema: downloadFigmaImagesTool.parametersSchema,
        annotations: { openWorldHint: true },
      },
      (params: DownloadImagesParams, extra: ToolExtra) =>
        downloadFigmaImagesTool.handler(
          params,
          figmaService,
          options.imageDir,
          options.transport,
          options.authMode,
          options.getClientInfo(),
          extra,
        ),
    );
  }

  const { specPolicy } = options;
  // Without a default spec or per-call specs, every call would fail; don't
  // advertise a tool that can't work.
  if (specPolicy.configured || specPolicy.allowPerCall) {
    server.registerTool(
      getApiContextTool.name,
      {
        title: "Get API Context",
        description: getApiContextTool.getDescription(specPolicy),
        inputSchema: getApiContextTool.parametersSchema,
        annotations: { readOnlyHint: true },
      },
      (params: GetApiContextParams) =>
        getApiContextTool.handler(params, specPolicy, options.outputFormat),
    );

    server.registerPrompt(
      implementDesignWithApiPrompt.name,
      {
        title: implementDesignWithApiPrompt.title,
        description: implementDesignWithApiPrompt.description,
        argsSchema: implementDesignWithApiPrompt.argsSchema,
      },
      (args) => implementDesignWithApiPrompt.build(args, specPolicy),
    );
  }
}

export { createServer };
