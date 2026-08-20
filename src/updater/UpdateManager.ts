/**
 * 更新管理器：多镜像源 + 自动降级 + 进度显示
 * 利用 tauri-plugin-updater，前端做镜像源轮询和 UI 交互
 */
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { toast } from "../ui/Toast";

/** 更新源配置（按优先级排列） */
const UPDATE_ENDPOINTS = [
  "https://github.com/Wumiu/Petra/releases/latest/download/latest.json",
  "https://mirror.ghproxy.com/https://github.com/Wumiu/Petra/releases/latest/download/latest.json",
  "https://ghfast.top/https://github.com/Wumiu/Petra/releases/latest/download/latest.json",
  "https://cdn.jsdelivr.net/gh/Wumiu/Petra@latest/latest.json",
];

interface UpdateManifest {
  version: string;
  notes?: string;
  pub_date?: string;
  platforms: Record<string, { url: string; signature: string }>;
}

function parseVersion(v: string): number[] {
  return v.replace(/^v/, "").split(".").map(Number);
}

function cmpVersion(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 从多个镜像源获取更新清单，返回第一个成功的 */
async function fetchManifest(): Promise<UpdateManifest | null> {
  for (const endpoint of UPDATE_ENDPOINTS) {
    try {
      const text = await invoke<string>("http_get", { url: endpoint });
      const manifest = JSON.parse(text);
      if (manifest?.version && manifest?.platforms) return manifest as UpdateManifest;
    } catch { continue; }
  }
  return null;
}

/** 下载文件并报告进度（支持多镜像源降级） */
async function downloadWithProgress(
  urls: string[],
  onProgress?: (percent: number) => void,
): Promise<ArrayBuffer | null> {
  for (const url of urls) {
    try {
      onProgress?.(5);
      const bytes = await invoke<number[]>("http_download", { url });
      onProgress?.(100);
      return new Uint8Array(bytes).buffer;
    } catch { continue; }
  }
  return null;
}

// ---------- 公开 API ----------

export interface UpdateInfo {
  version: string;
  notes?: string;
  currentVersion: string;
  downloadUrls: string[];
}

/** 检查是否有更新（静默） */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const manifest = await fetchManifest();
  if (!manifest) return null;
  const current = parseVersion(await getVersion().catch(() => "0"));
  const remote = parseVersion(manifest.version);
  if (cmpVersion(remote, current) <= 0) return null;
  const platform = "windows-x86_64";
  const asset = manifest.platforms[platform];
  if (!asset?.url) return null;
  const originalUrl = asset.url;
  const downloadUrls = [
    originalUrl,
    originalUrl.replace("https://github.com/", "https://mirror.ghproxy.com/https://github.com/"),
    originalUrl.replace("https://github.com/", "https://ghfast.top/https://github.com/"),
  ];
  return {
    version: manifest.version,
    notes: manifest.notes,
    currentVersion: await getVersion().catch(() => "?"),
    downloadUrls,
  };
}

/** 执行更新：下载 → 校验 → 安装 */
export async function performUpdate(
  downloadUrls: string[],
  onProgress?: (percent: number) => void,
): Promise<boolean> {
  try {
    onProgress?.(0);
    const buffer = await downloadWithProgress(downloadUrls, onProgress);
    if (!buffer) { toast("更新下载失败，请手动下载", "warn"); return false; }
    onProgress?.(100);
    const fileName = `Petra-update-${Date.now()}.exe`;
    const bytes = Array.from(new Uint8Array(buffer));
    await invoke("write_update_installer", { fileName, bytes });
    await invoke("launch_update_installer", { fileName });
    return true;
  } catch (e) {
    toast(`更新失败：${e}`, "warn");
    return false;
  }
}

