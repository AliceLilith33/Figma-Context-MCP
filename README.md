<a href="https://www.framelink.ai/?utm_source=github&utm_medium=referral&utm_campaign=readme" target="_blank" rel="noopener">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://www.framelink.ai/github/HeaderDark.png" />
    <img alt="Framelink" src="https://www.framelink.ai/github/HeaderLight.png" />
  </picture>
</a>

<div align="center">
  <h1>Framelink MCP for Figma</h1>
  <h3>Give your coding agent access to your Figma data.<br/>Implement designs in any framework in one-shot.</h3>
  <a href="https://npmcharts.com/compare/figma-developer-mcp?interval=30">
    <img alt="weekly downloads" src="https://img.shields.io/npm/dm/figma-developer-mcp.svg">
  </a>
  <a href="https://github.com/GLips/Figma-Context-MCP/blob/main/LICENSE">
    <img alt="MIT License" src="https://img.shields.io/github/license/GLips/Figma-Context-MCP" />
  </a>
  <a href="https://framelink.ai/discord">
    <img alt="Discord" src="https://img.shields.io/discord/1352337336913887343?color=7389D8&label&logo=discord&logoColor=ffffff" />
  </a>
  <br />
  <a href="https://twitter.com/glipsman">
    <img alt="Twitter" src="https://img.shields.io/twitter/url?url=https%3A%2F%2Fx.com%2Fglipsman&label=%40glipsman" />
  </a>
</div>

<br/>

