import type { OpenApiDocument } from "./load.js";

/**
 * Compact, TypeScript-flavoured rendering of a JSON Schema:
 *   - leaf types are strings: `integer`, `string<date-time>`, `"PAID" | "REFUNDED"`, `Order[]`
 *   - objects are maps of field → TypeExpr; a `?` key suffix marks an optional field
 *     and a `"#"` key carries the object's description
 *   - arrays of objects are single-element arrays: `[ { id: integer } ]`
 *   - a bare schema name (e.g. `Order`) points into `SimplifiedApi.schemas`
 *
 * LLMs already read TS types fluently, so this costs a fraction of the tokens of
 * raw JSON Schema without losing what they need to wire data into UI.
 */
export type TypeExpr = string | TypeExpr[] | { [key: string]: TypeExpr };

export type ParamLocation = "path" | "query" | "header" | "cookie";

export type SimplifiedOperation = {
  /** operationId, or `METHOD /path` when the spec omits it. Unique within the API. */
  id: string;
  method: string;
  path: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: true;
  /** Only set when it deviates from `info.auth`: `none`, or a different scheme. */
  auth?: string;
  params?: Partial<Record<ParamLocation, Record<string, TypeExpr>>>;
  body?: TypeExpr;
  /** Only set for non-JSON bodies (form, multipart, …). */
  bodyType?: string;
  response?: TypeExpr;
  /** Only set when the success status is not 200. */
  responseStatus?: string;
  errors?: Record<string, string>;
};

export type SimplifiedApi = {
  info: {
    title?: string;
    version?: string;
    description?: string;
    servers?: string[];
    /** Auth required by default for every operation. */
    auth?: string;
  };
  operations: SimplifiedOperation[];
  /** Named schemas referenced from 2+ places (or involved in a cycle). */
  schemas: Record<string, TypeExpr>;
  /** Schema names each operation references directly — see `schemaClosure`. */
  operationRefs: Map<string, Set<string>>;
  /** Schema names each hoisted schema references directly. */
  schemaRefs: Map<string, Set<string>>;
  /** Distinct `$ref`s pointing into other files — each renders as `unresolved(...)`. */
  externalRefs: string[];
};

type JsonObject = Record<string, unknown>;

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

// Nested single-use refs are inlined, but a deep chain of them produces a wall
// of indentation that's harder for an LLM to read than a named reference.
const MAX_INLINE_REF_DEPTH = 3;
const MAX_ENUM_VALUES = 20;
const MAX_EXAMPLE_CHARS = 40;

// Formats that change how code must handle a value. int32/float/double are
// noise for a JS consumer; int64 stays because it can exceed Number precision.
const MEANINGFUL_FORMATS = new Set([
  "date",
  "date-time",
  "time",
  "email",
  "uri",
  "url",
  "uuid",
  "binary",
  "byte",
  "int64",
]);

// Auth/transport headers the client stack sets globally — listing them on every
// operation is pure noise. Auth is reported once via `info.auth`.
const IGNORED_HEADERS = new Set(["authorization", "content-type", "accept"]);

// Error descriptions that only restate the status code carry no information.
const GENERIC_ERROR_TEXT =
  /^(bad request|unauthorized|forbidden|not found|internal server error|server error|error|conflict|unprocessable entity|too many requests|method not allowed)\.?$/i;

type Ctx = {
  doc: OpenApiDocument;
  schemaPrefix: string;
  /** Schemas rendered by name rather than inlined. Grows when cycles are found. */
  hoisted: Set<string>;
  /** Hoisted names still waiting to be rendered into `schemas`. */
  pending: string[];
  /** Named schemas currently being inlined — a hit here means a cycle. */
  inlining: Set<string>;
  /** Collects names referenced while rendering the current owner (operation or schema). */
  refs: Set<string>;
};

