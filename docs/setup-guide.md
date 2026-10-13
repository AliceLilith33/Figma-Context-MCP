# 安装与配置指南（各种 Agent）

本文说明怎样构建本仓库的 Framelink（含「对接后端接口」功能），并接入 Claude Code、Cursor、VS Code（GitHub Copilot）、Codex CLI、Gemini CLI、Windsurf、Cline、Claude Desktop 等 Agent。

- 功能原理见 [backend-api-integration.md](backend-api-integration.md)。
- 使用流程和常见问题见 [figma-to-page-guide.md](figma-to-page-guide.md)。

> **必须用本地构建的版本。** `npx figma-developer-mcp` 下载的是 npm 上的官方版本，没有 `--openapi`、`get_api_context` 和 `api` 命令。本文所有配置都指向本仓库的 `dist/bin.js`。

## 目录

1. [组成部分](#1-组成部分)
2. [前置条件](#2-前置条件)
3. [构建](#3-构建)
4. [配置项](#4-配置项)（[4.1 图片目录](#41-图片目录---image-dir)、[4.2 接口文档](#42-接口文档调用时指定或配置默认值)）
5. [运行方式：stdio 与 HTTP](#5-运行方式stdio-与-http)
6. [各 Agent 的配置](#6-各-agent-的配置)
7. [安装 figma-to-page Skill](#7-安装-figma-to-page-skill)
8. [配置 chrome-devtools MCP（验收用）](#8-配置-chrome-devtools-mcp验收用)
9. [验证清单](#9-验证清单)
10. [更新与卸载](#10-更新与卸载)
11. [常见问题](#11-常见问题)

---

## 1. 组成部分

| 部分                                           | 作用                                                                                                             | 是否必需                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Framelink MCP 服务（`dist/bin.js`）            | 提供 `get_figma_data`、`download_figma_images`，以及 `get_api_context` 工具和 `implement_design_with_api` 提示词 | 必需                                                           |
| figma-to-page Skill（`skills/figma-to-page/`） | 完整流程：项目约定、静态还原、视觉对比、找接口、绑定数据、mock/live 验收                                         | 推荐；Agent 不支持 Skill 时见 [7.4](#74-不支持-skill-的-agent) |
| chrome-devtools MCP                            | 截图对比、验收时检查页面、网络请求和控制台                                                                       | 可选；没有就跳过浏览器检查                                     |

接口文档不需要在安装时配置（stdio 模式；HTTP 模式见 4.2 末尾）：AI 调用 `get_api_context` 时再指定（用户提供，或从项目里找），见 [4.2](#42-接口文档调用时指定或配置默认值)。只想让 AI 读设计稿时，不用管这个工具。

## 2. 前置条件

| 项目                   | 要求                                                                                          | 检查方法                    |
| ---------------------- | --------------------------------------------------------------------------------------------- | --------------------------- |
| Node.js                | ≥ 20.20（`package.json` 的 `engines`）                                                        | `node -v`                   |
| Git                    | 任意较新版本                                                                                  | `git --version`             |
| Figma 访问令牌         | 个人访问令牌（PAT），或 OAuth 令牌                                                            | 见下文                      |
| Figma 席位             | 付费计划的 **Dev 或 Full 席位**。View/Collab 席位的 Tier 1 接口按月计次，额度极少，很快会用完 | Figma 账号设置 → 计划与席位 |
| 接口文档（对接接口时） | OpenAPI 3.x 或 Swagger 2.0，单文件，本地文件或 URL；可以对接时再提供                          | 见 [3.3](#33-检查接口文档)  |

**创建 Figma 个人访问令牌**：Figma → 左上角头像 → Settings → Security → Personal access tokens → Generate new token。权限至少勾选 **File content: Read-only**。令牌只显示一次，请立即保存。详见 [Figma 帮助文档](https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens)。

## 3. 构建

### 3.1 获取代码并构建

pnpm 不需要单独安装，用 `npx` 指定版本运行即可：

```bash
cd E:\Library\github.com\figmma\Figma-Context-MCP
npx pnpm@10.10.0 install
npx pnpm@10.10.0 build
```

成功后会生成 `dist/bin.js`。记下它的**绝对路径**，后面所有配置都要用，例如：

- Windows：`E:\Library\github.com\figmma\Figma-Context-MCP\dist\bin.js`
- macOS/Linux：`/Users/me/code/Figma-Context-MCP/dist/bin.js`

### 3.2 确认构建结果

```bash
node dist/bin.js --help
```

输出的参数列表里应该有 `--openapi` 和 `--openapi-header`，命令列表里应该有 `fetch` 和 `api`。没有的话，说明运行的不是本仓库的构建结果。

用一个 Figma 链接试一下令牌能不能用（会消耗一次 Figma 调用）：

```bash
node dist/bin.js fetch "https://www.figma.com/design/<fileKey>/<名称>?node-id=12-345" --figma-api-key=<令牌> --depth 1
```

### 3.3 检查接口文档

```bash
node dist/bin.js api --openapi http://localhost:8080/v3/api-docs
node dist/bin.js api --openapi ./openapi.yaml --keywords "订单列表,实付金额"
```

能看到接口列表，且字段带说明，就说明文档可用。文档质量要求见 README 的「Spec requirements」。

## 4. 配置项

每个配置项都可以用命令行参数或环境变量指定，**命令行参数优先**。

| 命令行参数                | 环境变量                                      | 说明                                                                                             | 默认值              |
| ------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------- |
| `--figma-api-key`         | `FIGMA_API_KEY`                               | Figma 个人访问令牌                                                                               | —                   |
| `--figma-oauth-token`     | `FIGMA_OAUTH_TOKEN`                           | Figma OAuth 令牌；设置后优先于个人访问令牌                                                       | —                   |
| `--stdio`                 | —                                             | stdio 模式（Agent 启动子进程时必须加）                                                           | HTTP 模式           |
| `--openapi`               | `OPENAPI_SPEC`                                | **默认**接口文档的文件路径或 URL。可以不配，由 AI 在调用时指定，见 4.2                           | —                   |
| `--openapi-header`        | `OPENAPI_SPEC_HEADER`                         | 拉取默认文档 URL 时附带的请求头，如 `Authorization: Bearer xxx`。只发给与 `--openapi` 同源的地址 | —                   |
| `--openapi-allow-dynamic` | `OPENAPI_ALLOW_DYNAMIC=true`                  | HTTP 模式下允许 AI 在调用时指定接口文档（stdio 模式始终允许）                                    | 否                  |
| `--image-dir`             | `IMAGE_DIR`                                   | 图片下载的根目录，下载工具只会写入这个目录                                                       | 服务进程的当前目录  |
| `--format`                | `OUTPUT_FORMAT`                               | 设计稿输出格式：`tree`、`yaml`、`json`                                                           | `tree`              |
| `--skip-image-downloads`  | `SKIP_IMAGE_DOWNLOADS`                        | 不注册图片下载工具                                                                               | 否                  |
| `--proxy`                 | `FIGMA_PROXY`                                 | 代理地址；`none` 表示忽略系统代理变量。也支持标准的 `HTTPS_PROXY`/`NO_PROXY`                     | —                   |
| `--port`                  | `FRAMELINK_PORT` 或 `PORT`                    | HTTP 模式端口                                                                                    | 3333                |
| `--host`                  | `FRAMELINK_HOST`                              | HTTP 模式监听地址                                                                                | 127.0.0.1           |
| `--env`                   | —                                             | 指定 `.env` 文件                                                                                 | 当前目录下的 `.env` |
| `--no-telemetry`          | `FRAMELINK_TELEMETRY=off` 或 `DO_NOT_TRACK=1` | 关闭使用统计（**默认开启**）                                                                     | 开启                |

**路径一律写绝对路径**：`--openapi`（本地文件）、`--image-dir`、`--env` 的相对路径按服务进程的当前目录解析。各 Agent 启动子进程时的当前目录不一样（有的是项目目录，有的是用户目录或 Agent 的安装目录），写相对路径很容易指错地方。

**`--image-dir` 建议设为前端项目根目录**，原因和设置方法见 [4.1](#41-图片目录---image-dir)。

**`.env` 文件会覆盖 Agent 配置里的 `env`**：服务启动时会读当前目录（或 `--env` 指定）的 `.env`，并且**覆盖**已有的同名环境变量。如果服务的当前目录里恰好有一个 `.env`（例如前端项目自己的 `.env` 里也有 `PORT`），Agent 配置里的同名 `env` 会失效。用命令行参数（优先级最高）可以避开这个问题。

**令牌的保管**：

- 不要把含令牌的配置文件提交到仓库。项目级配置（`.mcp.json`、`.cursor/mcp.json`、`.vscode/mcp.json` 等）如果要提交，令牌改用环境变量引用或输入提示（各 Agent 的写法见下文）。
- 也可以把令牌写进一个单独的 `.env` 文件，用 `--env=<绝对路径>` 指定，这个文件不进仓库。

### 4.1 图片目录 `--image-dir`

`--image-dir` 是 `download_figma_images` 工具保存文件的**根目录**，工具只能往这个目录里面写文件。

**存放的内容**：

1. **设计稿里的图片和图标**：照片、插画、背景图（PNG），以及图标（SVG）。AI 写页面时会把它们下载到前端项目的资源目录，如 `src/assets/icons/`。
2. **视觉对比用的参考图**：figma-to-page Skill 会把整个页面渲染成一张 PNG，放在 `.figma-ref/` 里，和浏览器截图做对比。

**路径规则**：AI 调用工具时会传一个 `localPath`（如 `src/assets/icons`），它是**相对 `--image-dir` 的路径**，文件实际保存在 `<image-dir>/<localPath>`。`localPath` 也可以是绝对路径，但必须在 `--image-dir` 里面。指向目录外面的路径（如 `../../`）会被拒绝，这样可以防止 AI 把文件写到任意位置。

**不设置时**：默认使用服务进程的**当前目录**。各 Agent 启动 MCP 子进程时的当前目录不一样（项目目录、用户目录或 Agent 的安装目录都有可能），所以图片常常会下载到意想不到的地方。工具返回的消息里有实际保存的绝对路径，可以从那里查。

**设置方法**：一般设成**前端项目根目录的绝对路径**，如 `--image-dir=E:/work/shop-web`。这样 AI 传的 `src/assets/...`、`.figma-ref/` 正好对应项目里的目录。

| 情况                   | 做法                                                                                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 只有一个前端项目       | 在全局配置里直接加 `--image-dir=<项目根目录>`                                                                                                                                                                                                                                               |
| 多个前端项目           | 全局配置不带 `--image-dir`，在每个项目的项目级配置里单独配一份带 `--image-dir` 的服务（Claude Code：在项目目录下运行 `claude mcp add framelink --scope local -- node <BIN> --stdio ... --image-dir=<该项目根目录>`，它会覆盖用户级的同名服务）。只有全局配置的 Agent 见 [6.6](#66-windsurf) |
| 不想让 AI 改动项目目录 | 设成一个专用目录（如 `E:/figma-assets`），下载后自己挑选文件复制到项目里                                                                                                                                                                                                                    |

另外，在前端项目的 `.gitignore` 里加上 `.figma-ref/`，那里面是参考图和截图，不需要提交。

### 4.2 接口文档：调用时指定或配置默认值

`get_api_context` 每次调用用哪份接口文档，按下面的顺序决定：

1. **调用时的 `spec` 参数**：文件的绝对路径或文档的 URL。
2. **服务配置的默认文档** `--openapi`：调用时没带 `spec` 就用它。
3. **都没有**：工具返回错误，让 AI 先在项目约定和项目文件里找，找不到就问用户。

所以一般**不用在安装时配置 `--openapi`**。对接接口时，直接告诉 AI 文档在哪里，例如「接口文档是 E:/work/shop-web/docs/api/swagger.json」；不说的话，AI 会自己找或者问你。figma-to-page Skill 会把确定下来的位置写进项目约定 `docs/frontend-conventions.md` 的「接口文档」一节，之后同一个项目不用再说。

**什么时候配置 `--openapi`**：所有项目都用同一份文档，或者文档 URL 需要认证（`--openapi-header` 只发给 `--openapi` 同源的地址）。

**推荐用导出的单文件**：后端服务不用开着，文档也不会因为后端重启而读不到。各工具的导出方法：

| 来源                       | 方法                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------ |
| Swagger UI 页面            | 页面标题下方有文档链接（如 `/v3/api-docs`、`/swagger.json`），打开后另存为文件       |
| springdoc（Spring Boot 3） | `/v3/api-docs`（JSON）或 `/v3/api-docs.yaml`（YAML）；分组用 `/v3/api-docs/<分组名>` |
| springfox（老项目）        | `/v2/api-docs`；分组用 `?group=<分组名>`                                             |
| knife4j（`doc.html`）      | 「文档管理 → 离线文档」，选 OpenAPI 格式导出                                         |
| FastAPI                    | `/openapi.json`                                                                      |
| Swagger Editor             | File → Save as JSON / YAML                                                           |
| Apifox / YApi / Postman    | 导出为 OpenAPI 3.0 或 Swagger 2.0（Postman 的「Collection」格式不能用）              |

注意：

- **路径写绝对路径**，Windows 要带盘符（`E:/work/...`；Git Bash 的 `/e/work/...` 也可以）。相对路径会被拒绝，因为它会按服务进程的当前目录解析，而不是项目目录。
- **文件放在哪里都可以**。放进前端项目（如 `docs/api/swagger.json`）并提交，团队里每个人都能用；文档里可能有内部信息时，不要提交。
- **后端改了接口要重新导出**。覆盖原来的文件即可，下一次调用就会用新内容，不用重启 Agent。
- **多文件文档要先合并**。主文件里有 `$ref: ./schemas/Order.yaml` 这类引用时，工具结果里会有 `warning`，被引用的部分显示为 `unresolved(...)`。合并命令：`npx @redocly/cli bundle openapi.yaml -o openapi.bundled.yaml`。
- **有多个分组或多个服务**：每个分组是一份单独的文档。一次调用只读一份，页面用到哪个分组的接口，就给哪一份。
- **给错文件时工具会说明原因**：Swagger UI 等 HTML 页面、Postman 集合、目录（会列出目录里的 JSON/YAML 文件）、相对路径。

**HTTP 模式**：服务可能被多人共用，默认**不接受** `spec` 参数，只用 `--openapi`。确认只有自己能访问这个服务时，可以加 `--openapi-allow-dynamic` 放开。注意这时文件路径指的是**运行服务的机器**上的路径。

## 5. 运行方式：stdio 与 HTTP

| 方式              | 适用                                                              | 做法                                                                                             |
| ----------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **stdio**（推荐） | 所有本机 Agent                                                    | Agent 启动 `node dist/bin.js --stdio ...` 子进程，通过标准输入输出通信。Agent 关闭时服务随之退出 |
| **HTTP**          | 多个 Agent 共用一个服务；Agent 只支持远程 URL；在另一台机器上运行 | 先手动启动服务，Agent 配置 URL                                                                   |

HTTP 模式的启动方法：

```bash
node dist/bin.js --figma-api-key=<令牌> --openapi=<文档> --image-dir=<目录> --port 3333
```

Agent 里配置的地址是 `http://127.0.0.1:3333/mcp`（`/sse` 也指向同一个服务，兼容旧配置）。HTTP 模式下也可以不在服务端配置令牌，改为由 Agent 在每个请求里带 `X-Figma-Token: <令牌>` 或 `Authorization: Bearer <令牌>` 请求头。

注意：默认只监听 127.0.0.1。改成 `--host 0.0.0.0` 会让局域网内任何人都能用你的 Figma 令牌，除非在受控的网络里，否则不要这样做。

下文的例子都用 stdio。

## 6. 各 Agent 的配置

下面的例子统一使用这些占位值，请换成自己的：

| 占位        | 含义                                                                                        | 例子                                                               |
| ----------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `<BIN>`     | `dist/bin.js` 的绝对路径                                                                    | `E:\\Library\\github.com\\figmma\\Figma-Context-MCP\\dist\\bin.js` |
| `<TOKEN>`   | Figma 令牌                                                                                  | `figd_xxx`                                                         |
| `<SPEC>`    | 默认接口文档的 URL 或绝对路径（**可选**，不需要时删掉整个 `--openapi=<SPEC>` 参数，见 4.2） | `http://localhost:8080/v3/api-docs`                                |
| `<PROJECT>` | 前端项目根目录的绝对路径                                                                    | `E:\\work\\shop-web`                                               |

JSON 里的 Windows 路径要把 `\` 写成 `\\`，或者直接用 `/`（`E:/work/shop-web`），Node 都能识别。

### 6.1 Claude Code

**命令行添加**（推荐）：

```bash
# 只在当前项目可用（写入当前项目的本地配置，不提交）
claude mcp add framelink -- node <BIN> --stdio --figma-api-key=<TOKEN> --openapi=<SPEC> --image-dir=<PROJECT>

# 所有项目可用
claude mcp add framelink --scope user -- node <BIN> --stdio --figma-api-key=<TOKEN>

# 写入项目根目录的 .mcp.json，随仓库共享（不带令牌，令牌见下面的 env 写法）
claude mcp add framelink --scope project -- node <BIN> --stdio --openapi=<SPEC> --image-dir=<PROJECT>
```

`--` 之后是服务的启动命令和参数。`-e KEY=value` 可以设置环境变量，但值会原样写进配置文件，`--scope project` 时不要用它传令牌。PowerShell 中一行写不下时用反引号 `` ` `` 续行，bash 用 `\`。

**手动编辑 `.mcp.json`**（项目根目录，团队共享时用）：

```json
{
  "mcpServers": {
    "framelink": {
      "command": "node",
      "args": ["<BIN>", "--stdio", "--openapi=<SPEC>", "--image-dir=<PROJECT>"],
      "env": { "FIGMA_API_KEY": "${FIGMA_API_KEY}" }
    }
  }
}
```

`${FIGMA_API_KEY}` 从启动 Claude Code 的环境中读取，令牌不会写进文件。每个人的 `<BIN>` 路径不同时，不适合提交 `.mcp.json`，改用 `--scope user`。

**检查**：在 Claude Code 里输入 `/mcp`，`framelink` 显示为已连接，工具里有 `get_api_context`。

**Skill**：放到 `<PROJECT>/.claude/skills/figma-to-page/`（项目）或 `~/.claude/skills/figma-to-page/`（所有项目）。见第 7 节。

### 6.2 Cursor

配置文件：项目级 `<PROJECT>/.cursor/mcp.json`，全局 `~/.cursor/mcp.json`。也可以在 Cursor Settings → MCP 里点「Add new MCP server」打开这个文件。

```json
{
  "mcpServers": {
    "framelink": {
      "type": "stdio",
      "command": "node",
      "args": ["<BIN>", "--stdio", "--openapi=<SPEC>", "--image-dir=<PROJECT>"],
      "env": { "FIGMA_API_KEY": "${env:FIGMA_API_KEY}" }
    }
  }
}
```

- 令牌可以直接写在 `env` 里（不提交的全局配置），也可以用 `${env:FIGMA_API_KEY}` 引用系统环境变量，或者用 `"envFile": "${workspaceFolder}/.env.figma"` 从文件加载。
- 项目级配置里可以用 `${workspaceFolder}` 代替 `<PROJECT>`。

**检查**：Cursor Settings → MCP，`framelink` 旁边是绿点，展开能看到工具列表。

**Skill**：Cursor 从 `.cursor/skills/`、`.agents/skills/`、`.claude/skills/`（以及对应的 `~/` 用户目录）加载 Skill。放在任一目录即可，也可以在 Agent 对话里输入 `/` 手动调用。

### 6.3 VS Code（GitHub Copilot）

配置文件：项目级 `<PROJECT>/.vscode/mcp.json`。也可以用命令面板的「MCP: Add Server」添加到用户配置。注意顶层键是 **`servers`**，不是 `mcpServers`。

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "figma-token",
      "description": "Figma 访问令牌",
      "password": true
    }
  ],
  "servers": {
    "framelink": {
      "type": "stdio",
      "command": "node",
      "args": ["<BIN>", "--stdio", "--openapi=<SPEC>", "--image-dir=${workspaceFolder}"],
      "env": { "FIGMA_API_KEY": "${input:figma-token}" }
    }
  }
}
```

`inputs` 让 VS Code 在第一次启动服务时提示输入令牌并加密保存，配置文件可以安全提交（`<BIN>` 路径因人而异时除外）。

**检查**：Copilot Chat 切到 Agent 模式，点工具图标，能看到 `framelink` 的工具；或者在 `mcp.json` 编辑器里看服务器上方的状态（Running）。

**Skill**：VS Code 从 `.github/skills/`、`.claude/skills/`、`.agents/skills/`（以及 `~/.copilot/skills/` 等用户目录）加载；其他目录可以用设置项 `chat.agentSkillsLocations` 添加。

### 6.4 Codex CLI

**命令行添加**：

```bash
codex mcp add framelink --env FIGMA_API_KEY=<TOKEN> -- node <BIN> --stdio --openapi=<SPEC> --image-dir=<PROJECT>
```

**或编辑 `~/.codex/config.toml`**（全局），或项目里的 `.codex/config.toml`（只对已信任的项目生效）：

```toml
[mcp_servers.framelink]
command = "node"
args = ["<BIN>", "--stdio", "--openapi=<SPEC>", "--image-dir=<PROJECT>"]
startup_timeout_sec = 30
env_vars = ["FIGMA_API_KEY"]   # 从当前环境转发，令牌不写进文件
```

- TOML 字符串里的 Windows 路径用 `/`，或者用单引号字面量 `'E:\work\shop-web'`。
- `startup_timeout_sec` 默认 10 秒，一般够用；机器较慢、启动超时时调大一些。

**检查**：`codex mcp list`；会话中输入 `/mcp`。

**Skill**：Codex 只从 `.agents/skills/` 加载（从当前目录一直向上到仓库根目录都会扫描），用户级是 `~/.agents/skills/`。**不读 `.claude/skills/`。**

### 6.5 Gemini CLI

配置文件：用户级 `~/.gemini/settings.json`，项目级 `<PROJECT>/.gemini/settings.json`。

```json
{
  "mcpServers": {
    "framelink": {
      "command": "node",
      "args": ["<BIN>", "--stdio", "--openapi=<SPEC>", "--image-dir=<PROJECT>"],
      "env": { "FIGMA_API_KEY": "$FIGMA_API_KEY" }
    }
  }
}
```

**检查**：会话中输入 `/mcp`。

**Skill**：从 `.gemini/skills/` 或 `.agents/skills/`（项目），`~/.gemini/skills/` 或 `~/.agents/skills/`（用户）加载。`/skills list` 查看已加载的 Skill。

### 6.6 Windsurf

配置文件：`~/.codeium/windsurf/mcp_config.json`（也可以在 Windsurf Settings → Cascade → MCP Servers 里打开）。格式与 Cursor 相同：

```json
{
  "mcpServers": {
    "framelink": {
      "command": "node",
      "args": [
        "<BIN>",
        "--stdio",
        "--figma-api-key=<TOKEN>",
        "--openapi=<SPEC>",
        "--image-dir=<PROJECT>"
      ]
    }
  }
}
```

只有全局配置，多个前端项目要用不同的 `--image-dir` 或接口文档时，可以配置多个服务（如 `framelink-shop`、`framelink-admin`），或改用 HTTP 模式分别启动。

**Skill**：本文没有核实 Windsurf 对 Skill 的支持情况，按 [7.4](#74-不支持-skill-的-agent) 处理。

### 6.7 Cline（VS Code 扩展）

在 Cline 面板点 MCP Servers → Configure，打开 `cline_mcp_settings.json`，格式同 Windsurf（`mcpServers`、`command`、`args`、`env`）。

**Skill**：本文没有核实 Cline 对 Skill 的支持情况，按 [7.4](#74-不支持-skill-的-agent) 处理。

### 6.8 Claude Desktop

配置文件：Windows 为 `%APPDATA%\Claude\claude_desktop_config.json`，macOS 为 `~/Library/Application Support/Claude/claude_desktop_config.json`。格式同 Windsurf。改完后需要完全退出并重新打开 Claude Desktop。

Claude Desktop 不能直接修改前端项目的代码，适合查看设计稿、检查接口匹配情况；写代码请用上面的编程类 Agent。

### 6.9 其他 Agent

只要支持 stdio 方式的 MCP 服务，配置方法都一样：命令是 `node`，参数是 `<BIN> --stdio` 加其他配置项，令牌通过参数或环境变量传入。只支持远程 URL 的 Agent 用 HTTP 模式（第 5 节）。

## 7. 安装 figma-to-page Skill

### 7.1 各 Agent 读取的目录

| Agent              | 项目级目录                                                                | 用户级目录                                                     |
| ------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Claude Code        | `.claude/skills/`                                                         | `~/.claude/skills/`                                            |
| Cursor             | `.cursor/skills/`、`.agents/skills/`、`.claude/skills/`、`.codex/skills/` | 对应的 `~/` 目录                                               |
| VS Code（Copilot） | `.github/skills/`、`.claude/skills/`、`.agents/skills/`                   | `~/.copilot/skills/`、`~/.claude/skills/`、`~/.agents/skills/` |
| Codex CLI          | `.agents/skills/`                                                         | `~/.agents/skills/`                                            |
| Gemini CLI         | `.gemini/skills/`、`.agents/skills/`                                      | `~/.gemini/skills/`、`~/.agents/skills/`                       |

**选哪个目录**：

- 只用 Claude Code：`.claude/skills/`。
- 团队里有人用 Codex 或 Gemini CLI：`.agents/skills/`，Cursor、VS Code 也能读到。如果还有人用 Claude Code，再在 `.claude/skills/` 下建一个指向它的链接（见下面的命令）。不要复制两份，否则 Cursor、VS Code 会看到两个同名 Skill，而且两份内容容易改得不一致。
- Skill 要按项目调整（约定、命令），所以推荐放在项目里并提交到仓库，而不是放在用户目录。

### 7.2 复制

**Windows（PowerShell）**：

```powershell
$src = "E:\Library\github.com\figmma\Figma-Context-MCP\skills\figma-to-page"
Copy-Item -Recurse $src "<PROJECT>\.agents\skills\figma-to-page"

# 同时给 Claude Code 用：建目录链接（不需要管理员权限）
New-Item -ItemType Directory -Force "<PROJECT>\.claude\skills" | Out-Null
New-Item -ItemType Junction -Path "<PROJECT>\.claude\skills\figma-to-page" -Target "<PROJECT>\.agents\skills\figma-to-page"
```

**macOS/Linux**：

```bash
cp -R /path/to/Figma-Context-MCP/skills/figma-to-page <PROJECT>/.agents/skills/
mkdir -p <PROJECT>/.claude/skills
ln -s ../../.agents/skills/figma-to-page <PROJECT>/.claude/skills/figma-to-page
```

Windows 的目录链接（junction）提交到 Git 后，在其他电脑上不一定能还原成链接。团队里有 Windows 用户时，可以只提交 `.agents/skills/`，让每个人在本机自己建 `.claude/skills` 的链接，并把 `.claude/skills/figma-to-page` 加进 `.gitignore`。

### 7.3 复制后要做的事

1. **在前端项目的 `.gitignore` 里加上 `.figma-ref/`**（参考图和截图）。
2. **第一次使用时生成项目约定**：在 Agent 里说「按 figma-to-page 的第 0 步生成项目约定」，确认生成的 `docs/frontend-conventions.md`。
3. **按需修改 Skill**：Skill 是通用模板，项目差异尽量写进约定文档，而不是改 `SKILL.md`。
4. **脚本依赖装在前端项目里**，按需安装（Skill 会先征求同意）：
   - mock 验收：`npm i -D msw`；接口文档是 YAML 时还要 `npm i -D js-yaml`
   - 像素对比：`npm i -D pixelmatch pngjs`
   - 脚本要在前端项目根目录运行，它们从当前目录加载这些依赖。

### 7.4 不支持 Skill 的 Agent

有两种替代方式：

1. **用 MCP 提示词**：服务提供 `implement_design_with_api` 提示词（参数是 Figma 链接和可选的接口文档位置），包含精简版流程。支持 MCP prompts 的 Agent 一般在输入 `/` 时能看到它。
2. **用规则文件引用 Skill**：把 `skills/figma-to-page/` 复制到项目里（如 `docs/figma-to-page/`），在 Agent 的规则文件（如 Windsurf 的 `.windsurf/rules/`、Cline 的 `.clinerules`）中写一句：「实现 Figma 设计稿或对接接口时，先阅读并遵循 `docs/figma-to-page/SKILL.md`」。

## 8. 配置 chrome-devtools MCP（验收用）

Skill 第 1 步的视觉对比和第 6 步的验收需要它。以 Claude Code 为例：

```bash
claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest
```

其他 Agent 按第 6 节的格式添加：命令 `npx`，参数 `["-y", "chrome-devtools-mcp@latest"]`。Windows 上部分 Agent 无法直接启动 `npx`，可以改成命令 `cmd`，参数 `["/c", "npx", "-y", "chrome-devtools-mcp@latest"]`。需要本机安装 Chrome。

## 9. 验证清单

| #   | 检查                                                                                                | 预期                                                                                    |
| --- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | `node <BIN> --help`                                                                                 | 有 `--openapi`、`--openapi-allow-dynamic` 参数和 `api` 命令                             |
| 2   | `node <BIN> api --openapi <SPEC>`                                                                   | 列出接口，不报错                                                                        |
| 3   | Agent 的 MCP 面板或 `/mcp`                                                                          | `framelink` 已连接；工具有 `get_figma_data`、`download_figma_images`、`get_api_context` |
| 4   | 对 Agent 说「用 get_api_context 查一下 <SPEC> 里订单相关的接口」                                    | 返回候选接口，带 `matched`                                                              |
| 5   | 对 Agent 说「用 get_figma_data 读一下 <Figma 链接>，depth 1」                                       | 返回设计稿结构                                                                          |
| 6   | Skill 是否被识别（Claude Code 问「有哪些 skill」；Gemini CLI `/skills list`；Cursor 输入 `/` 搜索） | 能看到 `figma-to-page`                                                                  |
| 7   | 让 Agent 下载一个图标                                                                               | 文件出现在 `<PROJECT>` 下，而不是别的目录                                               |

## 10. 更新与卸载

**更新**：

```bash
cd <Figma-Context-MCP 目录>
git pull
npx pnpm@10.10.0 install
npx pnpm@10.10.0 build
```

然后重启 Agent（或在 MCP 面板里重启 `framelink`），新版本才会生效。Skill 不会自动更新，需要重新复制，注意保留自己对它的修改。

**卸载**：删除各 Agent 配置里的 `framelink` 项（Claude Code：`claude mcp remove framelink`；Codex：`codex mcp remove framelink`），删除项目里的 Skill 目录。

## 11. 常见问题

| 问题                                                                              | 原因                                                                                             | 解决办法                                                                         |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| 看不到 `get_api_context`                                                          | 启动的是 npm 上的官方版本；或者是 HTTP 模式，既没配 `--openapi` 也没加 `--openapi-allow-dynamic` | 检查命令是 `node <BIN>`；HTTP 模式按 4.2 处理                                    |
| AI 说没有接口文档、问文档在哪                                                     | 调用时没给 `spec`，也没有默认文档                                                                | 告诉它文档的绝对路径或 URL；用 Skill 时它会记进项目约定                          |
| 报 `is an HTML/XML page`                                                          | 给的是 Swagger UI 等网页，不是文档本身                                                           | 按 4.2 的表格导出文档文件，或者给文档的 URL                                      |
| 结果里有 `warning`，提到 `split across files`                                     | 文档拆成了多个文件                                                                               | 用 `npx @redocly/cli bundle` 合并成一个文件                                      |
| 报 `only serves its configured`                                                   | HTTP 模式下服务只用 `--openapi` 配置的文档                                                       | 调用时不带 `spec`；要用别的文档就加 `--openapi-allow-dynamic`                    |
| 服务连不上，日志里有 `Either FIGMA_API_KEY or FIGMA_OAUTH_TOKEN is required`      | stdio 模式启动时没拿到令牌                                                                       | 用 `--figma-api-key` 传入；检查 `env` 写法是否被该 Agent 支持                    |
| 服务连不上，没有任何日志                                                          | 漏了 `--stdio`；或 `node` 不在 Agent 的 PATH 里                                                  | 加 `--stdio`；`command` 改成 node 的绝对路径（`where node` / `which node` 查看） |
| 配置的 `env` 不生效                                                               | 服务当前目录下的 `.env` 覆盖了它                                                                 | 改用命令行参数，或用 `--env` 指向专用的 `.env` 文件                              |
| `get_api_context` 报 `not an absolute path`、`file not found` 或 `is a directory` | 路径是相对路径或没有盘符、文件不存在，或者给的是目录                                             | 给文件的完整路径（带盘符）；目录的报错里会列出其中的 JSON/YAML 文件              |
| 图片下载到了奇怪的目录                                                            | 没配 `--image-dir`，默认是服务进程的当前目录                                                     | 配置 `--image-dir=<PROJECT>`；工具返回的消息里有实际保存的绝对路径               |
| 改了代码或重新构建后没变化                                                        | Agent 还在用旧进程                                                                               | 重启 Agent 或在 MCP 面板重启服务                                                 |
| Codex 启动服务超时                                                                | 默认 10 秒，机器较慢时不够                                                                       | `startup_timeout_sec = 30`                                                       |
| Codex 不认 Skill                                                                  | 放在了 `.claude/skills/`                                                                         | 放到 `.agents/skills/`                                                           |
| Cursor、VS Code 里出现两个 figma-to-page                                          | `.agents/skills/` 和 `.claude/skills/` 各有一份                                                  | 只保留一份，另一处用链接                                                         |
| 公司网络连不上 Figma 或接口文档                                                   | 需要代理                                                                                         | `--proxy=http://代理:端口`，或设置 `HTTPS_PROXY`                                 |
| 不想发送使用统计                                                                  | 默认开启                                                                                         | 加 `--no-telemetry`，或设置 `FRAMELINK_TELEMETRY=off`                            |

更多和使用流程有关的问题，见 [figma-to-page-guide.md](figma-to-page-guide.md) 第 7 节。

---

各 Agent 配置格式的依据（2026 年 10 月核对）：[Cursor MCP](https://cursor.com/docs/context/mcp)、[Cursor Skills](https://cursor.com/docs/skills)、[VS Code Agent Skills](https://code.visualstudio.com/docs/copilot/customization/agent-skills)、[VS Code MCP 配置参考](https://code.visualstudio.com/docs/copilot/reference/mcp-configuration)、[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[Codex Skills](https://learn.chatgpt.com/docs/build-skills)、[Gemini CLI Skills](https://geminicli.com/docs/cli/skills/)。Agent 更新频繁，配置方式以各自最新文档为准。Windsurf、Cline、Claude Desktop 的配置路径和 Gemini CLI 的 MCP 写法是按已知格式写的，本次没有逐一核对。
