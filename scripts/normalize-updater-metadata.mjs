#!/usr/bin/env node
/**
 * normalize-updater-metadata.mjs
 *
 * 将 tauri-action 生成的 latest.json 归一化，保证旧版 updater 兼容：
 *   platforms["windows-x86_64"]  →  强制指向 NSIS setup.exe（与 -nsis 完全一致）
 *
 * 背景：Petra v0.1.5 legacy updater 固定读取 platforms["windows-x86_64"].url，
 * 并把下载内容当作 .exe 直接 spawn。Tauri 默认生成的 windows-x86_64 指向 MSI，
 * 会导致旧客户端无法自动迁移。因此统一把 windows-x86_64 指向 NSIS。
 *
 * 用法：
 *   node scripts/normalize-updater-metadata.mjs <input.json> [output.json]
 *   无 output 时原地覆写 input.json。
 *
 * 不硬编码版本号 / URL / signature，全部从输入 JSON 动态复制。
 */
import fs from "node:fs";

const input = process.argv[2];
const output = process.argv[3] || input;
if (!input) {
  console.error("用法: node scripts/normalize-updater-metadata.mjs <input.json> [output.json]");
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(input, "utf8"));
const platforms = manifest.platforms;
if (!platforms || typeof platforms !== "object") {
  console.error("latest.json 缺少 platforms 字段，无法归一化");
  process.exit(1);
}

// NSIS 条目（windows-x86_64-nsis）作为权威来源
const nsis = platforms["windows-x86_64-nsis"];
if (!nsis || !nsis.url || !nsis.signature) {
  console.error("latest.json 缺少 windows-x86_64-nsis（url/signature），无法归一化");
  process.exit(1);
}

// 将通用 windows-x86_64 覆盖为 NSIS（旧版 updater 兼容）
platforms["windows-x86_64"] = {
  url: nsis.url,
  signature: nsis.signature,
};

fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n");
console.log(`归一化完成: windows-x86_64 → ${nsis.url}`);
console.log("  windows-x86_64-nsis → NSIS（保留）");
console.log(`  windows-x86_64-msi  → ${platforms["windows-x86_64-msi"]?.url ?? "(缺失)"}`);
