# Petra 开发指南

本文档说明如何参与 Petra 的开发。用户使用说明见 [README](README.md)，打包发布见 [RELEASING.md](RELEASING.md)。

## 一、开发环境

Windows 10/11、Node.js 18+、Rust（stable）、WebView2 Runtime。

```bash
git clone https://github.com/Wumiu/Petra.git
cd Petra
npm install
npm run tauri dev      # 开发
```

## 二、开发流程

每个功能都走「**issue → 关联分支 → PR**」三步。核心约定是：**把 issue 当任务列表用，动手写代码前先建 issue**。这样其他人打开 issue，右侧 Development 栏就能看到关联的分支和 PR，谁在做、做到哪了一目了然。

### 1. 建 issue

网页：仓库 → **Issues** → **New issue** → 选「**开发任务**」模板，填「目标」和「验收标准」。

命令行：

```bash
gh issue create --template dev_task.md --title "[Feature] 功能名" --label enhancement
```

### 2. 建关联分支

拿到 issue 编号后（下面假设是 `27`）：

```bash
gh issue develop 27 --name <分支名> --base master --checkout
```

这条命令会从 `master` 切出分支、推送到远程，并**自动把分支关联到该 issue**。

> ⚠️ 必须用 `gh issue develop`，或者在 issue 页面点 **Create a branch**。
> 手动 `git push` 一个名字里带编号的分支**不会**建立关联。
>
> 分支名本身可以随便取（`ks-kbl`、`feat/xxx` 都行）—— GitHub 的绑定关系来自创建方式，不依赖命名。

### 3. 提 PR

PR 描述里写 `Closes #27`，合并后该 issue 会自动关闭。

## 三、Commit 信息

沿用 conventional commits 前缀，例如 `feat:` / `fix:` / `docs:` / `chore:`，描述用中文：

```
fix: 修复天气面板布局和错误历史删除
feat: 支持屏幕截图识图
```

## 四、构建与自测

```bash
npm run build                    # 前端：sync:vendor + tsc + vite build
cd src-tauri && cargo check      # 后端
```

**语音识别的内置 Key（可选）**：仓库里没有任何 API Key，语音识别用的默认 Key 是编译期从
环境变量 `PETRA_ASR_KEY` 注入的（见 `src-tauri/src/lib.rs` 的 `DEFAULT_ASR_KEY`）。
本地要带上它，就在仓库根目录建 `.cargo/config.toml`（该路径已在 `.gitignore` 里）：

```toml
[env]
PETRA_ASR_KEY = "sk-..."
```

改完记得 `cargo clean -p petra` 强制重编 —— `option_env!` 变了 cargo 不一定能感知。
不配也能构建，只是 Mac / Linux 用户得自己在「🎤 语音识别设置」里填 Key。

单元测试按模块拆分，没有聚合命令，改到哪块就跑哪块：

| 命令 | 覆盖范围 |
| -- | -- |
| `npm run test:assistant` | 小助手工具调用、屏幕识图 |
| `npm run test:riichi` | 立直麻将规则与引擎 |
| `npm run test:riichi-sound` | 麻将音效 |
| `npm run test:music` | LRC 解析、歌词时钟 |
| `npm run test:diary` | 日记 |
| `npm run test:weather` | 天气格式化 |
| `npm run test:hourly` | 整点报时 |
| `npm run test:chat-history` | 对话历史 |
| `npm run test:info-panel` | 信息面板定位 |
| `npm run test:asr` | 语音识别后端选择、停顿判定、收尾取词 |
| `npm run test:visible` | 浮层钳进窗口可见区（贴边时弹窗不被切） |

## 五、变更日志

改动合并后，把用户可感知的部分写进 [CHANGELOG.md](CHANGELOG.md) 的 `[Unreleased]` 段落。维护者习惯在这里详细记录每次合并的内容，它也是了解「项目当前在做什么」的第一手资料。