export function simplifyOpenApi(doc: OpenApiDocument): SimplifiedApi {
  // load.ts already validated the version; anything not OAS3 is Swagger 2.
  const isSwagger2 = doc.openapi === undefined;
  const schemaPrefix = isSwagger2 ? "#/definitions/" : "#/components/schemas/";
  const { refCounts, externalRefs } = scanRefs(doc, schemaPrefix);

  const ctx: Ctx = {
    doc,
    schemaPrefix,
    // Count-gated hoisting, mirroring finalize.ts's style hoisting: a schema used
    // once is clearer inline; one used in many places is worth naming once.
    hoisted: new Set([...refCounts].filter(([, n]) => n >= 2).map(([name]) => name)),
    pending: [],
    inlining: new Set(),
    refs: new Set(),
  };
  ctx.pending.push(...ctx.hoisted);

  const securitySchemes = asObject(
    isSwagger2 ? doc.securityDefinitions : asObject(doc.components)?.securitySchemes,
  );
  const defaultAuth = describeSecurity(doc.security, securitySchemes);

  const operations: SimplifiedOperation[] = [];
  const operationRefs = new Map<string, Set<string>>();
  const usedIds = new Set<string>();

  for (const [path, rawPathItem] of Object.entries(doc.paths)) {
    const pathItem = asObject(deref(ctx, rawPathItem));
    if (!pathItem) continue;
    for (const method of HTTP_METHODS) {
      const op = asObject(pathItem[method]);
      if (!op) continue;

      ctx.refs = new Set();
      const simplified = simplifyOperation(ctx, {
        path,
        method,
        op,
        pathItem,
        isSwagger2,
        defaultAuth,
        securitySchemes,
      });
      if (usedIds.has(simplified.id)) simplified.id = `${simplified.method} ${path}`;
      usedIds.add(simplified.id);
      operations.push(simplified);
      operationRefs.set(simplified.id, ctx.refs);
    }
  }

  // Render hoisted schemas last: cycles discovered while rendering operations
  // (or other schemas) push new names onto `pending`, so drain until empty.
  const schemas: Record<string, TypeExpr> = {};
  const schemaRefs = new Map<string, Set<string>>();
  while (ctx.pending.length > 0) {
    const name = ctx.pending.shift()!;
    if (name in schemas) continue;
    ctx.refs = new Set();
    ctx.inlining = new Set([name]);
    schemas[name] = renderSchema(ctx, resolvePointer(doc, schemaPrefix + escapePointer(name)), 0);
    schemaRefs.set(name, ctx.refs);
  }

  return {
    info: {
      title: cleanText(asObject(doc.info)?.title, 80),
      version: asString(asObject(doc.info)?.version),
      description: cleanText(asObject(doc.info)?.description, 200),
      servers: listServers(doc, isSwagger2),
      auth: defaultAuth,
    },
    operations,
    schemas,
    operationRefs,
    schemaRefs,
    externalRefs,
  };
}

/** All hoisted schema names reachable from `roots`, following schema → schema refs. */
export function schemaClosure(api: SimplifiedApi, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    stack.push(...(api.schemaRefs.get(name) ?? []));
  }
  return seen;
}

// -------------------- OPERATIONS --------------------

type OperationInput = {
  path: string;
  method: (typeof HTTP_METHODS)[number];
  op: JsonObject;
  pathItem: JsonObject;
  isSwagger2: boolean;
  defaultAuth: string | undefined;
  securitySchemes: JsonObject | undefined;
};

function simplifyOperation(ctx: Ctx, input: OperationInput): SimplifiedOperation {
  const { path, method, op, pathItem, isSwagger2, defaultAuth, securitySchemes } = input;
  const METHOD = method.toUpperCase();

  const result: SimplifiedOperation = {
    id: asString(op.operationId) ?? `${METHOD} ${path}`,
    method: METHOD,
    path,
  };

  const summary = cleanText(op.summary, 80);
  const description = cleanText(op.description, 160);
  if (summary) result.summary = summary;
  if (description && description !== summary) result.description = description;
  if (Array.isArray(op.tags) && op.tags.length > 0) result.tags = op.tags.map(String);
  if (op.deprecated === true) result.deprecated = true;

  if (op.security !== undefined) {
    const opAuth = describeSecurity(op.security, securitySchemes);
    if (opAuth !== defaultAuth) result.auth = opAuth ?? "none";
  }

  const params = mergeParameters(ctx, pathItem.parameters, op.parameters);
  const groups: SimplifiedOperation["params"] = {};
  const formFields: Record<string, TypeExpr> = {};

  for (const param of params) {
    const name = asString(param.name);
    const location = asString(param.in);
    if (!name || !location) continue;

    if (location === "body") {
      result.body = renderSchema(ctx, param.schema, 0);
      continue;
    }
    // Swagger 2 params carry type/format/enum inline; OAS3 nests them in `schema`,
    // and puts the description/example on either level.
    const type = isSwagger2
      ? annotate(renderSchema(ctx, param, 0), param)
      : annotate(renderSchema(ctx, param.schema, 0), { ...asObject(param.schema), ...param });
    const key = location === "path" || param.required === true ? name : `${name}?`;
    if (location === "formData") {
      formFields[key] = type;
      continue;
    }
    if (location === "header" && IGNORED_HEADERS.has(name.toLowerCase())) continue;
    if (!isParamLocation(location)) continue;
    (groups[location] ??= {})[key] = type;
  }
  if (Object.keys(groups).length > 0) result.params = groups;

  if (Object.keys(formFields).length > 0) {
    result.body = formFields;
    const rawConsumes = op.consumes ?? ctx.doc.consumes;
    const consumes = Array.isArray(rawConsumes) ? rawConsumes.map(String) : [];
    result.bodyType = consumes.find((c) => c.includes("multipart")) ?? "form";
  }

  if (!isSwagger2) {
    const requestBody = asObject(deref(ctx, op.requestBody));
    const content = pickContent(requestBody?.content);
    if (content) {
      result.body = renderSchema(ctx, content.schema, 0);
      if (!isJsonMediaType(content.mediaType)) result.bodyType = content.mediaType;
    }
  }

  simplifyResponses(ctx, asObject(op.responses), isSwagger2, result);
  return result;
}

