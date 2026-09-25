import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      // 忽略 Rust 编译产物：Vite 监视器若去 watch target 里正在编译的 exe，会报 EBUSY 崩溃
      ignored: ["**/src-tauri/target/**", "**/target/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM == "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    commonjsOptions: {
      include: [/node_modules/, /vendor[\\/]anime2dr/],
    },
  },
});