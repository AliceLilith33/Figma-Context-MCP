import { stat, readFile } from "fs/promises";
import yaml from "js-yaml";
import { tagError } from "~/utils/error-meta.js";

/**
 * Where the OpenAPI document comes from: the server default (CLI flag / env) or
 * a per-call `spec`, vetted by `resolveSpecSource` in source.ts.
 */
export type OpenApiSource = {
  /** Local file path or http(s) URL. */
  location: string;
  /** Extra request headers used only when `location` is a URL (e.g. auth for internal docs). */
  headers?: Record<string, string>;
};

export type OpenApiDocument = Record<string, unknown> & { paths: Record<string, unknown> };

// Remote specs are re-fetched at most this often. Local files are keyed on
// mtime instead, so edits show up on the next call with no staleness.
const URL_TTL_MS = 60_000;
// A hung docs server would otherwise hang the tool call indefinitely.
const FETCH_TIMEOUT_MS = 30_000;

// Calls can name their own spec, so a long session may touch several; keep the
// most recently used ones rather than every spec ever loaded.
const MAX_CACHED_SPECS = 10;

type CacheEntry = { version: number; doc: OpenApiDocument };
const cache = new Map<string, CacheEntry>();

function remember(location: string, entry: CacheEntry): void {
  // Map iteration order is insertion order: re-inserting marks it most recent.
  cache.delete(location);
  cache.set(location, entry);
  if (cache.size > MAX_CACHED_SPECS) cache.delete(cache.keys().next().value!);
}

export function isUrl(location: string): boolean {
  return /^https?:\/\//i.test(location);
}

/**
 * Load and parse an OpenAPI 3.x / Swagger 2.0 document. Cached at module level
 * (not per server instance) because HTTP mode builds a fresh McpServer for
 * every request — a per-instance cache would never hit.
 *
 * Returns the same object identity while the cache is valid so downstream
 * work (simplification, search indexing) can be memoized on it with a WeakMap.
 */
export async function loadOpenApiDocument(source: OpenApiSource): Promise<OpenApiDocument> {
  const { location } = source;
  const cached = cache.get(location);

  if (isUrl(location)) {
    if (cached && Date.now() - cached.version < URL_TTL_MS) {
      remember(location, cached);
      return cached.doc;
    }
    let doc: OpenApiDocument;
    try {
      doc = parseDocument(await fetchText(location, source.headers), redactUrl(location));
    } catch (error) {
      // A dev backend restarting shouldn't break a session that already has
      // a good copy; keep serving it and retry after the next TTL window.
      if (!cached) throw error;
      cached.version = Date.now();
      return cached.doc;
    }
    remember(location, { version: Date.now(), doc });
    return doc;
  }

  // mtime, not a TTL: re-exporting the spec over the same file is picked up on
  // the very next call.
  const { mtimeMs } = await stat(location);
  if (cached && cached.version === mtimeMs) {
    remember(location, cached);
    return cached.doc;
  }
  const doc = parseDocument(await readFile(location, "utf8"), location);
  remember(location, { version: mtimeMs, doc });
  return doc;
}

/** Error messages reach the LLM and logs; a `?token=` in the spec URL must not. */
export function redactUrl(url: string): string {
  return url.replace(/[?#].*$/, "");
}

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    // undici's bare "fetch failed" hides the useful part in `cause` (ECONNREFUSED etc.).
    const cause = error instanceof Error ? (error.cause ?? error) : error;
    const reason = cause instanceof Error ? cause.message : String(cause);
    const wrapped = new Error(`Failed to fetch OpenAPI document from ${redactUrl(url)}: ${reason}`);
    tagError(wrapped, { category: "network" });
  }
  if (!response.ok) {
    // Deliberately no response body in the message: internal doc servers can
    // echo request headers (our auth header) back in error pages.
    const error = new Error(
      `Failed to fetch OpenAPI document from ${redactUrl(url)}: ${response.status} ${response.statusText}`,
    );
    tagError(error, { http_status: response.status, category: "network" });
  }
  return response.text();
}

/**
 * js-yaml parses JSON too (YAML 1.2 is a JSON superset), so one parser covers
 * both formats. CORE_SCHEMA rather than the default schema: the default turns
 * unquoted dates in `example`/`enum` values into Date objects.
 */
export function parseDocument(text: string, location: string): OpenApiDocument {
  // A saved Swagger UI / Redoc / knife4j page is the most common wrong file.
  // Caught before parsing so the error says what to do, not "bad YAML at line 1".
  // `\s` also matches a leading BOM.
  if (/^\s*</.test(text)) {
    throw new Error(
      `${location} is an HTML/XML page, not an OpenAPI document. ` +
        "From Swagger UI, use the spec link under the page title (e.g. /v3/api-docs or /swagger.json) or save what it returns as a file; " +
        "from knife4j, export the offline document in OpenAPI format.",
    );
  }

  let doc: unknown;
  try {
    doc = yaml.load(text, { schema: yaml.CORE_SCHEMA });
  } catch (error) {
    // Only reason + position: js-yaml's full message quotes source lines, and
    // a URL that answers 200 with an HTML login/error page would leak that
    // page (possibly echoing our auth header) into the tool result.
    const { reason, mark } = error as { reason?: string; mark?: { line: number; column: number } };
    const where = mark ? ` at line ${mark.line + 1}, column ${mark.column + 1}` : "";
    throw new Error(
      `Failed to parse OpenAPI document ${location}: ${reason ?? "invalid JSON/YAML"}${where}. ` +
        `If this is a URL, make sure it returns the spec itself (e.g. /v3/api-docs), not a Swagger UI or login page.`,
    );
  }

  const record = doc as Record<string, unknown> | null;
  // Hand-written specs often leave the version unquoted (`swagger: 2.0`,
  // `openapi: 3.0`), which CORE_SCHEMA reads as the numbers 2 and 3.
  const isOas3 = /^3(\.|$)/.test(String(record?.openapi ?? ""));
  const isSwagger2 = /^2(\.0)?$/.test(String(record?.swagger ?? ""));
  if (!isOas3 && !isSwagger2) {
    const info = record?.info as Record<string, unknown> | undefined;
    if (info?._postman_id !== undefined || String(info?.schema ?? "").includes("getpostman")) {
      throw new Error(
        `${location} is a Postman collection, not an OpenAPI document. Export the API as OpenAPI 3 or Swagger 2.0 instead.`,
      );
    }
    throw new Error(
      `${location} is not an OpenAPI 3.x or Swagger 2.0 document (missing "openapi: 3.x" or "swagger: 2.0").`,
    );
  }
  if (!record!.paths || typeof record!.paths !== "object") {
    throw new Error(`${location} has no "paths" section.`);
  }
  return record as OpenApiDocument;
}
