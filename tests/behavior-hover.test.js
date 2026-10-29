const assert = require("node:assert");
const { BehaviorEngine } = require("./build/autonomous/BehaviorEngine.js");

const engine = new BehaviorEngine({ x: 300, y: 100 });
engine.charBoundsCache = { left: 275, top: 233, right: 449, bottom: 455 };
engine.cursorRel = { x: 16, y: -6 }; // 窗口中心 350,350 → 模型内 366,344
assert.equal(engine.cursorOnPet(), true, "光标在模型内应判定为可抓取");

engine.cursorRel = { x: 200, y: 0 }; // 模型右边缘 + 101px，超出 80px 余量
assert.equal(engine.cursorOnPet(), false, "光标远离模型时不应冻结漫游");

engine.cursorRel = { x: 140, y: 0 }; // 右边缘 + 41px，落在 80px 抓取余量内
assert.equal(engine.cursorOnPet(), true, "模型边缘 80px 内也应可抓取");
console.log("behavior-hover.test: passed");
