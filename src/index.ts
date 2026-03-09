import html from "./index.html";

export interface Env {
  WEATHER_KV: KVNamespace;
}

interface Location {
  name: string;
  lat: number;
  lon: number;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/") {
      return new Response(html, {
        headers: { "Content-Type": "text/html;charset=utf-8" },
      });
    }

    if (url.pathname === "/api/locations") {
      if (req.method === "GET") {
        const user = url.searchParams.get("user");
        if (!user)
          return new Response('{"error": "Missing user"}', {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });

        const locString = await env.WEATHER_KV.get(`user:${user}`);
        return new Response(locString || "[]", {
          headers: { "Content-Type": "application/json" },
        });
      } else if (req.method === "POST") {
        try {
          const body = (await req.json()) as {
            user: string;
            name: string;
            lat: number;
            lon: number;
          };
          if (!body.user || !body.name || body.lat == null || body.lon == null) {
            return new Response('{"error": "Missing fields"}', {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }

          const kvKey = `user:${body.user}`;
          const locString = await env.WEATHER_KV.get(kvKey);
          let locations: Location[] = locString ? JSON.parse(locString) : [];

          // Update or add
          const existingIndex = locations.findIndex((l) => l.name === body.name);
          if (existingIndex >= 0) {
            locations[existingIndex] = {
              name: body.name,
              lat: body.lat,
              lon: body.lon,
            };
          } else {
            if (locations.length >= 5) {
              return new Response('{"error": "最多只能添加5个位置"}', {
                status: 400,
                headers: { "Content-Type": "application/json" },
              });
            }
            locations.push({ name: body.name, lat: body.lat, lon: body.lon });
          }

          await env.WEATHER_KV.put(kvKey, JSON.stringify(locations));
          return new Response('{"success": true}', {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          return new Response('{"error": "Invalid JSON"}', {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
      } else if (req.method === "DELETE") {
        try {
          const body = (await req.json()) as { user: string; name: string };
          if (!body.user || !body.name) {
            return new Response('{"error": "Missing fields"}', {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }

          const kvKey = `user:${body.user}`;
          const locString = await env.WEATHER_KV.get(kvKey);
          if (locString) {
            let locations: Location[] = JSON.parse(locString);
            locations = locations.filter((l) => l.name !== body.name);
            await env.WEATHER_KV.put(kvKey, JSON.stringify(locations));
          }

          return new Response('{"success": true}', {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          return new Response('{"error": "Invalid JSON"}', {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
    }

    if (url.pathname === "/api/push" && req.method === "POST") {
      try {
        const body = (await req.json()) as { user: string };
        if (!body.user) {
          return new Response('{"error": "Missing user"}', {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const kvKey = `user:${body.user}`;
        const locString = await env.WEATHER_KV.get(kvKey);
        if (locString) {
          const locations: Location[] = JSON.parse(locString);
          for (const loc of locations) {
            await checkWeatherAndNotify(body.user, loc, env);
          }
        }

        return new Response('{"success": true}', {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response('{"error": "Invalid JSON"}', {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    let cursor: string | undefined;
    const fetchPromises: Promise<void>[] = [];

    do {
      const result = await env.WEATHER_KV.list({ prefix: "user:", cursor });
      for (const key of result.keys) {
        const username = key.name.replace("user:", "");

        fetchPromises.push(
          (async () => {
            const locationsString = await env.WEATHER_KV.get(key.name);
            if (!locationsString) return;

            const locations: Location[] = JSON.parse(locationsString);
            for (const loc of locations) {
              await checkWeatherAndNotify(username, loc, env);
            }
          })(),
        );
      }
      cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);

    await Promise.all(fetchPromises);
  },
} satisfies ExportedHandler<Env>;

async function checkWeatherAndNotify(username: string, loc: Location, env: Env) {
  try {
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&hourly=weather_code,temperature_2m&forecast_hours=24&timezone=auto`;
    const resp = await fetch(weatherUrl);
    if (!resp.ok) return;

    const data = (await resp.json()) as any;
    const hourlyTimes = data.hourly?.time;
    const weatherCodes = data.hourly?.weather_code;
    const temps = data.hourly?.temperature_2m;

    if (!hourlyTimes || !weatherCodes || !temps) return;

    // Load history
    const historyKey = `history:${username}:${loc.name}`;
    const historyStr = await env.WEATHER_KV.get(historyKey);
    let history: string[] = historyStr ? JSON.parse(historyStr) : [];
    const historySet = new Set(history);

    let badWeatherDetected = false;
    let occurrences: string[] = [];
    let titleEmoji = "⚠️";
    let historyUpdated = false;

    for (let i = 0; i < weatherCodes.length; i++) {
      const code = weatherCodes[i];
      const info = getWeatherInfo(code);
      if (info.isBad) {
        // Create unique identifier: time + code
        const time = hourlyTimes[i];
        const identifier = `${time}|${code}`;

        if (historySet.has(identifier)) {
          continue;
        }

        if (!badWeatherDetected) {
          badWeatherDetected = true;
          titleEmoji = info.emoji; // Use the first bad weather emoji for the title
        }

        // hourlyTimes[i] format is "YYYY-MM-DDTHH:MM" like "2026-03-05T08:00"
        const timeStr = time.substring(5).replace("T", " ");
        occurrences.push(`🕒 ${timeStr} | 🌡️ ${temps[i]}°C | ${info.emoji} ${info.desc}`);

        history.push(identifier);
        historyUpdated = true;
      }
    }

    if (occurrences.length > 0) {
      const baiduWeatherUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(loc.name + "天气")}`;
      const alertMessage = `${username} 你好，未来24小时不良天气预警！\n${occurrences.join("\n")}`;

      await fetch("https://ntfy.sh/tingyuan-weather-alert-" + username, {
        method: "POST",
        body: alertMessage,
        headers: {
          Title: `${loc.name} ${titleEmoji} 未来24小时天气预警`,
          Tags: "warning,weather",
          Actions: `view, 查看百度天气, ${baiduWeatherUrl}`,
        },
      });

      if (historyUpdated) {
        // Keep only the last 24 entries
        if (history.length > 24) {
          history = history.slice(-24);
        }
        await env.WEATHER_KV.put(historyKey, JSON.stringify(history));
      }
    }
  } catch (e) {
    console.error(`Error checking weather for ${username} - ${loc.name}:`, e);
  }
}

function getWeatherInfo(code: number): {
  desc: string;
  emoji: string;
  isBad: boolean;
} {
  if (code === 0) return { desc: "晴朗", emoji: "☀️", isBad: false };
  if (code >= 1 && code <= 3) return { desc: "多云", emoji: "⛅", isBad: false };
  if (code >= 45 && code <= 48) return { desc: "雾天", emoji: "🌫️", isBad: false };
  if (code >= 51 && code <= 57) return { desc: "毛毛雨", emoji: "🌧️", isBad: true };
  if (code >= 61 && code <= 67) return { desc: "雨天", emoji: "🌧️", isBad: true };
  if (code >= 71 && code <= 77) return { desc: "雪天", emoji: "❄️", isBad: true };
  if (code >= 80 && code <= 82) return { desc: "阵雨", emoji: "🌦️", isBad: true };
  if (code >= 85 && code <= 86) return { desc: "阵雪", emoji: "🌨️", isBad: true };
  if (code >= 95 && code <= 99) return { desc: "雷暴", emoji: "⛈️", isBad: true };
  return { desc: "未知天气", emoji: "❓", isBad: false };
}
