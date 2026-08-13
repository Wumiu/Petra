# Live2D 桌宠

Tauri 2 + PixiJS 桌宠：垃圾桶功效、桌面乱逛、始终置顶、随音乐摆动（未完善）、AI 小助手（流式对话/Shell 工具调用/长期记忆/主动问候）、人格设定。
内置 Anime2.5DRig 技术（MIT）：**拖入分层 PSD 即自动生成 2.5D 角色**，无需 Cubism Editor、全本地离线运行。

自定义角色推荐流程：
准备一张想要的角色正面视图，前往 https://huggingface.co/spaces/24yearsold/see-through-demo 一键拆分成psd。
再前往 https://852wa.github.io/Anime2.5DRig/ 导入生成的psd看看效果，若有缺陷，则需使用软件修改图层（在线编辑网站：https://www.photopea.com/）
效果满意后，即可导入到软件中使用。

## 运行

```bash
npm install
npm run tauri dev      # 开发
npm run tauri build    # 打包
```

## 换模型

1. **拖入 PSD**：把分层 PSD 文件直接拖到桌宠身上 → 自动装配并即时换皮（存应用数据目录，持久化）
2. **右键菜单 → 模型设置**：「＋ 导入 PSD 模型」选择文件，也可在此面板切换内置/已导入模型
3. **打包默认模型**：PSD 放 `public/models/`，编辑 `public/models/manifest.json`：

```json
{ "type": "psd", "file": "my-char.psd" }
```

标准 Live2D 模型（model3.json）仍支持，manifest 改为 `{ "active": "model" }`。
使用标准 Live2D 模式需先放入官方 Cubism Core runtime：
将 `live2dcubismcore.min.js`（Live2D 官网下载，见其许可）放到 `public/vendor/`
并在 `index.html` 的 `<head>` 中以 `<script>` 引入。

## PSD 图层命名规范（Anime2.5DRig 约定）

| 图层名 | 内容 | 说明 |
|---|---|---|
| `face` | 脸基 | 锚点基准，最好有 |
| `eyewhite` | 白目（左右同层） | 自动左右分离 |
| `irides` | 虹膜 | 视线/瞳缩放，白目内裁剪 |
| `eyelash` | 开眼睫毛 | |
| `eye_close` | 闭眼 | 缺省自动生成 |
| `eyebrow` | 眉毛 | 角度/上下可操作 |
| `mouth_open` | 开口 | 开度驱动 |
| `mouth_close` | 闭口 | 缺省自动生成 |
| `nose` / `ears` / `neck` / `topwear` / `bottomwear` / `handwear` / `headwear` | 五官/躯体 | |
| `front hair` / `back hair` | 前/后发 | 自动发丝物理；可分 `front hair_1`、`_2`… |

- 不符合命名规则的图层也会自动按位置归类（头部/躯体），仅追随之
- 图层需**扁平**（不支持图层组）；画布建议正方形 768~2048
- 完整规范见上游 [Anime2.5DRig README](https://github.com/852wa/Anime2.5DRig)

## 功能

- 文件拖到身上松手 → 进回收站（可撤销，系统路径被拦截）；`.psd` 拖入则换模型
- 鼠标靠近会躲开；右键菜单：跟随音乐 / 逗猫棒 / 待机模式 / 活动频率 / 模型设置 / 小助手模式 / 小助手设置 / 隐藏 / 开机自启 / 重启 / 退出
- **待机模式**：沉到就近屏幕边缘（上半→顶部倒挂 180°，下半→底部），只露头顶+眼睛，完全静止；待机中拖动沿边缘滑动，退出靠右键菜单
- **活动频率三档**：低（几乎静止）/ 中（适度活动）/ 高（明显活跃）
- 托盘图标或 `Alt+P` 唤出/隐藏
- 音频走 WASAPI 回环捕获系统输出（免虚拟声卡）；失败时静默降级为待机动画
- PSD 角色：自动眨眼 / 发丝弹簧物理 / 闭眼闭口十字渐变 / 虹膜模板裁剪；音乐驱动身体律动、嘴型、眉毛、发丝（bass/mid/treble/beat → 身体/嘴/眉/发丝/瞳孔）（未完善）

## AI 小助手

- **流式对话**：点桌宠弹出输入框，回复逐字输出，左上角气泡展示
- **Shell 工具调用**（function calling）：AI 可执行系统命令，危险命令黑名单 + 链式拦截；默认弹确认气泡，可勾「免确认 shell」
- **长期记忆**：AI 自动归档用户偏好，也可说「记住 xx」
- **主动问候**：每 20 分钟智能打招呼（识别当前前台窗口标题/进程判断你在做什么）
- **人格设定**：小助手设置面板自定义人设

> **隐私说明**：主动问候会读取**当前前台窗口标题 + 进程名**并发送给 AI 判断，标题可能包含文件名、聊天内容等敏感信息；如介意，可关闭小助手模式。
> **安全说明**：API Key 经 Windows DPAPI 加密存储于应用数据目录（不明文落盘）；Shell 命令执行有危险命令黑名单（format/diskpart/del /s 等）与链式（& | > <）拦截。

## Astrobot 预留接口

前端桥接 `src/bridges/astrobot.ts`，外部进程可向窗口派发指令：

```js
window.__ASTROBOT__.emit({ type: "speak" | "emote" | "gesture" | "move" | "react", payload: {} })
// 或 document.dispatchEvent(new CustomEvent("astrobot:cmd", { detail: { type, payload } }))
```

指令会触发对应反馈动画（speak→吞咽、emote/gesture→点击反应、move→随机传送）。

## 诊断

- 所有前端报错（error/unhandledrejection/console）与启动阶段埋点汇集到
  `%APPDATA%\com.live2d.pet\logs\pet.log`（dev 时同步输出到终端）
- dev 构建自带 WebView2 远程调试端口 9222：
  `node scripts/cdp-diag.mjs` 可抓取页面异常/网络失败/模块加载详情
- 排查启动问题先看 `pet.log`：`boot:start → boot:view=<类型> → boot:loop=start → boot:audio=on`
  链路走到哪一步断了就是哪里的问题

## 目录

```
src/
├─ live2d/
│  ├─ psd/PsdRuntime.ts      # Anime2.5DRig 运行时（GL 网格/变形/物理/裁剪）
│  ├─ psd/Rigged2DView.ts    # PSD 渲染后端（PetView 实现，音乐/鼠标驱动映射）
│  └─ Live2DController.ts    # 标准 Live2D 后端
├─ assistant/                # AI 小助手（流式/工具调用/记忆）
├─ vendor/anime2dr/          # 上游 MIT 代码（rigger.js / genericparts.js）
└─ autonomous/ audio/ features/trash/ bridges/ ui/ utils/
```
