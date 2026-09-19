# Petra 麻将音频来源表

下载与核验日期：2026-09-19。所有正式资源均随项目本地分发，不在运行时访问外链。

| 游戏用途 | 本地文件 | 原始素材 / 作者 | 来源 | 许可 | 处理 |
| --- | --- | --- | --- | --- | --- |
| 摸牌 | `draw.ogg` | `chips-handle-3.ogg`，Kenney | [54 Casino sound effects](https://opengameart.org/content/54-casino-sound-effects-cards-dice-chips) | CC0 1.0；包内声明见 `LICENSE-Kenney-Casino.txt` | 原始 OGG，仅重命名 |
| 出牌变体 1～3 | `discard-1.wav`～`discard-3.wav` | `thwack-01.wav`～`thwack-03.wav`，Jordan Irwin / AntumDeluge | [Thwack Sounds 1.0](https://opengameart.org/content/thwack-sounds) | CC0 1.0；法律文本见 `LICENSE-CC0-1.0.txt` | 原始 PCM WAV，仅重命名 |
| 碰 | `pon.wav` | `thwack-05.wav`，Jordan Irwin / AntumDeluge | [Thwack Sounds 1.0](https://opengameart.org/content/thwack-sounds) | CC0 1.0 | 原始 PCM WAV，仅重命名 |
| 杠 | `kan.wav` | `thwack-08.wav`，Jordan Irwin / AntumDeluge | [Thwack Sounds 1.0](https://opengameart.org/content/thwack-sounds) | CC0 1.0 | 原始 PCM WAV，仅重命名 |
| 立直棒 | `riichi.ogg` | `chip-lay-2.ogg`，Kenney | [54 Casino sound effects](https://opengameart.org/content/54-casino-sound-effects-cards-dice-chips) | CC0 1.0 | 原始 OGG，仅重命名 |
| 普通按钮 | `button.ogg` | `click_002.ogg`，Kenney | [Interface Sounds 1.0](https://kenney.nl/assets/interface-sounds) | CC0 1.0；包内声明见 `LICENSE-Kenney-Interface.txt` | 原始 OGG，仅重命名 |
| 对局 BGM | `bgm.ogg` | *Forget Me Not*（looped），Kistol | [OpenGameArt 原始页面](https://opengameart.org/content/forget-me-not) | CC0 1.0 / Public Domain | 使用作者提供的循环版 OGG，未转码 |
| 玩家胜利 | `result-victory.ogg` | *Win Jingle* (`winfretless.ogg`)，Fupi | [OpenGameArt 原始页面](https://opengameart.org/content/win-jingle) | CC0 1.0 | 原始 OGG，仅重命名 |
| 玩家失败 | `result-defeat.ogg` | *Game Over Sad Short Music Clips* (`sadending1.ogg`)，Robin Lamb | [OpenGameArt 原始页面](https://opengameart.org/content/game-over-sad-short-music-clips) | CC0 1.0 | 原始 OGG，仅重命名 |
| 流局 | `result-draw.ogg` | `confirmation_004.ogg`，Kenney | [Interface Sounds 1.0](https://kenney.nl/assets/interface-sounds) | CC0 1.0 | 原始 OGG，仅重命名 |

## 筛选说明

- 首先检查了 GitHub 上的 `riichinomics/autotable`（核验 commit `85d7206098059ad88bb92ceac4c19a8d1fb92f74`）。该项目确实把 `Thwack Sounds` 的 `thwack-02.wav` 用作麻将出牌声，并明确列出声音来自上述两个 OpenGameArt CC0 包；Petra 最终从原作者页面下载原包，而不是复制来源不明的游戏资源。
- 没有找到许可与录音来源都足够明确的陶瓷麻将牌专用采样。因此操作音采用许可清楚的真实硬质物件撞击录音（Thwack）与赌场筹码拿取／落桌声（Kenney），不宣称它们是麻将牌原声。
- 检查但未采用：OpenRiichi（仓库 GPLv3，但音频素材的逐项授权范围不够清楚）；*Strange Moon*（CC-BY 4.0 且循环源文件过大）；*Lofi Hip Hop Loop*（节拍感偏强）；Kistol 的 *Game Over*（作者自己描述为“过度悲剧化”，不符合温和失败反馈）。
- 本轮没有使用振荡器、噪声生成、程序作曲或 AI 生成音频。上一轮程序合成 WAV 与生成脚本已移除。
