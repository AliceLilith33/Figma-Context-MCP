# 渲染设计稿参考图

参考图用于第 1 步的视觉对比。**每个页面只渲染一次**，渲染一次消耗一次 Figma Tier 1 调用。

## 渲染

`download_figma_images` 的工具说明写的是下载图片和图标节点，但它也能把**任意节点（包括整个 Frame）**渲染成 PNG：传入节点 ID，**不传 `imageRef`**，文件名以 `.png` 结尾即可。

```json
{
  "fileKey": "<fileKey>",
  "nodes": [{ "nodeId": "12:345", "fileName": "order-list.png" }],
  "localPath": ".figma-ref",
  "pngScale": 2
}
```

- **节点 ID** 用页面最外层的 Frame（Figma 链接里的 `node-id`，把 `-` 换成 `:`）。
- **文件名只能用英文字母、数字、`_ . -`**，中文页面名要换成英文（如 `order-list.png`）。
- **省一次调用**：参考图可以和页面里的 PNG 图片放在同一次调用里。一次调用只能指定一个 `localPath`，所以参考图会和图片下载到同一个目录，下载后再把它移到 `.figma-ref/`。
- **路径**：`localPath` 是相对于 Framelink `--image-dir` 的路径，不一定是项目根目录。以工具返回的 `Downloaded N images to <绝对路径>` 为准，后面的截图和对比命令都用绝对路径。把 `.figma-ref/` 加进 `.gitignore`。
- **复用**：渲染前先看 `.figma-ref/` 里有没有同名文件，有就复用。
- **参考图尺寸**：工具返回的每一行形如 `- order-list.png: 2880x5120`，除以 `pngScale` 就是 Frame 的宽高（这里是 1440×2560）。`get_figma_data` 对最外层 Frame 不一定输出宽度，以这里为准。

## 让浏览器截图和参考图可比

| 参考图                     | 浏览器设置（chrome-devtools MCP）                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Frame 宽度 W、`pngScale` S | `emulate` 的 `viewport` 设为 `WxHxS`，H 随便取一个屏幕高度（如 `1440x900x2`）。不要用 `resize_page`：窗口有最小宽度，且会被 `emulate` 的设置覆盖 |
| Frame 高度                 | 整页截图（`take_screenshot` 的 full page），不要只截首屏                                                                                         |

截图宽度和参考图差十几个像素时，通常是滚动条占了宽度：用 `evaluate_script` 给页面加 `html { scrollbar-width: none }` 后重截。

尺寸不一致时，像素对比没有意义。先把尺寸对齐，再比较。**不要为了对齐尺寸重新渲染参考图**，调整浏览器即可。
