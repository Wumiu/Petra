# Petra 立直麻将基础音效

本目录的 10 个 WAV 文件全部由 Petra 项目脚本 `scripts/generate-riichi-sfx.mjs`
以数学波形、确定性伪随机噪声和包络程序合成，不包含第三方录音、商业游戏资源或角色语音。

- 来源：Petra 项目内原创程序合成
- 生成参数：单声道 PCM 16-bit，22050 Hz
- 许可：MIT，与 Petra 根目录 `LICENSE` 一致
- 处理：统一峰值、短淡入淡出、无前置静音；运行时再按用途设置相对响度
- 说明：这些是克制的拟音提示，并非真实麻将牌实录采样

重新生成：`node scripts/generate-riichi-sfx.mjs`

文件用途：

- `draw.wav`：摸牌滑动
- `discard-1.wav`～`discard-3.wav`：三种出牌落桌变化
- `pon.wav`：碰
- `kan.wav`：杠
- `riichi.wav`：立直棒确认
- `win.wav`：荣和／自摸
- `draw-end.wav`：流局
- `button.wav`：普通界面按钮
