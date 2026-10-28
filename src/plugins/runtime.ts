import { invoke } from "@tauri-apps/api/core";
import { isBuiltinTool, registerToolSpec } from "../assistant/toolRuntime";
import { defaultSettings, normalizeManifest } from "./manifest";
import type {
  PluginHost,
  PluginListEntry,
  PluginManifest,
  PluginMenuDefinition,
  PluginPanelInfo,
  PluginSettingField,
  PluginToolDefinition,
} from "./types";

const ENABLED_KEY = "petra-plugin-enabled";
const SETTINGS_KEY_PREFIX = "petra-plugin-settings:";
const INIT_TIMEOUT_MS = 12_000;
const CALL_TIMEOUT_MS = 20_000;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: number;
}

interface PluginRecord {
  manifest: PluginManifest;
  dir: string;
  enabled: boolean;
  loaded: boolean;
  error: string;
  worker: Worker | null;
  sourceUrl: string;
  tools: Map<string, PluginToolDefinition>;
  menus: Map<string, PluginMenuDefinition>;
  settings: Record<string, string | number | boolean>;
  disposers: Array<() => void>;
  pending: Map<number, PendingCall>;
  nextCallId: number;
  readyTimer: number | null;
  resolveReady: (() => void) | null;
  rejectReady: ((error: Error) => void) | null;
}

let host: PluginHost = { say: () => {} };
let workerBootstrapUrl = "";
let initialized = false;
let records = new Map<string, PluginRecord>();
let toolOwner = new Map<string, string>();

