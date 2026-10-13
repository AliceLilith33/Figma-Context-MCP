# 后端接口对接功能：功能说明与工作原理

本文说明在 Framelink 上新增的「设计稿对接后端接口」能力：改了什么、每部分做什么、内部如何工作，以及有意不做的事。使用示例与问题排查见 [figma-to-page-guide.md](figma-to-page-guide.md)。

## 1. 背景与目标

原版 Framelink 只把 Figma 设计数据精简后交给 AI，AI 写出的页面是**静态的**：文字、列表都是设计稿里的占位内容。

本次改动让 AI 在实现页面时同时了解后端接口（来自 OpenAPI / Swagger 文档），从而直接写出请求接口、绑定数据的页面。

设计边界（已确认）：

| 决定             | 内容                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 接口来源         | OpenAPI 3.x / Swagger 2.0 文档，本地文件或 URL；由 AI 在调用时指定（用户提供或从项目里找），服务配置的 `--openapi` 作为默认值 |
| UI ↔ 字段对应   | 由 AI 推断，设计师无需做标注                                                                                                  |
| Framelink 的职责 | **只提供上下文**，不生成代码，不访问后端服务                                                                                  |
| 验收后端         | 同时支持 mock（MSW）与 live（真实开发环境后端）                                                                               |
| 像素级对比       | 按需使用                                                                                                                      |

## 2. 整体结构

```
                      ┌──────────────────────── Framelink MCP ────────────────────────┐
 Figma REST API ────► │ get_figma_data / download_figma_images（原有）                 │
                      │                                                                │
 OpenAPI 文档 ──────► │ get_api_context（新增；文档由调用参数 spec 或 --openapi 指定） │
 (文件 / URL)         │   source.ts → load.ts → simplify.ts → search.ts → 输出         │
                      │ implement_design_with_api 提示词（新增，最简兜底流程）         │
                      └───────────────────────────────┬────────────────────────────────┘
                                                      │ 工具调用
                                                      ▼
                      ┌──────────── AI 编辑器（Claude Code 等） ────────────┐
                      │ figma-to-page Skill（新增，放在前端项目里）         │
                      │   流程 + 项目约定 + 绑定规则 + 验收                  │
                      │   scripts/gen-mock-handlers.mjs → MSW mock          │
                      │   scripts/visual-diff.mjs → 像素对比（按需）        │
                      └─────────────────────────────────────────────────────┘
```

分工原则：**工具给数据，Skill 给流程和规范，代码由 AI 写**。

## 3. 改动清单

### 新增

| 文件                                                            | 作用                                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `src/services/openapi/source.ts`                                | 确定本次调用用哪份文档（`spec` 参数或默认配置），检查路径，限制请求头的发送范围 |
| `src/services/openapi/load.ts`                                  | 读取并缓存 OpenAPI 文档                                                         |
| `src/services/openapi/simplify.ts`                              | 把 OpenAPI 精简成紧凑的类 TypeScript 表示                                       |
| `src/services/openapi/search.ts`                                | 按设计稿关键词给接口打分排序                                                    |
| `src/services/get-api-context.ts`                               | 串起加载→精简→筛选→序列化；MCP 工具与 CLI 共用                                  |
| `src/mcp/tools/get-api-context-tool.ts`                         | MCP 工具 `get_api_context`                                                      |
| `src/mcp/prompts/implement-design-with-api.ts`                  | MCP 提示词 `implement_design_with_api`                                          |
| `src/commands/api.ts`                                           | CLI 调试命令 `api`                                                              |
| `src/tests/api-context.test.ts`、`src/tests/fixtures/openapi/*` | 测试与样例文档（OpenAPI 3 YAML + Swagger 2 JSON）                               |
| `skills/figma-to-page/`                                         | Skill：`SKILL.md`、4 篇参考文档、2 个脚本                                       |

### 修改

