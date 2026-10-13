# figma-to-page 使用指南

本文用一个完整例子说明如何使用 `figma-to-page` Skill：从 Figma 设计稿做出对接后端接口的页面。最后列出常见问题和解决办法。功能和原理见 [backend-api-integration.md](backend-api-integration.md)。

## 1. 例子场景

| 项目     | 内容                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------- |
| 页面     | 商城后台的「我的订单」列表页，路由 `/orders`                                                                      |
| 设计稿   | `https://www.figma.com/design/AbC123/Shop?node-id=12-345`                                                         |
| 后端文档 | `http://localhost:8080/v3/api-docs`（下文的输出取自仓库里的样例文档 `src/tests/fixtures/openapi/shop.oas3.yaml`） |
| 前端     | React 18 + Vite + Ant Design + React Query，请求封装在 `src/utils/request.ts`                                     |

设计稿内容：标题「我的订单」；状态筛选标签（全部 / 待支付 / 已支付 / 已发货）；订单卡片（订单号 `202501020001`、实付金额 `¥128.00`、下单时间 `2025-01-02 10:00`、收货人、状态标签）；每张卡片有「查看详情」按钮；底部分页。

## 2. 一次性准备

下面以 Claude Code 为例。其他 Agent（Cursor、VS Code、Codex CLI、Gemini CLI 等）的配置方法和全部配置项见 [setup-guide.md](setup-guide.md)。

### 2.1 构建 Framelink

这些改动只在本地仓库里。**`npx figma-developer-mcp` 下载的是 npm 上的官方版本，没有这些功能**，必须用本地构建的版本。

```bash
cd E:\Library\github.com\figmma\Figma-Context-MCP
npx pnpm@10.10.0 install
npx pnpm@10.10.0 build          # 生成 dist/bin.js
```

### 2.2 检查接口文档质量

```bash
node dist/bin.js api --openapi http://localhost:8080/v3/api-docs
node dist/bin.js api --openapi http://localhost:8080/v3/api-docs --keywords "我的订单,实付金额,下单时间"
```

合格的输出应该能把订单列表接口排在前面，并且字段带有说明（节选，省略了开头的 `api:` 文档信息）：

```yaml
operations:
  - id: listOrders
    endpoint: GET /orders
    summary: 订单列表
    matched: 我的订单(summary), 实付金额(desc), 下单时间(desc)
```

如果输出里字段没有说明、响应只写了 `object`、接口没有 summary，先让后端补齐文档（要求见 README「Spec requirements」）。文档质量决定 AI 匹配字段的准确率。

### 2.3 配置 MCP（Claude Code，Windows PowerShell）

```powershell
claude mcp add framelink -- node E:\Library\github.com\figmma\Figma-Context-MCP\dist\bin.js `
  --stdio --figma-api-key=你的Figma令牌 `
  --openapi=http://localhost:8080/v3/api-docs `
  --image-dir=E:\work\shop-web
```

- `--openapi` 用本地文件时写绝对路径：相对路径按 MCP 客户端启动服务时的目录解析，不一定是项目目录。

- `--image-dir` 设为前端项目根目录，下载的图片和参考图会保存在项目里。
- 验收需要 chrome-devtools MCP，请另行配置。
- 配好后在 Claude Code 里输入 `/mcp`，确认能看到 `get_api_context`。

### 2.4 把 Skill 放进前端项目

```powershell
Copy-Item -Recurse E:\Library\github.com\figmma\Figma-Context-MCP\skills\figma-to-page E:\work\shop-web\.claude\skills\figma-to-page
```

在前端项目的 `.gitignore` 里加上 `.figma-ref/`（参考图和截图）。

## 3. 第一次使用：生成项目约定

在前端项目里打开 Claude Code，输入：

> 实现 https://www.figma.com/design/AbC123/Shop?node-id=12-345 ，做成我的订单页，路由 /orders，对接后端接口

由于项目里还没有 `docs/frontend-conventions.md`，AI 会先执行第 0 步：读取 package.json、请求封装、已有页面等，按模板起草约定文档并请你确认。示例（节选）：

```markdown
## 请求层

