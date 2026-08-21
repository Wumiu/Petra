/**
 * 更新管理器（Tauri 官方 updater 签名验证链路）
 *
 * 安全链：check() → 签名验证 → downloadAndInstall() → 签名验证 → 安装
 * UI/策略层保留：静默检查、进度、手动检查、错误提示
 */
import { check, type Update } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";

// 检查 metadata 超时(ms)：网络不可达时快速失败，不无限等系统 TCP 超时。
const CHECK_TIMEOUT = 12_000;
// 下载 installer 超时(ms)：较大，允许慢速网络完成。
const DOWNLOAD_TIMEOUT = 120_000;

// ---------- 公开接口（保持与 main.ts 调用方兼容） ----------

export interface UpdateInfo {
  version: string;
  notes?: string;
  currentVersion: string;
  downloadUrls: string[]; // 保留字段以兼容 main.ts，不再用于实际下载
}

/** 将 updater 原始错误分类为用户可理解的错误类型。 */
export type UpdateCheckError =
  | "plugin-unavailable" // 更新组件不可用
  | "network" // 超时 / DNS / 连接 / 代理
  | "metadata" // HTTP / JSON 解析
  | "signature" // 签名验证失败
  | "unknown";

export class UpdateCheckErrorExt extends Error {
  readonly kind: UpdateCheckError;
  constructor(kind: UpdateCheckError, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** 读取系统可用代理（环境变量 > WinINET），失败返回 undefined（直连）。 */
async function resolveProxy(): Promise<string | undefined> {
  try {
    const p = await invoke<string | null>("get_system_proxy");
    console.log("[updater] detected proxy:", p ?? "none");
    return p ?? undefined;
  } catch {
    return undefined;
  }
}

/** 归类原始错误。 */
function classifyError(e: unknown): UpdateCheckErrorExt {
  const msg = e instanceof Error ? e.message : String(e);
  const m = msg.toLowerCase();
  if (m.includes("plugin updater not found") || m.includes("not initialized")) {
    return new UpdateCheckErrorExt("plugin-unavailable", msg);
  }
  if (m.includes("signature") || m.includes("verify")) {
    return new UpdateCheckErrorExt("signature", msg);
  }
  if (m.includes("404") || m.includes("json") || m.includes("parse")) {
    return new UpdateCheckErrorExt("metadata", msg);
  }
  if (
    m.includes("timeout") || m.includes("dns") || m.includes("connect") ||
    m.includes("proxy") || m.includes("tls") || m.includes("network") ||
    m.includes("request") || m.includes("send")
  ) {
    return new UpdateCheckErrorExt("network", msg);
  }
  return new UpdateCheckErrorExt("unknown", msg);
}

/** 检查是否有更新（静默）。通过 tauri-plugin-updater 检查，签名验证内置。 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  // single-flight：同一时刻只允许一个 check() 运行。
  // 启动自动检查与用户手动检查可能同时触发，防止并发请求导致重复弹窗/竞态。
  if (_checking) {
    return _checking;
  }
  _checking = (async () => {
    try {
      // 代理同时覆盖 metadata 检查与 installer 下载（tauri-plugin-updater 复用同一 client）。
      const proxy = await resolveProxy();
      console.log("[updater] check started (timeout", CHECK_TIMEOUT, "ms)");
      let update: Update | null;
      try {
        update = await check({ timeout: CHECK_TIMEOUT, proxy });
      } catch (e) {
        if (!proxy) throw e;
        // 代理失效（梯子已关但环境变量残留 / 代理端口未启动 / PAC 解析异常）时
        // 退回直连重试一次，保证"有代理配置但代理不可用"时只要直连可达就能检测到更新。
        console.warn("[updater] check via proxy failed, retrying direct:", e);
        update = await check({ timeout: CHECK_TIMEOUT, proxy: undefined });
      }
      console.log("[updater] check done, update:", update ? `version=${update.version}` : "none");
      if (!update) return null;
      // 缓存 Update 实例供后续下载使用
      _cachedUpdate = update;
      return {
        version: update.version,
        notes: update.body ?? undefined,
        currentVersion: update.currentVersion,
        downloadUrls: [], // 不再由前端管理下载 URL
      };
    } catch (e) {
      // 保留真实错误分类供日志诊断；上层 UI 按 kind 显示用户可理解提示。
      const ext = classifyError(e);
      console.error(`[updater] check failed (${ext.kind}):`, e);
      throw ext;
    } finally {
      _checking = null; // 无论成功失败都复位，手动检查不会被永久锁死
    }
  })();
  return _checking;
}

/** 执行更新：Tauri 官方签名验证 → 下载 → 签名验证 → 安装 */
export async function performUpdate(
  _downloadUrls: string[], // 保留签名兼容，实际不使用
  onProgress?: (percent: number) => void,
): Promise<boolean> {
  if (!_cachedUpdate) {
    return false;
  }
  // 开发版禁止实际安装：避免误触覆盖本机正式安装（dev 仍可 check/验证网络）。
  if (import.meta.env.DEV) {
    console.log("[updater] install skipped in development mode");
    return false;
  }
  try {
    onProgress?.(0);
    let contentLength: number | null = null;
    let downloaded = 0;
    await _cachedUpdate.downloadAndInstall(
      (event) => {
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
      },
      { timeout: DOWNLOAD_TIMEOUT },
    );
    // downloadAndInstall 成功后会自动安装并重启/退出
    return true;
  } catch (e) {
    console.error("[updater] download/install failed:", e);
    return false;
  }
}

// ---------- 内部状态 ----------

let _cachedUpdate: Update | null = null;
// single-flight：同一时刻最多一个真实 check() 请求（自动/手动检查共享）
let _checking: Promise<UpdateInfo | null> | null = null;
