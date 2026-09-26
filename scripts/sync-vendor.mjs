/**
 * 把 src/vendor/anime2dr/*.js 同步到 public/vendor/anime2dr/*.js。
 *
 * 背景：index.html 用的是 <script src="/vendor/anime2dr/rigger.js">，也就是**public/** 下的副本；
 * 而开发时改的是 src/vendor/ 下的同名文件 —— 两份副本曾经长期不一致，
 * 结果"更新内核"的改动一次都没进到应用里（排查了很久）。
 * 现在以 src/vendor 为唯一编辑点，dev/build 前自动同步，避免再次踩坑。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src", "vendor", "anime2dr");
const dstDir = join(root, "public", "vendor", "anime2dr");

if (!existsSync(srcDir)) {
  console.error("[sync-vendor] 找不到源目录:", srcDir);
  process.exit(1);
}
mkdirSync(dstDir, { recursive: true });

let copied = 0;
for (const name of readdirSync(srcDir)) {
  if (!name.endsWith(".js")) continue; // 只同步运行时脚本；ambient.d.ts 只给 TS 用
  const from = join(srcDir, name);
  const to = join(dstDir, name);
  const same = existsSync(to) && readFileSync(from).equals(readFileSync(to));
  if (!same) {
    copyFileSync(from, to);
    console.log("[sync-vendor] 已同步", name);
    copied++;
  }
}
console.log(copied ? `[sync-vendor] 完成，更新 ${copied} 个文件` : "[sync-vendor] 已是最新，无需同步");
