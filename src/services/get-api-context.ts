import { loadOpenApiDocument, type OpenApiDocument, type OpenApiSource } from "./openapi/load.js";
import {
  schemaClosure,
  simplifyOpenApi,
  type SimplifiedApi,
  type SimplifiedOperation,
} from "./openapi/simplify.js";
import { buildSearchIndex, searchOperations, type SearchIndex } from "./openapi/search.js";
import { serializeResult, type OutputFormat } from "~/utils/serialize.js";

export type ApiDetail = "index" | "full";

export type GetApiContextInput = {
  keywords?: string[];
  operationIds?: string[];
  tags?: string[];
  pathPrefix?: string;
  detail?: ApiDetail;
  limit?: number;
};

// Index entries are ~3 lines each, full entries can be 50+; the defaults keep a
// single response well inside a typical context budget.
const DEFAULT_SEARCH_LIMIT = 15;
const DEFAULT_BROWSE_LIMIT = 50;
const DEFAULT_FULL_LIMIT = 15;

type PreparedApi = { api: SimplifiedApi; index: SearchIndex };

// Keyed on the loader's cached document object, so simplification and indexing
// run once per spec version rather than once per tool call.
const preparedCache = new WeakMap<OpenApiDocument, PreparedApi>();

export function prepareApi(doc: OpenApiDocument): PreparedApi {
  let prepared = preparedCache.get(doc);
  if (!prepared) {
    const api = simplifyOpenApi(doc);
    prepared = { api, index: buildSearchIndex(api) };
    preparedCache.set(doc, prepared);
  }
  return prepared;
}

/**
 * Shared pipeline for "get api context": load spec → simplify (memoized) →
 * select operations → serialize. Used by the MCP `get_api_context` tool and the
 * `api` CLI command.
 */
export async function getApiContext(
  source: OpenApiSource,
  input: GetApiContextInput,
  outputFormat: OutputFormat,
): Promise<string> {
  const { api, index } = prepareApi(await loadOpenApiDocument(source));
  // The tree format is specific to Figma node trees; API context reads fine as YAML.
  return serializeResult(
    buildApiContext(api, index, input),
    outputFormat === "json" ? "json" : "yaml",
  );
}

export function buildApiContext(
  api: SimplifiedApi,
  index: SearchIndex,
  input: GetApiContextInput,
): Record<string, unknown> {
  const { keywords = [], operationIds = [], tags = [], pathPrefix } = input;
  let candidates = api.operations;
  const notFound: string[] = [];

  if (operationIds.length > 0) {
    const byKey = new Map<string, SimplifiedOperation>();
    for (const op of api.operations) {
      byKey.set(op.id.toLowerCase(), op);
      byKey.set(`${op.method} ${op.path}`.toLowerCase(), op);
    }
    const selected = new Set<SimplifiedOperation>();
    for (const id of operationIds) {
      const op = byKey.get(id.trim().replace(/\s+/g, " ").toLowerCase());
      if (op) selected.add(op);
      else notFound.push(id);
    }
    candidates = [...selected];
  }
  if (tags.length > 0) {
    const wanted = new Set(tags.map((t) => t.toLowerCase()));
    candidates = candidates.filter((op) => op.tags?.some((t) => wanted.has(t.toLowerCase())));
  }
  if (pathPrefix) {
    candidates = candidates.filter((op) => op.path.startsWith(pathPrefix));
  }

  const matchedBy = new Map<string, string>();
  if (keywords.length > 0) {
    const byId = new Map(candidates.map((op) => [op.id, op]));
    const hits = searchOperations(api, index, byId.keys(), keywords);
    candidates = hits.map((hit) => byId.get(hit.id)!);
    hits.forEach((hit) => matchedBy.set(hit.id, hit.matched.join(", ")));
  }

  const detail: ApiDetail = input.detail ?? (operationIds.length > 0 ? "full" : "index");
  const limit =
    input.limit ??
    (operationIds.length > 0
      ? candidates.length
      : keywords.length > 0
        ? DEFAULT_SEARCH_LIMIT
        : detail === "full"
          ? DEFAULT_FULL_LIMIT
          : DEFAULT_BROWSE_LIMIT);
  const shown = candidates.slice(0, limit);

  const out: Record<string, unknown> = { api: compact(api.info) };

  const isBrowsing =
    detail === "index" && !keywords.length && !operationIds.length && !tags.length && !pathPrefix;
  if (isBrowsing) out.tags = countTags(api.operations);

  if (detail === "index") {
    out.operations = shown.map((op) =>
      compact({
        id: op.id,
        endpoint: `${op.method} ${op.path}`,
        summary: op.summary,
        deprecated: op.deprecated,
        matched: matchedBy.get(op.id),
      }),
    );
  } else {
    out.operations = shown.map((op) => formatOperation(op, matchedBy.get(op.id)));
    const names = schemaClosure(
      api,
      shown.flatMap((op) => [...(api.operationRefs.get(op.id) ?? [])]),
    );
    if (names.size > 0) {
      out.schemas = Object.fromEntries(
        Object.entries(api.schemas).filter(([name]) => names.has(name)),
      );
    }
  }

  if (shown.length < candidates.length) {
    out.truncated = `Showing ${shown.length} of ${candidates.length}. Narrow with keywords/tags/pathPrefix or raise limit.`;
  }
  if (notFound.length > 0) out.notFound = notFound;
  if (api.externalRefs.length > 0) {
    const sample = api.externalRefs.slice(0, 3).join(", ");
    out.warning =
      `This spec is split across files (${api.externalRefs.length} external $ref, e.g. ${sample}); those parts show as unresolved(...). ` +
      "Ask the user for a single-file export, or to bundle it: npx @redocly/cli bundle <main file> -o openapi.bundled.yaml";
  }
  if (keywords.length > 0 && candidates.length === 0) {
    out.hint =
      "No operation matched these keywords. Only Chinese runs of 2+ characters and words/numbers of 3+ characters are searched. Try business nouns or English field names from the design, or call without keywords to browse by tag.";
  }
  return out;
}

function formatOperation(op: SimplifiedOperation, matched: string | undefined) {
  return compact({
    id: op.id,
    endpoint: `${op.method} ${op.path}`,
    summary: op.summary,
    description: op.description,
    tags: op.tags,
    deprecated: op.deprecated,
    auth: op.auth,
    matched,
    params: op.params,
    body: op.body,
    bodyType: op.bodyType,
    response: op.response,
    responseStatus: op.responseStatus,
    errors: op.errors,
  });
}

function countTags(operations: SimplifiedOperation[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const op of operations) {
    for (const tag of op.tags ?? ["(untagged)"]) counts[tag] = (counts[tag] ?? 0) + 1;
  }
  return counts;
}

/** Drop undefined fields — js-yaml refuses to dump them, and they're noise in JSON. */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