- 请求封装：src/utils/request.ts 导出的 request（来源：src/api/user.ts 均使用它）
- 数据获取方式：@tanstack/react-query 的 useQuery（来源：src/pages/user/list/index.tsx）
- 统一返回包装：{ code, msg, data }，code===0 成功；拦截器已解包，返回 data（来源：request.ts 第 30 行）
- 分页约定：请求 page/size，返回 { total, list }
- OpenAPI 类型生成：无

## 数据格式

- 金额：接口单位为分，用 src/utils/format.ts 的 formatMoney() 显示
- 枚举→文案：src/constants/enums.ts

## 验收环境

- mock 模式：未接入
- live 模式后端地址：vite 代理 /api → http://localhost:8080/v1
- 测试账号/登录方式：未约定 ← AI 找不到依据，会向你提问
```

**这一步要认真核对**，后面每次运行都会依据这份文档。确认后，AI 会在 CLAUDE.md 里加一行指向它，然后继续后面的流程。

## 4. 完整流程示例

### 第 1 步：静态还原 + 视觉对比

AI 依次：

1. 调用 `get_figma_data`，取得页面结构。订单卡片在输出里是重复结构：
   ```
   [INSTANCE] "OrderCard" #12:400 template=EL-3f9a2c1b
   [INSTANCE] "OrderCard" #12:401 template=EL-3f9a2c1b
   [INSTANCE] "OrderCard" #12:402 template=EL-3f9a2c1b
   ```
   三张卡片指向同一个模板（模板内容在输出的 `ELEMENTS:` 段），说明这是列表，对应数组字段。
2. 调用一次 `download_figma_images`：下载图标，同时把整个 Frame `12:345` 渲染成参考图 `orders.png`，再把参考图移到 `.figma-ref/`（只渲染一次）。
3. 用 Ant Design 组件写出静态页面。将来由接口提供的内容放进页面旁边的**交接文件** `index.mock.ts`（提交到仓库），固定文案（标题、按钮文字）留在模板里：
   ```ts
   /**
    * @figma     https://www.figma.com/design/AbC123/Shop?node-id=12-345
    * @keywords  我的订单, 实付金额, 下单时间, 收货人, 待支付, 已支付, 已发货, 查看详情, OrderCard
    * @lists     orders ← OrderCard（template=EL-3f9a2c1b，重复 3 次）
    * @actions   查看详情 → 跳转详情页；状态筛选标签 → 列表过滤
    * @stage     static        （阶段 B 完成后删除本文件）
    */
   export const MOCK_ORDERS = [
     {
       id: "202501020001",
       amount: "¥128.00",
       createdAt: "2025-01-02 10:00",
       buyerName: "张三",
       status: "待支付",
     },
     // ...
   ];
   ```
4. 启动 `pnpm dev`，把浏览器视口设为 Frame 宽度、设备像素比设为 2，截整页图，与参考图对比，修复明显差异。

> 如果你要求「严格按设计稿还原」，AI 会改用 `visual-diff.mjs` 做像素对比；项目里没有 pixelmatch 时，会先征求你同意再安装。

### 第 2 步：找接口

AI 从设计稿提取关键词并检索：

```
get_api_context({ keywords: ["我的订单", "实付金额", "下单时间", "收货人", "待支付", "OrderCard"] })
```

选定 `listOrders`，并取完整结构（节选，省略了 `api:` 和 `tags`）：

```
get_api_context({ operationIds: ["listOrders"] })
```

```yaml
operations:
  - id: listOrders
    endpoint: GET /orders
    summary: 订单列表
    params:
      query:
        page?: "integer  # 页码，从 1 开始"
        status?: "OrderStatus  # 订单状态筛选"
    response:
      code: integer
      msg: string
      data:
        total: "integer  # 总条数"
        list: Order[]
