const assert = require("assert");
const { normalizeManifest, defaultSettings } = require("./build/plugins/manifest.js");
const { registerToolSpec, isKnownTool, validateToolArgs, truncateToolResult, toolNames } = require("./build/assistant/toolRuntime.js");

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`not ok - ${name}`);
    throw e;
  }
}

test("normalizes a valid manifest", () => {
  const m = normalizeManifest({
    id: "petra-plugin-hello",
    name: "Hello",
    version: "1.0.0",
    apiVersion: 1,
    main: "index.js",
    permissions: ["pet.tools", "pet.say"],
    settings: [
      { key: "greeting", label: "问候", type: "string", default: "hi" },
      { key: "show", type: "boolean", default: true },
    ],
  });
  assert.strictEqual(m.id, "petra-plugin-hello");
  assert.deepStrictEqual(m.settings.map((s) => s.key), ["greeting", "show"]);
  assert.deepStrictEqual(defaultSettings(m.settings), { greeting: "hi", show: true });
});

test("rejects bad id / apiVersion / traversal main", () => {
  assert.throws(() => normalizeManifest({ id: "../x", apiVersion: 1 }), /id/);
  assert.throws(() => normalizeManifest({ id: "ok", apiVersion: 2 }), /apiVersion/);
  assert.throws(() => normalizeManifest({ id: "ok", apiVersion: 1, main: "../evil.js" }), /入口路径/);
});

test("requires directory id to match manifest id", () => {
  assert.throws(
    () => normalizeManifest({ id: "other", apiVersion: 1, main: "index.js" }, "petra-plugin-hello"),
    /目录名/,
  );
});

test("dynamic tool specs participate in validation and truncation", () => {
  const dispose = registerToolSpec("plugin_echo", { required: ["text"], maxResultChars: 5 });
  assert.ok(isKnownTool("plugin_echo"));
  assert.ok(toolNames().includes("plugin_echo"));
  assert.strictEqual(validateToolArgs("plugin_echo", {}).ok, false);
  assert.strictEqual(validateToolArgs("plugin_echo", { text: "x" }).ok, true);
  assert.ok(truncateToolResult("plugin_echo", "1234567890").includes("中间省略"));
  dispose();
  assert.ok(!isKnownTool("plugin_echo"));
});

console.log("plugin-manifest tests passed");
