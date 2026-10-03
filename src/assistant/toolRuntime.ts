/**
 * 小助手工具调用的「运行时」：参数校验、结果截断、错误措辞、轮次/重复预算。
 *
 * 这些逻辑不碰 DOM，方便直接单测（tests/assistant-tools.test.js）。
 * 设计上参考通用 Agent 运行时的几条硬规矩：
 *  1. 每个 tool_call 必须且只能回一条 tool 结果 —— 留一条悬空的 tool_calls 会让下一轮请求直接 400；
 *  2. 参数错误 / 未知工具要当成"可读的失败"回给模型（它才知道怎么改），不要静默丢弃或抛异常；
 *  3. 工具结果必须截断，否则一次 run_shell 的输出就能把上下文和 token 预算吃掉；
 *  4. 有轮次与重复调用预算，避免模型在同一件事上原地打转。
 */

export interface ToolSpec {
  /** 必填参数（缺失时不发 IPC，直接回一条可读的失败） */
  required?: string[];
  /** 结果超过这个长度就截断（字符） */
  maxResultChars?: number;
  /** 只读工具：不改动系统状态（留给未来做同轮并发执行） */
  readOnly?: boolean;
  /** 需要用户确认的高风险操作 */
  confirm?: boolean;
}

/** 工具清单：名字必须与 AssistantClient 的 TOOLS 定义保持一致 */
export const TOOL_SPECS: Record<string, ToolSpec> = {
  launch_application: { required: ["application"] },
  run_shell: { required: ["command"], maxResultChars: 4000, confirm: true },
  remember: { required: ["content"] },
  set_volume: {},
  set_reminder: { required: ["minutes", "message"] },
  get_weather: { maxResultChars: 1200, readOnly: true },
  schedule_shutdown: { required: ["minutes"] },
  cancel_shutdown: {},
  search_web: { required: ["query"] },
  open_url: { required: ["url"] },
  open_path: { required: ["path"] },
  list_installed_apps: { maxResultChars: 2000, readOnly: true },
  active_window_title: { maxResultChars: 400, readOnly: true },
  get_idle_seconds: { readOnly: true },
  send_notification: { required: ["title"] },
  lock_screen: {},
  daily_card: { maxResultChars: 900 },
  view_diary: { maxResultChars: 3000, readOnly: true },
};

/** 没写 maxResultChars 的工具统一用这个上限 */
export const DEFAULT_MAX_RESULT_CHARS = 1500;

export function toolNames(): string[] {
  return Object.keys(TOOL_SPECS);
}

export function isKnownTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_SPECS, name);
}

/** 参数校验结果 */
export type ToolArgCheck = { ok: true } | { ok: false; message: string };

/**
 * 校验工具名与必填参数。
 * 未知工具会顺带把可用工具列出来（模型编造工具名是常见失败模式）。
 */
export function validateToolArgs(name: string, args: Record<string, unknown>): ToolArgCheck {
  if (!isKnownTool(name)) {
    return {
      ok: false,
      message: `未知工具「${name}」，没有这个工具。可用工具只有：${toolNames().join("、")}。请改用其中之一，不要编造工具名。`,
    };
  }
  const spec = TOOL_SPECS[name];
  const missing = (spec.required ?? []).filter((key) => {
    const v = args[key];
    if (v === undefined || v === null) return true;
    // 空字符串同样算缺失；数字 0 / false 是合法值
    return typeof v === "string" && v.trim() === "";
  });
  if (missing.length > 0) {
    return {
      ok: false,
      message: `工具「${name}」缺少必填参数：${missing.join("、")}。请带上完整参数重新调用一次。`,
    };
  }
  return { ok: true };
}

/** 统一的失败文本（会作为 tool 消息回给模型，它据此自我纠正） */
export function formatToolError(name: string, reason: string, hint = ""): string {
  return `❌ ${name} 调用失败：${reason}${hint ? `\n提示：${hint}` : ""}`;
}

/** 工具结果按工具名截断：保留开头和结尾，中间省略，避免一次输出吃掉 token 预算 */
export function truncateToolResult(name: string, text: string): string {
  const cap = TOOL_SPECS[name]?.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  if (text.length <= cap) return text;
  const head = Math.ceil(cap * 0.6);
  const tail = cap - head;
  const omitted = text.length - cap;
  return `${text.slice(0, head)}\n…（中间省略 ${omitted} 字：结果过长已截断）…\n${text.slice(text.length - tail)}`;
}

/** 解析模型给的参数 JSON；失败时返回原因，而不是静默当成空参数执行 */
export function parseArgsSafe(raw: string): { args: Record<string, unknown>; error?: string } {
  const s = (raw ?? "").trim();
  if (!s) return { args: {} };
  try {
    const parsed = JSON.parse(s);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { args: {}, error: `参数必须是 JSON 对象，收到的是：${shorten(s)}` };
    }
    return { args: parsed as Record<string, unknown> };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { args: {}, error: `参数不是合法 JSON（${why}）：${shorten(s)}` };
  }
}

function shorten(s: string, max = 120): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 一次调用的指纹：用来识别"同样的调用又发了一遍"（键顺序不影响指纹） */
export function callSignature(name: string, args: Record<string, unknown>): string {
  let json = "";
  try {
    json = JSON.stringify(sortKeys(args ?? {}));
  } catch {
    json = String(args);
  }
  return `${name}(${json})`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export interface ToolLoopLimits {
  /** 一次对话最多几轮"模型 → 工具 → 模型"往返 */
  maxRounds?: number;
  /** 一次对话最多几次工具调用（含无效调用） */
  maxCalls?: number;
}

/**
 * 工具循环预算。
 * 轮数与次数双上限：模型一口气发多个调用、或在两个工具之间来回试探，都会被这里刹住。
 */
export class ToolLoopBudget {
  readonly maxRounds: number;
  readonly maxCalls: number;
  rounds = 0;
  calls = 0;
  private readonly seen = new Set<string>();

  constructor(limits: ToolLoopLimits = {}) {
    this.maxRounds = limits.maxRounds ?? 6;
    this.maxCalls = limits.maxCalls ?? 12;
  }

  /** 进入新一轮；false 表示轮数已用完，应该收尾了 */
  nextRound(): boolean {
    if (this.rounds >= this.maxRounds) return false;
    this.rounds += 1;
    return true;
  }

  canCall(): boolean {
    return this.calls < this.maxCalls;
  }

  remainingCalls(): number {
    return Math.max(0, this.maxCalls - this.calls);
  }

  /**
   * 记一次调用（无效调用也计入预算）。返回需要附加给模型的提示：
   * 同名同参数的调用第二次出现时提醒它别原地打转。
   */
  noteCall(name: string, args: Record<string, unknown>): string {
    this.calls += 1;
    const sig = callSignature(name, args);
    if (this.seen.has(sig)) {
      return `⚠️ 这次对话里你已经用相同参数调用过 ${name}，结果就在上文，不要重复调用：请直接用已有结果回答，或换一个工具/参数。`;
    }
    this.seen.add(sig);
    return "";
  }

  /** 预算用尽时的收尾说明（空串表示还有余量） */
  exhaustedNote(): string {
    if (this.calls >= this.maxCalls) return `（本轮工具调用已达上限 ${this.maxCalls} 次，先停在这里）`;
    if (this.rounds >= this.maxRounds) return `（本轮工具往返已达上限 ${this.maxRounds} 轮，先停在这里）`;
    return "";
  }
}
