---
kind: error_handling
name: Tauri 桌面桌宠应用的错误处理：Rust Result + 前端 try/catch + 诊断日志通道
category: error_handling
scope:
    - '**'
source_files:
    - src-tauri/src/lib.rs
    - src-tauri/src/audio.rs
    - src/main.ts
    - src/assistant/AssistantClient.ts
    - src/live2d/psd/PsdRuntime.ts
    - src/features/trash/TrashHandler.ts
---

## 1. 整体方案

该项目是一个基于 Tauri v2 的 Windows 桌面桌宠应用，前后端分别使用 TypeScript（Pixi.js）与 Rust。错误处理采用**分层策略**：
- **Rust 后端**：以 `Result<T, String>` 作为 Tauri command 的标准返回类型，通过 `?` 传播错误；全局 panic hook 将崩溃信息写入统一诊断日志。
- **前端**：对异步 I/O（fetch、invoke、WebGL、音频 API）使用 `try/catch` 或 `.catch(() => {})` 静默降级，关键失败通过 `toast()` 通知用户。
- **跨进程**：Rust 通过 `app.emit("audio:error", ...)` 向前端推送音频捕获异常，前端监听该事件并提示。

## 2. 关键文件与位置

| 层级 | 文件 | 职责 |
|---|---|---|
| Rust 入口 | `src-tauri/src/lib.rs` | 所有 Tauri command 定义、panic hook、诊断日志、托盘/自动启动等 |
| Rust 音频 | `src-tauri/src/audio.rs` | WASAPI 回环捕获循环，错误经 `emit("audio:error")` 上报 |
| 前端主入口 | `src/main.ts` | 模型加载链、UI 交互、Toast 提示、音频错误监听 |
| 小助手 API | `src/assistant/AssistantClient.ts` | OpenAI 兼容 HTTP 调用，构造业务语义错误 |
| PSD 渲染 | `src/live2d/psd/PsdRuntime.ts` | WebGL shader 编译错误抛出 |
| 回收站 | `src/features/trash/TrashHandler.ts` | 拖放导入时 catch 并 toast |

## 3. 架构与约定

### 3.1 Rust 侧：Result + 字符串错误 + 诊断日志
- 所有暴露给前端的命令函数签名形如 `fn xxx(...) -> Result<T, String>`（见 `trash_files`、`read_file_bytes`、`save_psd`、`read_psd`、`run_shell`），错误以人类可读字符串返回，由 Tauri 序列化后在前端 `.catch()` 中拿到。
- 非命令内部辅助函数（如 `models_dir`）也返回 `Result<PathBuf, String>`，通过 `?` 向调用方传播。
- 全局 panic 钩子：在 `run()` 中通过 `std::panic::set_hook` 把 panic 位置与消息写入 `log_line`，后者同时输出到 stdout（dev 可见）和 `app_data_dir/logs/pet.log`（打包后可查）。
- 诊断探针：`spawn_diag_probe` 定时注入 JS 调用 `debug_mark` 命令，把 WebView2 视角的加载状态打回同一日志通道，用于定位 WebView2 加载问题。
- 日志目录在 `setup` 阶段初始化，路径为 `app_data_dir/logs`，不存在则退回到 `temp_dir/pet-logs`。

### 3.2 前端侧：try/catch + toast + 静默降级
- 模型加载采用**多路降级链**：先尝试已导入 PSD → 再尝试 manifest 中的 PSD → 再动态 import Live2DController → 最后 fallback 到 PlaceholderRenderer。每一步都包裹 try/catch，失败即进入下一路，最终保证至少显示占位角色。
- 对不关键的 invoke 调用使用 `.catch(() => {})` 静吞错误（如 `clear_pet_target`、`drag_start/end`、`scaleFactor`），避免阻塞主流程。
- 对用户可感知的失败（导入 PSD、读取文件、设置开机自启等）统一通过 `toast(msg, "warn")` 提示。
- 网络请求错误集中在 `AssistantClient.chat`：HTTP 非 ok 时抛 `Error("API 错误 {status}: ...")`，返回体结构异常时抛 `Error("API 返回格式异常")`，调用方负责 catch 并 toast。
- WebGL shader 编译失败直接 `throw new Error(gl.getShaderInfoLog(...))`，由上层 `createView` 的 try/catch 捕获并走降级逻辑。

### 3.3 跨进程错误：事件 + 结果
- 音频捕获线程在 `start_loopback_capture` 中捕获 `run_capture` 的 `Result`，失败时 `app.emit("audio:error", ...)` 推送到前端；`main.ts` 通过 `listen<string | object>("audio:error", ...)` 监听并 toast 提示，同时关闭音频跟随。
- Tauri command 的错误通过 Promise reject 形式传到前端，由 `.catch(err => ...)` 消费。

## 4. 约定与约束

- **Rust command 必须返回 `Result<T, String>`**：这是项目内所有 Tauri command 的统一约定，错误信息是面向用户的中文描述（如 `"只接受 .psd 文件"`、`"命令执行超时（15s）已终止"`），而非原始 OS 错误码。
- **禁止 panic 泄露**：虽然允许 panic（有全局 hook 兜底），但正常错误路径一律用 `Result` + `?` 传播，仅不可恢复的系统级故障才依赖 panic hook。
- **前端不抛未捕获异常**：所有异步副作用（invoke、fetch、WebGL、AudioContext）都显式 catch；对“可忽略”的错误（如后台清理、窗口缩放获取失败）使用空 `.catch(() => {})`。
- **用户可见错误必须走 toast**：任何影响用户体验的操作失败都应通过 `toast(msg, "warn")` 反馈，而不是仅 console.error。
- **诊断信息集中化**：Rust 侧所有调试/错误信息统一经过 `log_line`，前端侧关键阶段通过 `__BOOT__`、`__pet` 等全局标记暴露给诊断探针。
- **长耗时/危险操作带超时保护**：`run_shell` 强制 15 秒超时并 kill 子进程，防止命令挂起导致 UI 卡死。
- **音频错误通过事件解耦**：WASM 音频捕获线程与 UI 线程完全分离，错误通过 `audio:error` 事件广播，前端自行决定是否关闭功能。

## 5. 缺失或不一致之处

- 没有统一的自定义错误类型（如 `AppError` enum），Rust 侧直接用 `String` 作为错误值，前端用原生 `Error`，缺乏跨层错误码体系。
- 部分 Rust 回调（如托盘菜单事件、拖动跟随循环）直接 `let _ = ...` 忽略返回值，错误被静默丢弃，适合高频后台循环但不利于排错。
- 前端多处 catch 块为空（`/* 忽略 */`），虽符合“健壮性优先”的设计，但可能掩盖真实问题。