schemas:
  OrderStatus: '"PENDING" | "PAID" | "SHIPPED" | "CANCELLED"'
  Order:
    "#": 订单
    id: "string  # e.g. 202501020001"
    status: OrderStatus
    amount: "integer  # 实付金额（分）; e.g. 12800"
    createdAt?: "string<date-time>  # 下单时间"
    buyerName?: "string | null  # 收货人"
```

「查看详情」按钮对应 `getOrderDetail`，属于跳转详情页，本页不调用。

### 第 3–5 步：数据层、绑定与运行检查

AI 按约定生成以下内容：

```ts
// src/api/order.ts
import request from "@/utils/request";

export type OrderStatus = "PENDING" | "PAID" | "SHIPPED" | "CANCELLED";
export interface Order {
  id: string;
  status: OrderStatus;
  amount: number; // 单位：分
  createdAt?: string;
  buyerName?: string | null;
}

export function listOrders(params: { page?: number; status?: OrderStatus }) {
  return request.get<{ total: number; list: Order[] }>("/orders", { params });
}
```

- `src/constants/enums.ts` 中增加 `ORDER_STATUS_TEXT`（`PENDING → 待支付` 等，文案取自设计稿）。
- 页面用 `useQuery` 调用 `listOrders`，金额用 `formatMoney(amount)`，`buyerName` 为空时显示 `-`。
- 补上 `Spin`、通用 `Empty` 组件、`Result` 加重试按钮，分别作为加载中、空数据、错误状态。
- 页面不再引用 `index.mock.ts`，删除这个交接文件。
- 执行 `pnpm type-check && pnpm lint`。

### 第 6 步：验收

**mock 模式**（项目还没接入 MSW，AI 会先征求同意）：

```bash
npm i -D msw
npx msw init public/ --save
node .claude/skills/figma-to-page/scripts/gen-mock-handlers.mjs --spec http://localhost:8080/v3/api-docs --out src/mocks/handlers.ts --ops listOrders,getCurrentUser --base api
```

（`getCurrentUser` 是外层布局请求的用户信息接口，不 mock 的话会跳到登录页。）接着新建 `src/mocks/browser.ts`，在入口文件中按 `VITE_API_MOCK` 启用，然后以 mock 模式启动，逐个检查。启动命令：macOS/Linux 用 `VITE_API_MOCK=true pnpm dev`；Windows 用 `npx cross-env VITE_API_MOCK=true pnpm dev`，或在 `.env.development.local` 中写入 `VITE_API_MOCK=true`。

| 地址                   | 检查结果                                                        |
| ---------------------- | --------------------------------------------------------------- |
| `/orders`              | 3 条订单，金额显示为 ¥128.00，状态显示为待支付/已支付/已发货 ✅ |
| `/orders?mock=empty`   | 显示空数据组件 ✅                                               |
| `/orders?mock=error`   | 显示错误提示和重试按钮 ✅                                       |
| `/orders?mock=loading` | 一直显示加载中 ✅                                               |
| 375px 宽度             | 卡片单列，没有横向滚动条 ✅                                     |

**live 模式**：用正常方式启动后，用约定里的测试账号登录，检查真实数据显示、请求参数（`page`、`status`）和鉴权头。不点击任何会写入数据的按钮。

### 第 7 步：交付（示例）

**字段对照表**

| UI 元素             | 接口       | 字段                          | 依据                       | 备注                  |
| ------------------- | ---------- | ----------------------------- | -------------------------- | --------------------- |
| 订单号 202501020001 | listOrders | `data.list[].id`              | 示例值完全一致             |                       |
| 实付金额 ¥128.00    | listOrders | `data.list[].amount`          | 字段说明「实付金额（分）」 | 分转元                |
| 下单时间            | listOrders | `data.list[].createdAt`       | 字段说明「下单时间」       | 格式 YYYY-MM-DD HH:mm |
| 收货人              | listOrders | `data.list[].buyerName`       | 字段说明「收货人」         | 可为空，显示 -        |
| 状态标签            | listOrders | `data.list[].status`          | 枚举值与筛选标签一一对应   | 文案放在 enums.ts     |
| 筛选标签            | listOrders | 查询参数 `status`             | 参数说明「订单状态筛选」   | 「全部」不传该参数    |
| 分页                | listOrders | 查询参数 `page`，`data.total` | 参数说明「页码」           |                       |

**写操作表**：无（「查看详情」只是路由跳转）。

**未匹配项**：设计稿中订单卡片的「商品缩略图」在 `listOrders` 中没有对应字段（只有 `getOrderDetail.items` 中有商品信息，但没有图片字段）→ 需要与后端确认。

**验收结果**：静态阶段目视对比通过；mock 模式 5 项通过；live 模式在已登录状态下通过；类型为手写。

## 5. 分两步做：先静态页面，后对接接口

后端接口还没好、或者想先评审界面时，可以分两次完成。两次之间可以隔几天、换会话，甚至换人。

**第一次（阶段 A）**

> 按 https://www.figma.com/design/AbC123/Shop?node-id=12-345 先做我的订单页的静态页面，路由 /orders，接口还没好

AI 执行第 0、1 步，交付：页面文件、交接文件 `src/pages/order/list/index.mock.ts`、视觉对比结果，以及提示「接口就绪后说『把订单列表页接上接口』」。**把交接文件和页面一起提交**。

**第二次（阶段 B）**

> 把订单列表页接上接口

AI 找到交接文件，用其中的 `@keywords`、`@lists`、`@actions` 检索接口，**不再调用 Figma**。然后执行第 2～7 步。绑定完成后删除交接文件，交付对照表和验收结果。

| 情况                                    | 处理                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------- |
| 阶段 A 和 B 之间设计稿改了              | 先重新做阶段 A（更新页面和交接文件），再做 B                           |
| 页面不是用本 Skill 做的（没有交接文件） | AI 会向你要 Figma 链接，重新获取设计稿提取关键词，并找出写死的占位内容 |
| 阶段 A 时没配置 `--openapi`             | 不影响，阶段 A 不需要 `get_api_context`；阶段 B 前配好即可             |
| 交接文件被误删                          | 同「没有交接文件」，代价是多一次 Figma 调用                            |

## 6. 其他用法

| 你说                                 | AI 执行的部分                                         |
| ------------------------------------ | ----------------------------------------------------- |
| 「先按设计稿做静态页面，接口还没好」 | 阶段 A：第 0、1 步，生成交接文件                      |
| 「订单页的接口好了，接上」           | 阶段 B：第 2～7 步，读取交接文件                      |
| 「后端订单接口加了字段，同步一下」   | 第 2、3 步更新类型和请求函数，重新生成 mock，然后验收 |
| 「用真实后端再验一遍」               | 第 6 步的 live 模式                                   |
| 「严格还原，做像素对比」             | 第 1 步改用 `visual-diff.mjs`                         |

## 7. 常见问题与解决办法

### 7.1 安装与配置

| 问题                                                                                                                                                        | 原因                                                                     | 解决办法                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AI 看不到 `get_api_context`                                                                                                                                 | 没加 `--openapi`；或用的是 `npx figma-developer-mcp`（npm 上的官方版本） | 用本地 `node .../dist/bin.js` 启动并加上 `--openapi`；用 `/mcp` 确认                                                                                   |
| 调用 `get_api_context` 时报 `Failed to parse OpenAPI document` 或 `is not an OpenAPI 3.x or Swagger 2.0 document`（启动时不会报，文档在第一次调用时才加载） | 地址返回的是 Swagger UI 网页或登录页，不是文档本身                       | 改用 JSON 地址：Spring 用 `/v3/api-docs`，FastAPI 用 `/openapi.json`；先用 `node dist/bin.js api --openapi <地址>` 确认                                |
| `Failed to fetch OpenAPI document ... 401`                                                                                                                  | 文档地址需要登录                                                         | 加上 `--openapi-header="Authorization: Bearer xxx"`                                                                                                    |
| 文档地址连不上（公司网络）                                                                                                                                  | 需要代理                                                                 | MCP 服务加 `--proxy=http://代理:端口`，或设置 `HTTPS_PROXY`。`api` 调试命令和 `gen-mock-handlers.mjs` 不走代理，改用本地文件：先把文档下载下来再传路径 |
| 输出里出现 `unresolved(other.yaml#/...)`                                                                                                                    | 文档由多个文件组成                                                       | `npx @redocly/cli bundle openapi.yaml -o bundled.yaml` 合并成单文件                                                                                    |
| 后端改了文档，AI 看到的还是旧的                                                                                                                             | URL 方式有 60 秒缓存                                                     | 等 1 分钟；本地文件改动会立即生效                                                                                                                      |
| 有多个微服务文档                                                                                                                                            | 只支持一份文档                                                           | 先合并成一份，或通过网关的聚合文档提供                                                                                                                 |

