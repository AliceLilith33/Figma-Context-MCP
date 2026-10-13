import { type Command, command } from "cleye";
import { loadEnvFile, parseOutputFormat, resolveOpenApiSource, UsageError } from "~/config.js";
import { getApiContext, type ApiDetail } from "~/services/get-api-context.js";

/**
 * Prints exactly what get_api_context would return. Mainly a tool for checking
 * how well a spec reads after simplification, and for tuning keyword search
 * against a real spec without going through an MCP client.
 */
export const apiCommand: Command = command(
  {
    name: "api",
    description: "Print simplified OpenAPI context (what get_api_context returns) to stdout",
    flags: {
      openapi: {
        type: String,
        description: "OpenAPI/Swagger spec file path or URL (defaults to OPENAPI_SPEC)",
      },
      openapiHeader: {
        type: String,
        description: 'Request header for fetching the spec URL, e.g. "Authorization: Bearer xxx"',
      },
      keywords: {
        type: String,
        description: "Comma-separated keywords to rank operations by",
      },
      operationIds: {
        type: String,
        description: "Comma-separated operation ids to show in full",
      },
      tags: {
        type: String,
        description: "Comma-separated tags to filter by",
      },
      pathPrefix: {
        type: String,
        description: "Only operations whose path starts with this",
      },
      detail: {
        type: String,
        description: "index or full",
      },
      limit: {
        type: Number,
        description: "Maximum operations to return",
      },
      format: {
        type: String,
        description: "Output format: yaml (default) or json",
      },
      env: {
        type: String,
        description: "Path to .env file",
      },
    },
  },
  (argv) => {
    run(argv.flags).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  },
);

async function run(flags: {
  openapi?: string;
  openapiHeader?: string;
  keywords?: string;
  operationIds?: string;
  tags?: string;
  pathPrefix?: string;
  detail?: string;
  limit?: number;
  format?: string;
  env?: string;
}) {
  loadEnvFile(flags.env);
  const source = resolveOpenApiSource(flags).value;
  if (!source) throw new UsageError("An OpenAPI spec is required (--openapi or OPENAPI_SPEC)");
  if (flags.detail !== undefined && flags.detail !== "index" && flags.detail !== "full") {
    throw new UsageError(`Invalid --detail '${flags.detail}'. Expected index or full.`);
  }
  if (flags.limit !== undefined && !(Number.isInteger(flags.limit) && flags.limit > 0)) {
    throw new UsageError(`Invalid --limit '${flags.limit}'. Expected a positive integer.`);
  }

  const output = await getApiContext(
    source,
    {
      keywords: splitList(flags.keywords),
      operationIds: splitList(flags.operationIds),
      tags: splitList(flags.tags),
      pathPrefix: flags.pathPrefix,
      detail: flags.detail as ApiDetail | undefined,
      limit: flags.limit,
    },
    parseOutputFormat(flags.format, "--format") ?? "yaml",
  );
  console.log(output);
}

function splitList(value: string | undefined): string[] | undefined {
  const items = value
    ?.split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return items && items.length > 0 ? items : undefined;
}
