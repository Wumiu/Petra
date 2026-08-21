//! updater 代理发现：只读，不修改系统代理，不记录凭据。
//!
//! 优先级（从高到低）：
//!   1. 环境变量 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY（进程级，TUN/手动模式）
//!   2. Windows WinINET 系统代理（Clash Verge / V2rayN 等 GUI 代理）
//!   3. 无代理（返回 None，直连）
//!
//! 返回 updater（reqwest::Proxy::all）可接受的完整 URL（默认补 http://）。
//! 检测到 PAC（AutoConfigURL）时不实现解释器，返回 None 走安全 fallback。

use std::env;

/// 读取 updater 可用代理 URL（http://host:port）。失败/无代理返回 None。
pub fn get_system_proxy() -> Option<String> {
    // 1) 进程环境变量（最高优先级，用户或 TUN 模式设置）
    for key in ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"] {
        if let Some(v) = env::var(key)
            .or_else(|_| env::var(key.to_lowercase()))
            .ok()
            .and_then(|s| normalize_proxy_url(&s))
        {
            return Some(v);
        }
    }
    // 2) WinINET 系统代理
    wininet_proxy()
}

/// 规范成 updater 可接受 URL：reqwest::Proxy::all 要求带 scheme。
fn normalize_proxy_url(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    if t.starts_with("http://") || t.starts_with("https://") || t.starts_with("socks5") {
        Some(t.to_string())
    } else {
        Some(format!("http://{t}"))
    }
}

/// 读 WinINET registry：ProxyEnable + ProxyServer（含 per-protocol 格式）。
fn wininet_proxy() -> Option<String> {
    use windows::Win32::Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
        REG_VALUE_TYPE,
    };

    const SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    let key_wide: Vec<u16> = SUBKEY.encode_utf16().chain(Some(0)).collect();
    let mut hkey: HKEY = HKEY::default();
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            windows::core::PCWSTR(key_wide.as_ptr()),
            0,
            KEY_READ,
            &mut hkey,
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    // 保证关闭句柄
    struct CloseOnDrop(HKEY);
    impl Drop for CloseOnDrop {
        fn drop(&mut self) {
            unsafe { let _ = RegCloseKey(self.0); }
        }
    }
    let _guard = CloseOnDrop(hkey);

    fn query_value(hkey: HKEY, name: &str) -> Option<Vec<u8>> {
        let name_wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        let mut typ: REG_VALUE_TYPE = REG_VALUE_TYPE(0);
        let mut size: u32 = 0;
        let status = unsafe {
            RegQueryValueExW(
                hkey,
                windows::core::PCWSTR(name_wide.as_ptr()),
                None,
                Some(&mut typ as *mut _),
                None,
                Some(&mut size),
            )
        };
        if status == ERROR_SUCCESS && size > 0 {
            let mut buf = vec![0u8; size as usize];
            let status2 = unsafe {
                RegQueryValueExW(
                    hkey,
                    windows::core::PCWSTR(name_wide.as_ptr()),
                    None,
                    Some(&mut typ as *mut _),
                    Some(buf.as_mut_ptr() as *mut u8),
                    Some(&mut size),
                )
            };
            if status2 == ERROR_SUCCESS || status2 == ERROR_MORE_DATA {
                return Some(buf);
            }
        }
        None
    }

    // ProxyEnable
    let enable_raw = query_value(hkey, "ProxyEnable");
    let enable = enable_raw.and_then(|b| {
        if b.len() >= 4 {
            Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        } else {
            None
        }
    });
    if enable != Some(1) {
        return None;
    }

    // PAC 不能直接交给 reqwest 解析，但不少客户端会同时写入 PAC 和
    // ProxyServer。此前只要检测到 PAC 就直接走直连，导致 GitHub 更新在
    // Clash/V2RayN 等 PAC 模式下必然失败。优先使用可用的静态代理；仅 PAC
    // 且没有 ProxyServer 时才退回系统直连。
    let server = query_value(hkey, "ProxyServer")
        .map(|raw| String::from_utf8_lossy(&raw).trim_end_matches('\0').trim().to_string())
        .unwrap_or_default();
    if !server.is_empty() {
        return parse_proxy_server(&server);
    }
    None
}

/// 解析 ProxyServer：`host:port` 或 `http=host:port;https=host:port`。
fn parse_proxy_server(server: &str) -> Option<String> {
    if server.contains('=') {
        // per-protocol 格式：优先 https=，否则 http=
        let mut https: Option<&str> = None;
        let mut http: Option<&str> = None;
        for part in server.split(';') {
            let p = part.trim();
            if let Some(v) = p.strip_prefix("https=") {
                https = Some(v.trim());
            } else if let Some(v) = p.strip_prefix("http=") {
                http = Some(v.trim());
            }
        }
        let picked = https.or(http)?;
        normalize_proxy_url(picked)
    } else {
        normalize_proxy_url(server)
    }
}

// ---------- 单元测试 ----------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_adds_scheme() {
        assert_eq!(normalize_proxy_url("127.0.0.1:7897").as_deref(), Some("http://127.0.0.1:7897"));
        assert_eq!(normalize_proxy_url(" http://x:1 ").as_deref(), Some("http://x:1"));
        assert_eq!(normalize_proxy_url("  "), None);
    }

    #[test]
    fn parse_proxy_server_simple() {
        assert_eq!(parse_proxy_server("127.0.0.1:7897").as_deref(), Some("http://127.0.0.1:7897"));
    }

    #[test]
    fn parse_proxy_server_per_protocol() {
        assert_eq!(
            parse_proxy_server("http=127.0.0.1:7890;https=127.0.0.1:7891").as_deref(),
            Some("http://127.0.0.1:7891")
        );
        assert_eq!(
            parse_proxy_server("http=127.0.0.1:7890").as_deref(),
            Some("http://127.0.0.1:7890")
        );
    }
}