function simplifyResponses(
  ctx: Ctx,
  responses: JsonObject | undefined,
  isSwagger2: boolean,
  result: SimplifiedOperation,
): void {
  if (!responses) return;
  const codes = Object.keys(responses);
  const successCode =
    ["200", "201", "202", "204"].find((c) => c in responses) ??
    codes.find((c) => c.startsWith("2")) ??
    (codes.length === 1 && codes[0] === "default" ? "default" : undefined);

  if (successCode) {
    const response = asObject(deref(ctx, responses[successCode]));
    const schema = isSwagger2 ? response?.schema : pickContent(response?.content)?.schema;
    if (schema !== undefined) result.response = renderSchema(ctx, schema, 0);
    if (successCode !== "200") result.responseStatus = successCode;
  }

  const errors: Record<string, string> = {};
  for (const code of codes) {
    if (code === successCode || code.startsWith("2")) continue;
    const text = cleanText(asObject(deref(ctx, responses[code]))?.description, 60);
    if (text && !GENERIC_ERROR_TEXT.test(text)) errors[code] = text;
  }
  if (Object.keys(errors).length > 0) result.errors = errors;
}

/** Path-level parameters apply to every operation; operation-level ones override by (in, name). */
function mergeParameters(ctx: Ctx, pathLevel: unknown, opLevel: unknown): JsonObject[] {
  const merged = new Map<string, JsonObject>();
  for (const list of [pathLevel, opLevel]) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const param = asObject(deref(ctx, raw));
      if (param) merged.set(`${String(param.in)}:${String(param.name)}`, param);
    }
  }
  return [...merged.values()];
}

function pickContent(content: unknown): { mediaType: string; schema: unknown } | undefined {
  const entries = Object.entries(asObject(content) ?? {});
  if (entries.length === 0) return undefined;
  const [mediaType, media] =
    entries.find(([type]) => type === "application/json") ??
    entries.find(([type]) => isJsonMediaType(type)) ??
    entries[0];
  return { mediaType, schema: asObject(media)?.schema };
}

function isJsonMediaType(mediaType: string): boolean {
  return /json/i.test(mediaType);
}

function isParamLocation(value: string): value is ParamLocation {
  return value === "path" || value === "query" || value === "header" || value === "cookie";
}

// -------------------- SCHEMAS --------------------

