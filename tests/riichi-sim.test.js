/** 立直麻将整场模拟（机器人代打，校验不卡死 + 分数守恒 + 双向和牌）：npm run test:riichi */
const { RiichiGame } = require("./build/engine.js");
const R = require("./build/rules.js");
const T = require("./build/tiles.js");

const realSetTimeout = global.setTimeout;
// 立即执行所有 delay，跑得动整场比赛；看门狗仍用真实计时器
global.setTimeout = function (fn) { queueMicrotask(fn); return 0; };

const stats = { matches: 0, hands: 0, meWin: 0, petWin: 0, draw: 0, bad: 0, stuck: 0, riichiHands: 0, meTsumo: 0, meRon: 0 };
const N = 12;

function pickDiscard(game) {
  const p = game.players[0];
  const counts = T.countsOf(p.hand);
  const dora = new Set(game.doraIndicators.map(T.doraFromIndicator));
  let best = p.hand[0];
  let bestScore = -Infinity;
  const seen = new Set();
  for (let i = 0; i < p.hand.length; i++) {
    const t = p.hand[i];
    if (seen.has(t)) continue;
    seen.add(t);
    const rest = p.hand.filter(function (_, j) { return j !== i; });
    let sc = R.handPotential(rest) * 10 + R.isolationOf(t, counts) * 0.8;
    if (dora.has(t)) sc -= 5;
    if (rest.length === 13 - 3 * p.melds.length && R.tenpaiWaits(rest, p.melds.length, function () { return false; }).length > 0) sc += 6;
    if (sc > bestScore) { bestScore = sc; best = t; }
  }
  return p.hand.indexOf(best);
}

function runMatch(idx) {
  return new Promise(function (resolve) {
    const game = new RiichiGame();
    let guard = 0;
    let lastHandNo = 0;
    let done = false;
    let riichiSeen = false;
    game.onUpdate = function () {
      if (done) return;
      guard++;
      if (guard > 20000) { stats.stuck++; done = true; game.dispose(); resolve(); return; }
      const total = game.players[0].score + game.players[1].score + game.sticks * 1000;
      if (total !== 50000) stats.bad++;
      if (!riichiSeen && (game.players[0].riichi || game.players[1].riichi)) { riichiSeen = true; stats.riichiHands++; }

      if (game.phase === "ended") { if (!done) { done = true; stats.matches++; resolve(); } return; }
      if (game.phase === "handend") {
        if (game.handNo !== lastHandNo) {
          stats.hands++;
          lastHandNo = game.handNo;
          if (game.lastHandWinner === 0) stats.meWin++;
          else if (game.lastHandWinner === 1) stats.petWin++;
          else stats.draw++;
          riichiSeen = false;
        }
        realSetTimeout(function () { game.nextHand(); }, 0);
        return;
      }
      const p = game.pending;
      if (!p) return;
      if (p.kind === "turn") {
        if (p.options.indexOf("tsumo") >= 0) { stats.meTsumo++; game.tsumo(); return; }
        if (p.options.indexOf("ankan") >= 0 && Math.random() < 0.3) { game.ankan(); return; }
        if (p.options.indexOf("riichi") >= 0 && Math.random() < 0.6) game.declareRiichi();
        game.playTile(pickDiscard(game));
        return;
      }
      if (p.options.indexOf("ron") >= 0) { stats.meRon++; game.call("ron"); return; }
      if (p.options.indexOf("pon") >= 0 && Math.random() < 0.35) { game.call("pon"); return; }
      if (p.options.indexOf("kan") >= 0 && Math.random() < 0.3) { game.call("kan"); return; }
      game.call("pass");
    };
    game.newMatch();
    // 低起始分：快速跑到终局，覆盖结算/终局路径
    game.players[0].score = 4000;
    game.players[1].score = 46000;
  });
}

const watchdog = realSetTimeout(function () {
  console.log("SIM TIMEOUT after " + stats.matches + " matches");
  process.exit(3);
}, 60000);

(async function () {
  const t0 = Date.now();
  for (let i = 0; i < N; i++) await runMatch(i);
  realSetTimeout(function () {
    const ms = Date.now() - t0;
    console.log("sim: matches=" + stats.matches + "/" + N + " hands=" + stats.hands +
      " meWin=" + stats.meWin + " petWin=" + stats.petWin + " draw=" + stats.draw +
      " riichiHands=" + stats.riichiHands + " meTsumo=" + stats.meTsumo + " meRon=" + stats.meRon +
      " scoreErrors=" + stats.bad + " stuck=" + stats.stuck + " time=" + ms + "ms");
    const bad = stats.bad > 0 || stats.stuck > 0 || stats.matches < N || stats.meWin === 0 || stats.petWin === 0;
    process.exit(bad ? 1 : 0);
  }, 0);
})();