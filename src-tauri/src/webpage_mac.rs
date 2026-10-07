//! close_web_page（macOS）：让浏览器自己关掉匹配的标签页。
//!
//! mac 上没有 UI Automation，等价物是 AppleScript：Chrome 系（含 Edge / Brave /
//! Chromium）和 Safari 都支持 `close t`（t 是 tab 对象）——走的是浏览器自己的关闭
//! 逻辑，只影响这一个标签页，不会把整个窗口带走。
//!
//! 两个必须注意的点：
//!  1. **关键词以 argv 传给 osascript，绝不拼进脚本正文**。拼字符串的话，用户说
//!     "关掉那个 it's 页面"里的单引号就能改写脚本；走 argv 就没有这个问题。
//!  2. `tell application "X"` 在 X 没运行时**会把 X 启动起来**。所以脚本先用
//!     System Events 查进程在不在，不在就直接返回 none，绝不因为"关个页面"把
//!     浏览器拉起来。
//!
//! 需要"自动化"权限（系统设置 → 隐私与安全性 → 自动化）：首次调用时系统会弹窗，
//! 用户拒绝就会返回失败 —— 如实转述给用户即可。
//!
//! ⚠️ 本文件没有在真机（mac）上验证过：开发机是 Windows。逻辑与 Windows 版对齐
//! （先数一遍命中、恰好一个才关、多个就交回去问用户），mac 用户遇到问题请提 issue。

use serde::Serialize;
use std::process::Command;

use crate::log_line;

/// 关闭结果（与 Windows 版同形，前端两边通用）。
#[derive(Serialize, Default)]
pub struct ClosePageResult {
    pub success: bool,
    pub message: String,
    pub closed: Option<String>,
    pub candidates: Vec<String>,
}

impl ClosePageResult {
    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            success: false,
            message: message.into(),
            closed: None,
            candidates: Vec::new(),
        }
    }

    fn failed_with(message: impl Into<String>, candidates: Vec<String>) -> Self {
        Self {
            candidates,
            ..Self::failed(message)
        }
    }

    fn ok(closed: String, message: String) -> Self {
        Self {
            success: true,
            message,
            closed: Some(closed),
            candidates: Vec::new(),
        }
    }
}

/// 支持脚本关闭标签页的浏览器（AppleScript 里的应用名）。
const SCRIPTABLE_BROWSERS: &[&str] = &[
    "Google Chrome",
    "Microsoft Edge",
    "Brave Browser",
    "Chromium",
    "Safari",
];

/// 先数一遍命中，恰好一个才关；多个把标题回给模型。
/// 返回值：none / multi:标题|标题 / closed:标题 / error:原因
const CLOSE_SCRIPT: &str = r#"
on run argv
  set kw to item 1 of argv
  set appName to item 2 of argv
  tell application "System Events"
    if not (exists process appName) then return "none"
  end tell
  tell application appName
    set hits to {}
    repeat with w in windows
      repeat with t in tabs of w
        if ((title of t) contains kw) or ((URL of t) contains kw) then
          set end of hits to (title of t)
        end if
      end repeat
    end repeat
    if (count of hits) is 0 then return "none"
    if (count of hits) is greater than 1 then
      set AppleScript's text item delimiters to "|"
      return "multi:" & (hits as string)
    end if
    repeat with w in windows
      repeat with t in tabs of w
        if ((title of t) contains kw) or ((URL of t) contains kw) then
          set tTitle to (title of t)
          close t
          return "closed:" & tTitle
        end if
      end repeat
    end repeat
  end tell
  return "none"
end run
"#;

/// 关闭浏览器里匹配 `keyword` 的那个标签页。
pub fn close_web_page(keyword: &str) -> ClosePageResult {
    let key = keyword.trim();
    if key.chars().count() < 2 {
        return ClosePageResult::failed("要关闭的页面关键词太短，请说得具体一点（至少 2 个字）");
    }

    let mut all_hits: Vec<String> = Vec::new();

    for app in SCRIPTABLE_BROWSERS {
        let out = Command::new("osascript")
            .arg("-e")
            .arg(CLOSE_SCRIPT)
            // 关键词与应用名都走 argv：不拼进脚本文本，杜绝引号注入
            .arg(key)
            .arg(app)
            .output();

        let Ok(out) = out else {
            continue;
        };
        if !out.status.success() {
            // 用户没给"自动化"权限时 osascript 会以非 0 退出：继续试下一个浏览器，
            // 全都不行时下面会给出一句如实说明。
            continue;
        }
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        log_line(&format!("close_web_page(mac): {app} -> {text}"));

        if let Some(title) = text.strip_prefix("closed:") {
            let title = title.trim().to_string();
            return ClosePageResult::ok(
                title.clone(),
                format!("已关闭 {app} 里的页面「{title}」。其它标签页没动。"),
            );
        }
        if let Some(list) = text.strip_prefix("multi:") {
            for t in list.split('|').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                all_hits.push(t.to_string());
            }
        }
    }

    if all_hits.len() == 1 {
        // 理论上不会走到（只有一个命中时脚本自己就关了），留作兜底
        return ClosePageResult::failed_with(
            format!("找到了「{}」，但浏览器没有关掉它，请手动确认", all_hits[0]),
            all_hits,
        );
    }
    if all_hits.len() > 1 {
        return ClosePageResult::failed_with(
            format!(
                "同时有 {} 个页面匹配「{key}」，不能猜着关：{}。请先问用户要关哪一个。",
                all_hits.len(),
                all_hits.join("、")
            ),
            all_hits,
        );
    }
    ClosePageResult::failed(format!(
        "没有找到匹配「{key}」的页面（也可能需要在「系统设置 → 隐私与安全性 → 自动化」里允许 Petra 控制浏览器）"
    ))
}
