import { toast } from "./Toast";
import { getVisibleRect } from "./visible";
import { trackEvent } from "../features/diary/DiaryEventTracker";

/** 待办项 */
export interface Reminder {
  id: number;
  time: number;      // 到期时间戳（ms）
  text: string;
  done?: boolean;
}

const STORAGE_KEY = "petra-reminders";
const CHECK_INTERVAL = 10000; // 10 秒检查一次

let reminders: Reminder[] = [];
let nextId = 1;
let modalEl: HTMLElement | null = null;

/** 从 localStorage 载入 */
function load(): Reminder[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as Reminder[];
    nextId = arr.reduce((m, r) => Math.max(m, r.id + 1), 1);
    return arr;
  } catch {
    return [];
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(reminders));
  } catch {
    /* ignore */
  }
}

export function fmtReminderTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 当前待办列表（按时间升序，未完成在前） */
export function getReminders(): Reminder[] {
  const now = Date.now();
  return [...reminders].sort((a, b) => {
    if (!!a.done !== !!b.done) return a.done ? 1 : -1;
    return a.time - b.time;
  });
}

export function removeReminder(id: number) {
  reminders = reminders.filter((r) => r.id !== id);
  save();
}

export function addReminder(time: number, text: string) {
  reminders.push({ id: nextId++, time, text });
  save();
  toast(`已添加提醒：${text}`);
}

/** 检查到期提醒（Windows 托盘通知 + toast 兜底） */
export function checkDue() {
  const now = Date.now();
  let changed = false;
  for (const r of reminders) {
    if (!r.done && r.time <= now) {
      r.done = true;
      // 模型头顶大气泡 + 提示音（main.ts 监听渲染）
      document.dispatchEvent(new CustomEvent("reminder-due", { detail: { text: r.text } }));
      // 记录提醒完成事件（日记系统）
      trackEvent({ type: "reminder_done", summary: r.text });
      changed = true;
    }
  }
  if (changed) save();
}

/** 弹出"添加待办"填写窗口（模态框） */
export function openReminderModal() {
  if (modalEl) {
    modalEl.classList.remove("hidden");
    return;
  }
  modalEl = document.createElement("div");
  modalEl.className = "rm-modal";

  const box = document.createElement("div");
  box.className = "rm-modal-box";

  const title = document.createElement("div");
  title.className = "rm-modal-title";
  title.textContent = "添加待办";

  const timeInput = document.createElement("input");
  timeInput.type = "datetime-local";
  timeInput.className = "rm-modal-input";
  timeInput.value = defaultTime();

  const textInput = document.createElement("input");
  textInput.type = "text";
  textInput.placeholder = "提醒内容…";
  textInput.className = "rm-modal-input";

  const btns = document.createElement("div");
  btns.className = "rm-modal-btns";
  const cancel = document.createElement("button");
  cancel.className = "as-btn";
  cancel.textContent = "取消";
  const ok = document.createElement("button");
  ok.className = "as-btn as-btn-primary";
  ok.textContent = "添加";

  const close = () => {
    modalEl?.classList.add("hidden");
  };

  cancel.addEventListener("click", close);
  ok.addEventListener("click", () => {
    const t = textInput.value.trim();
    const v = timeInput.value;
    if (!t || !v) {
      toast("请填写提醒内容和时间", "warn");
      return;
    }
    const ts = new Date(v).getTime();
    if (Number.isNaN(ts)) {
      toast("请选择有效时间", "warn");
      return;
    }
    addReminder(ts, t);
    close();
    // 通知信息版刷新（如果可见）
    document.dispatchEvent(new CustomEvent("reminders-changed"));
  });
  textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") ok.click();
  });

  btns.append(cancel, ok);
  box.append(title, timeInput, textInput, btns);
  modalEl.appendChild(box);

  // 点击遮罩关闭
  modalEl.addEventListener("pointerdown", (e) => {
    if (e.target === modalEl) close();
  });

  document.body.appendChild(modalEl);
  // 贴边自适应：模态框在窗口可见区内居中，避免窗口部分出屏时被裁
  const vr = getVisibleRect();
  const bw = box.offsetWidth || 280;
  const bh = box.offsetHeight || 200;
  box.style.position = "fixed";
  box.style.left = `${Math.round(vr.left + Math.max(0, (vr.right - vr.left - bw) / 2))}px`;
  box.style.top = `${Math.round(vr.top + Math.max(0, (vr.bottom - vr.top - bh) / 2))}px`;
  // 焦点到文本输入
  setTimeout(() => textInput.focus(), 50);
}

/** 默认时间为当前时间 +1 小时（取整到 5 分钟），格式 HH:mm（今天） */
function defaultTime(): string {
  const d = new Date(Date.now() + 3600000);
  d.setMinutes(Math.floor(d.getMinutes() / 5) * 5, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

let checked = false;
/** 初始化：载入数据 + 启动到期检查 */
export function setupReminder() {
  reminders = load();
  if (!checked) {
    checked = true;
    setInterval(checkDue, CHECK_INTERVAL);
  }
}