function renderSchema(ctx: Ctx, raw: unknown, inlineDepth: number): TypeExpr {
  const schema = asObject(raw);
  if (!schema) return "any";

  if (typeof schema.$ref === "string") return renderRef(ctx, schema.$ref, inlineDepth);

  if (Array.isArray(schema.allOf)) return renderAllOf(ctx, schema, inlineDepth);

  const variants = Array.isArray(schema.oneOf) ? schema.oneOf : schema.anyOf;
  if (Array.isArray(variants)) {
    const rendered = variants.map((v) => renderSchema(ctx, v, inlineDepth));
    const nonNull = rendered.filter((v) => v !== "null");
    const nullable = nonNull.length < rendered.length;
    if (nonNull.every((v) => typeof v === "string")) {
      return withNull((nonNull as string[]).join(" | "), nullable || isNullable(schema));
    }
    // Negative space: as with plain objects, `X | null` for an object type keeps only X.
    return nonNull.length === 1 ? nonNull[0] : { oneOf: nonNull };
  }

  const types = (Array.isArray(schema.type) ? schema.type : [schema.type]).filter(
    (t): t is string => typeof t === "string",
  );
  const nonNullTypes = types.filter((t) => t !== "null");
  const nullable = isNullable(schema) || types.includes("null");

  const literals = Array.isArray(schema.enum)
    ? schema.enum
    : schema.const !== undefined
      ? [schema.const]
      : undefined;
  if (literals && literals.length > 0 && literals.every((v) => v === null)) return "null";
  if (literals && literals.length > 0) {
    const values = literals.filter((v) => v !== null);
    const shown = values.slice(0, MAX_ENUM_VALUES).map(formatLiteral);
    if (values.length > MAX_ENUM_VALUES) shown.push("…");
    return withNull(shown.join(" | "), nullable || values.length < literals.length);
  }

  if (nonNullTypes.includes("array") || schema.items !== undefined) {
    const item = renderSchema(ctx, schema.items, inlineDepth);
    if (typeof item !== "string") return [item];
    return withNull(item.includes(" | ") ? `(${item})[]` : `${item}[]`, nullable);
  }

  if (
    nonNullTypes.includes("object") ||
    schema.properties !== undefined ||
    schema.additionalProperties !== undefined
  ) {
    // Negative space: nullability of object-typed values is dropped — there's no
    // clean slot for it in the map shape, and UI code null-guards objects anyway.
    return renderObject(ctx, schema, inlineDepth);
  }

  // OAS 3.1 `{type: "null"}`, usually a variant of `anyOf: [X, {type: null}]`.
  if (types.length > 0 && nonNullTypes.length === 0) return "null";

  const format = asString(schema.format);
  const base = nonNullTypes.length > 0 ? nonNullTypes.join(" | ") : "any";
  return withNull(format && MEANINGFUL_FORMATS.has(format) ? `${base}<${format}>` : base, nullable);
}

function renderRef(ctx: Ctx, ref: string, inlineDepth: number): TypeExpr {
  const name = schemaName(ctx, ref);
  if (name === undefined) {
    // Sub-schema refs (`#/components/schemas/X/properties/y`) have no name to
    // hoist under, so a cycle through one can only be cut off.
    if (ctx.inlining.has(ref)) return `circular(${ref})`;
    const target = resolvePointer(ctx.doc, ref);
    if (target === undefined) return `unresolved(${ref})`;
    ctx.inlining.add(ref);
    try {
      return renderSchema(ctx, target, inlineDepth);
    } finally {
      ctx.inlining.delete(ref);
    }
  }

  const mustName =
    ctx.hoisted.has(name) || ctx.inlining.has(name) || inlineDepth >= MAX_INLINE_REF_DEPTH;
  if (mustName) {
    if (!ctx.hoisted.has(name)) {
      ctx.hoisted.add(name);
      ctx.pending.push(name);
    }
    ctx.refs.add(name);
    return name;
  }

  const target = resolvePointer(ctx.doc, ref);
  if (target === undefined) return `unresolved(${ref})`;
  ctx.inlining.add(name);
  try {
    return renderSchema(ctx, target, inlineDepth + 1);
  } finally {
    ctx.inlining.delete(name);
  }
}

function renderObject(ctx: Ctx, schema: JsonObject, inlineDepth: number): TypeExpr {
  const properties = asObject(schema.properties) ?? {};
  // Only mark optional fields when the spec states what's required — many specs
  // omit `required` entirely, and marking every field `?` would be noise that
  // tells the reader nothing.
  const required = Array.isArray(schema.required) ? new Set(schema.required.map(String)) : null;

  const out: Record<string, TypeExpr> = {};
  const description = cleanText(schema.description, 120);
  if (description) out["#"] = description;

  for (const [name, prop] of Object.entries(properties)) {
    const key = required && !required.has(name) ? `${name}?` : name;
    out[key] = annotate(renderSchema(ctx, prop, inlineDepth), prop);
  }

  const extra = schema.additionalProperties;
  if (extra && typeof extra === "object") {
    const value = renderSchema(ctx, extra, inlineDepth);
    if (Object.keys(properties).length === 0) {
      return typeof value === "string" ? `Record<string, ${value}>` : { "[key: string]": value };
    }
    out["[key: string]"] = value;
  }
  if (Object.keys(out).length === 0) return "object";
  return out;
}

