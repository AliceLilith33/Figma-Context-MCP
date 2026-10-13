import { readdir, stat } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { isUrl, type OpenApiSource } from "./load.js";

/**
 * Where a `get_api_context` call may read its spec from.
 *
 * The spec is usually project-specific and often handed over in conversation
 * ("here's the exported swagger.json"), so calls may name it themselves; the
 * server-level `--openapi` is just the default.
 */
export type SpecPolicy = {
  /** From --openapi / OPENAPI_SPEC; used when a call names no spec. */
  configured?: OpenApiSource;
  /**
   * Whether a call may name its own spec. Off for HTTP servers by default: a
   * shared server would otherwise read files and reach URLs on its own host on
   * behalf of whoever can talk to it. In stdio mode the agent already has the
   * user's file and network access, so the param adds no new reach.
   */
  allowPerCall: boolean;
};

export class SpecSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecSourceError";
  }
}

// Read by the agent, which decides what to do next — hence the explicit steps.
const MISSING_SPEC_MESSAGE =
  "No OpenAPI spec given. Pass `spec`: the absolute path of a spec file (e.g. an exported swagger.json or openapi.yaml) " +
  "or the URL that serves the spec itself (e.g. http://host/v3/api-docs, not the Swagger UI page). " +
  "To find it: check the project's conventions doc for a recorded spec location, then look for files such as " +
  "openapi.* / swagger.* / api-docs*.json in the project. If none is found, ask the user where the spec is instead of guessing, " +
  "and once known, record it in the project conventions so later sessions reuse it.";

const MAX_LISTED_FILES = 10;

/** Pick the spec for one call: the call's own `spec`, else the configured default. */
export async function resolveSpecSource(
  spec: string | undefined,
  policy: SpecPolicy,
): Promise<OpenApiSource> {
  const requested = spec?.trim();
  const { configured } = policy;

  if (!requested) {
    if (configured) return configured;
    throw new SpecSourceError(MISSING_SPEC_MESSAGE);
  }
  // Agents often echo the default back (the tool description names it); that's
  // not a per-call spec, even if spelled with different slashes.
  if (configured && sameLocation(requested, configured.location)) return configured;
  if (!policy.allowPerCall) {
    throw new SpecSourceError(
      configured
        ? "This server only serves its configured OpenAPI spec. Call get_api_context without `spec`."
        : "This server has no OpenAPI spec configured and does not accept `spec` per call (HTTP mode). " +
          "Restart it with --openapi=<spec>, or with --openapi-allow-dynamic to accept `spec`.",
    );
  }

  if (isUrl(requested)) return { location: requested, headers: headersFor(requested, configured) };

  const filePath = /^file:/i.test(requested) ? fileURLToPath(requested) : requested;
  if (!path.isAbsolute(filePath)) {
    throw new SpecSourceError(
      `"${requested}" is a relative path. Pass an absolute path: relative paths would resolve against the MCP server's working directory, not the project.`,
    );
  }
  await assertSpecFile(filePath);
  // Same form config.ts gives the default, so one file is one cache entry.
  return { location: path.resolve(filePath) };
}

/** Configured file locations are already absolute and resolved (config.ts). */
function sameLocation(requested: string, configured: string): boolean {
  if (isUrl(requested) || isUrl(configured)) return requested === configured;
  return path.isAbsolute(requested) && path.resolve(requested) === configured;
}

/**
 * The configured auth header goes only to the configured spec's origin. The
 * agent chooses per-call URLs, so forwarding it elsewhere would hand the
 * token to whatever host a prompt-injected URL names.
 */
function headersFor(
  url: string,
  configured: OpenApiSource | undefined,
): Record<string, string> | undefined {
  if (!configured?.headers || !isUrl(configured.location)) return undefined;
  return new URL(url).origin === new URL(configured.location).origin
    ? configured.headers
    : undefined;
}

async function assertSpecFile(filePath: string): Promise<void> {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new SpecSourceError(`OpenAPI spec file not found: ${filePath}`);
  }
  if (!info.isDirectory()) return;

  // Users often point at the folder they exported into; listing its spec-like
  // files lets the agent pick one (or ask) without another round of searching.
  const candidates = (await readdir(filePath))
    .filter((name) => /\.(json|ya?ml)$/i.test(name))
    .sort((a, b) => specLikeness(b) - specLikeness(a))
    .slice(0, MAX_LISTED_FILES);
  throw new SpecSourceError(
    `${filePath} is a directory; pass the spec file itself.` +
      (candidates.length > 0
        ? ` JSON/YAML files there: ${candidates.join(", ")}`
        : " It has no JSON/YAML files."),
  );
}

function specLikeness(name: string): number {
  return /openapi|swagger|api-docs/i.test(name) ? 1 : 0;
}
