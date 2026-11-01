//! 内置联网搜索（无需任何 API Key）。
//!
//! 走 DuckDuckGo 的 html 版结果页，解析出「标题 / 链接 / 摘要」直接回给模型，
//! 模型拿到的是真实网页文本，而不是"帮你打开了一个浏览器"。
//! 走 Rust 侧发起请求：WebView 里 fetch 会被 CORS 挡住，也拿不到别的域的 HTML。

use std::time::Duration;

#[derive(serde::Serialize)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

const UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// 内置搜索：返回前 `limit` 条结果（默认 5，最多 10）。
/// 失败原因原样带回前端，由模型决定是换个说法再搜还是直接告诉用户。
#[tauri::command]
pub async fn web_search(query: String, limit: Option<usize>) -> Result<Vec<SearchHit>, String> {
    tauri::async_runtime::spawn_blocking(move || search_blocking(&query, limit))
        .await
        .map_err(|e| format!("搜索任务异常：{e}"))?
}

fn search_blocking(query: &str, limit: Option<usize>) -> Result<Vec<SearchHit>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("搜索词是空的".into());
    }
    let limit = limit.unwrap_or(5).clamp(1, 10);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(UA)
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))?;
    let url = format!("https://html.duckduckgo.com/html/?q={}", percent_encode(q));
    let html = client
        .get(url)
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("搜索请求失败：{e}"))?
        .text()
        .map_err(|e| format!("读取搜索结果失败：{e}"))?;
    let hits = parse_ddg(&html, limit);
    if hits.is_empty() {
        return Err("没解析到搜索结果（可能被搜索引擎限流，或网络无法访问）".into());
    }
    Ok(hits)
}

fn parse_ddg(html: &str, limit: usize) -> Vec<SearchHit> {
    let mut hits: Vec<SearchHit> = Vec::new();
    let mut cursor = 0usize;
    while hits.len() < limit && cursor < html.len() {
        let Some(rel) = html[cursor..].find("class=\"result__a\"") else {
            break;
        };
        let pos = cursor + rel;
        let Some(tag_start) = html[..pos].rfind('<') else {
            break;
        };
        let Some(gt) = html[pos..].find('>') else {
            break;
        };
        let tag_end = pos + gt;
        let tag = &html[tag_start..=tag_end];
        let href = attr_value(tag, "href").unwrap_or_default();
        let title_end = html[tag_end + 1..]
            .find("</a>")
            .map(|i| tag_end + 1 + i)
            .unwrap_or(html.len());
        let title = clean_text(&html[tag_end + 1..title_end]);
        cursor = title_end.min(html.len());

        let mut snippet = String::new();
        if let Some(sp_rel) = html[cursor..].find("class=\"result__snippet\"") {
            let sp = cursor + sp_rel;
            let s_tag_end = html[sp..].find('>').map(|i| sp + i).unwrap_or(sp);
            let s_end = html[s_tag_end..]
                .find("</a>")
                .map(|i| s_tag_end + i)
                .or_else(|| html[s_tag_end..].find("</div>").map(|i| s_tag_end + i))
                .unwrap_or(html.len());
            snippet = clean_text(&html[s_tag_end + 1..s_end]);
            cursor = s_end.min(html.len());
        }

        let url = decode_ddg_href(&href);
        if !title.is_empty() && !url.is_empty() {
            hits.push(SearchHit { title, url, snippet });
        }
    }
    hits
}

fn attr_value(tag: &str, name: &str) -> Option<String> {
    let pat = format!("{name}=\"");
    let start = tag.find(&pat)? + pat.len();
    let end = tag[start..].find('"')? + start;
    Some(tag[start..end].to_string())
}

/// DDG 的链接是跳转形式：//duckduckgo.com/l/?uddg=<百分号编码的真实地址>&rut=…
fn decode_ddg_href(href: &str) -> String {
    let h = href.trim();
    if let Some(idx) = h.find("uddg=") {
        let rest = &h[idx + 5..];
        let raw = rest.split('&').next().unwrap_or(rest);
        let decoded = percent_decode(raw);
        if decoded.starts_with("http") {
            return decoded;
        }
    }
    if let Some(stripped) = h.strip_prefix("//") {
        return format!("https://{stripped}");
    }
    h.to_string()
}

fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    for b in input.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = &input[i + 1..i + 3];
                match u8::from_str_radix(hex, 16) {
                    Ok(v) => {
                        out.push(v);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// 去标签 + 解实体 + 压空白：搜索结果里的摘要常带 <b> 高亮和 &amp;
fn clean_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    let unescaped = unescape_entities(&out);
    unescaped.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn unescape_entities(input: &str) -> String {
    input
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("&#x2F;", "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"
<div class="links_main links_deep result__body">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&amp;rut=abc">标题 &amp; 实体</a>
  </h2>
  <a class="result__snippet" href="//x">摘要 <b>高亮</b> 文本</a>
</div>
<div class="links_main links_deep result__body">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="https://plain.example.org/p">第二条</a>
  </h2>
  <a class="result__snippet" href="//y">第二条摘要</a>
</div>
"#;

    #[test]
    fn parses_two_results() {
        let hits = parse_ddg(FIXTURE, 5);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].title, "标题 & 实体");
        assert_eq!(hits[0].url, "https://example.com/a?b=1");
        assert_eq!(hits[0].snippet, "摘要 高亮 文本");
        assert_eq!(hits[1].url, "https://plain.example.org/p");
        assert_eq!(hits[1].snippet, "第二条摘要");
    }

    #[test]
    fn respects_limit() {
        let hits = parse_ddg(FIXTURE, 1);
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn decodes_ddg_redirect_and_keeps_direct_url() {
        assert_eq!(
            decode_ddg_href("//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com%2Fb&rut=1"),
            "https://a.com/b"
        );
        assert_eq!(decode_ddg_href("https://a.com/b"), "https://a.com/b");
    }

    #[test]
    fn encodes_and_decodes_query() {
        assert_eq!(percent_encode("tauri 桌宠&x=1"), "tauri+%E6%A1%8C%E5%AE%A0%26x%3D1");
        assert_eq!(percent_decode("tauri+%E6%A1%8C"), "tauri 桌");
    }

    #[test]
    fn strips_tags_and_entities() {
        assert_eq!(
            clean_text("  <b>a</b>\n &amp;  b  "),
            "a & b"
        );
    }
}