/**
 * `allOf` is used two ways in the wild: composition (`allOf: [Base, {extra fields}]`)
 * and annotation (`allOf: [{$ref: X}]` purely to attach a description/nullable to
 * a ref, since OAS 3.0 forbids siblings of `$ref`). The annotation form keeps the
 * named reference; the composition form is flattened into one object because the
 * reader needs the full field list in one place.
 */
function renderAllOf(ctx: Ctx, schema: JsonObject, inlineDepth: number): TypeExpr {
  const members = (schema.allOf as unknown[]).map(asObject).filter((m) => m !== undefined);
  const structural = members.filter((m) => !isAnnotationOnly(m));
  if (structural.length === 1 && schema.properties === undefined) {
    return renderSchema(ctx, structural[0], inlineDepth);
  }
  return renderSchema(ctx, mergeAllOf(ctx, schema, new Set()), inlineDepth);
}

function mergeAllOf(ctx: Ctx, schema: JsonObject, seen: Set<string>): JsonObject {
  const properties: JsonObject = {};
  const required = new Set<string>();
  let description = asString(schema.description);
  let anyRequired = false;

  let additionalProperties: unknown;

  const absorb = (part: JsonObject) => {
    Object.assign(properties, asObject(part.properties));
    additionalProperties ??= part.additionalProperties;
    if (Array.isArray(part.required)) {
      anyRequired = true;
      part.required.forEach((r) => required.add(String(r)));
    }
    description ??= asString(part.description);
  };

  for (const raw of schema.allOf as unknown[]) {
    let member = asObject(raw);
    if (typeof member?.$ref === "string") {
      // Guard against an allOf that (illegally) includes itself transitively.
      if (seen.has(member.$ref)) continue;
      seen.add(member.$ref);
      member = asObject(resolvePointer(ctx.doc, member.$ref));
    }
    if (!member) continue;
    absorb(Array.isArray(member.allOf) ? mergeAllOf(ctx, member, seen) : member);
  }
  absorb({ properties: schema.properties, required: schema.required });

  return {
    type: "object",
    description,
    properties,
    ...(additionalProperties !== undefined ? { additionalProperties } : {}),
    ...(anyRequired ? { required: [...required] } : {}),
  };
}

function isAnnotationOnly(schema: JsonObject): boolean {
  return !["$ref", "type", "properties", "items", "allOf", "oneOf", "anyOf", "enum"].some(
    (key) => key in schema,
  );
}

/**
 * Attach a field's description/example to its rendered type. Examples matter
 * more than they look: with no explicit design→API annotations, a value like
 * `¥128.00` or `PAID` is often the strongest signal for matching a design's
 * placeholder text to a field.
 */
function annotate(type: TypeExpr, rawSchema: unknown): TypeExpr {
  const schema = asObject(rawSchema);
  if (!schema) return type;

  const notes: string[] = [];
  const description = cleanText(schema.description, 120);
  if (description) notes.push(description);
  const example = pickExample(schema);
  if (example) notes.push(`e.g. ${example}`);
  if (schema.deprecated === true) notes.push("deprecated");
  if (notes.length === 0) return type;
  const note = notes.join("; ");

  if (typeof type === "string") return `${type}  # ${note}`;
  if (Array.isArray(type)) {
    const [item] = type;
    return item && typeof item === "object" && !Array.isArray(item) ? [withNote(item, note)] : type;
  }
  return withNote(type, note);
}

function withNote(obj: { [key: string]: TypeExpr }, note: string): { [key: string]: TypeExpr } {
  return "#" in obj ? obj : { "#": note, ...obj };
}

function pickExample(schema: JsonObject): string | undefined {
  const value = schema.example ?? (Array.isArray(schema.examples) ? schema.examples[0] : undefined);
  if (value === undefined || value === null || typeof value === "object") return undefined;
  const text = String(value);
  return text.length <= MAX_EXAMPLE_CHARS ? text : undefined;
}

function isNullable(schema: JsonObject): boolean {
  return schema.nullable === true || schema["x-nullable"] === true;
}

function withNull(type: string, nullable: boolean): string {
  return nullable ? `${type} | null` : type;
}

