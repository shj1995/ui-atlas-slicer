# 贡献指南

感谢你愿意帮助改进 SpriteLab。Bug、可复现的体验问题、算法改进和 Cocos 工作流建议都欢迎提交。

## 提交 Issue

请尽量包含：

- 浏览器和操作系统版本；
- 图集尺寸、透明类型和复现步骤；
- 期望结果与实际结果；
- 必要时提供可公开分享的最小测试图，不要上传私有或敏感素材。

## 本地开发

~~~bash
npm install
npm run dev
~~~

项目是无框架的原生 ES module 应用。图像算法集中在 src/imageProcessing.js，界面交互和 Canvas 渲染位于 app.js。

## 提交前检查

~~~bash
node --check app.js
node --check src/imageProcessing.js
npm run build
~~~

请保持图片处理在浏览器本地完成，不新增上传、遥测或不必要的第三方运行时依赖。提交 Pull Request 时说明变更动机、测试方式以及可能影响的导出行为。
