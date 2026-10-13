#!/usr/bin/env node
/**
 * 像素级对比设计稿参考图和页面截图（按需使用：需要精确还原时才用）。
 *
 * 用法：
 *   node visual-diff.mjs <参考图.png> <截图.png> [--out diff.png] [--threshold 0.1]
 *
 * 依赖项目里的 pixelmatch 和 pngjs（npm i -D pixelmatch pngjs），从当前目录解析，所以要在前端项目根目录运行。
 * 没装时会提示并以退出码 2 结束，由调用方决定是否安装——本脚本不自动安装依赖。
 *
 * 输出一行 JSON：{ width, height, diffPixels, diffRatio, heightMismatch, diffImage }。
 * 只给数字不下结论：允许多少差异取决于页面（字体渲染、抗锯齿必然产生少量差异）。
 * diffRatio 只针对重叠部分；heightMismatch 不为 0 时说明截图比参考图长或短，要单独看。
 *
 * 退出码：0 完成对比 | 1 参数错误或文件读不了 | 2 缺依赖 | 3 宽度不一致
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const [referencePath, actualPath] = positional;
if (!referencePath || !actualPath) {
  console.error("用法: node visual-diff.mjs <参考图.png> <截图.png> [--out diff.png] [--threshold 0.1]");
  process.exit(1);
}

for (const file of [referencePath, actualPath]) {
  if (!existsSync(file)) {
    console.error(`找不到文件：${file}`);
    process.exit(1);
  }
}

// 从项目（当前目录）解析依赖：脚本可能放在 ~/.claude/skills 等没有 node_modules 的地方。
async function importFromProject(name) {
  try {
    const resolved = createRequire(join(process.cwd(), "package.json")).resolve(name);
    return await import(pathToFileURL(resolved).href);
  } catch {
    return import(name);
  }
}

let pixelmatch;
let PNG;
try {
  const pm = await importFromProject("pixelmatch");
  pixelmatch = pm.default ?? pm;
  const png = await importFromProject("pngjs");
  PNG = png.PNG ?? png.default.PNG;
} catch {
  console.error("缺少依赖：需要 pixelmatch 和 pngjs（npm i -D pixelmatch pngjs）。");
  process.exit(2);
}

const reference = PNG.sync.read(readFileSync(referencePath));
const actual = PNG.sync.read(readFileSync(actualPath));

if (reference.width !== actual.width) {
  console.error(
    `宽度不一致：参考图 ${reference.width}px，截图 ${actual.width}px。` +
      "请把浏览器视口宽度 × 设备像素比调成和参考图一致（见 references/figma-reference.md）后重新截图；" +
      "宽度只差十几像素时，通常是页面滚动条占了宽度。",
  );
  process.exit(3);
}

// 高度不同很常见（内容撑高、滚动区域），只比较重叠部分，并如实报告差值。
const width = reference.width;
const height = Math.min(reference.height, actual.height);
const crop = (img) => img.data.subarray(0, width * height * 4);
const diff = new PNG({ width, height });

const diffPixels = pixelmatch(crop(reference), crop(actual), diff.data, width, height, {
  threshold: Number(flag("threshold", "0.1")),
});

const out = flag("out", "diff.png");
writeFileSync(out, PNG.sync.write(diff));

console.log(
  JSON.stringify({
    width,
    height,
    diffPixels,
    diffRatio: Number((diffPixels / (width * height)).toFixed(4)),
    heightMismatch: actual.height - reference.height,
    diffImage: out,
  }),
);
