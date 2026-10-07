//! close_web_page：关掉浏览器里用户指定的那个标签页（小助手"关网页"专用）。
//!
//! 为什么不直接对窗口发 WM_CLOSE：网页不是窗口，是浏览器窗口里的一个**标签页**。
//! 对着窗口发 WM_CLOSE 会把同一个窗口里其它标签页一起带走 —— 用户说"把那个 B站
//! 页面关了"，结果整个工作现场没了。所以这里走 UI Automation（读屏软件用的那套
//! 无障碍接口）：一个标签页是一个 TabItem 控件，它下面那个"关闭标签页"按钮支持
//! Invoke，点它走的是浏览器自己的关闭逻辑，只影响这一个标签页。
//!
//! 已在 Edge（Chromium）上实测到的几条事实，代码里的取舍都基于它们：
//!  1. **不需要把浏览器切到前台**。后台标签页的关闭按钮同样能找到、同样能 Invoke，
//!     所以关网页不会抢走用户正在打字的焦点，也不会打断播放。
//!  2. Chromium 会把同一个元素在无障碍树里暴露好几份（实测 2 个标签页 = 14 个
//!     TabItem 元素），不去重就会把"匹配到多个"误报成歧义。
//!  3. 标签页的无障碍名会带 Chromium 自己追加的状态后缀（"- 内存使用率 - 219 MB"、
//!     "- 音频正在播放"），所以匹配用"包含"而不是"相等"。
//!  4. 关闭按钮的名字是**本地化**的（简中"关闭标签页"、英文 "Close tab"…），所以
//!     除了名字白名单，还有一条与语言无关的兜底：取标签页里最靠右的可 Invoke 按钮
//!     （Chromium 把关闭按钮放在标签页右端，静音图标在它左边）。
//!
//! 刻意不做的事：不批量关（一次只关一个）、不碰自己进程的窗口、匹配到多个就原样
//! 把候选交回去让 AI 反问用户，宁可不关也不猜。

use serde::Serialize;
use windows::core::VARIANT;
use windows::Win32::Foundation::{LPARAM, RECT, WPARAM};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationCondition, IUIAutomationElement,
    IUIAutomationElementArray, IUIAutomationInvokePattern, IUIAutomationSelectionItemPattern,
    IUIAutomationValuePattern, TreeScope_Children, TreeScope_Descendants,
    UIA_ButtonControlTypeId, UIA_ControlTypePropertyId, UIA_EditControlTypeId, UIA_InvokePatternId,
    UIA_SelectionItemPatternId, UIA_TabItemControlTypeId, UIA_ValuePatternId,
    UIA_WindowControlTypeId,
};
use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};

use crate::log_line;

/// 关闭结果：交给前端（也就是交给模型）的结构化结果。
#[derive(Serialize, Default)]
pub struct ClosePageResult {
    pub success: bool,
    /// 给模型看的一句话结论（失败时要说清为什么、下一步该问什么）
    pub message: String,
    /// 真的关掉的那个页面的标题
    pub closed: Option<String>,
    /// 没关成时列出候选（当前开着的标签页 / 同时匹配的页面），让 AI 能反问用户
    pub candidates: Vec<String>,
}

