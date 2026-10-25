/**
 * 控制面板覆盖守卫：「原来右键菜单里的功能，面板上一个都不能少」。
 *
 * 三件事：
 *  1. 菜单里每个可点项（叶子）要么留在面板「动作」页的自动清单里，要么登记在 PANEL_MENU_COVERAGE；
 *     登记了就得在 index.html 里真的找得到那个控件（path:xxx / id:xxx），不许写个假锚点糊过去。
 *  2. 面板上每个按钮引用的功能 id，在桌宠侧必须真能执行（__data:/__sys:/__lyric:/… 都有处理分支）。
 *  3. PANEL_MENU_COVERAGE 里不许有菜单里已经不存在的僵尸条目。
 *
 * 为什么要有它：面板第一版把「模型设置/导入/调边框」塞进动作页按钮堆里被质疑过一次，
 * 后来精简右键菜单时又漏过置顶/开机自启/检查更新这几项 —— 靠人眼核对菜单树加面板是查不干净的。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

const mainSrc = fs.readFileSync('src/main.ts', 'utf8');
const htmlSrc = fs.readFileSync('src-tauri/panel/index.html', 'utf8');
const hourlySrc = fs.readFileSync('src/features/hourly/HourlyQuietRows.ts', 'utf8');

const sf = ts.createSourceFile('main.ts', mainSrc, ts.ScriptTarget.Latest, true);

function propsOf(obj) {
  const map = new Map();
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
      map.set(p.name.text, p.initializer);
    }
  }
  return map;
}

/** 收集某个函数体里所有「带 id 的对象字面量」，按有没有 submenu / onPick 分类 */
function collectMenuItems(source, fnName) {
  const leaves = new Map(); // id -> 行号
  const parents = new Set();
  source.forEachChild(function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text === fnName && node.body) {
      (function walk(n) {
        if (ts.isObjectLiteralExpression(n)) {
          const props = propsOf(n);
          const idNode = props.get('id');
          if (idNode && ts.isStringLiteral(idNode)) {
            const id = idNode.text;
            if (props.has('submenu')) parents.add(id);
            else if (props.has('onPick') || props.has('onStatePick')) leaves.set(id, id);
          }
        }
        ts.forEachChild(n, walk);
      })(node.body);
    }
    ts.forEachChild(node, visit);
  });
  return { leaves, parents };
}

const menu = collectMenuItems(sf, 'buildMenu');
// 整点播报免打扰那两行是另一个文件生成的（其中「时段」是行内控件，没有 onPick，不算功能项）
const hourlySf = ts.createSourceFile('HourlyQuietRows.ts', hourlySrc, ts.ScriptTarget.Latest, true);
for (const [id] of collectMenuItems(hourlySf, 'buildHourlyQuietMenuItems').leaves) menu.leaves.set(id, id);

/** 读 main.ts 里的一个 Set<string> 常量 */
function readStringSet(name) {
  let out = null;
  sf.forEachChild(function visit(node) {
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) {
          (function walk(n) {
            if (ts.isNewExpression(n) && n.arguments && n.arguments[0]) {
              for (const el of n.arguments[0].elements || []) if (ts.isStringLiteral(el)) (out ||= new Set()).add(el.text);
            }
            ts.forEachChild(n, walk);
          })(d.initializer);
        }
      }
    }
    ts.forEachChild(node, visit);
  });
  return out || new Set();
}

