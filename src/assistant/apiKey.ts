import { invoke } from "@tauri-apps/api/core";
import { loadSettings } from "../utils/settings";

/**
 * 按供应商分槽存取的 API Key。
 *
 * 以前只有一份全局 Key：从 DeepSeek 切到 OpenAI 后，Key 输入框会被回填成旧 Key，
 * 保存后旧 Key 被继续发给新厂商 —— 结果是 401，而且把一家厂商的 Key 发给了另一家。
 * 现在每个供应商（provider id）一个槽位，互不覆盖；旧版本存下的单 Key 由 Rust 侧
 * 自动归到首次保存的那个供应商，用户不需要重新填写。
 */
export function currentKeyScope(): string {
  return loadSettings().assistant.provider || "deepseek";
}

/** 读取某个供应商的 Key（失败返回空串，调用方按"未配置"处理） */
export async function getApiKey(scope: string = currentKeyScope()): Promise<string> {
  try {
    return (await invoke<string>("get_api_key", { scope })) ?? "";
  } catch {
    return "";
  }
}

/** 保存某个供应商的 Key（空串 = 清空该槽位） */
export async function setApiKey(key: string, scope: string = currentKeyScope()): Promise<void> {
  await invoke("set_api_key", { scope, apiKey: key });
}

/**
 * 把用户填的端点规范成"OpenAI 兼容 base"。
 *
 * 常见错误：填了完整地址 `https://api.foo.com/v1/chat/completions`（会被再拼一次路径），
 * 或者只填域名 `https://api.foo.com`（少了 /v1）。这里统一收拾一下：
 * - 去掉末尾斜杠；
 * - 去掉多余的 `/chat/completions`
 * - 完全没有路径时补 `/v1`（已有 `/v1`、`/v4`、`/compatible-mode/...` 等路径不动）
 */
export function normalizeOpenAIBase(raw: string): string {
  let url = (raw || "").trim().replace(/\/+$/, "");
  if (!url) return "";
  url = url.replace(/\/chat\/completions$/i, "");
  // 解析出 pathname，判断有没有"版本路径"
  let pathname = "";
  try {
    pathname = new URL(url).pathname.replace(/\/+$/, "");
  } catch {
    return url; // 不是合法 URL 就原样返回，让请求阶段报错更直观
  }
  if (!pathname) url += "/v1";
  return url;
}
