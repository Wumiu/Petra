//! Linux 代理发现：只读，不修改系统代理，不记录凭据。
//!
//! 优先级（从高到低）：
//!   1. 环境变量 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY（进程级，TUN/手动模式）
//!   2. GNOME 系统代理（gsettings 的 org.gnome.system.proxy，等价于
//!      「设置 → 网络 → 网络代理」）
//!   3. 无代理（返回 None，直连）
//!
//! 与 Windows / macOS 版一致：返回 updater（reqwest::Proxy::all）可接受的完整 URL
//! （缺 scheme 时补 http://）。遇到 PAC / 自动模式（mode=auto）时不实现 PAC 解释器，
//! 返回 None 走安全 fallback。
//!
//! 为什么只调 gsettings 命令行、不直接读 dconf 库：命令行工具在 GNOME 系发行版上一定存在，
//! 不必引入 glib/dconf 依赖；非 GNOME 桌面（KDE/XFCE…）没有这个 schema，
//! gsettings 会非零退出，自然退回环境变量或直连，不会误报代理。

use std::env;

/// 读取 updater 可用代理 URL（http://host:port）。失败/无代理返回 None。
pub fn get_system_proxy() -> Option<String> {
    // 1) 进程环境变量（最高优先级，用户或 TUN 模式设置）
    //    这一段与 Windows / macOS 版逐字一致，保证三边行为相同。
    for key in ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"] {
        if let Some(v) = env::var(key)
            .or_else(|_| env::var(key.to_lowercase()))
            .ok()
            .and_then(|s| normalize_proxy_url(&s))
        {
            return Some(v);
        }
    }
    // 2) GNOME 系统代理
    gsettings_proxy()
}

/// 规范成 updater 可接受 URL：reqwest::Proxy::all 要求带 scheme。
fn normalize_proxy_url(raw: &str) -> Option<String> {
    let t = raw.trim();
    // 控制字符/内嵌 NUL 不可能是合法代理地址，宁可当作"没有代理"也不要拿坏串去连
    if t.is_empty() || t.chars().any(|c| c.is_control()) {
        return None;
    }
    if t.starts_with("http://") || t.starts_with("https://") || t.starts_with("socks5") {
        Some(t.to_string())
    } else {
        Some(format!("http://{t}"))
    }
}

/// 跑一条 gsettings get，成功返回去掉 GVariant 引号后的值。
/// gsettings 的字符串值是形如 'manual' / '127.0.0.1' 的 GVariant 文本，数值则不带引号。
fn gsettings_get(schema_key: &str) -> Option<String> {
    let out = std::process::Command::new("gsettings")
        .args(["get", schema_key])
        .output()
        .ok()?;
    if !out.status.success() {
        // schema 不存在（非 GNOME 桌面）或取值失败：当作"没有这一项"
        return None;
    }
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let value = raw.trim_matches('\'').to_string();
    if value.is_empty() || value == "@as []" {
        return None;
    }
    Some(value)
}

/// 从 GNOME 的 system.proxy 里取 http(s) 代理。
/// mode 只有 manual 才是"固定代理"；none 是直连，auto 是 PAC（脚本内容不在这里解释）。
fn gsettings_proxy() -> Option<String> {
    let mode = gsettings_get("org.gnome.system.proxy mode")?;
    if mode != "manual" {
        return None;
    }
    // HTTP 是主代理（大多数用户只填这一项），其次 HTTPS；SOCKS 不处理：
    // reqwest 的 http 代理无法表达 socks，宁可不返回也不要给一个连不通的地址。
    for schema in ["org.gnome.system.proxy.http", "org.gnome.system.proxy.https"] {
        let host = gsettings_get(&format!("{schema} host"));
        let port = gsettings_get(&format!("{schema} port"));
        if let (Some(host), Some(port)) = (host, port) {
            if let Some(url) = normalize_proxy_url(&format!("{host}:{port}")) {
                return Some(url);
            }
        }
    }
    None
}
