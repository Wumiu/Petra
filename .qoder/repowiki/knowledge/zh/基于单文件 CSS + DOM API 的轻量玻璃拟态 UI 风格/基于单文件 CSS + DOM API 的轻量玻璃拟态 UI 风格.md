---
kind: frontend_style
name: 基于单文件 CSS + DOM API 的轻量玻璃拟态 UI 风格
category: frontend_style
scope:
    - '**'
source_files:
    - src/style.css
    - index.html
    - src/ui/ContextMenu.ts
    - src/ui/Toast.ts
---

## 1. 使用的系统/方法
- 纯原生 CSS（`src/style.css`，332 行），无 Sass/Less、PostCSS、Tailwind、CSS Modules、styled-components 等任何预处理或样式框架。
- 通过 `index.html` 直接 `<link rel="stylesheet" href="/src/style.css" />` 引入，Vite 仅做模块打包，不参与样式管线。
- UI 组件（右键菜单、Toast、小助手输入条/气泡）全部使用原生 DOM API（`document.createElement`、`className`、`classList`、`innerHTML`）动态构建，不依赖任何前端框架。
- 主舞台由 Pixi.js 渲染到 `#stage` 的 canvas，其余 HTML 浮层以固定定位叠加在 canvas 之上。

## 2. 关键文件
- `src/style.css`：全局样式与所有 UI 浮层的唯一样式来源。
- `index.html`：入口 HTML，挂载 `#stage`、`#menu`、`#toasts` 三个容器。
- `src/ui/ContextMenu.ts`：根据 `.pet-menu` / `.mi` / `.sep` / `.danger` 等 class 渲染右键菜单。
- `src/ui/Toast.ts`：向 `#toasts` 追加 `.toast` / `.warn` 元素并自动销毁。
- `src/main.ts`：应用启动时创建 Pixi 舞台并注入小助手输入条/气泡所需的 DOM 节点（对应 `.as-inputbar`、`.as-bubbles`、`.as-set-row` 等类）。

## 3. 架构与设计约定
- **单一样式源**：整个前端只维护一份 `style.css`，没有按组件拆分样式文件，也没有 CSS-in-JS。
- **命名空间式 class 前缀**：不同功能域用不同前缀区分，避免冲突——
  - 右键菜单：`.pet-menu`、`.mi`、`.sep`、`.danger`
  - 模型设置面板：`.model-panel`、`.mp-title`、`.mp-item`、`.mp-empty`、`.mp-hint`
  - 小助手：`.as-inputbar`、`.as-input`、`.as-send`、`.as-bubbles`、`.as-bubble`、`.as-ai`、`.as-sys`、`.as-confirm`、`.as-btn`、`.as-set-row`、`.as-select`、`.as-persona`
  - Toast：`.toast`、`.warn`、`.bye`
- **可见性控制**：统一通过 `.hidden` 类切换 `display: none`（如 `.pet-menu.hidden`、`.model-panel.hidden`、`.as-inputbar.hidden`）。
- **视觉主题（玻璃拟态）**：所有浮层一致采用半透明白底 + `backdrop-filter: blur(14px) saturate(1.4)` + 柔和阴影 + 内嵌白色描边，形成统一的毛玻璃卡片效果。
- **色彩体系**：主文字色 `#3a2a45`（深紫灰），强调色 `#d06a9a`（粉玫红），危险/警告色 `#c94a4a` / `rgba(140,58,52,0.85)`，辅助文本 `#8a7a95` / `#6a5a78`。按钮背景 `#262939`（深灰蓝）和 `#a01030`（深玫红）。
- **字体**：全局使用 `"Segoe UI", "Microsoft YaHei", system-ui, sans-serif`，适配 Windows 环境。
- **布局策略**：所有浮层使用 `position: fixed` + `z-index` 层级（菜单 100、面板 120、小助手 130、Toast 90），配合 `left/top` 或 `translate(-50%,-50%)` 居中/定位；Canvas 本身 `inset: 0` 铺满全屏。
- **动画**：统一使用 CSS `@keyframes toast-in` 实现入场弹跳，Toast 退出通过 `.bye` 类触发 `opacity` + `transform` 过渡。
- **无障碍/交互**：全局 `user-select: none` 防止拖拽选中文本；Toast 容器 `pointer-events: none` 让消息不阻挡点击。

## 4. 约定与约束
- **不使用任何样式预处理器或框架**：仓库中未发现 Tailwind、Sass、PostCSS、CSS Modules、styled-components、Emotion 等配置或引用。
- **样式与逻辑强耦合于 DOM class**：UI 组件通过 JS 动态创建元素并赋予预设 class（如 `toast warn`、`mi danger`），新增样式需同步更新 class 命名约定。
- **浮动窗口尺寸硬编码**：Canvas 默认 `300px × 300px`，菜单最小宽度 `132px`，输入条宽度 `236px`，气泡区宽度 `214px`，均为固定像素值，未使用响应式断点。
- **Windows 桌面场景导向**：字体选择 `Segoe UI`、`Microsoft YaHei`，`backdrop-filter` 同时提供 `-webkit-` 前缀，说明目标为 Windows 桌面浏览器环境。
- **无设计 Token 文件**：颜色、字号、圆角、阴影等值直接写在 CSS 中，未抽取为 CSS 变量或设计令牌，扩展时需逐处修改。