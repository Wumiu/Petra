// tsc 的 CommonJS 输出保留 Vite 的 ?raw 导入；只为此测试模块提供真实资源。
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const clientPath = require.resolve("./build/assistant/AssistantClient.js");
const originalLoad = Module._load;
try {
  Module._load = function (request, parent, ...rest) {
    if (parent?.filename === clientPath) {
      if (request === "../../CHANGELOG.md?raw") {
        return { default: fs.readFileSync(path.join(__dirname, "../CHANGELOG.md"), "utf8") };
      }
      if (request === "../../package.json") {
        return { default: JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8")) };
      }
    }
    return originalLoad.call(this, request, parent, ...rest);
  };
  module.exports = require(clientPath);
} finally {
  Module._load = originalLoad;
}
