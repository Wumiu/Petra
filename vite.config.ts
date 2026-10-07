import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    // 不监视 Rust 构建产物：target 里正在编译的 build_script_*.exe 会被瞬间占用，
    // Vite 监视器一旦 watch 到它就会抛 EBUSY（PR #3 与 #4 都提了这条，这里取并集）
    //
    // 后面两条是同一类问题的另一半：编辑器/工具的"原子写入"会在**源码目录里**留下
    // 瞬间存在、且写的时候被占用的临时产物 ——
    //   .<文件名>.<pid>.<guid>.tmpdir\<文件名>.tmp  （先写临时目录，再改名过去）
    //   <文件名>~RF<hex>.TMP                        （Windows ReplaceFileW 的备份文件）
    // 它们和真实源码同目录，dev 跑着的时候一旦被 watch 到就是 EBUSY，而 chokidar 的
    // error 会直接把 Vite（进而 beforeDevCommand → tauri dev）带崩。这两类名字不可能
    // 是源码，忽略掉没有副作用。
    watch: {
      ignored: [
        "**/src-tauri/target/**",
        "**/target/**",
        /\.tmpdir([\\/]|$)/,
        /~RF[0-9A-Fa-f]+\.TMP/i,
      ],
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