| 文件                     | 改动                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config.ts`          | 新增 `--openapi`/`OPENAPI_SPEC`、`--openapi-header`/`OPENAPI_SPEC_HEADER`、`--openapi-allow-dynamic`/`OPENAPI_ALLOW_DYNAMIC`；新增 `resolveOpenApiSource()` |
| `src/bin.ts`             | 注册上述参数与 `api` 子命令                                                                                                                                 |
| `src/server.ts`          | 把 `openapi` 配置传给 MCP 服务                                                                                                                              |
| `src/mcp/index.ts`       | 注册新工具和提示词：stdio 模式始终注册；HTTP 模式下配置了默认文档或开启 `--openapi-allow-dynamic` 才注册                                                    |
| `src/mcp/tools/index.ts` | 导出新工具                                                                                                                                                  |
| `eslint.config.js`       | `skills/**/scripts/*.mjs` 使用 Node 全局变量                                                                                                                |
| `README.md`、`CLAUDE.md` | 使用说明与架构说明                                                                                                                                          |

**没有新增任何 npm 依赖**（YAML/JSON 解析复用已有的 `js-yaml`）。

## 4. `get_api_context` 工作原理

### 4.1 指定接口文档

每次调用用哪份文档，按以下顺序决定（`source.ts`）：

1. **调用参数 `spec`**：文件的绝对路径（如用户导出的 `swagger.json`），或文档本身的 URL。AI 从用户的话、项目约定或项目里的文件得到它，每次调用都要带上（HTTP 模式下每个请求都新建服务实例，服务端记不住）。
2. **服务配置的默认文档** `--openapi`/`OPENAPI_SPEC`：不带 `spec` 时使用。
3. **两者都没有**：返回错误，告诉 AI 先查项目约定和项目里的 `openapi.*`/`swagger.*`/`api-docs*.json`，再找不到就**问用户**，不要猜。

```bash
# 不配默认文档，由 AI 在调用时指定
node dist/bin.js --stdio --figma-api-key=XXX
# 配一份默认文档；需要认证的 URL 可以带一个请求头
node dist/bin.js --stdio --figma-api-key=XXX --openapi=http://localhost:8080/v3/api-docs \
  --openapi-header="Authorization: Bearer xxx"
```

对 `spec` 的检查：

| 情况                                                   | 处理                                                                                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 相对路径、没有盘符的 Windows 路径（如 `/work/x.json`） | 拒绝。会按服务进程的当前目录（或当前盘）解析，而不是项目目录                                                               |
| 目录                                                   | 拒绝，并列出目录中的 JSON/YAML 文件（名字像接口文档的排在前面），方便 AI 选择或问用户                                      |
| Git Bash 写法（`/e/work/x.json`）                      | Windows 上转成 `E:/work/x.json`                                                                                            |
| 带引号（资源管理器「复制文件地址」）                   | 去掉引号                                                                                                                   |
| 文件不存在                                             | 拒绝                                                                                                                       |
| `file://` URL                                          | 转成本地路径                                                                                                               |
| 与默认文档相同                                         | 当作没传，用默认配置（包括请求头）。本地路径的斜杠、大小写（Windows）不同，或 URL 是工具说明里去掉查询参数的写法，也算相同 |

**安全上的考虑**：工具参数接受文件路径和 URL，意味着 AI 可能被设计稿、网页里的注入内容诱导去读别的文件或地址。对应的限制：

- `--openapi-header` 的请求头**只发给与默认文档同源的地址**，其他地址不带请求头，令牌不会被送到别处。需要认证的其他文档，让用户导出成文件。
- 读到的内容必须能解析成 OpenAPI 才会返回；解析失败的报错不引用原文，所以读错文件不会把文件内容带出来。
- **HTTP 模式默认不接受 `spec`**（开启后，`spec` 里的文件路径指的是**运行服务的机器**上的路径）：HTTP 服务可能被多人共用，接受 `spec` 等于让任何能访问它的人读取服务器上的文件、访问服务器所在的内网。需要时加 `--openapi-allow-dynamic`（`OPENAPI_ALLOW_DYNAMIC=true`），只在别人访问不到的服务上开启。HTTP 模式下既没有默认文档、又没开启这个选项时，不注册该工具。stdio 模式下 AI 本来就能读本地文件、访问网络，`spec` 不增加新的能力，所以默认接受。
- 本地默认文档的路径在启动时转成绝对路径。
- 带了 `--openapi-header` 时**不跟随跳转**：跳转可能把请求头带到别的网站（Node 只会在跨域跳转时去掉 `Authorization`，自定义请求头会被带过去）。遇到跳转会报错，提示改用跳转后的地址。
- URL 里的查询参数和 `用户名:密码@` 在日志、错误信息和工具说明里都会去掉。
- 配置了默认文档时，工具说明里会写出它的位置（URL 去掉查询参数），AI 据此判断是否就是用户说的那份，生成 mock 时也用同一个地址，不需要去读含令牌的 MCP 配置文件。

### 4.2 加载（`load.ts`）

1. 本地文件读文本；URL 用 `fetch` 拉取，可带一个请求头，30 秒超时。MCP 服务会沿用 Framelink 已有的代理设置（`--proxy` / `HTTPS_PROXY`）；`api` 调试命令不走代理。
2. 用 `js-yaml` 的 `CORE_SCHEMA` 解析——YAML 是 JSON 的超集，一个解析器处理两种格式；`CORE_SCHEMA` 避免把未加引号的日期示例转成 Date 对象。
3. 校验必须有 `openapi: 3.x` 或 `swagger: "2.0"`（不带引号的 `swagger: 2.0` 也接受），且有 `paths`。
4. **缓存在模块级**，最多保留最近用过的 10 份文档：本地文件按修改时间（mtime）和文件大小失效（覆盖导出同一个文件后，下一次调用就会用新内容），URL 每 60 秒最多重新拉取一次；重新拉取失败时继续用已缓存的版本（开发环境后端重启不影响正在进行的会话）。之所以不放在服务实例里，是因为 HTTP 模式下每个请求都会新建一个 MCP 服务实例。
5. 错误信息**不包含响应体**，URL 的查询参数也会去掉：内部文档服务器的错误页可能回显请求头（即鉴权信息）。
6. **常见的错误文件给出明确提示**，而不是笼统的解析错误：
   - 内容以 `<` 开头（Swagger UI、Redoc、knife4j 页面另存的 HTML，或登录页）：提示用页面标题下方的文档链接，或从 knife4j 导出 OpenAPI 格式的离线文档。
   - Postman 导出的集合：提示改为导出 OpenAPI 3 或 Swagger 2.0。
   - 其他解析失败只报行列号，不引用原文。

### 4.3 精简（`simplify.ts`）

目标：把动辄几千行的 OpenAPI 压成 AI 一眼能读懂、又省上下文的结构。

**表示法（类 TypeScript）**

| 写法                                              | 含义                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------- |
| `integer`、`string<date-time>`                    | 基础类型；只保留对前端有意义的 format（date、date-time、email、uuid、int64 等） |
| `"PAID" \| "REFUNDED"`                            | 枚举                                                                            |
| `Order[]`                                         | 数组；`[ { ... } ]` 表示对象数组                                                |
| `field?`                                          | 可选字段（**仅当文档声明了 `required` 时才标注**）                              |
| `string \| null`                                  | 可为空                                                                          |
| `amount: 'integer  # 实付金额（分）; e.g. 12800'` | `#` 后是字段说明与示例值                                                        |
| 对象中的 `"#"` 键                                 | 对象自身的说明                                                                  |
| 裸名称，如 `Order`                                | 引用 `schemas` 段中的定义                                                       |

**关键处理**

- **统一两种规范**：Swagger 2 的 `definitions`、`in: body`/`formData`、参数平铺类型，与 OpenAPI 3 的 `components.schemas`、`requestBody`、`schema` 嵌套，统一成同一种输出。
- **计数门控的结构提升**（与 Framelink 处理样式的 `finalize.ts` 同一思路）：先扫描全文统计每个 schema 被 `$ref` 引用的次数，**≥2 次的放进 `schemas` 只写一次，只用一次的就地展开**。
- **循环引用**：正在展开的 schema 再次出现时，改为输出名称并提升到 `schemas`（如 `Category.children: Category[]`）。连续嵌套超过 3 层的引用也改为输出名称，避免缩进过深。
- **`allOf`**：组合用法（`[Base, {额外字段}]`）合并成一个完整对象；仅用于给引用加说明的用法（`[{$ref: X}]`）保留引用名。
- **`oneOf`/`anyOf`**：全是简单类型时写成 `A | B`，否则输出 `{ oneOf: [...] }`。OpenAPI 3.1 的 `anyOf: [X, {type: "null"}]`（FastAPI 的 `Optional`）写成 `X | null`。
- **参数**：路径级与操作级参数合并（同名同位置时操作级覆盖）；忽略 `Authorization`、`Content-Type`、`Accept` 请求头（客户端统一处理）。
- **响应**：只取成功响应（优先 200/201/202/204），非 200 时注明 `responseStatus`；错误响应只保留有实际信息的说明（「Bad Request」这类只是复述状态码的会被丢弃）。
- **鉴权**：全局鉴权方式写在 `api.auth`；单个接口只有与全局不同时才写 `auth`（如登录接口 `auth: none`）。
- **丢弃**：完整 examples、externalDocs、`x-*` 扩展、安全细节——对写页面没有帮助。
- **外部引用**（`./schemas/Order.yaml`、`other.yaml#/...`）不解析，输出 `unresolved(...)` 而不是让整个调用失败；同时在结果里加 `warning`，说明文档拆成了多个文件，请用户提供单文件或用 `npx @redocly/cli bundle` 合并。不自动跟随外部引用，是因为那等于按文档内容去读任意文件或地址。指向子结构的引用（`#/components/schemas/X/properties/y`）形成循环时输出 `circular(...)`。

### 4.4 搜索（`search.ts`）

为「AI 推断」服务的召回工具：把几百个接口缩小到十几个候选并给出理由，最终由 AI 判断。

1. **建索引**（每份文档只建一次）：每个接口收集 summary、description、tags、operationId、路径片段、参数名、请求/响应字段名、字段说明与示例、枚举值（含其引用的 schema）。
2. **提取检索词**：从关键词中取出 2 个字以上的中文串，以及 3 个字符以上的英文单词和数字串（拆分 `orderNo`、`order_no`），丢弃符号。数字串保留是因为 `202501020001` 这类占位值可能命中字段的示例值；`¥128.00` 只剩 `128`，一般命中不了什么。
3. **匹配强度**（0～1）：
   - 英文：完全相同 = 1；4 个字母以上的前缀匹配（order/orders）= 0.8。
   - 中文：包含 = 1；否则按「两字一组」计算重合比例，≥30% 时得 `比例 × 0.6`（处理「我的订单」对「订单列表」、「订单编号」对「订单号」）。
4. **权重**：summary 5 > tag 4 > operationId、路径 3 > 字段名 2 > 说明 1。每个检索词取最佳匹配，累加得分；GET 接口 × 1.1（页面以展示数据为主）。
5. 输出 `matched: 我的订单(summary), 实付金额(desc)`，告诉 AI 每个词命中在哪里。

不使用向量检索的原因：需要额外的模型或服务依赖；而 summary 和字段名的字面命中已经覆盖真实文档中的大部分信号。

### 4.5 筛选与输出（`get-api-context.ts`）

| 参数                 | 作用                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `spec`               | 接口文档的绝对路径或 URL；不传时用服务配置的默认文档（见 4.1）                                                         |
| `keywords`           | 按相关度排序                                                                                                           |
| `operationIds`       | 取指定接口；可写 operationId 或 `GET /orders/{id}`（不区分大小写）                                                     |
| `tags`、`pathPrefix` | 精确过滤                                                                                                               |
| `detail`             | `index` 只给 id/endpoint/summary；`full` 给参数、请求体、响应结构。给了 `operationIds` 时默认 `full`，否则默认 `index` |
| `limit`              | 数量上限。默认：搜索 15、浏览 50、full 15、指定 operationIds 时全部                                                    |

- 不带任何条件、且 `detail` 为 `index` 时，额外输出按 tag 的接口计数，帮助 AI 缩小范围。
- `full` 模式只附带这些接口**传递引用到的** schema，不输出整份 `schemas`。
- 结果被截断时给出 `truncated` 提示；不存在的 operationId 列在 `notFound`；关键词无命中时给出 `hint`；文档有外部引用时给出 `warning`。
- 精简与索引结果按文档对象缓存（WeakMap），同一版本的文档只计算一次。
- 输出格式跟随全局 `--format`：`json` 输出 JSON，其他情况输出 YAML（`tree` 格式是 Figma 节点树专用的）。

### 4.6 提示词与 CLI

- **`implement_design_with_api` 提示词**：参数是 Figma 链接和可选的 `spec`。最简的 5 步流程，没给 `spec` 时要求 AI 按 Skill 的顺序确定文档、确定不了就问用户；服务不接受 `spec`（HTTP 模式）时只让它不带 `spec` 调用；作为没有 Skill 的项目的兜底；项目中有 `figma-to-page` Skill 时提示 AI 以 Skill 为准。完整流程只在 Skill 里写一次，避免多处内容逐渐不一致。
- **`api` 命令**：打印 `get_api_context` 会返回的内容，用于检查文档质量、调试关键词：
  ```bash
  node dist/bin.js api --openapi ./openapi.yaml --keywords "我的订单,实付金额"
  node dist/bin.js api --openapi ./openapi.yaml --operation-ids listOrders,getOrderDetail
  ```

## 5. `figma-to-page` Skill 工作原理

### 5.1 为什么是一个 Skill

曾考虑拆成「总流程 / 设计还原 / 接口对接 / 验收」4 个，复核后合并为 1 个：

- Skill 之间没有可靠的调用机制，串联 4 个 Skill 依赖 AI 自觉加载，不稳定。
- 多个 Skill 的触发描述相互重叠，容易加载错。
- 设计还原的项目差异部分属于项目约定，放 CLAUDE.md 更可靠（每次都会加载）。
- 细节放在 `references/` 中，用到时才读取（渐进加载），不会一次占满上下文。

### 5.2 结构

```
skills/figma-to-page/
├── SKILL.md                         前提、硬性规则、第 0～7 步、交付格式
├── references/
│   ├── conventions-template.md      第 0 步：从代码库生成项目约定文档
│   ├── figma-reference.md           渲染参考图、对齐浏览器截图尺寸
│   ├── data-binding.md              字段匹配依据、类型来源、数据转换、写操作
│   └── verification.md              静态阶段 / 数据阶段，mock 与 live 两种模式
└── scripts/
    ├── gen-mock-handlers.mjs        OpenAPI → MSW handlers
    └── visual-diff.mjs              像素对比（按需）
```

### 5.3 流程与设计依据

| 步骤       | 内容                                                                         | 设计依据                                             |
| ---------- | ---------------------------------------------------------------------------- | ---------------------------------------------------- |
| 0 项目约定 | 首次运行时读代码库生成 `docs/frontend-conventions.md`，注明出处，用户确认    | Skill 保持通用，项目差异集中在一份文档里             |
| 1 静态还原 | 用设计稿占位内容写静态页面，数据类内容放进交接文件；**视觉对比只在这一步做** | 接上真实数据后内容与设计稿必然不同，再比截图没有意义 |
| 2 找接口   | 关键词 → `get_api_context` 候选 → 取完整结构                                 | 先召回再精读，控制上下文                             |
| 3 数据层   | 类型以项目的代码生成为准，没有才手写并注明                                   | 精简结构会丢失部分信息，不能作为类型唯一来源         |
| 4 绑定     | 换掉交接文件中的占位数据，补齐 loading/空数据/错误，然后删除交接文件         | 第 1 步把占位数据集中存放，就是为这一步替换          |
| 5 运行检查 | 类型检查 + lint                                                              | 硬性规则靠工具保证，文档只能提示                     |
| 6 验收     | mock / live 两种模式；最多修 2 轮                                            | 防止无限循环                                         |
| 7 交付     | 改动文件、字段对照表（附**依据**）、写操作表、未匹配项、验收结果             | AI 自报的「置信度」不可靠，具体依据才能让人核对      |

**分阶段执行**：第 0、1 步为阶段 A（静态页面），第 2～7 步为阶段 B（对接接口），可以连续做，也可以分开做（隔几天、换会话、换人都可以）。两个阶段靠**交接文件** `<页面>.mock.ts` 衔接：它随页面一起提交，里面放占位数据，头部注释记录 Figma 链接、`@keywords`、`@lists`（重复结构对应的数组）、`@actions`（交互）。阶段 B 读取交接文件检索接口，不需要再调用 Figma；绑定完成后删除交接文件。没有交接文件时（页面不是用本 Skill 做的），退回到重新获取设计稿。

硬性规则：项目约定优先、一次一个页面、参考图只渲染一次、不擅自新增依赖、**live 后端上不执行写操作**、修复最多 2 轮。

### 5.4 `gen-mock-handlers.mjs`

1. 读取文档（文件或 URL；JSON 直接解析，YAML 需要项目里有 `js-yaml`）。
2. 对每个接口取成功响应的 schema，生成**确定性**的示例数据（同一份文档每次生成结果相同）：
   - 优先使用 `example`、`enum`（列表项轮换枚举值）；
   - 按 format 生成日期、邮箱、UUID 等；
   - 按字段名推测：`id` 类保证列表项不重复（React key），金额类给 12800 这类数值，`total` 与数组长度一致，图片类给占位图地址；
   - 统一包装中的 `code` 取成功值，`msg` 取 `"ok"`。成功值的优先级：`--success-code` → 文档中 `code` 字段的 `example`/`enum` → 0；
   - `allOf`（包括多层嵌套）合并所有字段；只写了 `default` 响应的接口也会生成数据；
   - 循环引用和超过 10 层的嵌套会被截断。
3. 生成 MSW v2 handler，路由为 `*<base><path>`（`{id}` 转为 `:id`；`*` 匹配任意域名）。`--base` 不传时取文档 servers 的路径，其中的变量用默认值替换。`--ops` 按 operationId 精确匹配（区分大小写），有不存在的就报错退出，不会生成残缺的文件。`--out` 以 `.ts` 结尾时文件头加 `// @ts-nocheck`。js-yaml 从当前目录解析，所以要在前端项目根目录运行。
4. 运行时读取场景设置，优先级：页面 URL `?mock=`（hash 路由的 `#/path?mock=` 也可以）→ `localStorage["mock:scenario"]` → `globalThis.__MOCK_SCENARIO__` → `normal`。可以统一指定（`empty`），也可以按接口指定（`listOrders:error,getCurrentUser:loading`）。

| 场景       | 行为                                                                         |
| ---------- | ---------------------------------------------------------------------------- |
| `normal`   | 返回示例数据（列表 3 条）                                                    |
| `empty`    | 所有数组清空，`total`/`count`/`pages` 等归零，`hasMore`/`hasNext` 置为 false |
| `error`    | HTTP 500                                                                     |
| `bizerror` | HTTP 200 + 失败的业务码（仅响应带 `code` 字段时）                            |
| `loading`  | 永不返回                                                                     |
| `slow`     | 延迟 2 秒                                                                    |

### 5.5 `visual-diff.mjs`

用 pixelmatch 逐像素比较参考图与截图，输出差异像素数、差异比例、高度差，并生成标红的差异图。

- 宽度不同：直接报错（退出码 3），提示先对齐视口宽度与设备像素比。
- 高度不同：只比较重叠部分，并报告高度差（`heightMismatch`）；差得多时 `diffRatio` 会偏乐观，要单独看。
- 缺依赖：退出码 2，只提示不自动安装。依赖从当前目录解析，要在前端项目根目录运行。
- 文件不存在或参数错误：退出码 1。
- 只输出数字，不判定是否合格：字体渲染和抗锯齿必然产生少量差异，合格与否由差异区域是否有实际问题决定。

## 6. 局限

| 局限               | 说明                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------- |
| 搜索是字面匹配     | 理解不了同义词（如「营业额」与 `revenue`），需要文档写好中文说明                            |
| 一次调用一份文档   | 页面同时用到多个微服务的接口时，分别对每份文档调用；或者先合并成一份                        |
| 精简会丢信息       | 对象类型的可空性不表示；没写 `required` 时不标可选；`allOf` 成员里的 `oneOf`/`anyOf` 不合并 |
| 外部 `$ref` 不解析 | 需先 bundle 成单文件（结果里会有 `warning` 提示）                                           |
| Figma 配额         | 需付费计划 Dev/Full 席位；View/Collab 席位即使在企业计划也按月计次                          |
| 规则不能强制执行   | Skill 只是说明文字，硬性规则需做成 ESLint 规则                                              |
| 跨客户端           | 仅确认 Claude Code 支持项目内 `.claude/skills/`，其他客户端未验证                           |
| 上游范围           | Framelink 贡献指南把第三方集成列为不接受的范围，本功能适合在 fork 中使用                    |

## 7. 测试与验证

| 内容                                                                 | 方式                                           | 结果                                         |
| -------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------- |
| 工具注册、提示词、关键词检索                                         | `api-context.test.ts`（通过 MCP 内存传输调用） | 通过                                         |
| `spec` 参数：覆盖默认文档、缺失时的提示、HTTP 模式的限制与开关、引号 | 同上                                           | 通过                                         |
| 请求头只发同源、去掉查询参数的默认地址仍算默认文档                   | 直接调用 `resolveSpecSource`                   | 通过                                         |
| 错误文件的提示：相对路径、目录、HTML、Postman、多文件                | 同上                                           | 通过                                         |
| 结构提升、循环引用、allOf 合并、notFound                             | 同上                                           | 通过                                         |
| Swagger 2 与 OpenAPI 3 输出一致                                      | 同上                                           | 通过                                         |
| 构建产物 stdio 端到端                                                | 启动 `dist/bin.js`，列工具、取提示词、调用工具 | 通过                                         |
| mock 6 种场景                                                        | 生成 handler，用真实 MSW（`setupServer`）请求  | 通过（手动运行，仓库里没有对应的自动化测试） |
| 像素对比                                                             | 构造图片：差异像素数、宽度不一致、缺依赖       | 通过（手动运行，同上）                       |
| Skill 端到端                                                         | 需在真实前端项目中运行                         | **未进行**                                   |