### 7.2 Figma

| 问题                                         | 原因                                        | 解决办法                                                                                               |
| -------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 报 429 或提示额度用完                        | Figma Tier 1 限流；View/Collab 席位按月计次 | 确认是 Dev/Full 席位；参考图只渲染一次；不要反复获取整个文件                                           |
| 设计稿数据太大、AI 输出被截断                | 一次给了整个页面或整个文件                  | 给具体的 Frame 链接；让 AI 先用 `depth` 获取上层结构，再分区块获取                                     |
| AI 不愿意用 `download_figma_images` 渲染整页 | 工具说明写的是下载图片和图标                | Skill 的 `figma-reference.md` 已写明方法；如果仍不执行，明确告诉它「按 figma-reference.md 渲染参考图」 |
| 参考图和截图对不上（宽度不同）               | 视口或设备像素比没对齐；或滚动条占了宽度    | 用 `emulate` 把视口设为 Frame 宽度、设备像素比与 `pngScale` 一致（默认 2）；只差十几像素时隐藏滚动条   |

### 7.3 接口匹配

| 问题                                 | 原因                                           | 解决办法                                                                              |
| ------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| 搜索不到正确的接口                   | 文档缺少中文 summary；设计稿用词与文档差别太大 | 补全文档 summary；用 `api --keywords` 自己调试；告诉 AI 具体的接口名                  |
| 字段绑错（如把应付金额当成实付金额） | 语义相近的字段                                 | 看对照表的「依据」列，依据含糊的要重点检查；让后端在字段说明里写清楚区别              |
| 金额显示放大或缩小 100 倍            | 文档没写单位                                   | 在字段说明里写明单位；在约定文档里写明全局金额单位                                    |
| 某个字段 AI 说找不到                 | 接口确实没有，或在另一个接口里                 | 看「未匹配项」，与后端确认是否需要新增字段                                            |
| 类型和实际返回不一致                 | 精简结构丢失了信息，或文档本身和实现不一致     | 有条件的话接入 openapi-typescript 等代码生成；live 验收时以实际返回为准，并反馈给后端 |
| 写操作接错接口                       | AI 推断错误                                    | 写操作表必须人工确认后再合并                                                          |

