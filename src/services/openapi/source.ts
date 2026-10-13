import { readdir, stat } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { isUrl, redactUrl, type OpenApiSource } from "./load.js";

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
  // "Copy as path" in Windows Explorer wraps the path in quotes.
  const requested = spec?.trim().replace(/^(["'])(.*)\1$/, "$2");
  const { configured } = policy;

  if (!requested) {
    if (configured) return configured;
    throw new SpecSourceError(MISSING_SPEC_MESSAGE);
  }
  const filePath = isUrl(requested) ? undefined : toAbsolutePath(requested);
  // Agents often echo the default back (the tool description names it); that's
  // not a per-call spec.
  if (configured && isConfigured(requested, filePath, configured.location)) return configured;
  if (!policy.allowPerCall) {
    // No default and no per-call specs means the tool isn't registered at all.
    throw new SpecSourceError(
      `This server only serves its configured OpenAPI spec (${redactUrl(configured?.location ?? "")}). Call get_api_context without \`spec\`.`,
    );
  }

  if (isUrl(requested)) return { location: requested, headers: headersFor(requested, configured) };

  if (!filePath) {
    throw new SpecSourceError(
      `"${requested}" is not an absolute path (on Windows, include the drive letter, e.g. E:/work/app/swagger.json). ` +
        "Relative paths would resolve against the MCP server's working directory, not the project.",
    );
  }
  await assertSpecFile(filePath);
  return { location: filePath };
}

/** Absolute, resolved form (as config.ts gives the default), or undefined if relative. */
function toAbsolutePath(input: string): string | undefined {
  let filePath = /^file:/i.test(input) ? fileURLToPath(input) : input;
  if (process.platform === "win32") {
    // Git Bash spells E:\work as /e/work, and it's the shell Claude Code uses
    // on Windows; Node would read it as E:\e\work on the current drive.
    filePath = filePath.replace(
      /^\/([a-z])(?=\/|$)/i,
      (_, drive: string) => `${drive.toUpperCase()}:`,
    );
    // `\work\x.json` counts as absolute to Node but depends on the server's
    // current drive — the same trap as a relative path.
    if (!/^([a-z]:[\\/]|[\\/]{2})/i.test(filePath)) return undefined;
  } else if (!path.isAbsolute(filePath)) {
    return undefined;
  }
  return path.resolve(filePath);
}

function isConfigured(
  requested: string,
  filePath: string | undefined,
  configured: string,
): boolean {
  // The description shows the default redacted, so that form counts as the default too.
  if (isUrl(configured)) return requested === configured || requested === redactUrl(configured);
  if (!filePath) return false;
  return process.platform === "win32"
    ? filePath.toLowerCase() === configured.toLowerCase()
    : filePath === configured;
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
