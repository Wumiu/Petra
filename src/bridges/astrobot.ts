/**
 * Astrobot 桥接预留接口。
 *
 * 未来接入 astrobot（AI 对话/表情生成）时：
 *  - 外部进程/脚本 → 桌宠：`window.__ASTROBOT__.emit({ type, payload })`
 *    （或向本窗口派发自定义事件 `document.dispatchEvent(new CustomEvent("astrobot:cmd", { detail }))`）
 *  - 桌宠 → 外部：订阅侧通道预留，尚未实现。
 *
 * 当前只做兜底：收到指令打日志，并转发给注册的业务钩子（如弹反馈动画）。
 */

export type AstrobotCommandName = "speak" | "emote" | "gesture" | "move" | "react";

export interface AstrobotMessage {
  type: AstrobotCommandName;
  payload: Record<string, unknown>;
  timestamp: number;
}

type Hook = (msg: AstrobotMessage) => void;

const hooks: Hook[] = [];

export function astrobotOn(hook: Hook): () => void {
  hooks.push(hook);
  return () => {
    const i = hooks.indexOf(hook);
    if (i >= 0) hooks.splice(i, 1);
  };
}

function dispatch(msg: AstrobotMessage) {
  console.info("[astrobot]", msg);
  for (const h of hooks) {
    try {
      h(msg);
    } catch {
      /* 忽略业务钩子错误 */
    }
  }
}

document.addEventListener("astrobot:cmd", (e) => {
  const detail = (e as CustomEvent).detail as Partial<AstrobotMessage>;
  if (!detail || !detail.type) return;
  dispatch({
    type: detail.type as AstrobotMessage["type"],
    payload: detail.payload ?? {},
    timestamp: detail.timestamp ?? Date.now(),
  });
});

// 全局入口：window.__ASTROBOT__.emit(...)
declare global {
  interface Window {
    __ASTROBOT__?: {
      emit: (msg: Partial<AstrobotMessage>) => void;
      on: (hook: Hook) => () => void;
    };
  }
}

window.__ASTROBOT__ = {
  emit: (msg) => {
    const full: AstrobotMessage = {
      type: msg.type ?? "react",
      payload: msg.payload ?? {},
      timestamp: msg.timestamp ?? Date.now(),
    };
    dispatch(full);
  },
  on: astrobotOn,
};