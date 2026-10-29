# Petra Plugin SDK

这是给 dsh / 其他编码 Agent 读的 Petra 插件开发包。Petra 安装后也能在控制面板「插件」页点「打开插件 SDK」得到同一份文件。

## 1. 插件目录

```text
<plugin-id>/
  petra-plugin.json
  index.js
```

- `petra-plugin.json`：manifest，`id` 必须与目录名一致。
- `index.js`：单文件 ESM，导出 `activate(pet)`，可选 `deactivate()`。
- 当前 MVP 不支持 npm 依赖、压缩包和任意 DOM。

## 2. manifest

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "apiVersion": 1,
  "main": "index.js",
  "description": "插件说明",
  "author": "you",
  "permissions": ["pet.tools", "pet.say", "pet.menu", "pet.settings"],
  "enabledByDefault": true,
  "settings": [
    { "key": "greeting", "label": "问候语", "type": "string", "default": "你好" }
  ]
}
```

- `apiVersion` 当前只支持 `1`。
- `permissions` 按需声明：
  - `pet.tools`：注册工具
  - `pet.say`：让桌宠说话
  - `pet.notify`：系统通知
  - `pet.menu`：注册插件命令（只显示在控制面板插件页）
  - `pet.settings`：读写插件设置
- `settings` 支持 `string` / `number` / `boolean` / `select`。控制面板会自动渲染表单。

## 3. 入口

```js
let disposeTool = null;

export async function activate(pet) {
  const cfg = pet.settings.get();

  disposeTool = pet.tools.register({
    name: "my_tool",
    description: "工具说明",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "可选参数" }
      }
    },
    async execute(args) {
      const text = String(args.text || cfg.greeting || "你好");
      await pet.say(text, 5000);
      return `已让 Petra 说：${text}`;
    }
  });

  pet.menu.add({
    id: "hello",
    label: "插件：打个招呼",
    async run() {
      await pet.say(cfg.greeting || "你好");
    }
  });

  pet.settings.onChange((next) => {
    Object.assign(cfg, next);
  });
}

export function deactivate() {
  disposeTool?.();
  disposeTool = null;
}
```

## 4. host API

- `pet.tools.register(tool)` → 返回取消注册函数
- `pet.menu.add(item)` → 返回取消注册函数
- `pet.settings.get()` / `await pet.settings.set(patch)` / `pet.settings.onChange(fn)`
- `await pet.say(text, holdMs?)`
- `await pet.notify(title, body)`
- `pet.log(...args)`

## 5. 安装与调试

1. 把整个插件目录放进 Petra 插件目录。
2. 控制面板 →「插件」→「全部重载」。
3. 启用插件。
4. 插件工具会出现在小助手的工具列表里；插件命令会显示在插件页。
5. 加载失败时，插件页会显示 `error`，修正后点「重载」。

Windows 插件目录：

```text
%APPDATA%\com.wumiu.petra\plugins\<plugin-id>\
```

## 6. 给 dsh 的工作方式

如果 dsh 能读文件：

1. 先读本目录的 `README.md`、`types.d.ts`、`template/`。
2. 在临时目录生成 `<plugin-id>/petra-plugin.json` + `index.js`。
3. 调 Petra 的 MCP 工具 `petra_install_plugin`（参数 `sourceDir` 指向临时目录）。
4. 调 `petra_reload_plugins`。
5. 调 `petra_list_plugins` 确认 `loaded=true`，再让用户测试。

如果没有 MCP，就手动把目录复制到 Petra 插件目录并点「全部重载」。
