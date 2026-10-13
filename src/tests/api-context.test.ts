import os from "os";
import path from "path";
import { mkdtemp, writeFile } from "fs/promises";
import yaml from "js-yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type CreateServerOptions } from "~/mcp/index.js";
import { getApiContext, type GetApiContextInput } from "~/services/get-api-context.js";
import { resolveSpecSource } from "~/services/openapi/source.js";
import type { FigmaAuthOptions } from "~/services/figma.js";

const fixtures = path.resolve(__dirname, "fixtures/openapi");
const oas3 = { location: path.join(fixtures, "shop.oas3.yaml") };
const swagger2 = { location: path.join(fixtures, "shop.swagger2.json") };

type Operation = Record<string, unknown> & { id: string };
type ApiContext = {
  operations: Operation[];
  schemas?: Record<string, unknown>;
  notFound?: string[];
};

async function query(source: typeof oas3, input: GetApiContextInput): Promise<ApiContext> {
  return yaml.load(await getApiContext(source, input, "yaml")) as ApiContext;
}

function operation(result: ApiContext, id: string): Operation {
  const op = result.operations.find((o) => o.id === id);
  if (!op) throw new Error(`operation ${id} missing`);
  return op;
}

const auth: FigmaAuthOptions = { figmaApiKey: "unused", figmaOAuthToken: "", useOAuth: false };