impl ClosePageResult {
    /// 失败结果。`pub` 是给 lib.rs 的命令入口兜底用的（spawn_blocking 出错时），
    /// mac / linux 模块也提供同名构造函数，三平台 API 一致。
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

/// 关闭按钮的（本地化）无障碍名。命中就优先用它；一个都认不出时走位置兜底。
/// 只做小写 contains 匹配，所以这里全部小写。
const CLOSE_BUTTON_NAMES: &[&str] = &[
    "关闭标签页",
    "关闭选项卡",
    "关闭",
    "close tab",
    "close",
    "タブを閉じる",
    "탭 닫기",
    "tab schließen",
    "fermer l'onglet",
    "cerrar pestaña",
    "chiudi scheda",
    "fechar guia",
    "закрыть вкладку",
];

/// 整窗兜底只对这些窗口类名生效。
///
/// PWA / 应用窗口（Chrome 的 --app 窗口）没有标签页栏，这种窗口里"关掉那个页面"
/// 就等于关掉这个窗口。但兜底必须是**白名单**：没有这一层，用户一句"关掉那个
/// 报表"就可能把 Word 文档窗口关掉 —— 那不是"关网页"该干的事。
const BROWSER_WINDOW_CLASSES: &[&str] = &[
    "chrome_widgetwin_1", // Chrome / Edge / Brave / Chromium 系 PWA
    "mozillawindowclass", // Firefox
    "ieframe",            // IE 内核外壳（部分国产浏览器）
];

/// 一个去重后的标签页。
struct TabInfo {
    title: String,
    selected: bool,
    close_button: Option<IUIAutomationElement>,
    /// 边界矩形：只用于去重（见 unique_tabs 的说明）
    rect: RECT,
}

/// 一条命中记录。
struct TabMatch {
    window_title: String,
    tab_title: String,
    close_button: Option<IUIAutomationElement>,
    /// true = 靠地址栏 URL 命中的（此时标签页标题里没有关键词）
    by_url: bool,
}

/// 关闭浏览器里匹配 `keyword` 的那个标签页。
pub fn close_web_page(keyword: &str) -> ClosePageResult {
    let key = normalize(keyword);
    // 单字关键词太容易误伤（"关"能命中一大堆页面），要求至少 2 个字符。
    if key.chars().count() < 2 {
        return ClosePageResult::failed("要关闭的页面关键词太短，请说得具体一点（至少 2 个字）");
    }

    // UIA 客户端在 MTA 下最省事（不用跨套间封送）。Tauri command 可能在任意线程
    // 执行，所以这里自己初始化、自己清理。RPC_E_CHANGED_MODE（本线程已用别的模式
    // 初始化过 COM）说明 COM 本来就可用了，这时**不能**再 CoUninitialize —— 多减
    // 一次引用计数会把别的模块（如 launch.rs 的快捷方式解析）的 COM 一起拆掉。
    let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let need_uninit = hr.is_ok();
    let result = close_web_page_inner(&key);
    if need_uninit {
        unsafe { CoUninitialize() };
    }
    log_line(&format!(
        "close_web_page: {} -> {}",
        keyword,
        if result.success { "ok" } else { "fail" }
    ));
    result
}

fn close_web_page_inner(key: &str) -> ClosePageResult {
    let uia: IUIAutomation =
        match unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) } {
            Ok(u) => u,
            Err(e) => {
                return ClosePageResult::failed(format!(
                    "初始化 UI Automation 失败：{e}。这台机器上可能禁用了无障碍接口"
                ))
            }
        };

    let root = match unsafe { uia.GetRootElement() } {
        Ok(r) => r,
        Err(e) => return ClosePageResult::failed(format!("拿不到桌面根元素：{e}")),
    };

    // 条件对象建一次、全程复用（FindAll 每次现建会明显变慢）
    let (win_cond, tab_cond, button_cond, edit_cond) = match make_conditions(&uia) {
        Some(c) => c,
        None => return ClosePageResult::failed("构建 UI Automation 查询条件失败"),
    };

    let windows: IUIAutomationElementArray =
        match unsafe { root.FindAll(TreeScope_Children, &win_cond) } {
            Ok(w) => w,
            Err(e) => return ClosePageResult::failed(format!("枚举窗口失败：{e}")),
        };

    let own_pid = std::process::id() as i32;
    let mut matches: Vec<TabMatch> = Vec::new();
    // 当前开着的所有标签页：一个都没命中时回给模型，它才能反问"你说的是哪个"
    let mut open_tabs: Vec<String> = Vec::new();
    // 没有标签页结构的窗口（PWA 等），留给整窗兜底
    let mut tabless_windows: Vec<(String, IUIAutomationElement)> = Vec::new();

    let win_count = unsafe { windows.Length() }.unwrap_or(0);
    for i in 0..win_count {
        let Ok(win) = (unsafe { windows.GetElement(i) }) else {
            continue;
        };
        // 桌宠自己的窗口永远不碰（点自己一下就把自己关了会很尴尬）
        if unsafe { win.CurrentProcessId() }.unwrap_or(own_pid) == own_pid {
            continue;
        }

        let win_title = element_name(&win);
        let Ok(tabs) = (unsafe { win.FindAll(TreeScope_Descendants, &tab_cond) }) else {
            continue;
        };
        let unique = unique_tabs(&tabs, &button_cond);
        if unique.is_empty() {
            tabless_windows.push((win_title, win));
            continue;
        }
        for t in &unique {
            open_tabs.push(display_title(&t.title));
        }

        // ① 先按标签页标题匹配（标题里通常带站点名，所以"B站那个""淘宝"都能命中）
        let mut hit_by_title = false;
        for t in &unique {
            if normalize(&t.title).contains(key) {
                hit_by_title = true;
                matches.push(TabMatch {
                    window_title: win_title.clone(),
                    tab_title: t.title.clone(),
                    close_button: t.close_button.clone(),
                    by_url: false,
                });
            }
        }

        // ② 标题没命中时，用地址栏 URL 兜底。地址栏显示的永远是**当前选中**的那个
        //    标签页，所以这条只对选中的标签页有效 —— 但用户说"关掉那个 xxx.com"时
        //    它正好是最常见的情形。
        if !hit_by_title {
            if let Some(selected) = unique.iter().find(|t| t.selected) {
                if let Some(url) = read_address_bar(&win, &edit_cond) {
                    if normalize(&url).contains(key) {
                        matches.push(TabMatch {
                            window_title: win_title.clone(),
                            tab_title: selected.title.clone(),
                            close_button: selected.close_button.clone(),
                            by_url: true,
                        });
                    }
                }
            }
        }
    }

    match matches.len() {
        0 => {}
        1 => {
            let m = matches.remove(0);
            let shown = display_title(&m.tab_title);
            let Some(button) = m.close_button else {
                return ClosePageResult::failed_with(
                    format!("找到了「{shown}」，但拿不到它的关闭按钮，没法安全地关（浏览器版本可能太新或太旧）"),
                    vec![shown],
                );
            };
            let invoke: IUIAutomationInvokePattern =
                match unsafe { button.GetCurrentPatternAs(UIA_InvokePatternId) } {
                    Ok(p) => p,
                    Err(e) => {
                        return ClosePageResult::failed_with(
                            format!("找到了「{shown}」，但它的关闭按钮不能点：{e}"),
                            vec![shown],
                        )
                    }
                };
            if let Err(e) = unsafe { invoke.Invoke() } {
                return ClosePageResult::failed_with(
                    format!("点「{shown}」的关闭按钮失败：{e}"),
                    vec![shown],
                );
            }
            let how = if m.by_url {
                "（按你正在看的地址匹配到的）"
            } else {
                ""
            };
            return ClosePageResult::ok(
                shown.clone(),
                format!("已关闭页面「{shown}」{how}。窗口「{}」里其它标签页没动。", m.window_title),
            );
        }
        n => {
            let titles: Vec<String> = matches.iter().map(|m| display_title(&m.tab_title)).collect();
            return ClosePageResult::failed_with(
                format!(
                    "同时有 {n} 个页面匹配「{key}」，不能猜着关：{}。请先问用户要关哪一个，拿到更具体的关键词后再调一次。",
                    titles.join("、")
                ),
                titles,
            );
        }
    }

    // 没有标签页可关：试试"没有标签页栏的浏览器窗口"（PWA / 应用窗口）整窗关闭
    let title_hits: Vec<&(String, IUIAutomationElement)> = tabless_windows
        .iter()
        .filter(|(title, win)| normalize(title).contains(key) && is_browser_window(win))
        .collect();

    if let Some((title, win)) = match title_hits.len() {
        1 => Some(title_hits[0]),
        n if n > 1 => {
            let titles: Vec<String> = title_hits.iter().map(|(t, _)| t.clone()).collect();
            return ClosePageResult::failed_with(
                format!(
                    "有 {n} 个浏览器窗口匹配「{key}」：{}。请先跟用户确认是哪一个。",
                    titles.join("、")
                ),
                titles,
            );
        }
        _ => None,
    } {
        let Ok(hwnd) = (unsafe { win.CurrentNativeWindowHandle() }) else {
            return ClosePageResult::failed(format!("窗口「{title}」拿不到窗口句柄，没法关"));
        };
        if hwnd.is_invalid() {
            return ClosePageResult::failed(format!("窗口「{title}」的窗口句柄无效，没法关"));
        }
        // PostMessage 是异步的：浏览器如果有"确认离开"弹窗，它会自己弹，我们如实转述。
        if let Err(e) = unsafe { PostMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0)) } {
            return ClosePageResult::failed_with(
                format!("给窗口「{title}」发关闭消息失败：{e}"),
                vec![title.clone()],
            );
        }
        return ClosePageResult::ok(
            title.clone(),
            format!("「{title}」没有标签页结构（PWA / 应用窗口），已按整个窗口关闭。"),
        );
    }

    // 一个都没命中：把当前开着的页面回给模型，让它能回答"你现在开着的是这些"
    if open_tabs.is_empty() {
        return ClosePageResult::failed(format!(
            "没有找到匹配「{key}」的页面，也没有发现任何可关闭的浏览器标签页"
        ));
    }
    open_tabs.sort();
    open_tabs.dedup();
    let shown = if open_tabs.len() > 12 {
        let mut v = open_tabs[..12].to_vec();
        v.push(format!("…等共 {} 个", open_tabs.len()));
        v
    } else {
        open_tabs.clone()
    };
    ClosePageResult::failed_with(
        format!(
            "没有找到匹配「{key}」的页面。当前开着的标签页是：{}。可以据此问用户指的是哪一个。",
            shown.join("、")
        ),
        shown,
    )
}

