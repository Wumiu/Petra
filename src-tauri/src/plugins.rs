//! Petra 插件包的文件层：只负责扫描、读 manifest、读源码和安装示例。
//!
//! 真正执行插件的是前端 `src/plugins/runtime.ts` 的 Worker Host。
//! Rust 侧刻意不执行任意 JS，也不把文件系统/命令能力暴露给插件；
//! 插件要做什么，必须经过前端 host API 的权限白名单。

use serde_json::{json, Value};
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 用户插件目录：app_data_dir/plugins
fn plugins_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?
        .join("plugins");
    fs::create_dir_all(&dir).map_err(|e| format!("创建插件目录失败：{e}"))?;
    Ok(dir)
}

/// 插件 id 同时是目录名，只允许保守字符，避免路径穿越。
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
        && id != "."
        && id != ".."
        && !id.starts_with('.')
}

fn manifest_path(root: &Path, id: &str) -> PathBuf {
    root.join(id).join("petra-plugin.json")
}

fn read_manifest(root: &Path, id: &str) -> Result<Value, String> {
    let path = manifest_path(root, id);
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("读取 {} 失败：{e}", path.display()))?;
    serde_json::from_str::<Value>(&raw)
        .map_err(|e| format!("解析 {} 失败：{e}", path.display()))
}

/// 插件入口路径必须是包内相对路径：不允许绝对路径、`..`、Windows 盘符。
fn safe_relative_main(main: &str) -> Option<PathBuf> {
    let path = Path::new(main);
    if path.as_os_str().is_empty() {
        return None;
    }
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            _ => return None,
        }
    }
    Some(out)
}

/// 创建插件目录并返回路径。控制面板「打开插件目录」用它。
#[tauri::command]
pub fn plugin_dir(app: AppHandle) -> Result<String, String> {
    Ok(plugins_root(&app)?.to_string_lossy().to_string())
}

/// 扫描用户插件目录，返回每个包的 manifest 原文（前端再做严格校验）。
#[tauri::command]
pub fn plugin_list(app: AppHandle) -> Result<Vec<Value>, String> {
    let root = plugins_root(&app)?;
    let mut out = Vec::new();
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(e) => return Err(format!("读取插件目录失败：{e}")),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if !valid_id(id) {
            continue;
        }
        let Some(manifest) = read_manifest(&root, id).ok() else {
            continue;
        };
        out.push(json!({
            "dir": path.to_string_lossy().to_string(),
            "manifest": manifest,
        }));
    }
    out.sort_by(|a, b| {
        let ai = a
            .get("manifest")
            .and_then(|m| m.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let bi = b
            .get("manifest")
            .and_then(|m| m.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("");
        ai.cmp(bi)
    });
    Ok(out)
}

/// 读取插件入口源码。只允许读包内 manifest.main 指向的那个文件。
#[tauri::command]
pub fn plugin_read_source(app: AppHandle, id: String) -> Result<String, String> {
    if !valid_id(&id) {
        return Err(format!("插件 id 不合法：{id}"));
    }
    let root = plugins_root(&app)?;
    let manifest = read_manifest(&root, &id)?;
    let main = manifest
        .get("main")
        .and_then(Value::as_str)
        .unwrap_or("index.js");
    let rel = safe_relative_main(main).ok_or_else(|| format!("插件入口路径不合法：{main}"))?;
    let full = root.join(&id).join(&rel);
    // 再兜一层：解析符号链接后必须仍在插件包目录内。
    let package_dir = fs::canonicalize(root.join(&id)).map_err(|e| format!("插件目录无效：{e}"))?;
    let full = fs::canonicalize(&full).map_err(|e| format!("读取插件入口失败：{e}"))?;
    if !full.starts_with(&package_dir) {
        return Err("插件入口越过了插件目录边界".into());
    }
    fs::read_to_string(&full).map_err(|e| format!("读取插件入口失败：{e}"))
}

/// 安装内置示例插件（Hello Petra）。已存在时不覆盖，避免把用户改过的示例冲掉。
#[tauri::command]
pub fn plugin_install_example(app: AppHandle) -> Result<String, String> {
    let root = plugins_root(&app)?;
    let id = "petra-plugin-hello";
    let dir = root.join(id);
    let manifest = dir.join("petra-plugin.json");
    if manifest.is_file() {
        return Ok("示例插件已经存在（未覆盖你改过的文件）".into());
    }
    fs::create_dir_all(&dir).map_err(|e| format!("创建示例插件目录失败：{e}"))?;
    fs::write(
        &manifest,
        include_str!("../../plugins/petra-plugin-hello/petra-plugin.json"),
    )
    .map_err(|e| format!("写入示例 manifest 失败：{e}"))?;
    fs::write(
        dir.join("index.js"),
        include_str!("../../plugins/petra-plugin-hello/index.js"),
    )
    .map_err(|e| format!("写入示例入口失败：{e}"))?;
    Ok("示例插件已安装，可在「插件」页启用".into())
}

/// 删除一个插件包。只接受合法 id，且只删 plugins_root 下对应目录。
#[tauri::command]
pub fn plugin_delete(app: AppHandle, id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err(format!("插件 id 不合法：{id}"));
    }
    let root = plugins_root(&app)?;
    let dir = root.join(&id);
    if !dir.is_dir() {
        return Err(format!("插件不存在：{id}"));
    }
    fs::remove_dir_all(&dir).map_err(|e| format!("删除插件失败：{e}"))
}
