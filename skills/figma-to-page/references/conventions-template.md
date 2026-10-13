# 前端项目约定模板

第 0 步用这个模板生成 `docs/frontend-conventions.md`。**每一项都从代码库里找证据填写**（注明来源文件），找不到的写「未约定」并向用户提问，不要凭常识补。

```markdown
# 前端项目约定

## 技术栈

- 框架/版本： <!-- 例：React 18 + Vite 5；来源 package.json -->
- 语言： <!-- TS / JS，strict 与否 -->
- UI 组件库： <!-- 例：Ant Design 5 -->
- 样式方案： <!-- CSS Modules / Tailwind / Less / styled-components -->
- 状态管理： <!-- Zustand / Pinia / Redux / 无 -->
- 路由： <!-- 例：react-router 6，路由表在 src/router/index.tsx -->

## 命令

- 开发服务器： <!-- 例：pnpm dev，端口 5173 -->
- 类型检查： <!-- 例：pnpm type-check -->
- Lint： <!-- 例：pnpm lint -->

## 目录

- 页面： <!-- 例：src/pages/<模块>/<页面>/index.tsx -->
- 通用组件： <!-- 例：src/components -->
- 接口请求： <!-- 例：src/api/<模块>.ts -->
- 类型： <!-- 例：src/types 或与 api 同文件 -->
- 静态资源/图片： <!-- 例：src/assets/images（download_figma_images 的保存位置） -->

## 接口文档

- 位置： <!-- 例：docs/api/swagger.json（相对项目根目录），或 http://localhost:8080/v3/api-docs -->
- 获取/更新方式： <!-- 例：后端改接口后，在 knife4j「文档管理 → 离线文档」导出 OpenAPI 覆盖该文件 -->

## 请求层

- 请求封装： <!-- 例：src/utils/request.ts 导出的 request，禁止直接用 axios -->
- 数据获取方式： <!-- 例：@tanstack/react-query 的 useQuery；或 ahooks useRequest；或 store action -->
- 鉴权： <!-- 例：拦截器自动加 Authorization，token 存 localStorage 'token' -->
- 统一返回包装： <!-- 例：{ code, data, msg }，code===0 成功；拦截器已解包返回 data -->
- 错误处理： <!-- 例：拦截器统一 message.error，页面无需重复提示 -->
- 分页约定： <!-- 例：请求 pageNum/pageSize，返回 { list, total } -->
- OpenAPI 类型生成： <!-- 例：openapi-typescript 生成到 src/types/api.d.ts；或「无」 -->

## 数据格式

- 金额： <!-- 例：接口单位为分，用 src/utils/format.ts 的 formatMoney() 显示 -->
- 时间： <!-- 例：ISO 字符串，用 dayjs 格式化为 YYYY-MM-DD HH:mm -->
- 枚举→文案： <!-- 例：src/constants/enums.ts 中定义 Map -->

## 通用状态组件

- 加载中： <!-- 例：antd Spin / Skeleton -->
- 空数据： <!-- 例：src/components/Empty -->
- 错误： <!-- 例：antd Result status="error" + 重试按钮 -->

## 验收环境

- mock 模式： <!-- 是否已接入 MSW；启用方式（例：VITE_API_MOCK=true pnpm dev） -->
- live 模式后端地址： <!-- 例：dev 代理到 https://dev-api.example.com -->
- 测试账号/登录方式： <!-- 例：账号见 .env.local 的 E2E_USER；或用 evaluate_script 写入 token -->
- 可写环境： <!-- live 后端能否执行写操作；默认「否」 -->

## 硬性规则（建议同步做成 ESLint 规则，只写在文档里不能保证被遵守）

- <!-- 例：页面中禁止 import axios（no-restricted-imports） -->
- <!-- 例：禁止写死颜色值，使用主题变量 -->
```
