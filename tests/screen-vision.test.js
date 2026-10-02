const assert = require("node:assert/strict");
const { chatStream } = require("./load-assistant-client.js");
const { validateToolArgs } = require("./build/assistant/toolRuntime.js");

(async () => {
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response('data: {"choices":[{"delta":{"content":"测试回复"}}]}\n\ndata: [DONE]\n\n', {
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  try {
    const history = [
      { role: "user", content: "旧问题" },
      { role: "assistant", content: "旧回答" },
      { role: "user", content: "帮我看看屏幕" },
      { role: "assistant", content: null, tool_calls: [{ id: "shot", type: "function", function: { name: "capture_screen", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "shot", content: "截图成功" },
    ];
    const originalHistory = JSON.stringify(history);
    const image = "data:image/png;base64,dGVzdA==";
    const run = (h, options) => chatStream("openai", "test-key", "test-model", h, "", [], "", () => {}, true, "", "", options);
    await run(history, { screenImage: image });
    const messages = requests[0].messages;
    assert.equal(messages[1].content, "旧问题", "旧用户消息不附图");
    assert.deepEqual(messages[3].content, [
      { type: "text", text: "帮我看看屏幕" },
      { type: "image_url", image_url: { url: image } },
    ]);
    assert.deepEqual(messages.slice(4), history.slice(3), "保留截图工具调用及结果");
    assert.equal(JSON.stringify(history), originalHistory, "图片不进入历史");
    assert.ok(requests[0].tools.some(t => t.function.name === "capture_screen"));
    assert.equal(validateToolArgs("capture_screen", {}).ok, true);
    await run(history, {});
    assert.deepEqual(requests[1].messages.slice(1), history, "下一轮未提供截图时不携带旧图");
    assert.ok(!JSON.stringify(requests[1]).includes(image));
    await run([{ role: "assistant", content: "没有用户消息" }], { screenImage: image });
    assert.equal(requests[2].messages[1].content, "没有用户消息");
    console.log("screen-vision: all assertions passed");
  } finally {
    global.fetch = originalFetch;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
