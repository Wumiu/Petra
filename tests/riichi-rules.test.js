/** 立直麻将规则单元测试（Node，ASCII 输出）：npm run test:riichi */
const R = require("./build/rules.js");
const T = require("./build/tiles.js");

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + (extra !== undefined ? " -> " + JSON.stringify(extra) : "")); }
}
function win(closed, melds, tsumo, riichi, seat, winning, indicators) {
  return R.evaluateWin({
    closed: closed, melds: melds, tsumo: tsumo, riichi: riichi,
    seatWind: seat, roundWind: 27, doraIndicators: indicators || [], winningTile: winning,
  });
}
function has(w, name) { return !!w && w.yaku.some(function (y) { return y.name === name; }); }

// 1. 平和 + 断幺九
const h1 = T.sortTiles([1,2,3, 4,5,6, 11,12,13, 23,24,25, 16,16]);
ok("canWin detects 4 melds + pair", R.canWin(h1, 0) === true);
const w1 = win(h1, [], false, false, 28, 25);
ok("tanyao + pinfu = 2 han / 2000 pts", w1 && w1.han === 2 && w1.points === 2000, w1 && w1.yaku);

// 2. 立直加成
const w2 = win(h1, [], false, true, 28, 25);
ok("riichi + tanyao + pinfu = 3 han", w2 && w2.han === 3, w2 && w2.han);

// 3. 役牌（中）
const h3 = T.sortTiles([33,33,33, 1,2,3, 11,12,13, 23,24,25, 5,5]);
const w3 = win(h3, [], false, false, 28, 5);
ok("yakuhai (chun) = 1 han", w3 && w3.han === 1 && has(w3, "役牌"), w3 && w3.yaku);

// 4. 场风+自风双役牌（东刻子，东家）
const h4 = T.sortTiles([27,27,27, 1,2,3, 11,12,13, 23,24,25, 5,5]);
const w4 = win(h4, [], false, false, 27, 5);
ok("east triplet = 2 han yakuhai", w4 && w4.han === 2, w4 && w4.yaku);

// 5. 听牌判定
const h5 = T.sortTiles([1,2,3, 4,5,6, 11,12,13, 23,24,25, 16]);
const waits = R.tenpaiWaits(h5, 0, function () { return false; });
ok("tenpai waits exactly p8", waits.length === 1 && waits[0] === 16, waits);

// 6. 副露无役 -> null
const h6 = T.sortTiles([1,2,3, 11,12,13, 23,24,25, 16,16]);
const meld6 = [{ kind: "triplet", tiles: [0,0,0], open: true, from: 1 }];
const w6 = win(h6, meld6, false, false, 28, 24);
ok("open hand without yaku returns null", w6 === null, w6 && w6.yaku);

// 7. 宝牌计数
const w7 = win(h1, [], false, false, 28, 25, [15]);
ok("dora counted (two p8 in hand)", w7 && w7.doraCount === 2, w7 && { dora: w7.doraCount, han: w7.han });

// 8. 清一色（单骑听不计平和）
const h8 = T.sortTiles([0,1,2, 3,4,5, 6,7,8, 0,1,2, 4,4]);
const w8 = win(h8, [], false, false, 28, 4);
ok("chinitsu 6 han (tanki, no pinfu) => 9 han", has(w8, "清一色") && w8.han === 9, w8 && w8.yaku);

// 9. 对对和
const h9 = T.sortTiles([0,0,0, 5,5,5, 11,11,11, 23,23,23, 8,8]);
const w9 = win(h9, [], false, false, 28, 8);
ok("toitoi detected", has(w9, "对对和"), w9 && w9.yaku);

// 10. 副露后手牌长度约束
const meldPon = [{ kind: "triplet", tiles: [2,2,2], open: true, from: 1 }];
ok("10 tiles + pon is not a win", R.canWin(T.sortTiles([1,3,4, 11,12,13, 23,24,25, 5]), 1) === false);
ok("11 tiles + pon is a win", R.canWin(T.sortTiles([0,1,2, 3,4,5, 24,25,26, 19,19]), 1) === true);

// 11/12. 平和的两面听约束
const h11 = T.sortTiles([1,2,3, 4,5,6, 10,11,12, 23,24,25, 16,16]);
const w11 = win(h11, [], false, false, 28, 11);
ok("kanchan wait is not pinfu", w11 && !has(w11, "平和") && w11.han === 1, w11 && w11.yaku);
const w12 = win(h1, [], false, false, 28, 23);
ok("ryanmen wait is pinfu", has(w12, "平和"), w12 && w12.yaku);

console.log("");
console.log("rules: pass=" + pass + " fail=" + fail);
process.exit(fail > 0 ? 1 : 0);