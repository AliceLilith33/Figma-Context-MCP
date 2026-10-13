import { z } from "zod";
import { Logger } from "~/utils/logger.js";
import type { OutputFormat } from "~/utils/serialize.js";
import { redactUrl } from "~/services/openapi/load.js";
import { resolveSpecSource, type SpecPolicy } from "~/services/openapi/source.js";
import { getApiContext as runGetApiContext } from "~/services/get-api-context.js";

const parameters = {
  spec: z
    .string()
    .optional()
    .describe(
      "Where the OpenAPI/Swagger spec is: absolute path of a spec file (JSON or YAML, e.g. an exported swagger.json) or the URL serving the spec itself. Omit to use the server's configured spec. Pass the same value on every call.",
    ),
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
  policy: SpecPolicy,
  outputFormat: OutputFormat,
) {
  try {
    const { spec, ...input } = parametersSchema.parse(params);
    const source = await resolveSpecSource(spec, policy);
    Logger.log(`Fetching API context from ${source.location}`);
    const formatted = await runGetApiContext(source, input, outputFormat);
    return { content: [{ type: "text" as const, text: formatted }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    Logger.error("Error fetching API context:", message);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Error fetching API context: ${message}` }],
    };
  }
}

function getDescription(policy: SpecPolicy): string {
  // Naming the default lets the agent tell whether it's the spec the user means,
  // and gives other tools (e.g. a mock generator) the same document to read.
  const configured = policy.configured && redactUrl(policy.configured.location);
  const specSource = !policy.allowPerCall
    ? `This server serves one configured spec (${configured}); do not pass \`spec\`.`
    : configured
      ? `Uses the server's configured spec (${configured}) unless \`spec\` names another one (e.g. a file the user exported).`
      : "No spec is configured: pass `spec` on every call. If you don't know where the spec is, look for it in the project or ask the user; the error message explains how.";
  return [
    "Look up the project's backend HTTP API (from its OpenAPI/Swagger spec) so a Figma design can be wired to real data instead of hard-coded placeholder content.",
    specSource,
    "Workflow: (1) after get_figma_data, call with `keywords` gathered from the design to get a ranked index of candidate operations; (2) call again with the chosen `operationIds` to get parameters and response shapes; (3) bind UI elements to response fields.",
    "Notation is TypeScript-like: `field?` is optional (only marked when the spec declares required fields), a `#` key or `  # ` suffix is the field description/example, `[ {...} ]` is an array of objects, and a bare name like `Order` refers to the `schemas` section.",
  ].join(" ");
}

export const getApiContextTool = {
  name: "get_api_context",
  getDescription,
  parametersSchema,
  handler: getApiContext,
} as const;
