const assert = require("node:assert/strict");
const { deleteWrongHistory } = require("./build/assistant/ChatHistory.js");

const oldTurn = [
  { role: "user", content: "我昨天没睡觉" },
  { role: "assistant", content: "你熬夜了", tool_calls: [{ id: "old", type: "function", function: { name: "remember", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "old", content: "已记住" },
  { role: "assistant", content: "早点休息" },
];
const unrelated = [{ role: "user", content: "天气如何" }, { role: "assistant", content: "晴天" }];
const currentTurn = [
  { role: "user", content: "我没有熬夜，昨天睡得很好" },
  { role: "assistant", content: null, tool_calls: [{ id: "delete", type: "function", function: { name: "delete_wrong_history", arguments: "{}" } }] },
];
const history = [...oldTurn, ...unrelated, ...currentTurn];
const original = JSON.stringify(history);
assert.deepEqual(deleteWrongHistory(history, ["熬夜"]), [...unrelated, ...currentTurn]);
assert.equal(JSON.stringify(history), original, "不修改调用前的历史对象");
assert.deepEqual(deleteWrongHistory(history, ["不匹配"]), history);
assert.deepEqual(deleteWrongHistory(history, ["", "   "]), history);
assert.deepEqual(deleteWrongHistory(currentTurn, ["熬夜"]), currentTurn, "只命中当前纠正时不删除");
assert.deepEqual(deleteWrongHistory([{ role: "assistant", content: "熬夜" }], ["熬夜"]), [{ role: "assistant", content: "熬夜" }]);
const callsOnly = [
  { role: "user", content: "熬夜" },
  { role: "assistant", content: null, tool_calls: [{ id: "old", type: "function", function: { name: "remember", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "old", content: "ok" },
  ...currentTurn,
];
assert.deepEqual(deleteWrongHistory(callsOnly, ["熬夜"]), currentTurn, "删除整轮时不会留下孤立工具结果");
console.log("chat-history: all assertions passed");