/// 建一次条件对象，全程复用。
fn make_conditions(
    uia: &IUIAutomation,
) -> Option<(
    IUIAutomationCondition,
    IUIAutomationCondition,
    IUIAutomationCondition,
    IUIAutomationCondition,
)> {
    // control type 是 VT_I4 的 VARIANT
    let control_type = |id: i32| -> Option<IUIAutomationCondition> {
        unsafe {
            uia.CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(id))
                .ok()
        }
    };
    Some((
        control_type(UIA_WindowControlTypeId.0)?,
        control_type(UIA_TabItemControlTypeId.0)?,
        control_type(UIA_ButtonControlTypeId.0)?,
        control_type(UIA_EditControlTypeId.0)?,
    ))
}

/// 标签页去重。
///
/// Chromium 会把同一个标签页在无障碍树里暴露好几份（实测 2 个标签页 = 14 个元素），
/// 不去重的话"同时匹配到多个"会误报。RuntimeId 能唯一标识元素，但取它是
/// `*mut SAFEARRAY`（要手工锁数组、解包），为这点事引入 SAFEARRAY 处理不划算；
/// 同一个 UI 元素暴露出来的多份，标题与边界矩形必然完全一致，而两个不同标签页
/// 不可能占同一块矩形，所以按（标题 + 左上角）判重就够了。
fn unique_tabs(
    tabs: &IUIAutomationElementArray,
    button_cond: &IUIAutomationCondition,
) -> Vec<TabInfo> {
    let mut out: Vec<TabInfo> = Vec::new();
    let count = unsafe { tabs.Length() }.unwrap_or(0);
    for i in 0..count {
        let Ok(tab) = (unsafe { tabs.GetElement(i) }) else {
            continue;
        };
        let title = element_name(&tab);
        let rect = unsafe { tab.CurrentBoundingRectangle() }.unwrap_or(RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        });
        // 同一份元素重复暴露时，标题和左上角必然一模一样
        if out
            .iter()
            .any(|o| o.title == title && o.rect.left == rect.left && o.rect.top == rect.top)
        {
            continue;
        }
        let selected = unsafe {
            tab.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
        }
        .and_then(|p| unsafe { p.CurrentIsSelected() })
        .map(|b| b.as_bool())
        .unwrap_or(false);
        let close_button = find_close_button(&tab, button_cond);
        out.push(TabInfo {
            title,
            selected,
            close_button,
            rect,
        });
    }
    out
}

