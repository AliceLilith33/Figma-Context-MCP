#!/usr/bin/env node
/**
 * 从 OpenAPI 3.x / Swagger 2.0 文档生成 MSW v2 handlers，支持按场景切换响应。
 *
 * 用法：
 *   node gen-mock-handlers.mjs --spec <文件路径|URL> --out src/mocks/handlers.js
 *        [--ops listOrders,getOrderDetail] [--base /api] [--success-code 0] [--header "Authorization: Bearer xxx"]
 *
 *   --base          前端实际请求的路径前缀，默认取文档 servers / basePath 的路径。
 *                   Windows Git Bash 会把 "/api" 改写成 "C:/Program Files/Git/api"，可写成 "api"（自动补斜杠）。
 *   --success-code  统一包装里 code 字段的成功值（默认 0；有的项目是 200 或 "SUCCESS"）。
 *                   指定后覆盖文档里 code 字段的 example/enum；不指定时优先用文档的 example/enum。
 *   --out 以 .ts 结尾时，生成的文件带 // @ts-nocheck，避免严格模式的 TS 项目类型检查报错。
 *
 * 场景（运行时切换，不用重新生成）：
 *   normal（默认）| empty（数组清空、total 归零）| error（HTTP 500）
 *   bizerror（HTTP 200 + 业务错误码，仅当响应带 code 字段时）| loading（永不返回）| slow（延迟 2 秒）
 *   页面 URL 加 ?mock=empty，或 ?mock=listOrders:error,getOrderDetail:loading 按接口指定；
 *   也可 localStorage.setItem("mock:scenario", "empty")；Node 环境用 globalThis.__MOCK_SCENARIO__。
 *
 * 不依赖第三方库。只有 YAML 格式的文档需要项目里装了 js-yaml；JSON 文档（如 /v3/api-docs）不需要。
 * js-yaml 从当前目录（前端项目根目录）解析，而不是从脚本所在目录，所以要在项目根目录运行。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const ARRAY_LENGTH = 3;
// 带统一包装时列表项已在第 3–4 层，太浅会把列表项里的嵌套对象截成 {}。
const MAX_DEPTH = 10;
const METHODS = ["get", "post", "put", "patch", "delete"];

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.spec || !args.out) {
    throw new Error(
      "用法: node gen-mock-handlers.mjs --spec <文件|URL> --out <输出文件> [--ops a,b] [--base /api] [--header 'K: V']",
    );
  }

  const doc = await loadSpec(args.spec, args.header);
  // 手写文档常写成不带引号的 swagger: 2.0，会被解析成数字，所以按"没有 openapi 字段"判断。
  const isSwagger2 = doc.openapi === undefined;
  const base = normalizeBase(args.base ?? defaultBase(doc, isSwagger2));
  const successCode = parseSuccessCode(args["success-code"]);
  const successCodeExplicit = args["success-code"] !== undefined;
  const wanted = args.ops ? new Set(args.ops.split(",").map((s) => s.trim())) : undefined;

  const handlers = [];
  const samples = {};
  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = pathItem?.[method];
      if (!op) continue;
      const id = op.operationId ?? `${method.toUpperCase()} ${path}`;
      if (wanted && !wanted.has(id)) continue;

      const { status, schema } = successResponse(doc, op, isSwagger2);
      if (schema !== undefined) {
        samples[id] = sample(doc, schema, { depth: 0, index: 0, stack: [], successCode, successCodeExplicit });
      }
      const route = `*${base}${path.replace(/\{([^}]+)\}/g, ":$1")}`;
      handlers.push(
        `  http.${method}(${JSON.stringify(route)}, () => respond(${JSON.stringify(id)}, ${status}, SAMPLES[${JSON.stringify(id)}])),`,
      );
    }
  }

  if (wanted) {
    // 静默跳过会让请求直接打到真实后端，看起来却像 mock 生效了，所以直接失败。
    const missing = [...wanted].filter((id) => !handlers.some((h) => h.includes(JSON.stringify(id))));
    if (missing.length) {
      throw new Error(
        `文档中没有这些 operationId：${missing.join(", ")}（区分大小写；没有 operationId 的接口写成 "GET /path"）`,
      );
    }
  }

  await mkdir(dirname(args.out), { recursive: true });
  const header = /\.tsx?$/.test(args.out) ? "// @ts-nocheck\n" : "";
  await writeFile(args.out, header + render(handlers, samples));
  console.log(`已生成 ${handlers.length} 个 handler → ${args.out}（路由前缀 "*${base}"）`);
}

// -------------------- 输出文件 --------------------

function render(handlers, samples) {
  return `// 由 gen-mock-handlers.mjs 生成，请勿手改；接口变化后重新生成。
// 场景切换：页面 URL ?mock=empty | ?mock=listOrders:error,getOrderDetail:loading
//          或 localStorage.setItem("mock:scenario", "empty")
// 可用场景：normal | empty | error | bizerror | loading | slow
import { http, HttpResponse, delay } from "msw";

const SAMPLES = ${JSON.stringify(samples, null, 2)};

function readScenarioSetting() {
  try {
    const loc = globalThis.location;
    // hash 路由（/#/orders?mock=empty）的参数在 hash 里
    const hashQuery = loc && loc.hash.includes("?") ? loc.hash.slice(loc.hash.indexOf("?")) : "";
    const fromUrl =
      loc && (new URLSearchParams(loc.search).get("mock") || new URLSearchParams(hashQuery).get("mock"));
    if (fromUrl) return fromUrl;
    const fromStorage = globalThis.localStorage && globalThis.localStorage.getItem("mock:scenario");
    if (fromStorage) return fromStorage;
  } catch {
    // 非浏览器环境或存储不可用：退回到全局变量
  }
  return globalThis.__MOCK_SCENARIO__ || "normal";
}

function scenarioFor(operationId) {
  let fallback = "normal";
  for (const entry of readScenarioSetting().split(",")) {
    const [left, right] = entry.split(":").map((s) => s.trim());
    if (right === undefined) fallback = left;
    else if (left === operationId) return right;
  }
  return fallback;
}

function emptied(value, key) {
  if (Array.isArray(value)) return [];
  if (typeof value === "number" && /^(total|count|totalCount|totalElements|pages|totalPages)$/i.test(key || "")) {
    return 0;
  }
  if (typeof value === "boolean" && /^(hasMore|hasNext|hasNextPage)$/i.test(key || "")) return false;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, emptied(v, k)]));
  }
  return value;
}

async function respond(operationId, status, body) {
  const scenario = scenarioFor(operationId);
  if (scenario === "loading") await delay("infinite");
  if (scenario === "slow") await delay(2000);
  if (scenario === "error") {
    return HttpResponse.json({ code: 500, msg: "mock 服务器错误", message: "mock 服务器错误" }, { status: 500 });
  }
  if (scenario === "bizerror" && body && typeof body === "object" && "code" in body) {
    const code = typeof body.code === "number" ? -1 : "MOCK_ERROR";
    return HttpResponse.json({ ...body, code, msg: "mock 业务错误", message: "mock 业务错误", data: null });
  }
  if (body === undefined) return new HttpResponse(null, { status });
  return HttpResponse.json(scenario === "empty" ? emptied(body) : body, { status });
}

export const handlers = [
${handlers.join("\n")}
];
`;
}

// -------------------- 文档读取 --------------------

/** 从项目（当前目录）解析依赖：脚本可能放在 ~/.claude/skills 等没有 node_modules 的地方。 */
async function importFromProject(name) {
  try {
    const resolved = createRequire(join(process.cwd(), "package.json")).resolve(name);
    return await import(pathToFileURL(resolved).href);
  } catch {
    return import(name);
  }
}