function formatLiteral(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

// -------------------- REFS & POINTERS --------------------

function scanRefs(
  doc: OpenApiDocument,
  prefix: string,
): { refCounts: Map<string, number>; externalRefs: string[] } {
  const counts = new Map<string, number>();
  // Split specs (`$ref: ./schemas/Order.yaml`) are deliberately not followed:
  // resolving them means reading arbitrary sibling files or URLs named by the
  // document. They're reported so the caller can ask for a bundled export.
  const external = new Set<string>();
  const seen = new Set<object>();
  const walk = (value: unknown) => {
    // YAML anchors can make the parsed tree a DAG; visit each object once.
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) return value.forEach(walk);
    const ref = (value as JsonObject).$ref;
    if (typeof ref === "string" && ref.startsWith(prefix)) {
      const name = unescapePointer(ref.slice(prefix.length));
      if (!name.includes("/")) counts.set(name, (counts.get(name) ?? 0) + 1);
    } else if (typeof ref === "string" && !ref.startsWith("#")) {
      external.add(ref);
    }
    Object.values(value).forEach(walk);
  };
  walk(doc);
  return { refCounts: counts, externalRefs: [...external] };
}

/** Name of a top-level schema ref (`#/components/schemas/Order` → `Order`), else undefined. */
function schemaName(ctx: Ctx, ref: string): string | undefined {
  if (!ref.startsWith(ctx.schemaPrefix)) return undefined;
  const rest = ref.slice(ctx.schemaPrefix.length);
  return rest.includes("/") ? undefined : unescapePointer(rest);
}

/** Follow a (non-schema) `$ref` such as `#/components/parameters/Page`. */
function deref(ctx: Ctx, value: unknown): unknown {
  let current = value;
  // A few hops cover ref-to-ref chains without risking an infinite loop.
  for (let i = 0; i < 5; i++) {
    const ref = asObject(current)?.$ref;
    if (typeof ref !== "string") return current;
    current = resolvePointer(ctx.doc, ref);
  }
  return current;
}

/**
 * Resolve an internal JSON pointer. External refs (`other.yaml#/...`) return
 * undefined — the README requires a bundled single-file spec, and rendering
 * `unresolved(...)` in place is more useful than failing the whole call.
 */
function resolvePointer(doc: OpenApiDocument, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = doc;
  for (const segment of ref.slice(2).split("/")) {
    current = asObject(current)?.[unescapePointer(segment)];
    if (current === undefined) return undefined;
  }
  return current;
}

function unescapePointer(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // A stray `%` in one ref must not fail the whole spec; use it verbatim.
  }
  return decoded.replace(/~1/g, "/").replace(/~0/g, "~");
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

// -------------------- MISC --------------------

function describeSecurity(
  requirements: unknown,
  schemes: JsonObject | undefined,
): string | undefined {
  if (!Array.isArray(requirements)) return undefined;
  const names = [...new Set(requirements.flatMap((req) => Object.keys(asObject(req) ?? {})))];
  if (names.length === 0) return undefined;
  return names.map((name) => describeScheme(name, asObject(schemes?.[name]))).join(" or ");
}

function describeScheme(name: string, scheme: JsonObject | undefined): string {
  const type = asString(scheme?.type);
  if (type === "http") {
    const httpScheme = asString(scheme?.scheme)?.toLowerCase();
    if (httpScheme === "bearer") return "Bearer token (Authorization header)";
    if (httpScheme === "basic") return "Basic auth";
  }
  if (type === "basic") return "Basic auth";
  if (type === "apiKey") return `API key (${asString(scheme?.in)} "${asString(scheme?.name)}")`;
  if (type === "oauth2") return "OAuth2 bearer token";
  if (type === "openIdConnect") return "OpenID Connect bearer token";
  return name;
}

function listServers(doc: OpenApiDocument, isSwagger2: boolean): string[] | undefined {
  if (isSwagger2) {
    const host = asString(doc.host);
    const basePath = asString(doc.basePath) ?? "";
    if (!host) return basePath ? [basePath] : undefined;
    const scheme =
      Array.isArray(doc.schemes) && doc.schemes.length > 0 ? String(doc.schemes[0]) : "https";
    return [`${scheme}://${host}${basePath}`];
  }
  if (!Array.isArray(doc.servers)) return undefined;
  const urls = doc.servers.map((s) => asString(asObject(s)?.url)).filter((u) => u !== undefined);
  return urls.length > 0 ? urls : undefined;
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}
