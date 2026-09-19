/**
 * 信息板天气解析测试（纯逻辑）：
 * - 后端 `城市|描述|温度|最高|最低|降雨|定位可疑` 的解析（含失败行与旧格式）
 * - 指定城市优先显示、定位可疑时的提示
 * - HTML 转义（描述/城市来自外部接口，不能直接拼进 innerHTML）
 *
 * 运行：npm run test:weather
 */
const w = require("./build/features/weather/WeatherFormat.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

// ---------- 解析 ----------
const ok = w.parseWeather("Beijing|Sunny|25|28|20|10|0");
check("解析城市/描述/温度", ok && ok.city === "Beijing" && ok.desc === "Sunny" && ok.temp === "25");
check("解析最高/最低/降雨", ok && ok.maxT === "28" && ok.minT === "20" && ok.rain === "10");
check("定位正常时不标可疑", ok && ok.suspect === false);

const suspect = w.parseWeather("Sarugakucho|Light rain|22|25|19|80|1");
check("定位可疑标记", suspect && suspect.suspect === true && suspect.city === "Sarugakucho");

const legacy = w.parseWeather("上海|多云|20|24|16|30");
check("旧格式（6 段）也能解析", legacy && legacy.city === "上海" && legacy.suspect === false);

check("失败行解析为 null", w.parseWeather("获取失败|天气获取失败|—|—|—|—|") === null);
check("段数不足为 null", w.parseWeather("Beijing|Sunny") === null);
check("空串为 null", w.parseWeather("") === null);

// ---------- 展示 ----------
const html = w.formatWeatherHtml("Beijing|Sunny|25|28|20|10|0");
check("展示两行", html.split("\n").length === 2, JSON.stringify(html));
check("展示含城市与温度", html.includes("Beijing") && html.includes("25°C"));
check("展示含最高最低与降雨", html.includes("最高 28°") && html.includes("降雨 10%"));

const withCity = w.formatWeatherHtml("Pootung|Cloudy|18|21|15|5|0", "上海");
check("指定城市优先", withCity.startsWith("上海") && !withCity.includes("Pootung"), withCity);

const suspectHtml = w.formatWeatherHtml("Sarugakucho|Light rain|22|25|19|80|1");
check("定位可疑有提示", suspectHtml.includes("定位可能受代理影响") && suspectHtml.includes("天气城市"));
check("正常天气没有提示", !html.includes("定位可能受代理影响"));

const injected = w.formatWeatherHtml('<img src=x onerror="1">|晴|1|1|1|1|0');
check("描述里的 HTML 被转义", !injected.includes("<img") && injected.includes("&lt;img"));
const injectedCity = w.formatWeatherHtml("Beijing|晴|1|1|1|1|0", '<b>上海</b>');
check("城市名里的 HTML 被转义", !injectedCity.includes("<b>") && injectedCity.includes("&lt;b&gt;"));

check("失败时给出失败文案", w.formatWeatherHtml("") === w.WEATHER_FAILED);

// ---------- emoji ----------
check("晴天 emoji", w.weatherEmoji("晴") === "☀️");
check("雨天 emoji", w.weatherEmoji("小雨") === "🌧");
check("雪天 emoji", w.weatherEmoji("Light snow") === "❄️");
check("未知描述有兜底 emoji", w.weatherEmoji("") === "🌤");

console.log("weather: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
process.exit(fail ? 1 : 0);
