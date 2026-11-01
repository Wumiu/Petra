/**
 * Petra 侧反向桥插件。
 *
 * 注册 ask_dsh 工具：把 { text, url } POST 给 dsh-petra-bridge，
 * 拿到回复后让 Petra 说出来。
 */
const DEFAULT_ENDPOINT = "http://127.0.0.1:3080/petra/ask";
let config = {
  endpoint: DEFAULT_ENDPOINT,
  token: "",
  sessionId: "",
};
let disposeTool = null;
let disposeSettings = null;

function endpointOf() {
  return String(config.endpoint || DEFAULT_ENDPOINT).trim();
}

/** 长任务进度提示：2 分钟后先安慰一句，之后每 5 分钟再说一次，直到调用结束 */
function startProgressNotice(say) {
  let timer = setTimeout(() => {
    say("我还在看，稍等…");
    timer = setInterval(() => say("还在处理，快好了…"), 300_000);
  }, 120_000);
  return () => {
    clearTimeout(timer);
    clearInterval(timer);
  };
}

async function askDsh(args) {
  const endpoint = endpointOf();
  if (!/^https?:\/\//i.test(endpoint)) {
    throw new Error("反向桥地址必须以 http:// 或 https:// 开头");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_790_000);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.token ? { "x-petra-token": String(config.token) } : {}),
      },
      body: JSON.stringify({
        text: String(args.text || "").trim(),
        url: String(args.url || "").trim(),
        ...(config.sessionId ? { sessionId: String(config.sessionId).trim() } : {}),
      }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok === false) {
      throw new Error(data?.error || `dsh 反向桥返回 HTTP ${res.status}`);
    }
    const reply = String(data.reply || data.text || "").trim();
    if (!reply) throw new Error("dsh 返回了空回复");
    return reply;
  } finally {
    clearTimeout(timer);
  }
}

export async function activate(pet) {
  config = { ...config, ...pet.settings.get() };

  disposeTool = pet.tools.register({
    name: "ask_dsh",
    description:
      "把用户给的问题或网络视频链接转给 dsh 处理，并让 Petra 说出 dsh 的最终回复。用户说『把这个链接发给 dsh 看看』时调用。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要问 dsh 的问题，例如：总结这个视频" },
        url: { type: "string", description: "可选：视频/网页链接" },
      },
      required: ["text"],
    },
    // dsh 那边看视频/长思考可能远超 20 秒（桥内 fetch 自己限 29:50，dsh 侧轮询上限 29:40），这里必须一起放宽
    timeoutMs: 1_800_000,
    async execute(args) {
      const stop = startProgressNotice((text) => {
        try {
          void pet.say(text, 6000);
        } catch (_) {
          /* 气泡失败不影响主流程 */
        }
      });
      try {
        const reply = await askDsh(args);
        await pet.say(reply, 9000);
        return reply;
      } finally {
        stop();
      }
    },
  });

  disposeSettings = pet.settings.onChange((next) => {
    config = { ...config, ...next };
  });
}

export function deactivate() {
  disposeTool?.();
  disposeSettings?.();
  disposeTool = null;
  disposeSettings = null;
}