/// 取标签页里的关闭按钮。
///
/// 两条路，缺一不可：
///  - 名字白名单：简中"关闭标签页"、英文 "Close tab"…（Chromium 的名字来自本地化字符串）
///  - 位置兜底：标签页里最靠右的可 Invoke 按钮。正在播放声音的标签页会**多出一个
///    静音按钮**，所以"只有一个按钮就当成关闭按钮"这种偷懒会在播放页上点错；
///    而 Chromium 把关闭按钮固定在标签页右端、静音图标在它左边，位置与语言无关。
fn find_close_button(
    tab: &IUIAutomationElement,
    button_cond: &IUIAutomationCondition,
) -> Option<IUIAutomationElement> {
    let buttons: IUIAutomationElementArray =
        unsafe { tab.FindAll(TreeScope_Descendants, button_cond) }.ok()?;
    let count = unsafe { buttons.Length() }.ok()?;

    let mut invokable: Vec<(IUIAutomationElement, String, i32)> = Vec::new();
    for i in 0..count {
        let Ok(b) = (unsafe { buttons.GetElement(i) }) else {
            continue;
        };
        // 只认真的能点的：拿不到 Invoke 的按钮点了也没用
        if unsafe { b.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) }
            .is_err()
        {
            continue;
        }
        let name = element_name(&b);
        let right = unsafe { b.CurrentBoundingRectangle() }
            .map(|r| r.right)
            .unwrap_or(0);
        invokable.push((b, name, right));
    }

    if invokable.is_empty() {
        return None;
    }

    if let Some((b, _, _)) = invokable.iter().find(|(_, name, _)| {
        let lower = name.to_lowercase();
        CLOSE_BUTTON_NAMES.iter().any(|k| lower.contains(k))
    }) {
        return Some(b.clone());
    }

    // 名字认不出（没见过的语言 / 换过皮肤的浏览器）→ 最靠右的那个
    invokable
        .into_iter()
        .max_by_key(|(_, _, right)| *right)
        .map(|(b, _, _)| b)
}

