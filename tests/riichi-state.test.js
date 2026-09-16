/** 牌山、王牌区、立直河牌与鸣牌状态回归。 */
const { RiichiGame } = require("./build/engine.js");
const A = require("./build/tileAssets.js");

let pass = 0;
let fail = 0;
function ok(name, condition, detail) {
  if (condition) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + " -> " + JSON.stringify(detail)); }
}

const game = new RiichiGame();
game.onUpdate = function () {};
game.newMatch();

ok("dead wall keeps 14 tiles", game.deadWall.length === 14, game.deadWall.length);
ok("initial dora comes from dead wall indicator slot", game.doraIndicators[0] === game.deadWall[4], {
  indicator: game.doraIndicators[0], dead: game.deadWall[4],
});
ok("136 tiles remain accounted for after dealer draw", game.wall.length + game.deadWall.length + game.players[0].hand.length + game.players[1].hand.length === 136, {
  wall: game.wall.length, dead: game.deadWall.length, me: game.players[0].hand.length, pet: game.players[1].hand.length,
});

const faces = Array.from({ length: 34 }, function (_, tile) { return A.tileFaceSrc(tile); });
ok("all 34 tile kinds have unique SVG image resources", faces.every(function (src) { return src.startsWith("data:image/svg+xml"); }) && new Set(faces).size === 34, new Set(faces).size);
ok("red-five artwork is mapped separately without enabling it in the wall", [4, 13, 22].every(function (tile) { return A.tileFaceSrc(tile, true) !== A.tileFaceSrc(tile, false); }), null);

const privacyGame = new RiichiGame();
privacyGame.players[0].hand = [1,2,3, 4,5,6, 11,12,13, 23,24,25, 16];
privacyGame.players[1].hand = [16,16,16,16];
privacyGame.doraIndicators = [];
ok("wait hint never reads opponent concealed tiles", privacyGame.waitsHint(0).includes(16), privacyGame.waitsHint(0));

// Private engine operations still exist at runtime; call them directly to make a deterministic state fixture.
const riverGame = new RiichiGame();
riverGame.players[0].hand = [4, 6, 7];
riverGame.players[1].hand = [4, 4, 9];
riverGame.players[0].score = 25000;
riverGame.players[1].score = 25000;
riverGame.applyDiscard(0, 4, true);
ok("riichi declaration tile is recorded horizontally", riverGame.players[0].river.length === 1 && riverGame.players[0].river[0].riichi, riverGame.players[0].river);
riverGame.applyCall(1, "pon", 4);
ok("called discard keeps ordered river slot", riverGame.players[0].river[0].called === true, riverGame.players[0].river);
ok("called tile moves out of visible discard list into meld", riverGame.players[0].discards.length === 0 && riverGame.players[1].melds[0].tiles.length === 3, {
  discards: riverGame.players[0].discards, melds: riverGame.players[1].melds,
});

console.log("");
console.log("state: pass=" + pass + " fail=" + fail);
process.exit(fail > 0 ? 1 : 0);
