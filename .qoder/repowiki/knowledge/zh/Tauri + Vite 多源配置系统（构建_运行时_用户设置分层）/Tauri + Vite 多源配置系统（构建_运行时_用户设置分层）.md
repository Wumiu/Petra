---
kind: configuration_system
name: Tauri + Vite 多源配置系统（构建/运行时/用户设置分层）
category: configuration_system
scope:
    - '**'
source_files:
    - vite.config.ts
    - package.json
    - src-tauri/tauri.conf.json
    - src-tauri/capabilities/default.json
    - src-tauri/Cargo.toml
    - src/utils/settings.ts
    - src/main.ts
    - src-tauri/src/lib.rs
---

## 1. 整体方案
本项目采用「三层配置」架构：
- **构建期配置**：`vite.config.ts`、`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`，决定前端打包目标、端口、环境变量前缀、Tauri 窗口与权限。
- **应用运行期配置**：Rust 侧通过 `AppHandle::path().app_data_dir()` 在用户数据目录创建 `models/` 存放导入的 PSD 模型；日志写入 `logs/pet.log`；自启动开关由 `tauri-plugin-autostart` 管理。
- **用户持久化设置**：前端 `src/utils/settings.ts` 将 `Settings` 对象以 JSON 形式存入浏览器 `localStorage`（key=`live2d-pet-settings`），并提供默认值合并、活动频率因子缓存等逻辑。

## 2. 关键文件
- `vite.config.ts`：Vite 开发服务器 host/port、`envPrefix: ["VITE_", "TAURI_"]`、按 `TAURI_ENV_PLATFORM`/`TAURI_ENV_DEBUG` 切换构建 target/minify/sourcemap。
- `package.json`：脚本入口 `dev/build/preview/tauri`，声明 `@tauri-apps/api`、`pixi.js`、`ag-psd` 等依赖。
- `src-tauri/tauri.conf.json`：应用名、版本、标识符、单窗口 `main`（300×300、透明、置顶、无边框）、安全策略 `csp: null`、bundle 图标列表。
- `src-tauri/capabilities/default.json`：能力清单，声明 `core:*`、`event:default`、`autostart:default` 等权限，绑定到 `windows: ["main"]`。
- `src-tauri/Cargo.toml`：Rust crate 定义，启用 `tray-icon`、`image-png` 特性，引入 `tauri-plugin-autostart`、`serde`、`windows` 平台 SDK。
- `src/utils/settings.ts`：用户设置类型定义、默认值、`loadSettings/saveSettings`、`getActivityFactor`、`nextActivity`、`ACTIVITY_LABEL`。
- `src/main.ts`：前端启动入口，加载 settings、调用 Tauri IPC 命令（`set_audio_enabled`、`drag_start/end`、`list_models`、`get/set_autostart` 等）。
- `src-tauri/src/lib.rs`：Rust 后端，注册所有 `#[tauri::command]`，维护 `AudioState`/`PetMotion`/`DragState` 全局状态，实现 PSD 模型读写、托盘菜单、点击穿透监控、诊断探针。

## 3. 架构与设计约定
- **环境区分**：通过 Vite 注入的 `TAURI_ENV_PLATFORM`、`TAURI_ENV_DEBUG` 控制构建产物（Windows 用 `chrome105` target，调试开启 sourcemap）。开发时 Tauri 指向 `http://127.0.0.1:1420` 的 Vite dev server。
- **用户设置不可变默认值**：`DEFAULTS` 与 `ACTIVITY_FACTOR` 在模块顶层定义，`loadSettings` 使用展开合并 `{ ...DEFAULTS, ...parsed }`，读取失败或解析异常回退到默认值。
- **设置即插即用**：`saveSettings` 同时更新模块级 `currentFactor` 缓存，避免每帧重复计算；其他模块通过 `getActivityFactor()` 零开销读取。
- **模型来源优先级**：`main.ts` 中 `createView()` 按顺序尝试：已导入 PSD（`localStorage` key=`live2d-pet-psd`）→ 打包 manifest（`/models/manifest.json`）→ 标准 Live2D → 占位渲染器，形成 fallback 链。
- **原生能力通过 IPC 暴露**：所有系统交互（音频开关、拖拽、自启动、回收站、PSD 读写）均经 `invoke("...")` 调用 Rust 命令，前端不直接访问文件系统。
- **权限最小化**：`capabilities/default.json` 仅开放窗口位置/显示/缩放、事件、自启动所需权限，未开放文件系统直读。

## 4. 约束与规则
- **环境变量命名**：仅 `VITE_*` 和 `TAURI_*` 前缀会被 Vite 注入前端（见 `envPrefix`），其他环境变量不会出现在客户端代码中。
- **窗口配置集中**：窗口尺寸、透明度、置顶、任务栏隐藏等行为全部集中在 `tauri.conf.json` 的 `app.windows[0]`，前端不硬编码这些属性。
- **用户设置 schema 稳定**：`Settings` 接口是前后端共享的配置契约，新增字段需保持向后兼容（`loadSettings` 会合并旧数据）。
- **敏感信息存储**：小助手 API Key 等敏感字段保存在 `localStorage`，当前无加密或远程同步机制，属于明文本地存储。
- **模型文件命名规范**：Rust 侧 `sanitize_psd_name` 强制文件名 ≤64 字符、仅保留 ASCII 字母数字/`_`/`-`，且必须以 `.psd` 结尾，否则自动补全。
- **自启动开关**：通过 `tauri-plugin-autostart` 的 `ManagerExt` 查询/设置，前端只感知布尔结果，具体注册表/启动项路径由插件处理。
- **调试输出统一**：Rust 侧所有诊断日志经 `log_line` 写入 stdout + `app_data_dir/logs/pet.log`，前端通过 `debug_mark` 命令上报 WebView2 视角的诊断信息。