async function loadSpec(location, header) {
  let text;
  if (/^https?:\/\//i.test(location)) {
    const headers = {};
    if (header) {
      const i = header.indexOf(":");
      if (i <= 0) throw new Error(`--header 格式应为 "Name: value"，收到：${header}`);
      headers[header.slice(0, i).trim()] = header.slice(i + 1).trim();
    }
    const response = await fetch(location, { headers });
    if (!response.ok) throw new Error(`获取文档失败：${response.status} ${response.statusText}`);
    text = await response.text();
  } else {
    text = await readFile(location, "utf8");
  }

  try {
    return JSON.parse(text);
  } catch {
    let yaml;
    try {
      yaml = (await importFromProject("js-yaml")).default;
    } catch {
      throw new Error(
        "这是 YAML 文档，需要项目里有 js-yaml（npm i -D js-yaml，并在项目根目录运行本脚本），或改用 JSON 格式的文档。",
      );
    }
    return yaml.load(text, { schema: yaml.CORE_SCHEMA });
  }
}

function normalizeBase(base) {
  const trimmed = base.trim().replace(/\/+$/, "");
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    throw new Error(
      `--base 被 shell 改写成了 Windows 路径（${trimmed}）。请改写成不带开头斜杠的形式，例如 --base api。`,
    );
  }
  return trimmed && !trimmed.startsWith("/") ? `/${trimmed}` : trimmed;
}

