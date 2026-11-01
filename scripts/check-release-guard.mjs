#!/usr/bin/env node
/**
 * 发布前守门：确保打出来的包"内置新公钥 + 版本号与 tag 一致"。
 *
 * 为什么需要：updater 的公钥是编译进包里的，用户装上的那一刻就固定了。
 * 一旦某个版本用旧提交构建（公钥是旧的），那批用户之后收不到任何新更新。
 * 这条守卫放在 release workflow 的构建之前，不满足就直接失败，避免发出坏包。
 */
import { readFileSync } from "node:fs";

/** 所有对外发布的包都必须内置这把公钥（换 key 时同步改这里） */
const EXPECTED_KEY_ID = "7CB49615F65D3C41";

function keyIdOf(pubkeyB64) {
  try {
    const text = Buffer.from(String(pubkeyB64 || ""), "base64").toString("utf8");
    const first = (text.split("\n")[0] || "").trim();
    const m = /minisign public key:\s*([0-9A-Fa-f]+)/.exec(first);
    return m ? m[1].toUpperCase() : "";
  } catch {
    return "";
  }
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const updater = conf?.plugins?.updater ?? {};
const keyId = keyIdOf(updater.pubkey);
const endpoint = String((updater.endpoints || [])[0] || "");
const ref = String(process.env.GITHUB_REF_NAME || "").trim();
const tagVersion = ref.replace(/^v/, "");

const errors = [];
if (!keyId) {
  errors.push("tauri.conf.json 的 updater.pubkey 解不出 keyid（格式不对）");
} else if (keyId !== EXPECTED_KEY_ID) {
  errors.push(`包内公钥是 ${keyId}，期望 ${EXPECTED_KEY_ID} —— 这个包装上去以后收不到后续更新`);
}
if (tagVersion && tagVersion !== pkg.version) {
  errors.push(`tag ${ref} 与 package.json 版本 ${pkg.version} 不一致`);
}
if (!/^https:\/\/github\.com\/ks-kbl\/petra\/releases\//.test(endpoint)) {
  errors.push(`updater endpoint 未指向新仓库：${endpoint || "(空)"}`);
}

console.log(`tag        : ${ref || "(本地运行，跳过版本比对)"}`);
console.log(`version    : ${pkg.version}`);
console.log(`pubkey id  : ${keyId || "(解析失败)"}`);
console.log(`endpoint   : ${endpoint || "(空)"}`);

if (errors.length > 0) {
  console.error("\n❌ 发布前校验失败：");
  for (const e of errors) console.error(" - " + e);
  process.exit(1);
}
console.log("\n✅ 发布前校验通过");
