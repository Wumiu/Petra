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

/// 从任意本地目录安装/更新插件（给 MCP / dsh 用）。
///
/// 只接受目录；manifest 必须合法，id 必须与目录名一致。复制时拒绝符号链接，
/// 并限制文件数/总大小，避免把一整个 node_modules 或恶意目录塞进来。
pub fn install_from_dir(app: &AppHandle, source: &str) -> Result<String, String> {
    let source = PathBuf::from(source);
    let source = fs::canonicalize(&source)
        .map_err(|e| format!("插件源目录无效：{e}"))?;
    if !source.is_dir() {
        return Err("插件源路径不是目录".into());
    }
    let manifest_raw = fs::read_to_string(source.join("petra-plugin.json"))
        .map_err(|e| format!("源目录缺少 petra-plugin.json：{e}"))?;
    let manifest: Value = serde_json::from_str(&manifest_raw)
        .map_err(|e| format!("petra-plugin.json 不是合法 JSON：{e}"))?;
    let id = manifest
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if !valid_id(&id) {
        return Err(format!("插件 id 不合法：{id}"));
    }
    let dir_name = source
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if dir_name != id {
        return Err(format!("插件目录名（{dir_name}）必须与 manifest.id（{id}）一致"));
    }
    let main = manifest
        .get("main")
        .and_then(Value::as_str)
        .unwrap_or("index.js");
    let main_rel = safe_relative_main(main).ok_or_else(|| format!("插件入口路径不合法：{main}"))?;
    if !source.join(&main_rel).is_file() {
        return Err(format!("插件入口不存在：{}", main_rel.display()));
    }
    let root = plugins_root(app)?;
    let dest = root.join(&id);
    // 先复制到临时目录，成功后再替换旧插件：避免复制到一半失败把可用插件删没了。
    let staging = root.join(format!(".{id}.installing-{}", std::process::id()));
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|e| format!("清理临时目录失败：{e}"))?;
    }
    let mut files = 0usize;
    let mut bytes = 0u64;
    if let Err(e) = copy_plugin_dir(&source, &staging, 0, &mut files, &mut bytes) {
        let _ = fs::remove_dir_all(&staging);
        return Err(e);
    }
    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|e| format!("替换旧插件失败：{e}"))?;
    }
    fs::rename(&staging, &dest).map_err(|e| {
        let _ = fs::remove_dir_all(&staging);
        format!("启用新插件失败：{e}")
    })?;
    Ok(id)
}

fn copy_plugin_dir(
    src: &Path,
    dest: &Path,
    depth: usize,
    files: &mut usize,
    bytes: &mut u64,
) -> Result<(), String> {
    if depth > 8 {
        return Err("插件目录层级过深".into());
    }
    fs::create_dir_all(dest).map_err(|e| format!("创建插件目录失败：{e}"))?;
    for entry in fs::read_dir(src).map_err(|e| format!("读取插件目录失败：{e}"))? {
        let entry = entry.map_err(|e| format!("读取插件条目失败：{e}"))?;
        let ty = entry
            .file_type()
            .map_err(|e| format!("读取插件条目类型失败：{e}"))?;
        if ty.is_symlink() {
            return Err("插件目录里不允许符号链接".into());
        }
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if ty.is_dir() {
            copy_plugin_dir(&from, &to, depth + 1, files, bytes)?;
        } else if ty.is_file() {
            *files += 1;
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            *bytes += size;
            if *files > 200 || *bytes > 20 * 1024 * 1024 {
                return Err("插件包过大（最多 200 个文件 / 20MB）".into());
            }
            fs::copy(&from, &to).map_err(|e| format!("复制 {} 失败：{e}", from.display()))?;
        }
    }
    Ok(())
}

/// 把内置 SDK（README / types / 模板）写到 app_data_dir/plugin-sdk。
/// 文档每次覆盖，模板只在不存在时写入，避免把用户改过的模板冲掉。
#[tauri::command]
pub fn plugin_sdk_install(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?
        .join("plugin-sdk");
    fs::create_dir_all(&dir).map_err(|e| format!("创建 SDK 目录失败：{e}"))?;
    fs::write(dir.join("README.md"), include_str!("../../plugins/sdk/README.md"))
        .map_err(|e| format!("写入 SDK README 失败：{e}"))?;
    fs::write(dir.join("types.d.ts"), include_str!("../../plugins/sdk/types.d.ts"))
        .map_err(|e| format!("写入 SDK 类型失败：{e}"))?;
    let tpl = dir.join("template");
    fs::create_dir_all(&tpl).map_err(|e| format!("创建 SDK 模板目录失败：{e}"))?;
    let tpl_manifest = tpl.join("petra-plugin.json");
    if !tpl_manifest.is_file() {
        fs::write(&tpl_manifest, include_str!("../../plugins/sdk/template/petra-plugin.json"))
            .map_err(|e| format!("写入模板 manifest 失败：{e}"))?;
    }
    let tpl_index = tpl.join("index.js");
    if !tpl_index.is_file() {
        fs::write(&tpl_index, include_str!("../../plugins/sdk/template/index.js"))
            .map_err(|e| format!("写入模板入口失败：{e}"))?;
    }
    Ok(dir.to_string_lossy().to_string())
}

/// 返回 SDK 目录（不存在时先安装）。
#[tauri::command]
pub fn plugin_sdk_dir(app: AppHandle) -> Result<String, String> {
    plugin_sdk_install(app)
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

/// 安装内置的 dsh 反向桥插件（Petra 侧）。
#[tauri::command]
pub fn plugin_install_dsh_bridge(app: AppHandle) -> Result<String, String> {
    let root = plugins_root(&app)?;
    let id = "petra-plugin-dsh-bridge";
    let dir = root.join(id);
    let manifest = dir.join("petra-plugin.json");
    if manifest.is_file() {
        return Ok("dsh 反向桥插件已经存在（未覆盖你改过的文件）".into());
    }
    fs::create_dir_all(&dir).map_err(|e| format!("创建 dsh 桥插件目录失败：{e}"))?;
    fs::write(
        &manifest,
        include_str!("../../plugins/petra-plugin-dsh-bridge/petra-plugin.json"),
    )
    .map_err(|e| format!("写入 dsh 桥 manifest 失败：{e}"))?;
    fs::write(
        dir.join("index.js"),
        include_str!("../../plugins/petra-plugin-dsh-bridge/index.js"),
    )
    .map_err(|e| format!("写入 dsh 桥入口失败：{e}"))?;
    fs::write(
        dir.join("README.md"),
        include_str!("../../plugins/petra-plugin-dsh-bridge/README.md"),
    )
    .map_err(|e| format!("写入 dsh 桥 README 失败：{e}"))?;
    Ok("dsh 反向桥插件已安装；去插件设置里填 dsh 地址/token".into())
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
