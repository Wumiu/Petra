/**
 * 整点播报的免打扰时段：直接做在右键菜单里的行内控件，不单开窗口。
 *
 * 菜单里的样子（⏰ 整点播报 子菜单）：
 *   免打扰              23→08      ← 点一下开关免打扰
 *   时段         ▼ 23 ▲ 到 ▼ 08 ▲  ← 左右两块调时，缩在一栏里
 *
 * 注意：这里通过 `read()` **实时读当前设置**，不能存快照 ——
 * 之前存了快照，点 ▲▼ 时值写进了设置但数字显示的还是旧快照，看起来就是"点了没反应"。
 */
import type { MenuItemSpec } from "../../ui/ContextMenu";
import { formatQuietRange, stepHour } from "./HourlyChime";

export interface QuietRangeSettings {
  enabled: boolean;
  start: number;
  end: number;
}

/** 一行里的小控件：▼ 值 ▲ （左减右加，0~23 循环） */
function appendStepper(
  row: HTMLElement,
  get: () => number,
  bump: (delta: number) => void,
): void {
  const wrap = document.createElement("span");
  wrap.className = "hq-inline";

  const down = document.createElement("button");
  down.type = "button";
  down.className = "hq-inline-btn";
  down.textContent = "▼";
  down.title = "减一小时";

  const value = document.createElement("span");
  value.className = "hq-inline-val";

  const up = document.createElement("button");
  up.type = "button";
  up.className = "hq-inline-btn";
  up.textContent = "▲";
  up.title = "加一小时";

  const paint = () => {
    value.textContent = String(get()).padStart(2, "0");
  };
  paint();

  down.addEventListener("click", (ev) => {
    ev.stopPropagation();
    bump(-1);
    paint();
  });
  up.addEventListener("click", (ev) => {
    ev.stopPropagation();
    bump(1);
    paint();
  });

  wrap.append(down, value, up);
  row.appendChild(wrap);
}

/**
 * 生成菜单项。
 * `read` 每次都重新取当前设置（保证显示与真实设置一致）；
 * `onChange` 只回传变化的部分，由 main.ts 统一写设置并按新时段重装定时器。
 */
export function buildHourlyQuietMenuItems(
  read: () => QuietRangeSettings,
  onChange: (patch: Partial<QuietRangeSettings>) => void,
): MenuItemSpec[] {
  const now = read();

  /** 两个调时控件挤在同一栏里 */
  const rangeRow = (row: HTMLElement) => {
    appendStepper(row, () => read().start, (d) => onChange({ start: stepHour(read().start, d) }));
    const to = document.createElement("span");
    to.className = "hq-inline-to";
    to.textContent = "到";
    row.appendChild(to);
    appendStepper(row, () => read().end, (d) => onChange({ end: stepHour(read().end, d) }));
  };

  return [
    {
      id: "hourly-quiet-toggle",
      label: "免打扰",
      state: now.enabled ? formatQuietRange(now.start, now.end, true) : "关",
      onPick: () => onChange({ enabled: !now.enabled }),
    },
    {
      id: "hourly-quiet-range",
      label: "时段",
      control: rangeRow,
    },
  ];
}
