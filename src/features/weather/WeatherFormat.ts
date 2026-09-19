/**
 * 信息板天气的解析与展示（纯函数，方便单测：tests/weather.test.js）。
 *
 * 后端返回格式：`城市|描述|温度|最高|最低|降雨%|定位可疑`
 * 最后一段是 0/1：后端比较了"系统区域"和"IP 定位到的国家"，
 * 不一致说明多半是代理出口（实测开梯子时 wttr.in 会返回 Tokyo/Japan），
 * 于是这一条会提示用户去设置里指定城市。
 */

export interface WeatherInfo {
  city: string;
  desc: string;
  temp: string;
  maxT: string;
  minT: string;
  rain: string;
  /** 定位疑似被代理带偏（系统区域与定位国家不符） */
  suspect: boolean;
}

export const WEATHER_FAILED = "天气获取失败";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 解析后端输出；不足 6 段或明显失败时返回 null */
export function parseWeather(raw: string): WeatherInfo | null {
  const parts = (raw || "").split("|").map((s) => s.trim());
  if (parts.length < 6) return null;
  const [city, desc, temp, maxT, minT, rain, suspect] = parts;
  if (!desc || desc.includes("获取失败")) return null;
  return { city, desc, temp, maxT, minT, rain, suspect: suspect === "1" };
}

/** 天气描述 → emoji */
export function weatherEmoji(desc: string): string {
  const d = (desc || "").toLowerCase();
  if (d.includes("晴") || d.includes("sunny") || d.includes("clear")) return "☀️";
  if (d.includes("多云") || d.includes("cloud")) return "⛅";
  if (d.includes("阴") || d.includes("overcast")) return "☁️";
  if (d.includes("雨") || d.includes("rain")) return "🌧";
  if (d.includes("雪") || d.includes("snow")) return "❄️";
  if (d.includes("雷") || d.includes("thunder")) return "⛈";
  if (d.includes("雾") || d.includes("fog") || d.includes("mist")) return "🌫";
  return "🌤";
}

/**
 * 组装信息板里的天气文本（多行，面板用 white-space: pre-line 显示）。
 * `configuredCity` 是用户在设置里指定的城市名：指定了就优先显示它
 * （wttr.in 对国内城市的英文/拼音写法很怪，例如上海会返回 "Pootung"）。
 */
export function formatWeatherHtml(raw: string, configuredCity = ""): string {
  const info = parseWeather(raw);
  if (!info) return WEATHER_FAILED;
  const city = configuredCity.trim() || info.city;
  const lines = [
    `${escapeHtml(city)}　${weatherEmoji(info.desc)} ${escapeHtml(info.desc)} ${escapeHtml(info.temp)}°C`,
    `最高 ${escapeHtml(info.maxT)}° / 最低 ${escapeHtml(info.minT)}° · 降雨 ${escapeHtml(info.rain)}%`,
  ];
  if (info.suspect) {
    lines.push("⚠️ 定位可能受代理影响，可在「小助手设置 → 天气城市」指定城市");
  }
  return lines.join("\n");
}
