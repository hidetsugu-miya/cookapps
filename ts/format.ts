// Pure helpers: dates, avatars.

// Gmail snippets arrive HTML-escaped (e.g. &#39;).
export const unescapeHtml = (s: string) => new DOMParser().parseFromString(s, "text/html").documentElement.textContent ?? "";

export const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

export const pad2 = (n: number) => String(n).padStart(2, "0");
export const isoDate = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
// Local midnight of the "YYYY-MM-DD" date, `days` later.
export const addDays = (iso: string, days: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d + days);
};
export const hhmm = (min: number) => `${Math.floor(min / 60)}:${pad2(min % 60)}`;

// Short list date: today "9:05", this year "10月17日", older "2025/10/17".
export function formatDate(ms: number, now = Date.now()) {
  const d = new Date(ms);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

// The label of a day in a list: "今日", "昨日", this year "10月27日（火）", older "2025年10月27日（月）".
export function formatDay(ms: number, now = Date.now()) {
  const d = new Date(ms);
  const n = new Date(now);
  const daysAgo = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
  if (daysAgo === 0) return "今日";
  if (daysAgo === 1) return "昨日";
  const day = `${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS[d.getDay()]}）`;
  return d.getFullYear() === n.getFullYear() ? day : `${d.getFullYear()}年${day}`;
}

// Date of a message in the detail view: today "7:12（30 分前）", this year "10月29日 13:05", older "2025/10/17 13:05".
export function formatDetailDate(ms: number, now = Date.now()) {
  const d = new Date(ms);
  const clock = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() !== new Date(now).toDateString()) return `${formatDate(ms, now)} ${clock}`;
  const minutes = Math.max(1, Math.floor((now - ms) / 60000));
  return `${clock}（${minutes < 60 ? `${minutes} 分前` : `${Math.floor(minutes / 60)} 時間前`}）`;
}

// Up to two initials (first letters of the first two words), uppercased.
export function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => Array.from(w)[0])
      .join("")
      .toUpperCase() || "?"
  );
}

// Same string, same color; no image is fetched from outside.
export function avatarColor(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.codePointAt(0)!) >>> 0;
  return `hsl(${h % 360} 55% 45%)`;
}

export const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};
