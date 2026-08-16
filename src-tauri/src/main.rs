#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebView2 直连，避免本地开发请求被系统代理（如 Clash）劫持。
    // 生产环境访问 tauri:// 协议不受影响。
    let mut args = String::from("--no-proxy-server");
    // dev 构建开启 CDP 远程调试（scripts/cdp-diag.mjs 用）
    if cfg!(debug_assertions) {
        args.push_str(" --remote-debugging-port=9222");
    }
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args);
    petra_lib::run()
}