/** 读 main.ts 里的一个 Record<string,string> 常量 */
function readStringRecord(name) {
  const out = {};
  sf.forEachChild(function visit(node) {
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer && ts.isObjectLiteralExpression(d.initializer)) {
          for (const p of d.initializer.properties) {
            if (ts.isPropertyAssignment(p) && ts.isStringLiteral(p.initializer)) {
              const key = ts.isIdentifier(p.name) ? p.name.text : p.name.text;
              out[key] = p.initializer.text;
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  });
  return out;
}

const NATIVE = readStringSet('PANEL_NATIVE_IDS');
const COVERAGE = readStringRecord('PANEL_MENU_COVERAGE');

/** 跟 main.ts 的 panelCoverageOf 同一套规则：先用精确 id，再用 "mg-*" 这种前缀兜 */
const coverageOf = (id) => COVERAGE[id] ?? COVERAGE[id.replace(/-.*$/, '-*')];

// ---------- 1. 面板上的「位置」必须真的存在 ----------
const anchorFound = (anchor) => {
  const [kind, ...rest] = anchor.split(':');
  const value = rest.join(':');
  if (kind === 'path') return htmlSrc.includes(`path: "${value}"`);
  if (kind === 'id') {
    return htmlSrc.includes(`id: "${value}"`) ||
           htmlSrc.includes(`action: "${value}"`) ||
           htmlSrc.includes(`runAction("${value}"`) ||
           htmlSrc.includes(`runAction(\`${value}`);
  }
  if (kind === 'section') return htmlSrc.includes(`id: "${value}", label:`);
  throw new Error('未知锚点类型：' + anchor);
};

for (const [id, anchor] of Object.entries(COVERAGE)) {
  assert.ok(anchorFound(anchor), `菜单项 ${id} 登记的位置 ${anchor} 在 index.html 里找不到 —— 要么控件被删了，要么锚点写错了`);
}

// ---------- 2. 面板上引用的每个功能 id 都得能执行 ----------
const SECTION_IDS = new Set(['overview', 'look', 'interact', 'assistant', 'persona', 'voice', 'fun', 'perm', 'actions']);
const panelIds = [...new Set([...htmlSrc.matchAll(/\bid:\s*"([^"]+)"/g)].map((m) => m[1]))]
  .filter((id) => !SECTION_IDS.has(id));

for (const id of panelIds) {
  if (id.startsWith('__data:')) {
    const kind = id.slice('__data:'.length);
    assert.ok(mainSrc.includes(`case "${kind}":`), `面板按钮 ${id} 在 handlePanelDataAction 里没有处理分支`);
  } else if (id.startsWith('__sys:')) {
    assert.ok(mainSrc.includes(`"${id}"`), `面板按钮 ${id} 在 runPanelAction 里没有分支`);
  } else if (id.startsWith('__lyric:')) {
    assert.ok(mainSrc.includes('"__lyric:"'), '歌词微调的分支不见了');
  } else if (id === '__selfcheck') {
    assert.ok(mainSrc.includes('"__selfcheck"'), '功能自检的入口不见了');
  } else if (/^__(model|key|preset):/.test(id)) {
    assert.ok(mainSrc.includes(`"${id.split(':')[0]}:"`), `面板按钮 ${id} 的伪动作前缀没有处理分支`);
  } else {
    assert.ok(menu.leaves.has(id), `面板按钮 ${id} 在 buildMenu 里找不到对应菜单项（点了会只弹"没找到这个功能"）`);
  }
  // 子菜单父行点了没反应，绝不能当按钮用（曾经「按歌微调时间轴」就是这么坏的）
  assert.ok(!menu.parents.has(id), `面板按钮 ${id} 是个子菜单父行，没有 onPick，点了不会有任何反应`);
}

// ---------- 3. 覆盖清单不许漏、也不许有僵尸 ----------
for (const id of menu.leaves.keys()) {
  const covered = coverageOf(id) || NATIVE.has(id);
  assert.ok(covered, `菜单项 ${id} 既没在面板上有原生控件，也没在 PANEL_MENU_COVERAGE 里登记`);
}
for (const id of Object.keys(COVERAGE)) {
  if (id.endsWith('*')) continue; // 通配（mg-*）
  assert.ok(menu.leaves.has(id), `PANEL_MENU_COVERAGE 里的 ${id} 在菜单里已经不存在了，删掉它`);
}

console.log(`panel-coverage: ${menu.leaves.size} 个菜单项全部有落点，${panelIds.length} 个面板按钮全部可执行`);