export function configurePluginHost(next: PluginHost): void {
  host = next;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function loadEnabledMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(ENABLED_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveEnabledMap(map: Record<string, boolean>): void {
  try {
    localStorage.setItem(ENABLED_KEY, JSON.stringify(map));
  } catch {
    /* 忽略 */
  }
}

function loadSettings(record: PluginRecord): Record<string, string | number | boolean> {
  const defaults = defaultSettings(record.manifest.settings);
  try {
    const raw = localStorage.getItem(SETTINGS_KEY_PREFIX + record.manifest.id);
    const saved = raw ? JSON.parse(raw) : {};
    return { ...defaults, ...(saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {}) };
  } catch {
    return defaults;
  }
}

function saveSettings(record: PluginRecord): void {
  try {
    localStorage.setItem(SETTINGS_KEY_PREFIX + record.manifest.id, JSON.stringify(record.settings));
  } catch {
    /* 忽略 */
  }
}

function ensureWorkerBootstrap(): string {
  if (workerBootstrapUrl) return workerBootstrapUrl;
  // 这段代码在 Web Worker 里运行，只通过 postMessage 和主线程通信。
  // 不要在这里引用任何主窗口变量：Worker 里没有 DOM，也没有 window。
  const source = String.raw`
const tools = new Map();
const commands = new Map();
let settings = {};
let settingsListeners = [];
let seq = 0;
const pending = new Map();
let deactivateFn = null;

function post(type, extra) {
  self.postMessage(Object.assign({ type }, extra || {}));
}

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    post("rpc", { id, method, params: params || {} });
  });
}

function stringify(value) {
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

const pet = {
  apiVersion: 1,
  tools: {
    register(tool) {
      const name = String((tool && tool.name) || "").trim();
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
        throw new Error("tool.name 必须匹配 ^[a-zA-Z0-9_-]{1,64}$");
      }
      if (typeof tool.execute !== "function") throw new Error("tool.execute 必须是函数");
      tools.set(name, tool);
      post("register-tool", {
        tool: {
          name,
          description: String(tool.description || ""),
          parameters: tool.parameters || { type: "object", properties: {} },
          maxResultChars: Number(tool.maxResultChars) || undefined
        }
      });
      return () => {
        tools.delete(name);
        post("unregister-tool", { name });
      };
    }
  },
  menu: {
    add(item) {
      const id = String((item && item.id) || "").trim();
      if (!id) throw new Error("menu.id 不能为空");
      commands.set(id, item);
      post("register-menu", { item: { id, label: String(item.label || id) } });
      return () => {
        commands.delete(id);
        post("unregister-menu", { id });
      };
    }
  },
  settings: {
    get() { return Object.assign({}, settings); },
    async set(patch) {
      settings = Object.assign({}, settings, patch || {});
      post("settings-local", { settings });
      return rpc("settings.set", patch || {});
    },
    onChange(fn) {
      if (typeof fn !== "function") return () => {};
      settingsListeners.push(fn);
      return () => {
        settingsListeners = settingsListeners.filter((x) => x !== fn);
      };
    }
  },
  say: (text, holdMs) => rpc("pet.say", { text: String(text || ""), holdMs: Number(holdMs) || 6000 }),
  notify: (title, body) => rpc("pet.notify", { title: String(title || ""), body: String(body || "") }),
  log: (...args) => {
    post("log", { text: args.map((x) => typeof x === "string" ? x : stringify(x)).join(" ") });
  }
};

self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.type === "init") {
    settings = message.settings || {};
    try {
      const mod = await import(message.url);
      const activate =
        (mod && typeof mod.activate === "function" && mod.activate) ||
        (mod && mod.default && typeof mod.default.activate === "function" && mod.default.activate) ||
        (mod && typeof mod.default === "function" && mod.default) ||
        null;
      if (!activate) throw new Error("插件入口必须导出 activate(pet)");
      deactivateFn =
        (mod && typeof mod.deactivate === "function" && mod.deactivate) ||
        (mod && mod.default && typeof mod.default.deactivate === "function" && mod.default.deactivate) ||
        null;
      await activate(pet);
      post("ready", {});
    } catch (error) {
      post("fatal", { error: String((error && error.stack) || error) });
    }
    return;
  }

  if (message.type === "exec-tool") {
    const tool = tools.get(message.name);
    if (!tool) {
      post("tool-result", { id: message.id, ok: false, error: "插件工具不存在或已卸载" });
      return;
    }
    try {
      const value = await tool.execute(message.args || {}, {});
      post("tool-result", { id: message.id, ok: true, value });
    } catch (error) {
      post("tool-result", { id: message.id, ok: false, error: String((error && error.message) || error) });
    }
    return;
  }

  if (message.type === "run-command") {
    const command = commands.get(message.commandId);
    if (!command || typeof command.run !== "function") {
      post("command-result", { id: message.id, ok: false, error: "插件命令不存在" });
      return;
    }
    try {
      const value = await command.run();
      post("command-result", { id: message.id, ok: true, value });
    } catch (error) {
      post("command-result", { id: message.id, ok: false, error: String((error && error.message) || error) });
    }
    return;
  }

  if (message.type === "settings") {
    settings = message.settings || {};
    for (const fn of settingsListeners) {
      try { fn(Object.assign({}, settings)); } catch (_) { /* 插件自己的回调错误不能影响宿主 */ }
    }
    return;
  }

  if (message.type === "rpc-result") {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.value);
    else entry.reject(new Error(message.error || "宿主调用失败"));
    return;
  }

  if (message.type === "shutdown") {
    try { if (deactivateFn) await deactivateFn(); } catch (_) { /* 忽略卸载错误 */ }
    post("bye", {});
  }
};
`;
  workerBootstrapUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  return workerBootstrapUrl;
}

function hasPermission(record: PluginRecord, permission: string): boolean {
  return record.manifest.permissions.includes(permission);
}

function registerRecordTools(record: PluginRecord): void {
  for (const tool of record.tools.values()) {
    if (isBuiltinTool(tool.name) || toolOwner.has(tool.name)) {
      record.error = `工具名冲突：${tool.name}`;
      continue;
    }
    toolOwner.set(tool.name, record.manifest.id);
    const spec = {
      required: Array.isArray((tool.parameters as { required?: unknown }).required)
        ? ((tool.parameters as { required?: unknown[] }).required as unknown[]).map(String)
        : [],
      maxResultChars: tool.maxResultChars,
    };
    const dispose = registerToolSpec(tool.name, spec);
    record.disposers.push(dispose);
  }
}

function unregisterRecordTools(record: PluginRecord): void {
  for (const dispose of record.disposers.splice(0)) {
    try { dispose(); } catch { /* 忽略 */ }
  }
  for (const name of [...record.tools.keys()]) {
    if (toolOwner.get(name) === record.manifest.id) toolOwner.delete(name);
  }
}

function makeRecord(manifest: PluginManifest, dir: string, enabled: boolean): PluginRecord {
  const record: PluginRecord = {
    manifest,
    dir,
    enabled,
    loaded: false,
    error: "",
    worker: null,
    sourceUrl: "",
    tools: new Map(),
    menus: new Map(),
    settings: {},
    disposers: [],
    pending: new Map(),
    nextCallId: 1,
    readyTimer: null,
    resolveReady: null,
    rejectReady: null,
  };
  record.settings = loadSettings(record);
  return record;
}

function postToWorker(record: PluginRecord, message: unknown): void {
  record.worker?.postMessage(message);
}

function replyRpc(record: PluginRecord, id: number, ok: boolean, value?: unknown, error?: string): void {
  postToWorker(record, { type: "rpc-result", id, ok, value, error });
}

async function handleRpc(record: PluginRecord, id: number, method: string, params: Record<string, unknown>): Promise<void> {
  try {
    if (method === "pet.say") {
      if (!hasPermission(record, "pet.say")) throw new Error("缺少权限 pet.say");
      host.say(String(params.text ?? ""), Number(params.holdMs) || 6000);
      replyRpc(record, id, true, true);
      return;
    }
    if (method === "pet.notify") {
      if (!hasPermission(record, "pet.notify")) throw new Error("缺少权限 pet.notify");
      await invoke("send_notification", {
        title: String(params.title ?? "Petra"),
        body: String(params.body ?? ""),
      });
      replyRpc(record, id, true, true);
      return;
    }
    if (method === "settings.set") {
      if (!hasPermission(record, "pet.settings")) throw new Error("缺少权限 pet.settings");
      const patch = params && typeof params === "object" ? params : {};
      record.settings = { ...record.settings, ...(patch as Record<string, string | number | boolean>) };
      saveSettings(record);
      postToWorker(record, { type: "settings", settings: record.settings });
      replyRpc(record, id, true, record.settings);
      return;
    }
    throw new Error(`未知的 host API：${method}`);
  } catch (error) {
    replyRpc(record, id, false, undefined, normalizeError(error));
  }
}

function handleWorkerMessage(record: PluginRecord, message: Record<string, unknown>): void {
  const type = String(message.type ?? "");
  if (type === "ready") {
    if (record.readyTimer !== null) window.clearTimeout(record.readyTimer);
    record.readyTimer = null;
    record.loaded = true;
    record.error = "";
    registerRecordTools(record);
    record.resolveReady?.();
    record.resolveReady = null;
    record.rejectReady = null;
    return;
  }
  if (type === "fatal") {
    const error = normalizeError(message.error);
    record.loaded = false;
    record.error = error;
    if (record.readyTimer !== null) window.clearTimeout(record.readyTimer);
    record.readyTimer = null;
    record.rejectReady?.(new Error(error));
    record.resolveReady = null;
    record.rejectReady = null;
    return;
  }
  if (type === "register-tool") {
    if (!hasPermission(record, "pet.tools")) {
      record.error = "缺少权限 pet.tools，工具未注册";
      return;
    }
    const raw = message.tool as Partial<PluginToolDefinition> | undefined;
    const name = String(raw?.name ?? "").trim();
    if (!name) return;
    record.tools.set(name, {
      name,
      description: String(raw?.description ?? ""),
      parameters: (raw?.parameters as Record<string, unknown>) ?? { type: "object", properties: {} },
      maxResultChars: Number(raw?.maxResultChars) || undefined,
    });
    return;
  }
  if (type === "unregister-tool") {
    const name = String(message.name ?? "");
    record.tools.delete(name);
    return;
  }
  if (type === "register-menu") {
    if (!hasPermission(record, "pet.menu")) {
      record.error = "缺少权限 pet.menu，菜单项未注册";
      return;
    }
    const raw = message.item as Partial<PluginMenuDefinition> | undefined;
    const id = String(raw?.id ?? "").trim();
    if (!id) return;
    record.menus.set(id, { id, label: String(raw?.label ?? id) });
    host.onMenuChanged?.();
    return;
  }
  if (type === "unregister-menu") {
    record.menus.delete(String(message.id ?? ""));
    host.onMenuChanged?.();
    return;
  }
  if (type === "tool-result" || type === "command-result") {
    const id = Number(message.id);
    const entry = record.pending.get(id);
    if (!entry) return;
    record.pending.delete(id);
    window.clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.value);
    else entry.reject(new Error(String(message.error ?? "插件执行失败")));
    return;
  }
  if (type === "rpc") {
    void handleRpc(record, Number(message.id), String(message.method ?? ""), (message.params as Record<string, unknown>) ?? {});
    return;
  }
  if (type === "log") {
    console.log(`[plugin:${record.manifest.id}]`, String(message.text ?? ""));
  }
}

function callWorker(record: PluginRecord, message: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!record.worker || !record.loaded) {
      reject(new Error("插件未加载"));
      return;
    }
    const id = record.nextCallId++;
    const timer = window.setTimeout(() => {
      record.pending.delete(id);
      reject(new Error(`插件调用超时（${timeoutMs}ms）`));
    }, timeoutMs);
    record.pending.set(id, { resolve, reject, timer });
    postToWorker(record, { ...message, id });
  });
}

