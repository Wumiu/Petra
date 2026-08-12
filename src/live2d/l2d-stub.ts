/**
 * Cubism 4 Core 占位。
 *
 * pixi-live2d-display 的 cubism4 入口在模块求值时会检查 window.Live2DCubismCore
 * （Cubism Core runtime，官方 wasm 文件），缺失则顶层 throw，拖垮整条 import 链。
 * 本模块在 import 链中先于 pixi-live2d-display 求值，预置占位让模块加载通过。
 *
 * 注意：
 *  - PSD 2.5D 模式完全不需要真 core（不会解析 .moc3），占位即可。
 *  - 标准 Live2D（model3.json）模式需要真 core：将官方 live2dcubismcore.min.js
 *    放入 public/vendor/ 并在 index.html 以 <script> 引入（本占位会在真 core
 *    存在时原样保留它）。
 */
(window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore ??= {};
