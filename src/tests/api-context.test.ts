import os from "os";
import path from "path";
import { mkdtemp, writeFile } from "fs/promises";
import yaml from "js-yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "~/mcp/index.js";
import { getApiContext, type GetApiContextInput } from "~/services/get-api-context.js";
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

describe("get_api_context", () => {
  it("is exposed over MCP only when an OpenAPI spec is configured", async () => {
    const auth: FigmaAuthOptions = { figmaApiKey: "unused", figmaOAuthToken: "", useOAuth: false };

    const connect = async (openapi?: typeof oas3) => {
      const server = createServer(auth, { transport: "stdio", openapi });
      const client = new Client({ name: "test", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      return client;
    };

    const without = await connect();
    const { tools: baseTools } = await without.listTools();
    expect(baseTools.map((t) => t.name)).not.toContain("get_api_context");
    await without.close();

    const client = await connect(oas3);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("get_api_context");
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("implement_design_with_api");

    const result = await client.callTool({
      name: "get_api_context",
      arguments: { keywords: ["我的订单", "实付金额"] },
    });
    const [content] = result.content as { type: string; text: string }[];
    const parsed = yaml.load(content.text) as ApiContext;
    expect(parsed.operations[0].id).toBe("listOrders");
    await client.close();
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