Give [Cursor](https://cursor.sh/) and other AI-powered coding tools access to your Figma files with this [Model Context Protocol](https://modelcontextprotocol.io/introduction) server.

When Cursor has access to Figma design data, it's **way** better at one-shotting designs accurately than alternative approaches like pasting screenshots.

<h3><a href="https://www.framelink.ai/docs/quickstart?utm_source=github&utm_medium=referral&utm_campaign=readme">See quickstart instructions →</a></h3>

## Demo

[Watch a demo of building a UI in Cursor with Figma design data](https://youtu.be/6G9yb-LrEqg)

[![Watch the video](https://img.youtube.com/vi/6G9yb-LrEqg/maxresdefault.jpg)](https://youtu.be/6G9yb-LrEqg)

## How it works

1. Open your IDE's chat (e.g. agent mode in Cursor).
2. Paste a link to a Figma file, frame, or group.
3. Ask Cursor to do something with the Figma file—e.g. implement the design.
4. Cursor will fetch the relevant metadata from Figma and use it to write your code.

This MCP server is specifically designed for use with Cursor. Before responding with context from the [Figma API](https://www.figma.com/developers/api), it simplifies and translates the response so only the most relevant layout and styling information is provided to the model.

Reducing the amount of context provided to the model helps make the AI more accurate and the responses more relevant.

## Getting Started

Many code editors and other AI clients use a configuration file to manage MCP servers.

The `figma-developer-mcp` server can be configured by adding the following to your configuration file.

> NOTE: You will need to create a Figma access token to use this server. Instructions on how to create a Figma API access token can be found [here](https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens).

### MacOS / Linux

```json
{
  "mcpServers": {
    "Framelink MCP for Figma": {
      "command": "npx",
      "args": ["-y", "figma-developer-mcp", "--figma-api-key=YOUR-KEY", "--stdio"]
    }
  }
}
```

### Windows

```json
{
  "mcpServers": {
    "Framelink MCP for Figma": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "figma-developer-mcp", "--figma-api-key=YOUR-KEY", "--stdio"]
    }
  }
}
```

Or you can set `FIGMA_API_KEY` and `PORT` in the `env` field.

If you need more information on how to configure the Framelink MCP for Figma, see the [Framelink docs](https://www.framelink.ai/docs/quickstart?utm_source=github&utm_medium=referral&utm_campaign=readme).

## Wiring designs to your backend API

Give the AI your backend's OpenAPI spec and it can build pages that fetch and display real data instead of hard-coding the design's placeholder content. See [docs/setup-guide.md](docs/setup-guide.md) for installing and configuring it in Claude Code, Cursor, VS Code, Codex CLI, Gemini CLI and other agents, [docs/backend-api-integration.md](docs/backend-api-integration.md) for how it works, and [docs/figma-to-page-guide.md](docs/figma-to-page-guide.md) for a walkthrough and troubleshooting.

> These features exist only in this repository's local build — `npx figma-developer-mcp` installs the upstream npm package, which has no `get_api_context`. Build it (`pnpm install && pnpm build`) and run `dist/bin.js` directly.

No extra configuration is needed: the spec is chosen per call. Tell the AI where it is (an exported `swagger.json`/`openapi.yaml` file, or the URL that serves the spec), and it passes that as the tool's `spec` argument. Without one, the tool tells the AI to look in the project's conventions and files and otherwise ask you. Optionally configure a default spec:

```json
"command": "node",
"args": ["/path/to/Figma-Context-MCP/dist/bin.js", "--figma-api-key=YOUR-KEY", "--openapi=/path/to/openapi.yaml", "--stdio"]
```

| Option                    | Env var                      | Description                                                                                                                          |
| ------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `--openapi`               | `OPENAPI_SPEC`               | Default spec, used when a call names none: file path or URL (e.g. `http://localhost:8080/v3/api-docs`)                               |
| `--openapi-header`        | `OPENAPI_SPEC_HEADER`        | Header for fetching a protected `--openapi` URL, e.g. `Authorization: Bearer xxx`. Only sent to that URL's origin                    |
| `--openapi-allow-dynamic` | `OPENAPI_ALLOW_DYNAMIC=true` | HTTP mode only: accept the per-call `spec` argument. Off by default because a shared server would read files and URLs for any caller |

Spec paths must be absolute: relative paths would resolve against the directory your MCP client launches the server from, not your project.

This adds:

- **`get_api_context` tool** — a simplified, TypeScript-like view of the spec (from its `spec` argument or the default). Called with words from the design (`keywords`), it returns a ranked index of candidate operations; called with `operationIds`, it returns their params, request body and response shapes. Read-only: the server never calls your backend.
- **`implement_design_with_api` prompt** — takes a Figma URL and an optional spec. A guided workflow: fetch the design → find matching operations → implement with loading/empty/error states → finish with a UI element ↔ API field table citing the evidence for each match (matched keyword, field name or example), with write operations listed separately for confirmation.

The design-to-API matching is inferred by the AI, so results depend on how much meaning the spec and design carry:

**Spec requirements**

1. A single file (JSON or YAML). `$ref`s must be internal (`#/components/schemas/...`); bundle multi-file specs first (e.g. `npx @redocly/cli bundle`) — the tool warns when it finds external refs. Exporting the spec to a file (springdoc `/v3/api-docs`, knife4j offline export, Swagger Editor, Apifox…) means the backend needn't be running.
2. Every operation has a `summary` (business wording, in the same language as the design), an `operationId` and `tags`.
3. 2xx responses declare a concrete schema, not just `type: object`. Add `description`, `enum`, `format` and `example` to fields — examples are a strong signal for matching design placeholder text.
4. Pagination and response wrappers (e.g. `{ code, data, msg }`) are described as they really are.

**Design requirements**

1. Semantic layer names (`OrderCard`, not `Group 5`).
2. Realistic placeholder text (`¥128.00`, `2025-01-02`, `Paid`) rather than lorem ipsum.
3. Lists built from components or repeated structures, so they're recognisable as array data.

### `figma-to-page` skill

For agents that support skills (e.g. Claude Code), [`skills/figma-to-page/`](skills/figma-to-page/SKILL.md) holds the full workflow: project conventions bootstrap, static UI with visual check against a rendered Figma reference, API matching, data binding, and verification against either a mock backend (MSW, with switchable normal/empty/error/bizerror/loading/slow scenarios) or a live dev backend. The static page and the API wiring can also be done as two separate steps. Copy it into your frontend project's `.claude/skills/` and adapt it. It includes two scripts, run with the frontend project's own dependencies:

- `scripts/gen-mock-handlers.mjs` — generates MSW handlers from the OpenAPI spec (the generated file imports `msw`; YAML specs also need `js-yaml`)
- `scripts/visual-diff.mjs` — optional pixel diff of a screenshot against the Figma reference (needs `pixelmatch` + `pngjs`)

To check how your spec reads after simplification, or tune keywords against it:

```bash
node dist/bin.js api --openapi ./openapi.yaml --keywords "My orders,Amount paid"
node dist/bin.js api --openapi ./openapi.yaml --operation-ids listOrders,getOrderDetail
```

## Star History

<a href="https://star-history.com/#GLips/Figma-Context-MCP"><img src="https://api.star-history.com/svg?repos=GLips/Figma-Context-MCP&type=Date" alt="Star History Chart" width="600" /></a>

## Learn More

The Framelink MCP for Figma is simple but powerful. Get the most out of it by learning more at the [Framelink](https://framelink.ai?utm_source=github&utm_medium=referral&utm_campaign=readme) site.
