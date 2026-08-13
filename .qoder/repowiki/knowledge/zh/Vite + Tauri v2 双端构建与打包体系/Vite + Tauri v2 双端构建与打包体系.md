---
kind: build_system
name: Vite + Tauri v2 双端构建与打包体系
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - vite.config.ts
    - src-tauri/Cargo.toml
    - src-tauri/tauri.conf.json
    - src-tauri/build.rs
    - scripts/gen-icons.ps1
    - 启动桌宠.dev.bat
---

## 1. 使用的系统/工具

本项目采用 **Tauri v2** 作为桌面应用壳，前端基于 **Vite 6** + **TypeScript 5** 构建 Pixi.js 渲染层，后端 Rust 通过 `tauri-build` 在 Cargo 构建阶段集成。整体流程：
- 前端：`vite build`（经 `tsc` 类型检查）产出静态资源到 `dist/`。
- 后端：Cargo 编译 `pet_lib`（同时输出 staticlib/cdylib/rlib），`build.rs` 调用 `tauri_build::build()` 注入平台 schema 与能力清单。
- 打包：`tauri.conf.json` 的 `bundle.targets = "all"` 触发多平台产物生成（Windows MSI/EXE、macOS DMG、Linux AppImage 等）。
- 开发：`npm run tauri dev` → Tauri 启动 `beforeDevCommand: npm run dev`，通过 `devUrl: http://127.0.0.1:1420` 加载 Vite 热更新页面。

## 2. 关键文件

- `package.json`：定义 `dev` / `build` / `preview` / `tauri` 脚本；依赖 `@tauri-apps/cli`、`pixi.js`、`pixi-live2d-display`、`ag-psd`。
- `vite.config.ts`：固定开发端口 `1420`（`strictPort: true`），根据 `TAURI_ENV_PLATFORM` 选择目标浏览器（Windows→`chrome105`，其他→`safari13`），调试时关闭 minify 并开启 sourcemap，CommonJS include 覆盖 `node_modules` 与 `vendor/anime2dr`。
- `src-tauri/Cargo.toml`：Rust crate `pet`，启用 `tray-icon`、`image-png` 特性；依赖 `windows 0.58` 的 Win32 API 子集（Foundation/Gdi/Media-Audio/System-Com/UI-Shell/UI-WindowsAndMessaging）。
- `src-tauri/tauri.conf.json`：声明窗口（无边框、透明、置顶、可拖拽）、安全策略（CSP 关闭）、Bundle 图标列表及 `frontendDist: ../dist`。
- `src-tauri/build.rs`：仅调用 `tauri_build::build()`，由 Tauri 自动生成 `gen/schemas/*.json`。
- `scripts/gen-icons.ps1`：PowerShell 脚本用 System.Drawing 动态绘制矢量风格的圆脸猫头图标，输出 `src-tauri/icons/app-icon.png` 与 `tray.png`。
- `启动桌宠.dev.bat`：Windows 快捷入口，设置 UTF-8 编码后执行 `npm run tauri dev`。

## 3. 架构与约定

- **前后端版本同步**：前端 `package.json.version` 与 `src-tauri/tauri.conf.json.version` 均硬编码为 `0.1.0`，发布时需手动保持一致。
- **环境变量驱动构建**：Vite 通过 `TAURI_ENV_PLATFORM` / `TAURI_ENV_DEBUG` 切换目标平台与调试开关，Tauri 在构建时注入这些变量。
- **资源路径约定**：前端静态模型放在根目录 `public/models/`（manifest.json、sample.psd、deepseek.psd），Tauri 打包时通过 `bundle.icon` 数组引用 `src-tauri/icons/*`。
- **能力与权限**：`src-tauri/capabilities/default.json` 配合 `gen/schemas/` 中的 ACL manifest 控制 IPC 访问范围，由 `tauri_build` 在构建期生成。
- **原生能力边界**：Rust 侧仅暴露音频捕获、屏幕/窗口管理、回收站操作、托盘菜单与自动启动（`tauri-plugin-autostart`）等必要功能，其余逻辑留在前端。

## 4. 约定与约束

- **开发端口锁定**：Vite 强制使用 `127.0.0.1:1420` 且 `strictPort: true`，避免端口冲突导致 Tauri dev 模式失败。
- **调试开关**：当 `TAURI_ENV_DEBUG` 存在时，Vite 关闭压缩并生成 source map；否则生产构建默认 minify。
- **CommonJS 兼容**：`commonjsOptions.include` 显式包含 `node_modules` 和 `vendor/anime2dr`，说明项目中存在需以 CommonJS 方式处理的第三方代码。
- **Windows 专属依赖**：Cargo 依赖 `windows 0.58` 并仅启用必要的 Win32 feature 集合，体现最小化原生依赖的原则。
- **图标生成规范**：所有平台图标统一由 `scripts/gen-icons.ps1` 生成，输出至 `src-tauri/icons/`，再被 `tauri.conf.json` 的 bundle 配置引用。
- **无 CI/Makefile/Dockerfile**：仓库未提供自动化 CI 流水线或容器化构建脚本，本地通过 `npm run tauri build` 完成打包，通过 `启动桌宠.dev.bat` 快速启动开发环境。
- **版本管理**：版本号分散在 `package.json` 与 `src-tauri/tauri.conf.json` 两处，当前均为 `0.1.0`，发布前需人工同步修改。