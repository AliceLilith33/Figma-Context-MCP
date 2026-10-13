# 验收

分两个阶段做，检查的内容不同。**不要拿接上真实数据后的页面去和设计稿比截图**：数据条数和文字长度都和设计稿不同，这样比较没有意义。

脚本路径相对于本 Skill 目录：`scripts/visual-diff.mjs`、`scripts/gen-mock-handlers.mjs`。两个脚本都要**在前端项目根目录运行**：它们从当前目录加载项目里的依赖（pixelmatch、pngjs、js-yaml）。

没有 chrome-devtools MCP 时，本文件中需要浏览器的检查（静态阶段的截图对比、数据阶段的页面检查）全部标注「跳过（无 chrome-devtools）」，只做类型检查和 lint，并在交付时说明。

## 静态阶段（第 1 步之后，页面还是占位内容）

1. 启动开发服务器（命令见约定文档），后台运行。
2. 用 chrome-devtools 打开页面，视口和设备像素比按 [figma-reference.md](figma-reference.md) 对齐参考图，截整页图，保存为 `.figma-ref/<页面>.actual.png`（`take_screenshot` 的 `filePath` 用绝对路径，相对路径是相对于 chrome-devtools 服务的目录）。
3. 对比参考图和截图，按需求选一种方式：
   - **默认（目视对比）**：同时查看两张图，检查布局结构、元素是否缺失、颜色、字号字重、图片图标、对齐方式。目视只能发现明显差异，交付时说明用的是目视对比。
   - **要求精确还原时（像素对比）**：
     ```bash
     node <skill>/scripts/visual-diff.mjs .figma-ref/<页面>.png .figma-ref/<页面>.actual.png --out .figma-ref/<页面>.diff.png
     ```
     需要 `pixelmatch` 和 `pngjs`。没装时脚本以退出码 2 结束，**先问用户是否同意安装**（`npm i -D pixelmatch pngjs`）。退出码 3 表示宽度不一致，按 figma-reference.md 调整浏览器后重截；退出码 1 是文件路径不对。
     查看 `diff.png` 中标红的区域，定位差异来源。`diffRatio` 没有统一的合格线：字体渲染和抗锯齿必然产生少量差异，以差异区域是否有实际问题为准。`diffRatio` 只统计重叠部分，**`heightMismatch` 不为 0 要单独看**：页面比设计稿短很多，通常是少了区块。
4. 有问题就修，最多 2 轮。

## 数据阶段（第 4、5 步之后）

这一阶段**不比较截图**，检查结构和行为：

| 检查项                                               | 怎么查                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| 页面能正常渲染，列表条数和数据一致                   | 截图或 `take_snapshot` 查看 DOM                                          |
| 字段显示正确：金额单位、时间格式、枚举文案、空值占位 | 对照字段对照表逐项看                                                     |
| 请求正确：URL、方法、查询参数、请求体、鉴权头        | `list_network_requests` / `get_network_request`                          |
| 控制台没有报错和 React/Vue 警告                      | `list_console_messages`                                                  |
| 加载中、空数据、错误三种状态                         | 见下面两种模式                                                           |
| 窄屏（375px）布局不错乱                              | `emulate` 的 `viewport` 设为 `375x812x2,mobile,touch` 后截图，检查完恢复 |

### mock 模式（MSW）

前提：项目已经接入 MSW。没接入时，**先问用户是否同意**，再按下面的步骤接入：

1. 安装并初始化：`npm i -D msw`，然后 `npx msw init public/ --save`。
2. 生成 handler：
   ```bash
   node <skill>/scripts/gen-mock-handlers.mjs --spec <OpenAPI 文件或 URL> --out src/mocks/handlers.ts --ops listOrders,getOrderDetail,getCurrentUser --base api
   ```
   - `--spec`：和 `get_api_context` 用的是同一份文档（SKILL 第 2 步确定的位置）。用的是服务配置的默认文档时，地址写在 `get_api_context` 的工具说明里（`configured spec (<位置>)`）。不要为了找地址去读 MCP 配置文件，里面有 Figma 令牌。
   - `--ops`：本页面用到的接口，**加上页面外层布局会请求的公共接口**（用户信息、菜单、权限等）。否则这些请求会打到可能没启动的后端，跳登录页或弹全局错误提示，看起来像是本页面的错误状态。写错的 operationId 会让脚本直接报错（区分大小写）。
   - `--base`：前端实际请求的路径前缀。例如前端请求 `/api/orders`，代理再转发给后端，就填 `api`（不写开头的斜杠，脚本会补；写成 `/api` 在 Git Bash 里会被改写成 Windows 路径）。不传时取文档里 servers 的路径。
   - `--out`：TS 项目用 `.ts`（文件头会加 `// @ts-nocheck`），JS 项目用 `.js`。