### 7.4 mock 模式

| 问题                                            | 原因                                                                                     | 解决办法                                                                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `--base /api` 变成了 `C:/Program Files/Git/api` | Git Bash 会把 `/api` 当成路径改写                                                        | 写成 `--base api`（脚本会自动补斜杠），或在 cmd/PowerShell 中运行                                               |
| 页面请求没有被拦截                              | `--base` 和前端实际请求的前缀不一致；worker 没启动；`public/mockServiceWorker.js` 不存在 | 在网络面板看实际请求路径；确认入口文件里的启用条件成立；重新执行 `npx msw init public/`                         |
| 生成脚本提示需要 js-yaml                        | YAML 文档需要 js-yaml；或者不是在项目根目录运行的                                        | 改用 JSON 地址（如 `/v3/api-docs`），或 `npm i -D js-yaml`；脚本要在前端项目根目录运行                          |
| 生成脚本报 `文档中没有这些 operationId`         | `--ops` 写错（区分大小写）                                                               | 用 `node dist/bin.js api --openapi <文档> --keywords ...` 查准确的 id                                           |
| mock 数据被前端当成业务错误                     | 后端的成功码不是 0                                                                       | 重新生成时加 `--success-code 200`（或 `SUCCESS`）。不加时，文档里 `code` 字段写了 `example`/`enum` 就用文档的值 |
| `?mock=bizerror` 没有效果                       | 响应里没有 `code` 字段                                                                   | 这个场景只适用于带统一包装的接口                                                                                |
| `?mock=empty` 不起作用                          | 路由跳转时去掉了 URL 参数                                                                | 改用 `localStorage.setItem("mock:scenario","empty")` 后刷新；hash 路由写成 `/#/orders?mock=empty`               |
| 一直停在某个场景（如总是空数据）                | `localStorage` 里的场景设置没清                                                          | `localStorage.removeItem("mock:scenario")` 后刷新                                                               |
| 接口变了，mock 还是旧的                         | 生成的文件不会自动更新                                                                   | 重新运行生成命令；不要手改生成的文件                                                                            |
| mock 进入了生产构建                             | 启用条件写错                                                                             | 启用条件必须包含 `import.meta.env.DEV`（或项目对应的写法）                                                      |

