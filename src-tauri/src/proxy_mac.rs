//! macOS 代理发现：只读，不修改系统代理，不记录凭据。
//!
//! 优先级（从高到低）：
//!   1. 环境变量 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY（进程级，TUN/手动模式）
//!   2. macOS 系统网络代理（/usr/sbin/scutil --proxy，
//!      等价于「系统设置 → 网络 → 详细信息 → 代理」）
//!   3. 无代理（返回 None，直连）
//!
//! 返回 updater（reqwest::Proxy::all）可接受的完整 URL（默认补 http://）。
//! 检测到 PAC（ProxyAutoConfigEnable=1）时不实现解释器，返回 None 走安全 fallback。

use std::collections::HashMap;
use std::env;

/// 读取 updater 可用代理 URL（http://host:port）。失败/无代理返回 None。
pub fn get_system_proxy() -> Option<String> {
    // 1) 进程环境变量（最高优先级，用户或 TUN 模式设置）
    //    这一段与 Windows 版逐字一致，保证两边行为相同。
    for key in ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"] {
        if let Some(v) = env::var(key)
            .or_else(|_| env::var(key.to_lowercase()))
            .ok()
            .and_then(|s| normalize_proxy_url(&s))
        {
            return Some(v);
        }
    }
    // 2) 系统网络代理
    scutil_proxy()
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

/// 把 scutil --proxy 的输出解析成 key → value。输出形如：
///
///     <dictionary> {
///       HTTPEnable : 1
///       HTTPPort : 7890
///       HTTPProxy : 127.0.0.1
///       HTTPSEnable : 1
///       HTTPSPort : 7890
///       HTTPSProxy : 127.0.0.1
///       ProxyAutoConfigEnable : 0
///     }
fn parse_scutil(text: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('<') || line == "}" {
            continue;
        }
        // 每个键值对只含一个冒号（值里不会有冒号：host / port / 0|1）
        if let Some((k, v)) = line.split_once(':') {
            map.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    map
}

/// 从系统代理设置里取 http(s) 代理。
/// 系统设置里 HTTP 是主代理（大多数客户端只配这一项），所以优先 HTTP，其次 HTTPS。
/// SOCKS 不在这里处理：reqwest 的 http 代理无法表达 socks，宁可不返回也不要给一个连不通的地址。
fn scutil_proxy() -> Option<String> {
    let out = std::process::Command::new("/usr/sbin/scutil")
        .arg("--proxy")
        .output()
        .or_else(|_| std::process::Command::new("scutil").arg("--proxy").output())
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let map = parse_scutil(&text);

    for (host_key, port_key, enable_key) in [
        ("HTTPProxy", "HTTPPort", "HTTPEnable"),
        ("HTTPSProxy", "HTTPSPort", "HTTPSEnable"),
    ] {
        // 缺 Enable 字段时按「启用」处理，避免个别系统版本少字段就完全不认代理
        let enabled = map.get(enable_key).map(|v| v == "1").unwrap_or(true);
        if !enabled {
            continue;
        }
        if let (Some(host), Some(port)) = (map.get(host_key), map.get(port_key)) {
            if let Some(url) = normalize_proxy_url(&format!("{host}:{port}")) {
                return Some(url);
            }
        }
    }
    None
}
