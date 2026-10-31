// Pure helpers: dates, names and addresses, avatars.

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

// A From header or one To entry as {name, address}: `Name <addr>` splits; anything else is an address with no name.
export function splitAddress(s: string) {
  const m = s.match(/^\s*"?(.*?)"?\s*<([^>]*)>\s*$/);
  return m ? { name: m[1], address: m[2] } : { name: "", address: s.trim() };
}

// Display name of a From header: the Name of `Name <addr>`, else the address.
export function senderName(from: string) {
  const { name, address } = splitAddress(from);
  return name || address;
}

// The entries of a To header, split at commas outside double quotes.
// shortcut: a backslash-escaped quote inside a quoted name is not understood, upgrade if such a header shows up.
function splitRecipients(to: string) {
  const entries: string[] = [];
  let entry = "";
  let quoted = false;
  for (const c of to) {
    if (c === '"') quoted = !quoted;
    if (c === "," && !quoted) {
      entries.push(entry);
      entry = "";
    } else {
      entry += c;
    }
  }
  entries.push(entry);
  return entries.map((e) => e.trim()).filter(Boolean);
}

// The To line of a message: "To 自分" when `account` is among the recipients, else the recipients' names (or addresses); "" with no To.
export function recipientsLabel(to: string, account: string) {
  const people = splitRecipients(to).map(splitAddress);
  if (!people.length) return "";
  if (people.some((p) => p.address.toLowerCase() === account.toLowerCase())) return "To 自分";
  return `To ${people.map((p) => p.name || p.address).join(", ")}`;
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