async function loadRecord(record: PluginRecord): Promise<void> {
  if (record.loaded || record.worker) return;
  record.error = "";
  try {
    const source = await invoke<string>("plugin_read_source", { id: record.manifest.id });
    const blob = new Blob([source], { type: "text/javascript" });
    record.sourceUrl = URL.createObjectURL(blob);
    const worker = new Worker(ensureWorkerBootstrap(), { type: "module" });
    record.worker = worker;
    const ready = new Promise<void>((resolve, reject) => {
      record.resolveReady = resolve;
      record.rejectReady = reject;
      record.readyTimer = window.setTimeout(() => {
        record.readyTimer = null;
        reject(new Error(`插件加载超时（${INIT_TIMEOUT_MS}ms）`));
      }, INIT_TIMEOUT_MS);
    });
    worker.onmessage = (event) => handleWorkerMessage(record, (event.data ?? {}) as Record<string, unknown>);
    worker.onerror = (event) => {
      const error = event.message || "Worker 运行错误";
      record.loaded = false;
      record.error = error;
      record.rejectReady?.(new Error(error));
    };
    worker.onmessageerror = () => {
      record.error = "插件消息无法反序列化";
    };
    worker.postMessage({ type: "init", url: record.sourceUrl, settings: record.settings });
    await ready;
  } catch (error) {
    record.loaded = false;
    record.error = normalizeError(error);
    record.worker?.terminate();
    record.worker = null;
    if (record.sourceUrl) URL.revokeObjectURL(record.sourceUrl);
    record.sourceUrl = "";
    throw error;
  }
}

