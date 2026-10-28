// Petra 插件示例：单文件 ESM，运行在 Web Worker 里。
// 所有宿主能力都通过 activate(pet) 注入的 pet API 调用，不能直接使用 DOM / Tauri。
let config = {
  greeting: "你好呀，我是插件里的 Petra。",
  showMenu: true,
};
let disposeTool = null;
let disposeMenu = null;
let disposeSettings = null;

export async function activate(pet) {
  config = { ...config, ...pet.settings.get() };
  pet.log("Hello Petra 已启动");

  disposeTool = pet.tools.register({
    name: "hello_petra",
    description: "让桌宠用插件里配置的问候语打招呼。用户说「让桌宠打个招呼」时调用。",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "可选：覆盖插件设置里的问候语",
        },
      },
    },
    async execute(args) {
      const text = String(args.text || config.greeting || "你好呀。");
      await pet.say(text, 5000);
      return `已让 Petra 打招呼：${text}`;
    },
  });

  if (config.showMenu !== false) {
    disposeMenu = pet.menu.add({
      id: "hello",
      label: "插件：打个招呼",
      async run() {
        await pet.say(String(config.greeting || "你好呀。"), 5000);
      },
    });
  }

  disposeSettings = pet.settings.onChange((next) => {
    config = { ...config, ...next };
  });
}

export function deactivate() {
  disposeTool?.();
  disposeMenu?.();
  disposeSettings?.();
  disposeTool = null;
  disposeMenu = null;
  disposeSettings = null;
}
