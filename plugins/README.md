# Petra 插件

当前 MVP 支持**单文件 ESM 插件**，运行在 Web Worker 中，通过 `pet` API 使用受控能力。

## 安装

把一个插件目录放到 Petra 的用户数据目录：

- Windows：`%APPDATA%\com.wumiu.petra\plugins\<插件 id>\`
- macOS：`~/Library/Application Support/com.wumiu.petra/plugins/<插件 id>/`
- Linux：`~/.local/share/com.wumiu.petra/plugins/<插件 id>/`

目录里至少要有：

```text
<插件 id>/
  petra-plugin.json
  index.js
```

打开控制面板 →「插件」→「打开插件目录」，或点「安装示例插件」。

## petra-plugin.json

```json
{
  "id": "petra-plugin-hello",
  "name": "Hello Petra",
  "version": "1.0.0",
  "apiVersion": 1,
  "main": "index.js",
  "description": "示例插件",
  "permissions": ["pet.tools", "pet.say", "pet.menu", "pet.settings"],
  "enabledByDefault": true,
  "settings": [
    { "key": "greeting", "label": "问候语", "type": "string", "default": "你好呀" }
  ]
}
```

- `id` 必须与目录名一致。
- `apiVersion` 当前只支持 `1`。
- `permissions`：`pet.tools` / `pet.say` / `pet.notify` / `pet.menu` / `pet.settings`。

## 插件入口

```js
export async function activate(pet) {
  pet.tools.register({
    name: "hello_petra",
    description: "让桌宠打个招呼",
    parameters: { type: "object", properties: {} },
    async execute(args) {
      await pet.say("你好呀");
      return "已打招呼";
    },
  });

  pet.menu.add({
    id: "hello",
    label: "插件：打个招呼",
    async run() {
      await pet.say("你好呀");
    },
  });
}

export function deactivate() {
  // 清理定时器等资源
}
```

## pet API

- `pet.tools.register(tool)` → 返回取消注册函数
- `pet.menu.add(item)` → 返回取消注册函数
- `pet.settings.get()` / `await pet.settings.set(patch)` / `pet.settings.onChange(fn)`
- `await pet.say(text, holdMs?)`
- `await pet.notify(title, body)`
- `pet.log(...args)`

## 安全边界

插件是本地代码，**只安装你信任的插件**。Worker 隔离能防止插件直接操作主窗口 DOM，但不是操作系统级沙箱；插件仍可通过 `fetch` 访问网络。宿主 API 只暴露上述白名单，不会把 `invoke`、文件系统或 shell 直接交给插件。


## 用 dsh 自动写 / 安装

Petra 控制面板 →「插件」页提供：

- **「dsh MCP 接入」**：显示可复制的 `mcpServers` 配置，dsh 可直接调用
  `petra_plugin_sdk`、`petra_install_plugin`、`petra_reload_plugins`、`petra_list_plugins`。
- **「给 dsh 的说明」**：一段可直接复制给 dsh 的插件开发 prompt。
- **「打开插件 SDK」**：把 `README.md`、`types.d.ts`、`template/` 落到
  `%APPDATA%\com.wumiu.petra\plugin-sdk`，没有源码也能让 dsh 读到契约。
