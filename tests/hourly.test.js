/**
 * 整点播报纯逻辑测试：npm run test:hourly
 * - 时段划分与文案（含 12 小时制钟点）
 * - 免打扰区间（含跨零点、以及"关掉免打扰"的表达方式）
 * - 距下一个整点的毫秒数（正好在整点时不能返回 0，否则启动瞬间就播报）
 */
const H = require("./build/features/hourly/HourlyChime.js");

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + (extra !== undefined ? " -> " + JSON.stringify(extra) : "")); }
}

// ---------- 时段 ----------
ok("5 点属于清晨", H.dayPartOf(5) === "dawn");
ok("7 点属于清晨", H.dayPartOf(7) === "dawn");
ok("8 点属于上午", H.dayPartOf(8) === "morning");
ok("11 点属于上午", H.dayPartOf(11) === "morning");
ok("12 点属于中午", H.dayPartOf(12) === "noon");
ok("14 点属于下午", H.dayPartOf(14) === "afternoon");
ok("18 点属于傍晚", H.dayPartOf(18) === "evening");
ok("22 点属于夜里", H.dayPartOf(22) === "night");
ok("0 点属于凌晨", H.dayPartOf(0) === "latenight");
ok("4 点属于凌晨", H.dayPartOf(4) === "latenight");

// ---------- 钟点与文案 ----------
ok("0 点读作 12 点", H.clockHour(0) === 12);
ok("13 点读作 1 点", H.clockHour(13) === 1);
ok("12 点读作 12 点", H.clockHour(12) === 12);
const line9 = H.chimeLine(9, () => 0);
ok("上午 9 点文案含钟点", line9.includes("9 点"), line9);
ok("文案不含占位符", !line9.includes("{h}"), line9);
const line0 = H.chimeLine(0, () => 0);
ok("0 点文案读作 12 点", line0.includes("12 点"), line0);
const all = [];
for (let h = 0; h < 24; h++) all.push(H.chimeLine(h, () => 0));
ok("24 个整点都有文案", all.every((s) => s && s.length > 3 && /\d/.test(s)), all.filter((s) => !s || s.length <= 3));
ok("同一时段有两句备选", H.chimeLine(9, () => 0) !== H.chimeLine(9, () => 0.999), [H.chimeLine(9, () => 0), H.chimeLine(9, () => 0.999)]);
ok("rand 越界也不崩", typeof H.chimeLine(9, () => 1.5) === "string" && typeof H.chimeLine(9, () => -1) === "string");

// ---------- 免打扰 ----------
ok("默认 23 点免打扰", H.isQuietHour(23) === true);
ok("默认 7 点免打扰", H.isQuietHour(7) === true);
ok("默认 0 点免打扰", H.isQuietHour(0) === true);
ok("默认 8 点已恢复", H.isQuietHour(8) === false);
ok("默认 22 点未静音", H.isQuietHour(22) === false);
ok("quietStart==quietEnd 表示不静音", H.isQuietHour(3, { quietStart: 0, quietEnd: 0 }) === false);
ok("自定义区间生效", H.isQuietHour(13, { quietStart: 12, quietEnd: 14 }) === true);
ok("自定义区间边界", H.isQuietHour(14, { quietStart: 12, quietEnd: 14 }) === false);

// ---------- 上下调时（面板里的左右两个控件）----------
ok("小时归一：24 → 0", H.normalizeHour(24) === 0);
ok("小时归一：-1 → 23", H.normalizeHour(-1) === 23);
ok("小时归一：四舍五入", H.normalizeHour(23.6) === 0 && H.normalizeHour(8.2) === 8);
ok("小时归一：非法值 → 0", H.normalizeHour(Number.NaN) === 0);
ok("往上越过 23 回到 0", H.stepHour(23, 1) === 0);
ok("往下越过 0 回到 23", H.stepHour(0, -1) === 23);
ok("普通步进", H.stepHour(8, 2) === 10 && H.stepHour(8, -3) === 5);
ok("区间文案", H.formatQuietRange(23, 8) === "23:00 – 08:00", H.formatQuietRange(23, 8));
ok("区间文案补零", H.formatQuietRange(9, 5) === "09:00 – 05:00", H.formatQuietRange(9, 5));
ok("紧凑文案（菜单用）", H.formatQuietRange(23, 8, true) === "23→08", H.formatQuietRange(23, 8, true));

// 用户在面板里设的时段要能正确判定（含跨零点 / 起止相同）
ok("自定义 0→6 只在凌晨静音", H.isQuietHour(3, { quietStart: 0, quietEnd: 6 }) === true && H.isQuietHour(7, { quietStart: 0, quietEnd: 6 }) === false);
ok("自定义 22→23 只在 22 点静音", H.isQuietHour(22, { quietStart: 22, quietEnd: 23 }) === true && H.isQuietHour(23, { quietStart: 22, quietEnd: 23 }) === false);
ok("起止相同 = 不静音", H.isQuietHour(3, { quietStart: 8, quietEnd: 8 }) === false);

// ---------- 距下一个整点 ----------
const at = (h, m, s, ms) => new Date(2026, 0, 1, h, m, s, ms);
ok("正好整点 → 一小时后", H.msUntilNextHour(at(10, 0, 0, 0)) === 3600000, H.msUntilNextHour(at(10, 0, 0, 0)));
ok("10:59:30 → 30 秒", H.msUntilNextHour(at(10, 59, 30, 0)) === 30000, H.msUntilNextHour(at(10, 59, 30, 0)));
ok("10:30:00.500 → 29 分 59.5 秒", H.msUntilNextHour(at(10, 30, 0, 500)) === 1799500, H.msUntilNextHour(at(10, 30, 0, 500)));
ok("23:59:59 → 1 秒", H.msUntilNextHour(at(23, 59, 59, 0)) === 1000, H.msUntilNextHour(at(23, 59, 59, 0)));

console.log("");
console.log("hourly: pass=" + pass + " fail=" + fail);
process.exit(fail > 0 ? 1 : 0);
