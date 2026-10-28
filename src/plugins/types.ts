/** Petra 插件系统的公共类型。
 *
 * 设计边界：MVP 只支持单文件 ESM 插件 + 受控 host API。
 * 插件跑在 Web Worker 里，不能直接碰 DOM，也不能直接调用 Tauri invoke；
 * 所有能力都通过 runtime.ts 的 RPC 白名单代理。
 */

export type PluginSettingType = "string" | "number" | "boolean" | "select";

export interface PluginSettingField {
  key: string;
  label: string;
  type: PluginSettingType;
  default?: string | number | boolean;
  description?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  /** [value, label] 二元组，和现有控制面板的 select 保持一致 */
  options?: Array<[string, string]>;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  main: string;
  description?: string;
  author?: string;
  homepage?: string;
  /** host API 权限，例如 pet.tools / pet.say / pet.notify / pet.menu / pet.settings */
  permissions: string[];
  settings: PluginSettingField[];
  enabledByDefault: boolean;
}

/** Rust `plugin_list` 返回的一条记录 */
export interface PluginListEntry {
  dir: string;
  manifest: unknown;
}

export interface PluginToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  maxResultChars?: number;
}

export interface PluginMenuDefinition {
  id: string;
  label: string;
}

/** 控制面板「插件」页要显示的一条插件状态（必须是纯 JSON，能过 invoke/JSON） */
export interface PluginPanelInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  permissions: string[];
  enabled: boolean;
  loaded: boolean;
  error: string;
  tools: Array<{ name: string; description: string }>;
  menus: PluginMenuDefinition[];
  settings: PluginSettingField[];
  values: Record<string, string | number | boolean>;
}

export interface PluginHost {
  /** 让桌宠说一句本地文案（零 token） */
  say: (text: string, holdMs?: number) => void;
  /** 菜单数据变化时通知外层；当前菜单是每次打开时重建，所以可以为空 */
  onMenuChanged?: () => void;
}
