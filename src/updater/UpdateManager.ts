/**
 * 更新管理器（Tauri 官方 updater 签名验证链路）
 *
 * 安全链：check() → 签名验证 → downloadAndInstall() → 签名验证 → 安装
 * UI/策略层保留：静默检查、进度、手动检查、错误提示
 */
import { check, type Update } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";

// ---------- 公开接口（保持与 main.ts 调用方兼容） ----------

export interface UpdateInfo {
  version: string;
  notes?: string;
  currentVersion: string;
  downloadUrls: string[]; // 保留字段以兼容 main.ts，不再用于实际下载
}

/** 检查是否有更新（静默）。通过 tauri-plugin-updater 检查，签名验证内置。 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const update = await check();
  if (!update) return null;
  // 缓存 Update 实例供后续下载使用
  _cachedUpdate = update;
  return {
    version: update.version,
    notes: update.body ?? undefined,
    currentVersion: update.currentVersion,
    downloadUrls: [], // 不再由前端管理下载 URL
  };
}

/** 执行更新：Tauri 官方签名验证 → 下载 → 签名验证 → 安装 */
export async function performUpdate(
  _downloadUrls: string[], // 保留签名兼容，实际不使用
  onProgress?: (percent: number) => void,
): Promise<boolean> {
  if (!_cachedUpdate) {
    return false;
  }
  try {
    onProgress?.(0);
    let contentLength: number | null = null;
    let downloaded = 0;
    await _cachedUpdate.downloadAndInstall((event) => {
      if (event.event === "Started") {
        contentLength = event.data.contentLength ?? null;
        onProgress?.(contentLength ? 2 : 5);
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        if (contentLength && contentLength > 0) {
          onProgress?.(Math.min(99, Math.round((downloaded / contentLength) * 100)));
        } else {
          // 无 contentLength 时用步进
          onProgress?.(Math.min(99, 5 + Math.round(downloaded / 1024 / 10)));
        }
      } else if (event.event === "Finished") {
        onProgress?.(100);
      }
    });
    // downloadAndInstall 成功后会自动安装并重启/退出
    return true;
  } catch (e) {
    console.error("[updater] download/install failed:", e);
    return false;
  }
}

// ---------- 内部状态 ----------

let _cachedUpdate: Update | null = null;
