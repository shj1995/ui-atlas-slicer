<div align="center">

# UI Atlas Slicer · UI 图集拆分器

一款纯前端 UI 图集拆分工具。
在浏览器本地把一张 PNG 图集拆成可直接使用的独立 PNG，不上传素材，不依赖后端。

[![GitHub](https://img.shields.io/badge/GitHub-shj1995%2Fui--atlas--slicer-181717?logo=github)](https://github.com/shj1995/ui-atlas-slicer)
[![License](https://img.shields.io/github/license/shj1995/ui-atlas-slicer?color=0d9f89)](LICENSE)
[![Runtime](https://img.shields.io/badge/runtime-browser%20only-0d9f89)](#隐私与安全)
[![Deploy](https://img.shields.io/badge/deploy-cloudflare%20workers-f38020?logo=cloudflare)](#部署到-cloudflare-workers)

<br />

**手动画框为主，自动识别为辅。**  
为尺寸不统一、带阴影光效、需要精确控制边距的 UI 素材而设计。

</div>

## 为什么做 UI Atlas Slicer

通用图集工具通常更偏向规则精灵或批量压缩，而游戏 UI 经常需要逐个确认边界：按钮、面板、图标尺寸不一致，自动识别还可能把一排素材合并在一起。UI Atlas Slicer 把精确的手动切片放在核心位置，同时提供自动识别、假透明清理和网格切片作为辅助流程。

## 功能一览

| 模块 | 能力 |
| --- | --- |
| 导入与预览 | 点击选择、拖拽 PNG、剪贴板粘贴；显示尺寸、透明棋盘格、缩放、平移、适应窗口 |
| 手动矩形切片 | 拖拽创建、移动、8 向调整、坐标编辑、多选、复制、删除、命名、撤销/重做 |
| 对齐辅助 | 像素吸附、4/8/16/32 px 网格吸附、可选保留透明边距 |
| Alpha 自动识别 | Alpha 阈值、最小面积/宽高、碎片合并、候选框删除/合并/调整、接受结果 |
| 假透明清理 | 四角取样、颜色阈值、边缘 Flood Fill、羽化/边缘保护、原图/清理后/Alpha 蒙版预览 |
| 网格切片 | 行列、单格尺寸、横纵间距、外边距、跳过空白、排序、每格透明裁剪 |
| 导出 | 批量导出独立 PNG；可按名称编号，并生成可选的坐标清单 JSON |
| ZIP 打包 | 一键把当前全部切片和可选的坐标清单打包为单个 ZIP，完全在浏览器本地完成 |
| 主题 | 默认白色主题；支持深色主题并记住浏览器本地偏好，适配 2K 屏字体与控件尺寸 |

## 快速开始

~~~bash
git clone https://github.com/shj1995/ui-atlas-slicer.git
cd ui-atlas-slicer
npm install
npm run dev
~~~

打开 Vite 输出的本地地址，把 PNG 拖到画布即可开始。也可以直接打开 index.html，但使用 Vite 开发服务器的模块加载和热更新体验更稳定。

> 需要部署到 Cloudflare 时，推荐使用 Node.js 20 或更高版本。项目已经内置 Workers Static Assets 配置，可直接使用下面的一键部署按钮。

生产构建：

~~~bash
npm run build
npm run preview
~~~

## 推荐工作流

1. 导入图集，先用缩放和棋盘格确认真透明情况。
2. 优先使用“矩形切片”逐个框选需要精确控制的 UI 素材。
3. 素材很多时，可先用“自动识别”生成候选框，再删除、合并或调整错误结果。
4. 如果棋盘格已经写进 PNG，进入“背景清理”，取样并预览清理结果。
5. 对规则动画帧或规则图标使用“网格切片”。
6. 导出 PNG 和坐标清单，交给后续设计或游戏资源流程继续使用。

## 导出说明

- 名称支持 {n} 序号占位符；{nn}、{nnn} 可生成两位或三位补零序号。
- “生成坐标清单”会额外下载一个 *.atlas.json 文件，便于后续工具链继续处理。
- 该 JSON 是 UI Atlas Slicer 的自定义坐标清单，记录原图尺寸、切片坐标和裁剪状态。
- “导出 ZIP”会将 PNG 文件（以及启用命名时的坐标清单）打包为一个 ZIP，适合归档或交付。

## 快捷键

| 快捷键 | 操作 |
| --- | --- |
| V | 选择工具 |
| R | 矩形切片 |
| H / Space | 平移画布 |
| Ctrl/⌘ Z | 撤销 |
| Ctrl/⌘ Y | 重做 |
| Ctrl/⌘ D | 复制切片 |
| Delete | 删除选中切片 |
| 鼠标滚轮 | 缩放 |

## 部署到 Cloudflare Workers

### 一键部署（推荐）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/shj1995/ui-atlas-slicer)

点击按钮后，Cloudflare 会引导你将仓库导入自己的 GitHub 账号，并创建 Workers 项目。仓库必须保持公开；首次部署时可以按需修改 Worker 名称和构建设置。

### GitHub 自动部署

也可以在 Cloudflare Dashboard 进入 **Workers & Pages → Create application → Workers → Import a repository**，选择 `shj1995/ui-atlas-slicer`，然后使用以下设置：

| 配置项 | 值 |
| --- | --- |
| Root directory | `/` |
| Build command | `npm run build` |
| Deploy command | `npm run deploy` |
| Node.js version | 20 或更高 |

连接仓库后，推送到 `main` 分支会自动构建并部署；也可以开启非生产分支预览。

### Wrangler 手动部署

~~~bash
npm install
npm run build
npm run deploy
~~~

`wrangler.jsonc` 将 `dist` 配置为 Workers Static Assets 目录。这个项目没有 Worker 后端代码，部署的只是静态资源；图像处理仍然完全在访问者浏览器本地完成。

## 隐私与安全

- 图片通过 Canvas 在浏览器内存中读取和处理。
- 项目没有上传接口、后端服务、账号系统或外部图片请求。
- 导出动作只生成本地下载文件；主题偏好仅保存在当前浏览器的 localStorage 中。

## 项目结构

~~~text
ui-atlas-slicer/
├── index.html                 # 应用界面
├── styles.css                 # 主题、布局和响应式样式
├── app.js                     # 交互、Canvas 渲染和导出流程
├── wrangler.jsonc             # Cloudflare Workers Static Assets 配置
├── public/
│   └── ui-atlas-slicer-icon.png # 应用图标与 favicon
├── src/
│   ├── imageProcessing.js     # 无框架图像处理算法
│   └── imageProcessing.README.md
├── dist/                      # npm run build 生成（不提交）
├── CONTRIBUTING.md
├── LICENSE
└── package.json
~~~

## 参与贡献

欢迎提交 Issue 和 Pull Request。提交前请先阅读 CONTRIBUTING.md，并确保：

~~~bash
node --check app.js
node --check src/imageProcessing.js
npm run build
~~~

## 路线图

- [ ] Web Worker 处理超大图集，降低主线程占用
- [ ] 可保存/导入切片工程文件
- [ ] 更多通用元数据格式适配
- [ ] 批量处理多个图集

## License

[MIT](LICENSE) © 2026 shj1995