function parseSuccessCode(value) {
  if (value === undefined) return 0;
  return /^-?\d+$/.test(value) ? Number(value) : value;
}

function defaultBase(doc, isSwagger2) {
  if (isSwagger2) return doc.basePath ?? "";
  const server = doc.servers?.[0];
  if (!server?.url) return "";
  // 服务器变量（{basePath}）用默认值替换；没有默认值就无法推断，要求显式指定。
  const url = server.url.replace(/\{([^}]+)\}/g, (m, name) => server.variables?.[name]?.default ?? m);
  if (url.includes("{")) {
    throw new Error(`servers[0].url 含有没有默认值的变量（${server.url}），请用 --base 指定前端请求的路径前缀。`);
  }
  try {
    return decodeURI(new URL(url, "http://placeholder").pathname);
  } catch {
    return "";
  }
}

function successResponse(doc, op, isSwagger2) {
  const responses = op.responses ?? {};
  const code =
    ["200", "201", "202", "204"].find((c) => c in responses) ??
    Object.keys(responses).find((c) => /^2/.test(c)) ??
    // springdoc 等常只写 default 响应
    ("default" in responses ? "default" : "200");
  const response = deref(doc, responses[code]);
  const schema = isSwagger2 ? response?.schema : pickJson(response?.content)?.schema;
  const status = /^2\d\d$/.test(code) ? Number(code) : 200;
  return { status, schema };
}

function pickJson(content) {
  const entries = Object.entries(content ?? {});
  return (
    entries.find(([t]) => t === "application/json")?.[1] ??
    entries.find(([t]) => /json/i.test(t))?.[1] ??
    entries[0]?.[1]
  );
}

function deref(doc, value) {
  let current = value;
  for (let i = 0; i < 5 && typeof current?.$ref === "string"; i++) current = resolve(doc, current.$ref);
  return current;
}

function resolve(doc, ref) {
  if (!ref.startsWith("#/")) return undefined;
  return ref
    .slice(2)
    .split("/")
    .reduce(
      (node, part) => node?.[safeDecode(part).replace(/~1/g, "/").replace(/~0/g, "~")],
      doc,
    );
}