/// 读地址栏里的 URL。
///
/// 地址栏的无障碍名是本地化的（"地址和搜索栏" / "Address and search bar"），所以
/// **不按名字认，按值的形状认**：第一个"值以 http:// 或 https:// 开头"的可编辑框
/// 就是地址栏。页面内容里的输入框极少以 http 开头，而且地址栏在树的靠前位置。
fn read_address_bar(
    win: &IUIAutomationElement,
    edit_cond: &IUIAutomationCondition,
) -> Option<String> {
    let edits: IUIAutomationElementArray =
        unsafe { win.FindAll(TreeScope_Descendants, edit_cond) }.ok()?;
    let count = unsafe { edits.Length() }.ok()?;
    for i in 0..count {
        let Ok(e) = (unsafe { edits.GetElement(i) }) else {
            continue;
        };
        let Ok(vp) =
            (unsafe { e.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) })
        else {
            continue;
        };
        let Ok(value) = (unsafe { vp.CurrentValue() }) else {
            continue;
        };
        let v = value.to_string();
        let lower = v.trim().to_ascii_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") {
            return Some(v.trim().to_string());
        }
    }
    None
}

/// 窗口类名是否属于已知浏览器（整窗兜底的白名单，见 BROWSER_WINDOW_CLASSES）。
fn is_browser_window(win: &IUIAutomationElement) -> bool {
    let class = unsafe { win.CurrentClassName() }
        .map(|b| b.to_string())
        .unwrap_or_default()
        .to_lowercase();
    BROWSER_WINDOW_CLASSES.iter().any(|c| class.contains(c))
}

fn element_name(el: &IUIAutomationElement) -> String {
    unsafe { el.CurrentName() }
        .map(|b| b.to_string())
        .unwrap_or_default()
}