async function connect(
  options: Omit<CreateServerOptions, "transport"> & { transport?: "stdio" | "http" },
) {
  const server = createServer(auth, { transport: "stdio", ...options });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function callTool(client: Client, args: Record<string, unknown>) {
  const result = await client.callTool({ name: "get_api_context", arguments: args });
  const [content] = result.content as { type: string; text: string }[];
  return { isError: Boolean(result.isError), text: content.text };
}

describe("get_api_context", () => {
  it("takes the spec from the call, falls back to the configured one, and asks when there is neither", async () => {
    // stdio: no default spec needed — the agent passes the file the user handed over.
    const stdio = await connect({});
    expect((await stdio.listTools()).tools.map((t) => t.name)).toContain("get_api_context");
    expect((await stdio.listPrompts()).prompts.map((p) => p.name)).toContain(
      "implement_design_with_api",
    );

    const missing = await callTool(stdio, { keywords: ["订单"] });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/ask the user/);

    const given = await callTool(stdio, {
      spec: oas3.location,
      keywords: ["我的订单", "实付金额"],
    });
    expect((yaml.load(given.text) as ApiContext).operations[0].id).toBe("listOrders");
    await stdio.close();

    // HTTP: a shared server only serves its configured spec unless explicitly opened up.
    const bare = await connect({ transport: "http" });
    expect((await bare.listTools()).tools.map((t) => t.name)).not.toContain("get_api_context");
    await bare.close();

    const http = await connect({ transport: "http", openapi: oas3 });
    const [tool] = (await http.listTools()).tools.filter((t) => t.name === "get_api_context");
    expect(tool.description).toContain(oas3.location);
    expect((await callTool(http, { keywords: ["订单"] })).isError).toBe(false);
    // Echoing the default back (as named in the description) is not a per-call spec.
    const echoed = oas3.location.replaceAll("\\", "/");
    expect((await callTool(http, { spec: echoed, keywords: ["订单"] })).isError).toBe(false);
    expect((await callTool(http, { spec: swagger2.location })).text).toMatch(/only serves/);
    await http.close();
  });

  it("explains the usual wrong files instead of failing with a parse error", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "api-spec-"));
    const write = async (name: string, text: string) => {
      await writeFile(path.join(dir, name), text);
      return path.join(dir, name);
    };
    const swaggerUi = await write(
      "index.html",
      "<!DOCTYPE html><html><body>Swagger UI</body></html>",
    );
    const postman = await write(
      "orders.postman.json",
      '{"info":{"_postman_id":"x","name":"o"},"item":[]}',
    );
    const split = await write(
      "openapi.yaml",
      'openapi: 3.0.3\npaths:\n  /o:\n    get:\n      operationId: o\n      responses:\n        "200":\n          content:\n            application/json:\n              schema: { $ref: "./schemas/Order.yaml" }\n',
    );

    const client = await connect({});
    const error = async (spec: string) => (await callTool(client, { spec })).text;

    expect(await error("specs/openapi.yaml")).toMatch(/relative path/);
    expect(await error(dir)).toMatch(/directory.*openapi\.yaml/);
    expect(await error(swaggerUi)).toMatch(/HTML\/XML page/);
    expect(await error(postman)).toMatch(/Postman collection/);

    // A split spec still loads; the agent is told why parts are unresolved.
    const result = yaml.load(
      (await callTool(client, { spec: split, operationIds: ["o"] })).text,
    ) as {
      warning?: string;
    };
    expect(result.warning).toMatch(/split across files.*bundle/);
    await client.close();
  });

  it("sends the configured auth header only to the configured spec's origin", async () => {
    const configured = {
      location: "https://docs.internal/v3/api-docs",
      headers: { Authorization: "Bearer secret" },
    };
    const policy = { configured, allowPerCall: true };

    expect(await resolveSpecSource("https://docs.internal/v3/api-docs/admin", policy)).toEqual({
      location: "https://docs.internal/v3/api-docs/admin",
      headers: configured.headers,
    });
    expect(
      (await resolveSpecSource("https://elsewhere.example/openapi.json", policy)).headers,
    ).toBeUndefined();
  });

  it("ranks operations from design wording that only partly matches the spec", async () => {
    // "我的订单" never appears in the spec; "订单列表" shares a bigram with it.
    // "categoryTree" exercises camelCase splitting + plural/prefix stemming.
    const orders = await query(oas3, { keywords: ["我的订单", "下单时间"] });
    expect(orders.operations[0].id).toBe("listOrders");

    const categories = await query(oas3, { keywords: ["categoryTree", "分类名称"] });
    expect(categories.operations[0].id).toBe("listCategories");
  });

  it("returns full shapes with shared schemas hoisted, cycles named and allOf flattened", async () => {
    const result = await query(oas3, {
      operationIds: ["listOrders", "GET /orders/{orderId}", "listCategories", "missingOp"],
    });

    // Order is referenced from several operations → named once in `schemas`.
    expect(operation(result, "listOrders").response).toMatchObject({
      data: { list: "Order[]" },
    });
    expect(result.schemas?.Order).toMatchObject({ id: expect.stringMatching(/^string/) });

    // OrderDetail is used once → inlined, with Order's fields merged in via allOf.
    const detail = operation(result, "getOrderDetail").response as Record<string, unknown>;
    expect(Object.keys(detail)).toEqual(
      expect.arrayContaining(["id", "status", "amount", "items?"]),
    );

    // Category references itself → rendered by name instead of recursing forever.
    expect(result.schemas?.Category).toMatchObject({ children: "Category[]" });
    expect(result.notFound).toEqual(["missingOp"]);
  });

  it("normalises Swagger 2.0 and OpenAPI 3 into the same shapes", async () => {
    const ids = ["listOrders", "createOrder"];
    const [fromOas3, fromSwagger2] = await Promise.all([
      query(oas3, { operationIds: ids }),
      query(swagger2, { operationIds: ids }),
    ]);

    for (const result of [fromOas3, fromSwagger2]) {
      const list = operation(result, "listOrders");
      expect(list.params).toMatchObject({
        query: { "page?": "integer  # 页码，从 1 开始" },
      });
      expect(operation(result, "createOrder")).toMatchObject({
        body: { skuId: "string" },
        response: "Order",
        responseStatus: "201",
      });
    }
  });

  it("tolerates common spec quirks instead of failing the whole document", async () => {
    // Each of these, unhandled, either failed every call or produced misleading types:
    // unquoted version (parsed as a number), FastAPI-style `anyOf [X, {type: null}]`,
    // a malformed `%` escape in one ref, and a cycle through a sub-schema ref.
    const spec = `
swagger: 2.0
paths:
  /a:
    get:
      operationId: a
      responses:
        "200":
          schema:
            type: object
            properties:
              name: { x-nullable: true, type: string }
              bad: { $ref: "#/definitions/Bad%ZZ" }
              node: { $ref: "#/definitions/Node" }
definitions:
  Node:
    type: object
    properties:
      self: { $ref: "#/definitions/Node/properties/self" }
`;
    const oas31 = `
openapi: 3.1.0
paths:
  /b:
    get:
      operationId: b
      responses:
        "200":
          content:
            application/json:
              schema:
                type: object
                properties:
                  title: { anyOf: [{ type: string }, { type: "null" }] }
`;
    const dir = await mkdtemp(path.join(os.tmpdir(), "api-context-"));
    await writeFile(path.join(dir, "s2.yaml"), spec);
    await writeFile(path.join(dir, "s31.yaml"), oas31);

    const a = await query({ location: path.join(dir, "s2.yaml") }, { operationIds: ["a"] });
    expect(operation(a, "a").response).toMatchObject({
      name: "string | null",
      bad: "unresolved(#/definitions/Bad%ZZ)",
      node: { self: "circular(#/definitions/Node/properties/self)" },
    });

    const b = await query({ location: path.join(dir, "s31.yaml") }, { operationIds: ["b"] });
    expect(operation(b, "b").response).toEqual({ title: "string | null" });
  });
});
