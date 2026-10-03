const assert = require("node:assert/strict");
const { infoPanelPlacement } = require("./build/ui/infoPanelPlacement.js");
const visible = { left: 0, top: 0, right: 700, bottom: 700 };
const model = { left: 200, top: 200, right: 500, bottom: 500 };
const hits = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
function verify(m, v, size, input) {
  const p = infoPanelPlacement(m, v, size, input);
  assert.ok(p, "有空闲空间时必须能显示面板");
  assert.ok(p.left >= v.left && p.right <= v.right && p.top >= v.top && p.bottom <= v.bottom, "面板不出可见区");
  assert.ok(!hits(p, m), "面板不盖住模型");
  if (input) assert.ok(!hits(p, input), "面板不盖住输入框");
  return p;
}
assert.equal(verify(model, visible, { width: 270, height: 200 }).width, 192, "默认大小收缩到侧面的 192px");
const nearRight = { left: 380, top: 180, right: 680, bottom: 480 };
assert.ok(verify(nearRight, visible, { width: 270, height: 200 }).right < nearRight.left, "靠右时翻到左侧");
verify(model, { left: 0, top: 400, right: 700, bottom: 700 }, { width: 270, height: 500 });
const wide = { left: 50, top: 180, right: 650, bottom: 480 };
const input = { left: 257, top: 490, right: 443, bottom: 550 };
assert.ok(verify(wide, visible, { width: 270, height: 200 }, input).bottom < wide.top, "两侧不足时放上方且避开输入框");
assert.equal(infoPanelPlacement({ left: 10, top: 10, right: 690, bottom: 690 }, visible, { width: 270, height: 200 }), null, "极限布局不强行覆盖模型");
// 不同模型大小、贴边程度及内容高度都应符合可见性/碰撞约束。
for (const width of [60, 180, 300, 450, 600]) {
  for (const left of [-40, 0, 180, 420, 650]) {
    for (const top of [-40, 0, 180, 420, 650]) {
      const m = { left, top, right: left + width, bottom: top + 180 };
      const p = infoPanelPlacement(m, visible, { width: 270, height: 500 }, input);
      if (p) {
        assert.ok(p.left >= 0 && p.right <= 700 && p.top >= 0 && p.bottom <= 700);
        assert.ok(!hits(p, m) && !hits(p, input));
      }
    }
  }
}
console.log("info-panel: all assertions passed");
