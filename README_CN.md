# LLM Wiki Interview Assistant

一个基于 [LLM Wiki](https://github.com/nashsu/llm_wiki) 搭建的个人面试助手。

它把本地 LLM Wiki 知识库扩展成面试辅助工具：采集面试音频、转写双方对话、识别面试官问题、把项目类问题路由到对应项目画像，并基于你的知识库生成适合口述的简洁回答提示。

本仓库已按公开发布场景整理，不包含私有项目画像、个人转写记录、API key、本地路径、候选人姓名、公司名称或私有知识库内容。

## 和 LLM Wiki 的关系

[LLM Wiki](https://github.com/nashsu/llm_wiki) 提供本地优先的知识库、文档导入、搜索、对话、本地 API 和 MCP 基础能力。

本项目聚焦在面试助手层：

- Tauri 桌面应用中的系统音频和麦克风采集。
- 流式 ASR 集成。
- 从滚动转写文本中识别面试问题。
- 可选项目画像，用于把项目问题匹配到具体项目。
- 五类回答模板：项目经历概览、项目方法方案、项目细节深挖、知识八股、手撕代码。
- 导出 Markdown，包含转写、识别到的问题、回答、路由诊断和耗时数据。
- 可重置面试会话，方便多轮模拟或正式面试。

## 工作流程

```text
系统音频 + 麦克风
  -> 流式 ASR
  -> 转写文本
  -> 问题识别
  -> 项目路由 + 问题类型
  -> 回答模板
  -> LLM Wiki 检索和回答生成
```

默认情况下，系统音频会被视为面试官侧音频，麦克风会被视为候选人侧音频。

## 环境要求

- Node.js 20+
- npm
- Rust 和 Cargo
- 实时面试模式需要 macOS 麦克风、屏幕录制或音频采集权限

如果没有 Rust，请从 [rustup.rs](https://rustup.rs/) 安装。macOS 如果编译 Rust 时提示缺少编译器，可以安装 Apple 命令行工具：

```bash
xcode-select --install
```

## 安装

所有命令都在仓库根目录执行，也就是包含 `package.json` 和 `src-tauri/` 的目录。

```bash
npm install
npm --prefix mcp-server ci
npm run mcp:build
npm run typecheck
```

## 运行

启动真正的桌面应用：

```bash
npm run tauri -- dev
```

第一次运行时，Rust 依赖可能需要编译几分钟。

可选的 Web UI 冒烟测试：

```bash
npm run dev -- --host 127.0.0.1 --port 5173
```

Web UI 适合检查 React 页面是否能加载，但新建项目、导入文件和音频采集等原生能力需要 Tauri 桌面应用。

构建桌面安装包：

```bash
npm run build:desktop
npm run tauri -- build
```

## 快速开始

1. 用 `npm run tauri -- dev` 打开桌面应用。
2. 创建或打开一个 LLM Wiki 项目。
3. 在 `Sources` 中导入面试材料，例如简历要点、项目总结、指标结果、设计文档、问答笔记、编程题笔记或理论知识笔记。
4. 在 `Settings` 中配置 `LLM Provider`。
5. 如果需要音频转写，在 `Settings` 中配置 `Speech-to-text`。
6. 打开 `Interview Assistant`。
7. 可选：添加 `项目识别画像`，让项目类问题匹配到你自己的已脱敏项目。
8. 可选：编辑 `回答模板`，调整口述回答风格。
9. 先用 `选择测试音频文件` 和 `用音频文件测试` 跑通链路。
10. 文件测试跑通后，再使用 `开始实时面试`。

实时面试时建议佩戴耳机，减少面试官声音被麦克风重复录入。

## 项目识别画像

项目画像是可选的。只有当你希望项目类问题锁定到具体项目上下文时，才需要配置。

每个画像可以包含：

- 项目名称
- 项目别名
- 核心关键词
- 辅助关键词
- 技术或指标关键词
- 排除关键词
- 组合关键词

公开仓库默认不内置任何项目画像。请只添加你自己的已脱敏项目关键词。

## 回答模板

助手会按问题类型选择回答模板：

- 项目经历概览
- 项目方法方案
- 项目细节深挖
- 知识八股
- 手撕代码

模板可以在 UI 中编辑，并会保存在本地。实时面试中，模板越短，回答通常越快。

## 开发

常用检查：

```bash
npm run typecheck
npm run test:mocks
npm --prefix mcp-server test
```

Rust 检查：

```bash
cd src-tauri
cargo check
cargo test
```

关键路径：

```text
src/components/interview/       面试助手 UI
src/lib/interview-*.ts          面试流水线逻辑
src/stores/interview-store.ts   面试会话状态
src-tauri/src/commands/         Tauri 原生命令
mcp-server/                     连接本地 API 的 MCP 桥接
```

## 隐私

面试数据应视为敏感数据。不要发布：

- 真实面试转写
- 简历源文档
- 私有项目笔记
- 私有面试中的候选人或公司名称
- API key 或 ASR 凭证
- 本地绝对路径
- 真实 `.llm-wiki/` 项目元数据

## 许可证

本项目遵循 [LICENSE](LICENSE) 中的许可条款。