/// 匹配用的归一化：小写 + 去掉空白。
///
/// 顺手解决三个实际问题：用户说"关掉 b 站"、标签页标题里是 "Bilibili"；中文页面
/// 标题里带全角空格；以及模型偶尔会把关键词前后带空格。
fn normalize(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// 给用户看的标题：剥掉 Chromium 追加的状态后缀。
///
/// 这些后缀是给读屏用户的（"… - 内存使用率 - 219 MB"、"- 音频正在播放"），原样
/// 转述给用户很怪，模型还可能把内存占用当成页面内容复述一遍。**只影响显示**，
/// 匹配一律用原始标题。
fn display_title(raw: &str) -> String {
    let mut parts: Vec<&str> = raw.split(" - ").collect();
    while parts.len() > 1 {
        let last = parts[parts.len() - 1].trim();
        if is_status_suffix(last) {
            parts.pop();
        } else {
            break;
        }
    }
    parts.join(" - ")
}

fn is_status_suffix(s: &str) -> bool {
    let lower = s.to_lowercase();
    const MARKERS: &[&str] = &[
        "内存使用率",
        "memory usage",
        "音频正在播放",
        "正在播放音频",
        "audio playing",
        "正在播放",
        "playing",
        "静音",
        "muted",
        "媒体",
        "media",
        "内存",
    ];
    if MARKERS.iter().any(|m| lower.contains(m)) {
        return true;
    }
    // "219 MB" / "1.2 GB" 这类纯容量片段
    lower.ends_with(" mb") || lower.ends_with(" kb") || lower.ends_with(" gb")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_ignores_case_and_whitespace() {
        // 用户说"关掉 B 站"、标题里写的是 "Bilibili"：两边都要能对上
        assert_eq!(normalize("B 站"), "b站");
        assert_eq!(normalize("  Bilibili  "), "bilibili");
        assert_eq!(normalize("哔哩哔哩"), "哔哩哔哩");
        assert_eq!(normalize(""), "");
    }

    #[test]
    fn display_title_strips_chromium_status_suffix() {
        // 实测到的两种后缀形态（Edge/Chromium 追加给读屏用户的）
        assert_eq!(
            display_title("哔哩哔哩 (゜-゜)つロ 干杯~-bilibili - 内存使用率 - 219 MB"),
            "哔哩哔哩 (゜-゜)つロ 干杯~-bilibili"
        );
        assert_eq!(
            display_title("某某视频_哔哩哔哩_bilibili - 音频正在播放 - 内存使用率 - 335 MB"),
            "某某视频_哔哩哔哩_bilibili"
        );
        assert_eq!(
            display_title("DeepSeek 开放平台 - Memory usage - 93.8 MB"),
            "DeepSeek 开放平台"
        );
    }

    #[test]
    fn display_title_keeps_real_dashes() {
        // 页面标题里的 " - " 是内容，不能一起剥掉
        assert_eq!(display_title("GitHub - Wumiu/Petra"), "GitHub - Wumiu/Petra");
        assert_eq!(display_title("没有横杠的标题"), "没有横杠的标题");
        assert_eq!(display_title(""), "");
        // 只有结尾那一段是状态后缀时才剥
        assert_eq!(
            display_title("GitHub - Wumiu/Petra - 音频正在播放"),
            "GitHub - Wumiu/Petra"
        );
    }

    #[test]
    fn status_suffix_detection() {
        assert!(is_status_suffix("219 MB"));
        assert!(is_status_suffix("1.2 GB"));
        assert!(is_status_suffix("内存使用率"));
        assert!(is_status_suffix("音频正在播放"));
        assert!(!is_status_suffix("Wumiu/Petra"));
        assert!(!is_status_suffix("哔哩哔哩"));
    }

    #[test]
    fn short_keyword_is_rejected() {
        // 一个字的"关"能命中一大堆页面，必须在入口就拦掉（也不会去碰 COM）
        let r = close_web_page("关");
        assert!(!r.success);
        assert!(r.message.contains("太短"));
        assert!(r.candidates.is_empty());
    }
}
