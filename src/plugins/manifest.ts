import type { PluginManifest, PluginSettingField } from "./types";

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/i;
const MAIN_RE = /^[a-zA-Z0-9._/-]+$/;

/**
 * 校验并规范化 manifest。
 *
 * 这里刻意不信任磁盘上的 JSON：用户可以手改，插件也可能来自不可信来源。
 * 宁可让这一条插件加载失败并显示原因，也不要让半个坏配置进入运行时。
 */
export function normalizeManifest(raw: unknown, expectedId?: string): PluginManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("petra-plugin.json 必须是 JSON 对象");
  }
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? "").trim();
  if (!ID_RE.test(id)) throw new Error(`插件 id 不合法：${id || "(空)"}（只允许字母、数字、. _ -）`);
  if (expectedId && id !== expectedId) throw new Error(`manifest.id（${id}）必须与插件目录名（${expectedId}）一致`);
  const apiVersion = Number(r.apiVersion);
  if (apiVersion !== 1) throw new Error(`不支持的 apiVersion：${String(r.apiVersion)}（当前只支持 1）`);
  const main = String(r.main ?? "index.js").trim().replace(/\\/g, "/");
  if (!main || !MAIN_RE.test(main) || main.split("/").some((p) => p === ".." || p === "")) {
    throw new Error(`插件入口路径不合法：${main || "(空)"}`);
  }
  const name = String(r.name ?? id).trim() || id;
  const version = String(r.version ?? "0.0.0").trim() || "0.0.0";
  const permissions = Array.isArray(r.permissions)
    ? [...new Set(r.permissions.map((x) => String(x).trim()).filter(Boolean))]
    : ["pet.tools"];
  const settings = Array.isArray(r.settings)
    ? r.settings.map(normalizeSetting).filter((x): x is PluginSettingField => x !== null)
    : [];
  return {
    id,
    name,
    version,
    apiVersion,
    main,
    description: typeof r.description === "string" ? r.description : "",
    author: typeof r.author === "string" ? r.author : "",
    homepage: typeof r.homepage === "string" ? r.homepage : "",
    permissions,
    settings,
    enabledByDefault: r.enabledByDefault !== false,
  };
}

function normalizeSetting(raw: unknown): PluginSettingField | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const key = String(r.key ?? "").trim();
  const type = String(r.type ?? "string") as PluginSettingField["type"];
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(key)) return null;
  if (!["string", "number", "boolean", "select"].includes(type)) return null;
  const out: PluginSettingField = {
    key,
    type,
    label: String(r.label ?? key).trim() || key,
  };
  if (typeof r.description === "string") out.description = r.description;
  if (typeof r.placeholder === "string") out.placeholder = r.placeholder;
  if (typeof r.default === "string" || typeof r.default === "number" || typeof r.default === "boolean") {
    out.default = r.default;
  }
  if (Number.isFinite(Number(r.min))) out.min = Number(r.min);
  if (Number.isFinite(Number(r.max))) out.max = Number(r.max);
  if (Number.isFinite(Number(r.step))) out.step = Number(r.step);
  if (Array.isArray(r.options)) {
    out.options = r.options
      .map((o) => (Array.isArray(o) && o.length >= 2 ? [String(o[0]), String(o[1])] as [string, string] : null))
      .filter((o): o is [string, string] => o !== null);
  }
  return out;
}

/** 把 manifest 的默认值摊平成一份可持久化的对象 */
export function defaultSettings(fields: PluginSettingField[]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const f of fields) {
    if (f.default !== undefined) out[f.key] = f.default;
    else if (f.type === "boolean") out[f.key] = false;
    else if (f.type === "number") out[f.key] = 0;
    else if (f.type === "select") out[f.key] = f.options?.[0]?.[0] ?? "";
    else out[f.key] = "";
  }
  return out;
}
