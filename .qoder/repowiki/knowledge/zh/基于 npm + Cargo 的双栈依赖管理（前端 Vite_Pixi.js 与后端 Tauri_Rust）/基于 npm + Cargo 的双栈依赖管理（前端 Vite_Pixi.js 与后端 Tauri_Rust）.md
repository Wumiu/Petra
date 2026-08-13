---
kind: dependency_management
name: 基于 npm + Cargo 的双栈依赖管理（前端 Vite/Pixi.js 与后端 Tauri/Rust）
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - package-lock.json
    - src-tauri/Cargo.toml
    - src-tauri/Cargo.lock
---

## 1. 使用的系统与工具

本项目采用**双栈依赖管理**：
- **前端（TypeScript/Pixi.js）**：使用 **npm**（由 `package.json` 和根目录的 `package-lock.json` 可知），包管理器锁定版本，构建工具链为 **Vite 6** + **TypeScript 5**。
- **后端（Rust/Tauri v2）**：使用 **Cargo**，通过 `src-tauri/Cargo.toml` 声明 crate 依赖，并通过 `src-tauri/Cargo.lock` 锁定精确版本。

两个子工程各自独立维护依赖，不存在跨语言共享依赖。项目没有使用私有 npm registry、`pnpm`/`yarn`、`bun`、`.npmrc`、`cargo config` 或 `vendor/` 等机制。

## 2. 关键文件

- `package.json`：定义项目名称 `live2d-pet`、`private: true`、模块类型 `"type": "module"`，以及运行时依赖与开发依赖。
- `package-lock.json`：npm lockfile v3，锁定所有 npm 包的精确版本与完整性校验哈希，确保可重复安装。
- `src-tauri/Cargo.toml`：Rust crate `pet`（lib name `pet_lib`，crate-type 同时包含 `staticlib`、`cdylib`、`rlib`），声明 Tauri v2 及 Windows 平台相关依赖。
- `src-tauri/Cargo.lock`：Cargo 锁文件，锁定 Rust 依赖树。

## 3. 架构与约定

### 前端依赖（npm）
- **运行时依赖**：
  - `pixi.js ^6.5.10`：2D 渲染引擎。
  - `pixi-live2d-display ^0.4.0`：Live2D 模型在 Pixi.js 中的显示插件。
  - `ag-psd ^31.0.2`：PSD 文件解析（配合 `public/models/*.psd` 资源）。
  - `@tauri-apps/api ^2.5.0`：前端调用 Tauri 后端的 API。
  - `@tauri-apps/plugin-autostart ^2.2.1`：开机自启动能力的前端绑定。
- **开发依赖**：`vite ^6.1.0`、`typescript ^5.7.2`、`@tauri-apps/cli ^2.5.0`、`ws ^8.21.3`。
- 版本策略：全部使用 `^` 语义化版本范围，允许小版本升级；具体锁定版本由 `package-lock.json` 保证。
- 无 vendoring：未检出 `node_modules` 到仓库，依赖通过 npm 安装。

### 后端依赖（Cargo）
- **build-dependencies**：`tauri-build = { version = "2", features = [] }`，用于生成 Tauri schema。
- **dependencies**：
  - `tauri = { version = "2", features = ["tray-icon", "image-png"] }`：启用托盘图标与 PNG 图像解码能力。
  - `tauri-plugin-autostart = "2"`：与前端 `@tauri-apps/plugin-autostart` 对应的原生实现。
  - `serde = { version = "1", features = ["derive"] }` + `serde_json = "1"`：序列化/反序列化。
  - `windows = { version = "0.58", features = [...] }`：仅启用所需的 Win32 子系统（Foundation、Graphics_Gdi、Media_Audio、System_Com、UI_Shell、UI_WindowsAndMessaging）。
  - `raw-window-handle = "0.6"`：窗口句柄互操作。
- 版本策略：major 版本约束（如 `"2"`、`"1"`、`"0.58"`），不指定 patch/minor，由 `Cargo.lock` 锁定。
- 无 vendoring：未检出 `target/` 或 `vendor/` 目录。

### 前后端依赖对齐
- Tauri 生态在前端（`@tauri-apps/*`）与后端（`tauri` crate）均锁定在 **v2** 主版本，保持 ABI/API 一致。
- 自启动能力通过前后端两个独立包分别引入，形成对称依赖关系。

## 4. 约定与约束

- **双锁文件**：npm 侧使用 `package-lock.json`，Rust 侧使用 `Cargo.lock`，两者均需提交至版本库以保证可重现构建。
- **版本范围**：前端使用 `^` 语义化版本范围；Rust 使用 major-only 范围，避免意外大版本升级。
- **最小化 feature**：Rust 依赖通过显式 `features` 列表启用所需 Win32 子系统，避免全量引入 Windows SDK。
- **无私有源配置**：未发现 `.npmrc`、`registry=` 或 `CARGO_HOME` 自定义配置，默认使用官方 npm registry 与 crates.io。
- **无 vendoring**：未将第三方源码纳入仓库，依赖均由包管理器在安装时拉取。
- **脚本入口**：`package.json.scripts` 中提供 `dev`、`build`、`preview`、`tauri` 四个命令，统一依赖安装与构建流程入口。
- **Tauri 能力声明**：除 `Cargo.toml` 中的 `features` 外，还通过 `src-tauri/capabilities/default.json` 声明应用权限，属于依赖之外的安全边界控制。

综上，该项目是一个典型的“前端 npm + 后端 Cargo”双栈桌面应用，依赖管理简单清晰：每个子工程各自维护 manifest 与 lockfile，通过 Tauri v2 生态将前后端依赖对齐到同一主版本。