3. 新建 `src/mocks/browser.ts`（JS 项目用 `.js`）：
   ```ts
   import { setupWorker } from "msw/browser";
   import { handlers } from "./handlers";
   export const worker = setupWorker(...handlers);
   ```
4. 在应用入口按环境变量启用，等 worker 启动后再渲染（只在开发环境生效，不能进入生产构建）：

   ```ts
   async function enableMocking() {
     if (!import.meta.env.DEV || import.meta.env.VITE_API_MOCK !== "true") return;
     const { worker } = await import("./mocks/browser");
     await worker.start({ onUnhandledRequest: "bypass" });
   }

   enableMocking().then(() => {
     // 原来的渲染代码，例如 createRoot(...).render(...) 或 app.mount("#app")
   });
   ```

   不要在入口顶层写 `await`：部分 Vite 版本的生产构建目标不支持顶层 await。非 Vite 项目按约定换成对应的环境变量写法。

5. 把启用方式写进约定文档的「验收环境 → mock 模式」。

逐个切换场景检查，**不需要重新生成 handler**：

| 场景       | 打开方式                                             | 预期                                       |
| ---------- | ---------------------------------------------------- | ------------------------------------------ |
| 正常       | `/orders`                                            | 显示 3 条示例数据                          |
| 空数据     | `/orders?mock=empty`                                 | 显示空数据组件                             |
| 错误       | `/orders?mock=error`（HTTP 500）                     | 显示错误状态或统一的错误提示               |
| 业务错误   | `/orders?mock=bizerror`（HTTP 200，code 不为成功值） | 同上。只有响应带 `code` 字段时才有这个场景 |
| 加载中     | `/orders?mock=loading`                               | 一直显示加载状态                           |
| 按接口指定 | `/orders?mock=listOrders:empty,getCurrentUser:error` | 各区块各自显示对应状态                     |

hash 路由写成 `/#/orders?mock=empty`。如果路由会去掉 URL 里的查询参数，改用 `localStorage.setItem("mock:scenario", "empty")` 后刷新页面；**检查完要 `localStorage.removeItem("mock:scenario")`**，否则后面的检查都会停留在这个场景。

用户不同意接入 MSW、又没有可用的 live 后端时，加载中、空数据、错误三种状态标注「跳过（无 mock 和后端）」，只能通过读代码确认处理逻辑。

接口变化后，重新运行生成命令即可。生成的文件不要手改。

### live 模式（真实开发环境后端）

前提：约定文档里写了后端地址和测试账号。没写的话问用户，不要猜。

1. 以正常模式启动开发服务器（不启用 mock）。
2. 登录：按约定的方式进行，可以用 `fill_form` 填登录表单，也可以用 `evaluate_script` 写入 token。**token 和密码不要写进代码或交付内容里。**
3. 检查正常数据的显示和请求是否正确，方法同上表。
4. **不执行写操作**：不点击提交、删除、支付等按钮，除非约定写明这是可写环境，或用户明确允许。写操作只检查请求函数的参数构造是否正确（读代码）。
5. 空数据、错误状态在 live 模式下通常无法触发，标注「跳过（由 mock 模式覆盖）」。

### 两种都测

先跑 mock，覆盖所有状态。再跑 live，确认真实的接口、鉴权和数据格式。如果 live 发现的字段格式和文档不一致（例如文档写数字，实际返回字符串），**以实际返回为准修改代码，并在交付时列出文档和实际不一致的地方**，提醒后端更新文档。
