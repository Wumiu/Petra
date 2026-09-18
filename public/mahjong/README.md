# Petra 立直麻将牌面资源

牌面采用 [FluffyStuff/riichi-mahjong-tiles](https://github.com/FluffyStuff/riichi-mahjong-tiles) 的 `Regular` SVG 牌组，
固定到上游 commit `26e127ba2117f45cdce5ea0225748cc0cfad3169`。
上游明确将全部素材置于 Public Domain（CC0）；许可证原文保存在
`LICENSE-FluffyStuff.md`。

- 万子使用传统汉字“一萬”至“九萬”；
- 筒子、索子、一索鸟、四风牌、三元牌与日式白板均沿用统一传统构图；
- 所有 SVG 采用同一画布、内边距和比例；
- 手牌、摸入牌、牌河、副露、宝牌指示牌和牌山牌背使用同一映射。

当前双人房规未启用赤五；资源中保留三种赤五牌面，但规则启用前不会加入牌组。

工具栏图标采用 [lucide-icons/lucide](https://github.com/lucide-icons/lucide) 的
`sparkles`、`message-circle`、`rotate-ccw`、`x`，固定到上游 commit
`076b52527f0c5fe4cc1cd2472ef716fc332ccf0e`。为继承界面颜色，仅将原始路径内嵌到
`src/games/riichi/icons.ts`，未修改图形；许可证见 `LICENSE-Lucide.txt`。

## 月夜主题素材

以下素材由项目用户于 2026-09-18 提供，运行时全部从 `public/mahjong/theme/`
本地加载，不使用远程热链：

| 本地文件 | 用户附件 | 处理记录 |
| --- | --- | --- |
| `table-felt.png` | `codex-clipboard-10b4353f-a19d-4819-b311-5af0a709018d.png` | `1254×1254` 缩至 `1024×1024`，作为独立低透明度毛毡层 |
| `moon-emblem.png` | `codex-clipboard-42f33c72-f182-4cc4-b7f2-303e69cf46f6.png` | 清理 Alpha≤16 的边缘噪点，按有效内容留 24px 安全边距后缩至 `256×256` |
| `result-ornament.png` | `codex-clipboard-f297b875-a333-4dd3-8428-0c6ad31dc345.png` | 保留原透明通道，清理低 Alpha 画布噪点并裁切右下角装饰，缩至 `384×440` |
| `tile-back.png` | `codex-clipboard-6ebf76d2-2923-4e43-a110-0601732ee596.png` | 保持原比例与完整绘制边框，缩至 `256×382` |
| `room-background.png` | `codex-clipboard-7671e8de-48b4-435f-aabc-9668a390e19e.png` | 保持 `1024×687` 原比例，仅进行 PNG 无损优化 |

主题图片只承担背景、材质、牌背与结算装饰；牌体、面板、边框、按钮和文字样式仍由代码实现。

## 番符与双人支付口径

番、符、庄闲倍率及满贯以上上限参考 World Riichi Championship 的
[WRC Rules 2022](https://www.worldriichi.org/s/WRC_Rules_2022_20220708_site.pdf)
第 11 章。采用 1920 基本点切上满贯；13 番以上普通役仍为三倍满，不采用累计役满。

Petra 保留既有双人房规：先按庄家 6 倍／闲家 4 倍基本点并进位到百点计算整笔手牌价值，
荣和或自摸均由唯一对手全额支付；这不是四人麻将的自摸三家分摊。立直供托归下一位和牌者，
流局时留在桌上。当前对局流程没有连庄和本场计数，因此结算明确显示“本场 0”，不会虚构本场奖励。

当前识别：立直、门前清自摸、断幺九、平和、役牌、一杯口／二杯口、三色同顺、
一气通贯、对对和、三暗刻、三杠子、三色同刻、小三元、混老头、混全带幺九、
纯全带幺九、混一色、清一色、七对子、岭上开花、海底摸月、河底捞鱼，以及国士无双、
四暗刻、大三元、小四喜、大四喜、四杠子、字一色、清老头。符数包括底符、门清荣和、
自摸、役牌／连风雀头、等待形、明暗刻杠和幺九区别；七对子固定 25 符，平和自摸 20 符。

仍未支持：振听、一发、里宝牌、赤牌、抢杠、双立直、天和／地和、九莲宝灯、绿一色、
责任支付及本场／连庄。宝牌只加番，不能单独满足和牌所需的役。
