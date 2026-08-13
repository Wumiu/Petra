---
kind: logging_system
name: 基于 stdout + 文件双写与 console.* 的轻量诊断日志系统
category: logging_system
scope:
    - '**'
source_files:
    - src-tauri/src/lib.rs
    - src-tauri/src/audio.rs
    - src-tauri/src/main.rs
    - src/main.ts
    - src/audio/AudioAnalyzer.ts
    - src/bridges/astrobot.ts
---

## 1. 使用的系统与框架

本项目**没有引入任何第三方日志库**（如 `tracing`、`log4rs`、`slog`、`winston`、`pino` 等），而是采用最轻量的方式：
- **Rust 后端**：使用标准库 `println!` / `eprintln!` 输出到 stdout/stderr，并通过一个自实现的 `log_line` 函数同时追加写入本地日志文件。
- **前端（TypeScript/Pixi.js）**：直接使用浏览器控制台 API `console.log` / `console.info` / `console.error`，以及 Tauri 提供的 `toast()` 作为用户可见提示。

## 2. 核心文件与位置

| 组件 | 文件 | 作用 |
|---|---|---|
| Rust 统一日志入口 | `src-tauri/src/lib.rs` | 定义全局 `LOG_DIR`、`log_line(s)`、`log_environment()`、`debug_mark` 命令 |
| Rust 音频模块 | `src-tauri/src/audio.rs` | 通过 `eprintln!` 输出 `[audio] ...` 前缀的诊断信息 |
| Rust 主入口 | `src-tauri/src/main.rs` | 设置 WebView2 参数（含 dev 模式 CDP 端口） |
| 前端主入口 | `src/main.ts` | 使用 `console.log/error/info` 输出驱动/加载状态 |
| 前端音频分析器 | `src/audio/AudioAnalyzer.ts` | 使用 `console.log` 输出 PCM 采样与频谱数据 |
| 前端桥接层 | `src/bridges/astrobot.ts` | 使用 `console.info` 转发消息 |

## 3. 架构与约定

### 3.1 Rust 侧：`log_line` 双写通道
- 在 `lib.rs` 中通过 `OnceLock<std::path::PathBuf>` 维护全局 `LOG_DIR`，在 Tauri `setup` 阶段初始化为 `<app_data_dir>/logs`，不存在则回退到 `temp_dir()/pet-logs`。
- `log_line(s: &str)` 实现**双写**：
  1. `println!("[pet-debug] {s}")` → 开发模式下可在终端看到；
  2. 若 `LOG_DIR` 已初始化，则以 Unix 时间戳为行首 `[ts]` 追加写入 `pet.log`。
- 启动时调用 `log_environment()` 记录 OS、WebView2 版本、WinINET 代理、`HTTP_PROXY`/`HTTPS_PROXY`、`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 环境变量及 `LOG_DIR` 路径，便于定位 WebView2 加载问题。
- 通过 Tauri command `debug_mark(msg)` 暴露给前端，把前端诊断探针结果汇聚到同一通道。
- 通过 `std::panic::set_hook` 捕获所有 panic，同样走 `log_line`，保证崩溃也能落盘。

### 3.2 前端侧：`console.*` + `toast`
- 前端不使用集中式 logger，各模块直接调用 `console.log` / `console.info` / `console.error`，并习惯以 `[模块名]` 前缀区分来源（如 `[audio]`、`[driver]`、`[astrobot]`）。
- 用户可见的错误/警告通过 `ui/Toast.ts` 的 `toast(msg, "warn")` 弹出，不进入控制台。
- 通过 `window.__BOOT__ = true` 和 `window.__pet` 暴露调试钩子，配合 Rust 侧 `spawn_diag_probe` 定时注入 JS 探测 WebView2 加载状态，结果经 `debug_mark` 回到 Rust 日志通道。

### 3.3 日志级别策略
- **无结构化级别**。Rust 侧全部走 `log_line`，前端用 `console.log`/`console.info`/`console.error` 粗略区分。
- 关键运行期事件（drag start/end、shell 执行、音频捕获循环、panic）均打点；高频数据（PCM 采样、频谱值）仅在特定条件或开发场景下输出。

## 4. 约定与约束

- **所有 Rust 诊断输出必须经过 `log_line`**：项目中的 `audio.rs` 仍直接用 `eprintln!` 输出 `[audio] ...`，但 `lib.rs` 中业务逻辑（拖拽、shell、环境信息等）统一通过 `log_line`，体现“新代码应走统一入口”的约定。
- **日志文件位置固定**：`<app_data_dir>/logs/pet.log`，文件名不可配置，仅目录由 `LOG_DIR` 管理。
- **生产环境隐藏窗口子系统**：`main.rs` 使用 `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`，意味着发布构建不会显示控制台窗口，stdout 不可见，因此依赖 `pet.log` 文件兜底。
- **dev 模式开启 CDP**：`--remote-debugging-port=9222` 配合 `scripts/cdp-diag.mjs` 进行 WebView2 诊断，属于开发期辅助手段。
- **前端日志无持久化**：`console.*` 仅输出到浏览器控制台，重启后丢失；需要持久化的诊断信息需通过 `invoke("debug_mark", ...)` 转交 Rust 侧落盘。
- **panic 自动落盘**：通过 `std::panic::set_hook` 将 panic 信息格式化后写入日志，无需业务代码手动捕获。

## 5. 总结

这是一个**极简、无依赖、面向桌面桌宠场景的诊断型日志系统**：Rust 侧通过单函数双写 stdout+文件，前端侧散落使用 `console.*`，两者通过 Tauri `debug_mark` 命令打通。它不具备结构化字段、动态级别切换、多 sink 路由等能力，但在当前小体量应用中足以满足开发与排障需求。