### 7.5 live 模式与验收

| 问题                                 | 原因                       | 解决办法                                                        |
| ------------------------------------ | -------------------------- | --------------------------------------------------------------- |
| 页面一直提示未登录                   | 浏览器里没有登录状态       | 在约定文档中写明测试账号或 token 的写入方式；token 不要写进代码 |
| 空数据、错误状态测不到               | 真实后端很难触发           | 用 mock 模式覆盖；live 下标注「跳过」                           |
| AI 反复修复、停不下来                | 问题超出自动修复能力       | Skill 限制最多 2 轮，剩下的问题会列出来交给你                   |
| 目视对比漏掉了细微差异               | AI 看图只能发现明显问题    | 需要精确还原时要求像素对比                                      |
| 像素对比差异比例偏高，但看起来没问题 | 字体渲染、抗锯齿、动态内容 | 看 diff 图里标红的位置，而不是只看比例                          |

### 7.6 Skill 本身

| 问题                            | 原因                                                   | 解决办法                                                                            |
| ------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| AI 没有使用 Skill               | 请求描述没有命中 Skill 的触发描述                      | 说明「按 figma-to-page 做」，或直接调用 `/figma-to-page`                            |
| AI 没遵守约定（如直接用 axios） | Skill 只是说明文字，不能强制执行                       | 把规则做成 ESLint 规则（如 `no-restricted-imports`），第 5 步会检查出来             |
| 同样的错误反复出现              | 约定文档里没写                                         | 把规则补进 `docs/frontend-conventions.md`                                           |
| 上下文太长、AI 前后矛盾         | 一次处理的内容太多                                     | 一次只做一个页面；分阶段 A、B 两次会话完成（见第 5 节）                             |
| 阶段 B 还在调用 Figma           | 没找到交接文件（位置或命名不对）                       | 告诉 AI 交接文件路径；检查是否随页面一起提交了                                      |
| 阶段 B 后页面里还残留占位数据   | 阶段 A 有内容写死在模板里，没放进交接文件              | 让 AI 对照设计稿重新检查一遍写死的内容；阶段 A 时就要求把数据类内容全部放进交接文件 |
| 在 Cursor 等编辑器里不生效      | Skill 的加载方式因客户端而异，目前只验证了 Claude Code | 改用 MCP 提示词 `implement_design_with_api`（最简流程）                             |

## 8. 使用建议

1. **先检查文档，再写页面**：用 `api --keywords` 试几次，搜索结果不准时先改文档。
2. **一次只做一个页面**，给出明确的路由和文件位置。
3. **对照表和写操作表一定要看**，这是自动化中最可能出错的地方。
4. **把反复出现的问题写进约定文档或 ESLint 规则**，下次就不会再犯。
5. **mock 和 live 都测**：mock 覆盖各种状态，live 确认真实数据格式。
