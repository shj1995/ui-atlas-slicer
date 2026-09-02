# 图像处理模块

`imageProcessing.js` 是 UI 图集拆分器的无框架 ES module。像素算法同步执行，图片解码和 PNG 编码异步执行；所有数据只在浏览器内存中处理。

## 常用流程

```js
import {
  loadImage,
  detectConnectedComponents,
  cleanFakeTransparency,
  generateGridSlices,
  exportSlicesAsPng,
  createZipBlob,
  downloadZipBlob,
} from "./imageProcessing.js";

const loaded = await loadImage(file); // file 可以是 PNG File/Blob、URL、ImageBitmap
let imageData = loaded.imageData;

// 假棋盘格清理（不会修改 imageData）
const cleaned = cleanFakeTransparency(imageData, {
  mode: "flood",              // 只清理从边缘连通的颜色
  colorThreshold: 28,
  connectivity: 4,
  // backgroundColor: "#d7d7d7", // 可选；不提供时自动采样四角
});
imageData = cleaned.imageData;

// 自动识别透明连通域
const detected = detectConnectedComponents(imageData, {
  alphaThreshold: 20,
  minPixelArea: 12,
  minWidth: 3,
  minHeight: 3,
  mergeAdjacentFragments: false,
  mergeDistance: 2,
});
const autoRects = detected.rects;

// 规则网格（例如 7 列 1 行）
const grid = generateGridSlices(imageData, {
  columns: 7,
  rows: 1,
  skipEmpty: true,
  trim: true,
  namePrefix: "button",
});

// 导出为独立 PNG Blob；需要下载时再调用 downloadPngFiles(result.files)
const result = await exportSlicesAsPng(imageData, grid.rects, {
  trim: false, // grid 已经 trim 时无需再次裁切
  onProgress: ({ completed, total }) => console.log(`${completed}/${total}`),
});

// 将 PNG 和可选的 JSON 清单打包为一个本地 ZIP
const zip = await createZipBlob(result.files, {
  extraFiles: [{ name: "sprites.cocos.json", blob: new Blob(["{}"], { type: "application/json" }) }],
});
downloadZipBlob(zip, "sprites.zip");
```

## 主要接口

- `loadImage(source)`：解码图片并返回 `{ imageData, canvas, width, height }`。
- `detectConnectedComponents(imageData, options)`：按 Alpha 阈值找连通域，返回 `{ rects, mask, components }`。默认 4 邻域，避免相邻按钮的对角像素被误合并；可选 `mergeAdjacentFragments` 和 `mergeDistance`。
- `cleanFakeTransparency(imageData, options)`：`flood`/`global`/`both` 三种模式，返回清理后的 `imageData`、一字节 `alphaMask`、采样到的背景色和移除像素数。输入不会被修改。
- `generateGridSlices(imageData, options)`：按列、行、格宽高、间距和外边距生成切片；支持 `skipEmpty`、`trim`、`order: "row-major" | "bottom-left" | "rtl" | "column-major"`。
- `cropImageData`、`getAlphaBounds`、`alphaMaskToImageData`、`snapRect`、`mergeRects`：供手动画框编辑器复用。
- `encodePng`、`exportSlicesAsPng`、`downloadPngFiles`：裁切、编码和批量触发 PNG 下载。
- `createZipBlob(files, options)`、`downloadZipBlob(blob, filename)`：在浏览器本地生成并下载 ZIP；`options.extraFiles` 可传入 JSON 等额外文件。

`exportSlicesAsPng` 会将名称中的 `{n}` 替换为从 1 开始的序号，重复 `n` 可控制零填充位数。

矩形均为 `{ x, y, width, height }`，原点在左上角，单位为源图像像素。`cropImageData`、自动识别和网格切片都会将矩形限制在源图像范围内。
