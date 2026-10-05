/**
 * AI 输出语言的共用逻辑。
 *
 * `settings.assistant.outputLanguage` 是 explicit_language 代码（"en"/"ja"/…），
 * 空串或 "zh-cn" 表示中文。所有「会产出面向用户文本」的 AI 调用都应通过
 * 本模块拼语言指令，避免各出口各写一份、漏掉某些路径。
 */

/** explicit_language 代码 → 中文名 */
const LANG_NAMES: Record<string, string> = {
  "en": "英语", "ja": "日语", "ko": "韩语", "fr": "法语", "de": "德语",
  "es-es": "西班牙语", "ru": "俄语", "th": "泰语", "vi": "越南语",
  "it": "意大利语", "pt": "葡萄牙语", "ar": "阿拉伯语",
};

/** 语言代码转中文名；未知代码原样返回 */
export function langNameOf(code: string): string {
  return LANG_NAMES[code] ?? code;
}

export interface LanguageInstructionOptions {
  /** 附加「原文 + --- + 中文翻译」的输出格式要求 */
  withTranslation?: boolean;
  /** 中文/自动时也返回一条「用中文」的指令（默认为空串，即不干预） */
  pinChinese?: boolean;
}

/**
 * 生成注入 prompt 的语言指令。中文/自动且未开 pinChinese 时返回空串。
 *
 * 指令语言与输出语言无关：prompt 本身可以是中文，模型仍会按这条指令换语言。
 */
export function buildLanguageInstruction(
  outputLanguage: string,
  opts: LanguageInstructionOptions = {},
): string {
  if (!outputLanguage || outputLanguage === "zh-cn") {
    return opts.pinChinese ? "【最高优先级·最终指令】你必须全程用中文回复用户。" : "";
  }
  const name = langNameOf(outputLanguage);
  const base =
    `【最高优先级·最终指令】你必须全程用${name}回复用户，不管用户说什么语言。` +
    `回复中绝对不要夹杂中文，哪怕用户用中文提问也要用${name}回答。`;
  return opts.withTranslation
    ? `${base}回复格式：第一行是${name}原文，然后换行写---，再换行写中文翻译。`
    : base;
}

/**
 * 按首个 `---` 分隔符把模型输出拆成「原文 + 中文译文」。
 * 没有分隔符时整段视为原文、译文为空。
 */
export function splitTranslation(raw: string): { main: string; trans: string } {
  const m = /-{3,}/.exec(raw);
  if (!m) return { main: raw.trim(), trans: "" };
  return {
    main: raw.slice(0, m.index).trim(),
    trans: raw.slice(m.index + m[0].length).trim(),
  };
}
