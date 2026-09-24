import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    // 不监视 Rust 构建产物：target 里的 build_script_*.exe 编译时会被瞬间占用，
    // Vite 监视器一旦 watch 它就会抛 EBUSY。
    watch: {
      ignored: ["**/src-tauri/target/**"],
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