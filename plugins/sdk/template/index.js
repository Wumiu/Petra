let config = { greeting: "你好呀，我是 Petra 里的插件。" };
let disposeTool = null;
let disposeMenu = null;

export async function activate(pet) {
  config = { ...config, ...pet.settings.get() };

  disposeTool = pet.tools.register({
    name: "my_tool",
    description: "一个示例工具：让 Petra 说一句话。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "可选：覆盖设置里的问候语" }
      }
    },
    async execute(args) {
      const text = String(args.text || config.greeting || "你好");
      await pet.say(text, 5000);
      return `已让 Petra 说：${text}`;
    }
  });

  disposeMenu = pet.menu.add({
    id: "hello",
    label: "插件：打个招呼",
    async run() {
      await pet.say(config.greeting || "你好", 5000);
    }
  });

  pet.settings.onChange((next) => {
    config = { ...config, ...next };
  });
}

export function deactivate() {
  disposeTool?.();
  disposeMenu?.();
  disposeTool = null;
  disposeMenu = null;
}
