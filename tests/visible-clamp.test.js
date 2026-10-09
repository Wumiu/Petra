/**
 * 浮层（语音设置 / 语音识别设置弹窗）要"钳进窗口可见区"的纯计算。
 *
 * 锁的场景：桌宠窗口固定 700×700，但可以贴到屏幕边缘（部分出屏）。弹窗按窗口居中时，
 * 出屏的那一半连弹窗一起看不见 —— 用户看到的就是"模型靠着屏幕一边时弹窗显示不全"。
 */
const path = require("node:path");
const v = require(path.join(__dirname, "build", "ui", "visible.js"));

let pass = 0;
let fail = 0;
function check(name, ok, extra = "") {
  if (ok) {
    pass++;
    console.log("PASS " + name);
  } else {
    fail++;
    console.log("FAIL " + name + (extra ? "  → " + extra : ""));
  }
}

const full = { left: 0, top: 0, right: 700, bottom: 700 };

// ---------- 全屏可见：不该乱动 ----------
check(
  "窗口完整在屏内时，居中弹窗原地不动",
  JSON.stringify(v.clampIntoRect({ left: 180, top: 300, width: 340, height: 200 }, full)) ===
    JSON.stringify({ left: 180, top: 300 }),
);

// ---------- 窗口右侧出屏：可见区只剩左边 350 ----------
const halfRight = { left: 0, top: 0, right: 350, bottom: 700 };
// 弹窗按窗口居中 = left 180，右边缘 520 > 350 → 必须往左推
const r1 = v.clampIntoRect({ left: 180, top: 300, width: 340, height: 200 }, halfRight);
check("右出屏：左边缘被推到可见区左侧留白内", r1.left === 8, `left=${r1.left}`);
check("右出屏：整体落在可见区内", r1.left + 340 <= 350, `右边缘=${r1.left + 340}`);

// ---------- 窗口左侧出屏：可见区只剩右边 350（窗口坐标 350~700） ----------
const halfLeft = { left: 350, top: 0, right: 700, bottom: 700 };
const r2 = v.clampIntoRect({ left: 180, top: 300, width: 340, height: 200 }, halfLeft);
check("左出屏：整体落在可见区内", r2.left >= 350 && r2.left + 340 <= 700, `left=${r2.left}`);
check("左出屏：左侧至少留出 margin", r2.left >= 350 + 8, `left=${r2.left}`);
// 可见区只剩 350 宽、弹窗 340 宽时，两边留白加起来只有 10px，做不到两边各 8——
// 所以先按可见区缩尺寸（fitSizeInRect），再夹位置，才是真机上走的路
const sizeL = v.fitSizeInRect(halfLeft);
const r2b = v.clampIntoRect({ left: 180, top: 300, width: sizeL.maxWidth, height: 200 }, halfLeft);
check(
  "左出屏：先缩到上限再夹，左右留白都够",
  r2b.left === 350 + 8 && r2b.left + sizeL.maxWidth <= 700 - 8,
  `left=${r2b.left} 右边缘=${r2b.left + sizeL.maxWidth}`,
);

// ---------- 上/下出屏 ----------
const topOut = { left: 0, top: 0, right: 700, bottom: 300 };
const r3 = v.clampIntoRect({ left: 100, top: 100, width: 340, height: 240 }, topOut);
check("下出屏：整体落在可见区内", r3.top + 240 <= 300, `下边缘=${r3.top + 240}`);
check("下出屏：上边缘不小于留白", r3.top >= 8, `top=${r3.top}`);

// ---------- 可见区比弹窗还小：退化成贴左上角，且配合 fitSizeInRect 能缩到装得下 ----------
const tiny = { left: 0, top: 0, right: 200, bottom: 160 };
const size = v.fitSizeInRect(tiny);
check("超小可见区：给出尺寸上限", size.maxWidth === 184 && size.maxHeight === 144, JSON.stringify(size));
const shrunk = v.clampIntoRect({ left: 0, top: 0, width: size.maxWidth, height: size.maxHeight }, tiny);
check("超小可见区：缩到上限后正好完全放得下", shrunk.left + size.maxWidth <= tiny.right && shrunk.top + size.maxHeight <= tiny.bottom, JSON.stringify(shrunk));

// ---------- 尺寸上限永远为正（可见区为 0 之类的退化输入也不出负数） ----------
const empty = { left: 0, top: 0, right: 0, bottom: 0 };
const size2 = v.fitSizeInRect(empty);
check("退化可见区：上限不为负", size2.maxWidth > 0 && size2.maxHeight > 0, JSON.stringify(size2));

console.log(`\nvisible-clamp: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