function unloadRecord(record: PluginRecord): void {
  unregisterRecordTools(record);
  const worker = record.worker;
  if (worker) {
    try { worker.postMessage({ type: "shutdown" }); } catch { /* 忽略 */ }
    window.setTimeout(() => worker.terminate(), 80);
  }
  for (const entry of record.pending.values()) {
    window.clearTimeout(entry.timer);
    entry.reject(new Error("插件已卸载"));
  }
  record.pending.clear();
  record.worker = null;
  record.loaded = false;
  record.tools.clear();
  record.menus.clear();
  if (record.sourceUrl) URL.revokeObjectURL(record.sourceUrl);
  record.sourceUrl = "";
  if (record.readyTimer !== null) window.clearTimeout(record.readyTimer);
  record.readyTimer = null;
}

async function loadManifestEntries(): Promise<PluginListEntry[]> {
  try {
    return await invoke<PluginListEntry[]>("plugin_list");
  } catch (error) {
    console.warn("插件列表读取失败：", error);
    return [];
  }
}

async function initInternal(force: boolean): Promise<void> {
  if (initialized && !force) return;
  initialized = true;
  const enabledMap = loadEnabledMap();
  const entries = await loadManifestEntries();
  const next = new Map<string, PluginRecord>();
  for (const entry of entries) {
    try {
      const expectedId = entry.dir.split(/[\\/]/).pop() ?? "";
      const manifest = normalizeManifest(entry.manifest, expectedId);
      const enabled = enabledMap[manifest.id] ?? manifest.enabledByDefault;
      const record = makeRecord(manifest, entry.dir, enabled);
      next.set(manifest.id, record);
      if (enabled) {
        try {
          await loadRecord(record);
        } catch {
          // 单个插件失败不能拖垮启动；错误保留在 record.error，面板里能看到
        }
      }
    } catch (error) {
      const id = String((entry.manifest as { id?: unknown } | null)?.id ?? entry.dir);
      console.warn(`插件 manifest 无效（${id}）：`, error);
    }
  }
  records = next;
}

