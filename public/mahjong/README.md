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