function safeDecode(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

// -------------------- 示例数据 --------------------

/**
 * 生成确定性的示例数据：同一份文档每次生成结果一致，便于提交和比对。
 * 优先用文档里的 example / enum，其次按字段名和 format 推测，保证列表项之间 id 不重复（React key）。
 */
function sample(doc, rawSchema, ctx, key = "") {
  if (!rawSchema || ctx.depth > MAX_DEPTH) return undefined;

  if (typeof rawSchema.$ref === "string") {
    if (ctx.stack.includes(rawSchema.$ref)) return undefined;
    return sample(doc, resolve(doc, rawSchema.$ref), { ...ctx, stack: [...ctx.stack, rawSchema.$ref] }, key);
  }
  const schema = rawSchema;

  if (Array.isArray(schema.allOf)) {
    return sample(doc, { type: "object", properties: flattenAllOf(doc, schema, new Set()) }, ctx, key);
  }
  const variants = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(variants)) {
    const first = variants.find((v) => v?.type !== "null");
    return sample(doc, first, ctx, key);
  }

  const i = ctx.index;
  // 统一包装（{ code, msg, data }）的 code 必须是"成功"，否则前端会把 mock 数据当成业务错误。
  const docGivesCode = schema.example !== undefined || Array.isArray(schema.enum);
  if (key === "code" && ctx.depth === 1 && (ctx.successCodeExplicit || !docGivesCode)) {
    const codeType = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
    return codeType === "string" ? String(ctx.successCode) : ctx.successCode;
  }
  if (schema.example !== undefined && typeof schema.example !== "object") {
    return vary(schema.example, key, i);
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const values = schema.enum.filter((v) => v !== null);
    return values[i % values.length];
  }

  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;

  if (type === "array" || schema.items) {
    return Array.from({ length: ARRAY_LENGTH }, (_, index) =>
      sample(doc, schema.items, { ...ctx, depth: ctx.depth + 1, index }, key),
    ).filter((v) => v !== undefined);
  }
  if (type === "object" || schema.properties || schema.additionalProperties) {
    const out = {};
    for (const [name, prop] of Object.entries(schema.properties ?? {})) {
      const value = sample(doc, prop, { ...ctx, depth: ctx.depth + 1 }, name);
      if (value !== undefined) out[name] = value;
    }
    if (!schema.properties && schema.additionalProperties && typeof schema.additionalProperties === "object") {
      out.key1 = sample(doc, schema.additionalProperties, { ...ctx, depth: ctx.depth + 1 }, "key1");
    }
    return out;
  }
  if ((key === "msg" || key === "message") && ctx.depth === 1) return "ok";
  if (type === "boolean") return i % 2 === 0;
  if (type === "integer" || type === "number") return sampleNumber(key, i, type);
  return sampleString(schema, key, i);
}

/** 递归合并 allOf（含嵌套 allOf 和 $ref），常见于 Java 生成的 Result<T> / BaseEntity。 */
function flattenAllOf(doc, schema, seen) {
  const properties = {};
  for (const raw of schema.allOf ?? []) {
    if (typeof raw?.$ref === "string") {
      if (seen.has(raw.$ref)) continue;
      seen.add(raw.$ref);
    }
    const part = deref(doc, raw) ?? {};
    Object.assign(properties, Array.isArray(part.allOf) ? flattenAllOf(doc, part, seen) : part.properties);
  }
  return Object.assign(properties, schema.properties);
}

function sampleNumber(key, i, type) {
  if (/(^id$|Id$|_id$)/.test(key)) return i + 1;
  if (/^(total|count|totalCount|totalElements)$/i.test(key)) return ARRAY_LENGTH;
  if (/(price|amount|money|fee|cost|balance)/i.test(key)) return type === "integer" ? 12800 + i * 1000 : 128 + i * 10;
  if (/(page|pageNum|current)$/i.test(key)) return 1;
  if (/(size|pageSize|limit)$/i.test(key)) return 10;
  if (/(count|num|qty|quantity|stock)/i.test(key)) return i + 1;
  if (/(status|type|state|level)$/i.test(key)) return 1;
  return (i + 1) * 10;
}

function sampleString(schema, key, i) {
  const day = String(i + 1).padStart(2, "0");
  switch (schema.format) {
    case "date-time":
      return `2025-01-${day}T10:00:00Z`;
    case "date":
      return `2025-01-${day}`;
    case "time":
      return "10:00:00";
    case "email":
      return `user${i + 1}@example.com`;
    case "uri":
    case "url":
      return `https://example.com/${key || "item"}/${i + 1}`;
    case "uuid":
      return `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
  }
  if (/(^id$|Id$|_id$|No$|_no$|code$)/.test(key)) return `${key || "id"}-${i + 1}`;
  if (/(avatar|image|img|pic|cover|logo|icon|url)$/i.test(key)) return `https://picsum.photos/seed/${key}${i + 1}/200`;
  const label = (schema.description ?? key ?? "文本").replace(/\s+/g, " ").slice(0, 20);
  return `${label} ${i + 1}`;
}

function vary(example, key, i) {
  if (i === 0) return example;
  const isIdLike = /(^id$|Id$|_id$|No$|_no$)/.test(key);
  if (typeof example === "number") return isIdLike ? example + i : example;
  if (typeof example === "string" && isIdLike) return `${example}-${i + 1}`;
  return example;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const match = argv[i].match(/^--([^=]+)(?:=(.*))?$/);
    if (!match) continue;
    out[match[1]] = match[2] ?? argv[++i];
  }
  return out;
}