export const pluginRuntime = {
  async init(): Promise<void> {
    await initInternal(false);
  },

  async reloadAll(): Promise<void> {
    for (const record of records.values()) unloadRecord(record);
    records.clear();
    toolOwner.clear();
    initialized = false;
    await initInternal(true);
  },

  async reloadPlugin(id: string): Promise<void> {
    const record = records.get(id);
    if (!record) throw new Error(`插件不存在：${id}`);
    unloadRecord(record);
    if (record.enabled) await loadRecord(record);
  },

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const record = records.get(id);
    if (!record) throw new Error(`插件不存在：${id}`);
    record.enabled = enabled;
    const map = loadEnabledMap();
    map[id] = enabled;
    saveEnabledMap(map);
    if (enabled) {
      await loadRecord(record);
    } else {
      unloadRecord(record);
    }
  },

  async updateSettings(id: string, key: string, value: unknown): Promise<void> {
    const record = records.get(id);
    if (!record) throw new Error(`插件不存在：${id}`);
    record.settings = { ...record.settings, [key]: value as string | number | boolean };
    saveSettings(record);
    postToWorker(record, { type: "settings", settings: record.settings });
  },

  async removePlugin(id: string): Promise<void> {
    const record = records.get(id);
    if (!record) throw new Error(`插件不存在：${id}`);
    unloadRecord(record);
    await invoke("plugin_delete", { id });
    records.delete(id);
  },

  getOpenAITools(): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
    const out: Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> = [];
    for (const record of records.values()) {
      if (!record.loaded) continue;
      for (const tool of record.tools.values()) {
        out.push({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        });
      }
    }
    return out;
  },

  isPluginTool(name: string): boolean {
    return toolOwner.has(name);
  },

  async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    const owner = toolOwner.get(name);
    const record = owner ? records.get(owner) : undefined;
    if (!record) return `插件工具不存在：${name}`;
    try {
      const value = await callWorker(record, { type: "exec-tool", name, args });
      const text = typeof value === "string" ? value : safeJson(value);
      return text;
    } catch (error) {
      return `插件「${record.manifest.name}」执行失败：${normalizeError(error)}`;
    }
  },

  getMenuItems(): Array<PluginMenuDefinition & { pluginId: string; pluginName: string }> {
    const out: Array<PluginMenuDefinition & { pluginId: string; pluginName: string }> = [];
    for (const record of records.values()) {
      if (!record.loaded) continue;
      for (const menu of record.menus.values()) {
        out.push({ ...menu, pluginId: record.manifest.id, pluginName: record.manifest.name });
      }
    }
    return out;
  },

  async runCommand(pluginId: string, commandId: string): Promise<void> {
    const record = records.get(pluginId);
    if (!record || !record.loaded) {
      throw new Error(`插件未加载：${pluginId}`);
    }
    await callWorker(record, { type: "run-command", commandId });
  },

  getPanelPlugins(): PluginPanelInfo[] {
    return [...records.values()].map((record) => ({
      id: record.manifest.id,
      name: record.manifest.name,
      version: record.manifest.version,
      description: record.manifest.description ?? "",
      author: record.manifest.author ?? "",
      permissions: [...record.manifest.permissions],
      enabled: record.enabled,
      loaded: record.loaded,
      error: record.error,
      tools: [...record.tools.values()].map((t) => ({ name: t.name, description: t.description })),
      menus: [...record.menus.values()],
      settings: record.manifest.settings,
      values: { ...record.settings },
    }));
  },
};

export type { PluginSettingField };
