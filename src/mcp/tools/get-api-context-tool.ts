import { z } from "zod";
import { Logger } from "~/utils/logger.js";
import type { OutputFormat } from "~/utils/serialize.js";
import type { OpenApiSource } from "~/services/openapi/load.js";
import { getApiContext as runGetApiContext } from "~/services/get-api-context.js";

// No spec URL/path parameter on purpose: the spec source is project-level
// config (--openapi). Accepting a URL here would let any prompt-injected
// content steer the server into fetching arbitrary addresses.
const parameters = {
  keywords: z
    .array(z.string())
    .optional()
    .describe(
      "Words taken from the design: visible text (headings, labels, placeholder values, status chips, button text) and semantic layer/component names. Chinese and English both work. Ranks candidate operations by relevance.",
    ),
  operationIds: z
    .array(z.string())
    .optional()
    .describe(
      "Operations to fetch in full: the `id` values from a previous result (operationId, or 'METHOD /path' when the spec has none). Defaults detail to 'full'.",
    ),
  tags: z.array(z.string()).optional().describe("Only include operations with one of these tags."),
  pathPrefix: z
    .string()
    .optional()
    .describe("Only include operations whose path starts with this, e.g. '/api/orders'."),
  detail: z
    .enum(["index", "full"])
    .optional()
    .describe(
      "'index' lists id/endpoint/summary only; 'full' adds params, body and response shapes. Defaults to 'full' when operationIds is given, otherwise 'index'.",
    ),
  limit: z.number().int().positive().max(200).optional().describe("Maximum operations to return."),
};

const parametersSchema = z.object(parameters);
export type GetApiContextParams = z.infer<typeof parametersSchema>;

async function getApiContext(
  params: GetApiContextParams,
  source: OpenApiSource,
  outputFormat: OutputFormat,
) {
  try {
    const input = parametersSchema.parse(params);
    Logger.log(`Fetching API context from ${source.location}`);
    const formatted = await runGetApiContext(source, input, outputFormat);
    return { content: [{ type: "text" as const, text: formatted }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    Logger.error(`Error fetching API context from ${source.location}:`, message);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Error fetching API context: ${message}` }],
    };
  }
}

export const getApiContextTool = {
  name: "get_api_context",
  description: [
    "Look up the project's backend HTTP API (from its OpenAPI/Swagger spec) so a Figma design can be wired to real data instead of hard-coded placeholder content.",
    "Workflow: (1) after get_figma_data, call with `keywords` gathered from the design to get a ranked index of candidate operations; (2) call again with the chosen `operationIds` to get parameters and response shapes; (3) bind UI elements to response fields.",
    "Notation is TypeScript-like: `field?` is optional (only marked when the spec declares required fields), a `#` key or `  # ` suffix is the field description/example, `[ {...} ]` is an array of objects, and a bare name like `Order` refers to the `schemas` section.",
  ].join(" "),
  parametersSchema,
  handler: getApiContext,
} as const;
