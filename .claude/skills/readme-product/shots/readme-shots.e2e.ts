// Temporary: the product screenshots of the README. Not a test; made-up data only.
import type { Info } from "../../ts/bindings/Info";
import type { OrcaRow } from "../../ts/bindings/OrcaRow";
import type { TaskItem } from "../../ts/bindings/TaskItem";
import type { HandoffSummary } from "../../ts/bindings/HandoffSummary";
import type { OrcaWorktree } from "../../ts/bindings/OrcaWorktree";
import type { SideChannel } from "../../ts/bindings/SideChannel";
import type { SideWorkspace } from "../../ts/bindings/SideWorkspace";
import type { ThreadDetail } from "../../ts/bindings/ThreadDetail";
import type { ThreadItem } from "../../ts/bindings/ThreadItem";
import type { TimelineMessage } from "../../ts/bindings/TimelineMessage";
import type { Todo } from "../../ts/bindings/Todo";
import type { Week } from "../../ts/bindings/Week";
import type { Workspace } from "../../ts/bindings/Workspace";
import {
  boot,
  claudeReady,
  isoDate,
  mock,
  orcaOverview,
  orcaRow,
  orcaSsh,
  orcaTerminal,
  para,
  plain,
  rowOf,
  sendStream,
  sendTerm,
  setClock,
  slackThread,
  span,
  streamList,
  task,
  threadMessage,
  timeline,
  timelineMessage,
  timelineReply,
  unreadRepliesOf,
  waitForCalls,
  waitForCount,
  watchedMessage,
  weekOfToday,
} from "../support";

const OUT = process.env.SHOT_OUT!;
const now = new Date();
const today = isoDate(now);
const CLOCK = `${today}T14:20:00`;
const nowMs = new Date(CLOCK).getTime();
const minutesAgo = (m: number) => nowMs - m * 60_000;
const hoursAgo = (h: number) => minutesAgo(h * 60);
const daysAgo = (d: number, hhmm = "10:00") => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - d, h, m).getTime();
};

async function shot(name: string) {
  await browser.pause(500);
  const missing = await browser.execute(() => (window as unknown as { __e2e_unmocked__?: string[] }).__e2e_unmocked__ ?? []);
  if (missing.length) console.log(`shot ${name}: unmocked ${[...new Set(missing)].join(", ")}`);
  await browser.saveScreenshot(`${OUT}/${name}.png`);
}

// ---- mail ----

const WORK = "aoi.sato@example.com";
const HOME = "aoi.sato@example.org";
// The name and the address of a `Name <addr>` sender, as Rust splits them (`fromName`, `fromAddress`): the rows and the thread draw these, not `from`.
const sender = (from: string) => {
  const [, fromName, fromAddress] = /^(.*) <(.*)>$/.exec(from)!;
  return { from, fromName, fromAddress };
};
const mail = (id: string, account: string, from: string, subject: string, snippet: string, dateMs: number, unread: boolean): ThreadItem => ({ id, account, ...sender(from), subject, snippet, dateMs, unread });

const threads = (): ThreadItem[] => [
  mail("a1", WORK, "田中 蓮 <ren.tanaka@example.com>", "請求書の金額が画面と合わない件", "お疲れさまです。10 月分の請求書について、お客さまから金額が画面と違うとのお問い合わせがありました。", minutesAgo(18), true),
  mail("a2", WORK, "鈴木 陽菜 <hina.suzuki@example.com>", "ログイン画面の不具合について", "昨夜のリリースのあと、スマートフォンでログインできないという報告が 3 件来ています。", minutesAgo(52), true),
  mail("a3", WORK, "高橋 湊 <minato.takahashi@example.com>", "週次の定例の議題", "明日の定例で話したいことがあれば、午前中までに共有シートへ書いてください。", minutesAgo(127), true),
  mail("a4", HOME, "月見坂書店 <news@example.org>", "11 月の新刊のお知らせ", "今月の新刊と、会員のみなさま向けのおすすめをご案内します。", minutesAgo(191), true),
  mail("a5", WORK, "伊藤 結衣 <yui.ito@example.com>", "管理画面のレビューをお願いします", "一覧の絞り込みを直しました。お手すきのときに確認をお願いします。", minutesAgo(244), true),
  mail("a6", HOME, "山本 悠 <haruka.yamamoto@example.org>", "来週の土曜の予定", "久しぶりに集まりませんか。駅前のお店を 18 時で考えています。", minutesAgo(312), true),
  mail("b1", WORK, "渡辺 大和 <yamato.watanabe@example.com>", "リリース手順の見直し", "前回の振り返りを受けて、手順書の案を作りました。コメントをいただけると助かります。", minutesAgo(433), false),
  mail("b2", WORK, "監視通知 <alert@example.com>", "夜間バッチが正常に終了しました", "11 月 5 日 3:00 開始の請求データ集計は、すべて正常に終了しました。", minutesAgo(633), false),
  mail("b3", WORK, "中村 さくら <sakura.nakamura@example.com>", "デザイン案の共有", "カート画面の案を 2 つ用意しました。金曜の打ち合わせで決められればと思います。", daysAgo(1, "17:40"), false),
  mail("b4", HOME, "そよかぜ銀行 <info@example.org>", "10 月分のご利用明細を掲載しました", "ご利用明細が確認できるようになりました。ログインのうえご覧ください。", daysAgo(1, "12:05"), false),
  mail("b5", WORK, "小林 樹 <itsuki.kobayashi@example.com>", "テスト環境のメンテナンス", "金曜の 18 時から 1 時間ほど、テスト環境が使えなくなります。", daysAgo(1, "10:15"), false),
  mail("b6", WORK, "加藤 美咲 <misaki.kato@example.com>", "クーポン機能の仕様について", "併用できるクーポンの条件を確認させてください。営業側の希望は別紙のとおりです。", daysAgo(2, "16:30"), false),
  mail("b7", WORK, "田中 蓮 <ren.tanaka@example.com>", "お問い合わせの月次集計", "10 月のお問い合わせ件数をまとめました。ログイン関連が先月より減っています。", daysAgo(4, "11:20"), false),
  mail("b8", HOME, "山本 悠 <haruka.yamamoto@example.org>", "写真を送ります", "先日の旅行の写真をまとめました。共有フォルダに入れてあります。", daysAgo(5, "20:45"), false),
];

const inboxOf = () => ({ accounts: [WORK, HOME], threads: threads(), needsLogin: [], failed: {}, historyIds: { [WORK]: "100", [HOME]: "200" } });

const invoiceThread = (): ThreadDetail => ({
  subject: "請求書の金額が画面と合わない件",
  unread: true,
  messages: [
    {
      id: "m0",
      ...sender("鈴木 陽菜 <hina.suzuki@example.com>"),
      to: "ren.tanaka@example.com",
      toLabel: "To 田中 蓮",
      dateMs: minutesAgo(64),
      snippet: "経理の鈴木です。お客さまから請求書の金額についてお問い合わせをいただきました。",
      html: false,
      authenticated: false,
      body: "田中さん\n\n経理の鈴木です。お客さまから請求書の金額についてお問い合わせをいただきました。\nサポートで確認をお願いできますか。",
    },
    {
      id: "m00",
      ...sender("田中 蓮 <ren.tanaka@example.com>"),
      to: "hina.suzuki@example.com",
      toLabel: "To 鈴木 陽菜",
      dateMs: minutesAgo(41),
      snippet: "承知しました。同じ条件のお客さまがいないか調べて、開発にも共有します。",
      html: false,
      authenticated: false,
      body: "鈴木さん\n\n承知しました。同じ条件のお客さまがいないか調べて、開発にも共有します。",
    },
    {
      id: "m1",
      ...sender("田中 蓮 <ren.tanaka@example.com>"),
      to: WORK,
      toLabel: "To 自分",
      dateMs: minutesAgo(18),
      snippet: "お疲れさまです。",
      html: false,
      authenticated: false,
      body: "佐藤さん\n\nお疲れさまです。サポートの田中です。\n\n10 月分の請求書について、お客さまから「画面の金額と違う」とお問い合わせがありました。\n\n・画面の請求額: 118,800 円\n・請求書の金額: 120,000 円\n\n差額は 1,200 円で、10 月に割引クーポンを使ったお客さまだけで起きているようです。\n同じ条件のお客さまが、ほかに 14 件見つかりました。\n\nお客さまには、明日の午前中に回答するとお伝えしています。\n原因が分かりましたら、教えていただけますか。\n\nよろしくお願いします。\n\n田中 蓮",
    },
  ],
});

// ---- Orca ----

type Spec = [repo: string, branch: string, line: string, extra: Partial<OrcaRow> & { minutes?: number }];
const path = (repo: string, branch: string) => `/work/${repo}/${branch.replace(/\//g, "-")}`;
const specs: Spec[] = [
  ["billing-api", "fix/invoice-discount", "請求書の金額の差を直して", { group: "waiting", minutes: 3, activity: "プルリクエストを開いてよいですか" }],
  ["shop-web", "fix/login-redirect", "ログイン後の戻り先を直して", { group: "waiting", minutes: 8, activity: "どちらの画面に戻すか確認させてください" }],
  ["billing-api", "feat/csv-export", "請求データを CSV で出力したい", { minutes: 12, activity: "テストを実行しています" }],
  ["shop-web", "feat/cart-coupon", "カートでクーポンを使いたい", { minutes: 25, activity: "カート画面を編集しています" }],
  ["mobile-api", "fix/push-retry", "通知の再送が止まる件を調べて", { minutes: 6, activity: "ログを読んでいます" }],
  ["admin-console", "feat/date-filter", "一覧を日付で絞り込みたい", { group: "done", minutes: 40, activity: "プルリクエストを開きました" }],
  ["design-docs", "docs/release-steps", "リリース手順書を整えて", { group: "done", minutes: 95, activity: "手順書を更新しました" }],
];
const rows = () =>
  specs.map(([repo, branch, line, extra], i) => orcaRow(repo, branch, line, { handle: `term_${i}`, paneKey: `tab_${i}:leaf_1`, path: path(repo, branch), atMs: minutesAgo(extra.minutes ?? 2) - 5_000, ...extra }));
// The worktree of `main` is the project's own folder (`isMain`), which a handoff without 新規作成 starts in (A-9).
const worktreeOf = (repo: string, branch: string): OrcaWorktree => ({ path: path(repo, branch), repo, branch, projectKey: `proj_${repo}`, isMain: branch === "main" });
const worktreeList = (): OrcaWorktree[] => [
  ...specs.map(([repo, branch]) => worktreeOf(repo, branch)),
  ...["billing-api", "shop-web", "mobile-api", "admin-console", "design-docs", "auth-service", "notify-worker", "data-batch", "ops-scripts", "landing-page"].map((repo) => worktreeOf(repo, "main")),
];
// What Claude answers for the instruction of the handoff photo (`claude_summarize_handoff`, A-9).
const INSTRUCTION = "この差額の原因を調べて、直してください。同じ条件のお客さまがほかにいないかも確かめてください。";
const handoffPoints: HandoffSummary = {
  points: [
    "10 月分の請求書の金額が、画面の請求額より 1,200 円多くなる原因を調べる",
    "割引クーポンを使ったお客さまの請求書に、割引が反映されるように直す",
    "同じ条件のお客さま 14 件のほかに、影響を受けた請求書がないか確かめる",
    "割引クーポンがある場合の請求書の金額のテストを足す",
  ],
  worktreeName: "fix-invoice-coupon",
};
// The target is a saved environment, so that its list and its terminal are streamed (A-12) and the terminal has colors.
const ENVIRONMENT = "build-server";
const streamOverview = () => orcaOverview([], [], { target: ENVIRONMENT, environments: [ENVIRONMENT], ssh: [orcaSsh("s1", "staging"), orcaSsh("s2", "ops-bastion")] });
const terminals = () => [orcaTerminal("billing-api", "zsh", { branch: "feat/csv-export", path: path("billing-api", "feat/csv-export") })];
const overview = () => orcaOverview(rows(), worktreeList(), { terminals: [orcaTerminal("billing-api", "zsh", { branch: "fix/invoice-discount" })], ssh: [orcaSsh("s1", "staging"), orcaSsh("s2", "build-server")], hosts: [{ key: "ssh:s1", name: "s1", status: "done", sessions: 1, atMs: 0 }] });

// The screen of Claude Code at work on the session of billing-api, feat/csv-export, as the terminal prints it.
const SHOT_SESSION = 2;
const sgr = (code: string, text: string) => `\x1b[${code}m${text}\x1b[0m`;
const dim = (text: string) => sgr("2", text);
const bullet = (text: string) => `${sgr("32", "●")} ${text}`;
const result = (text: string) => `  ${dim("⎿")}  ${dim(text)}`;
const claudeScreen = (cols: number, rows: number) => {
  const rule = dim("─".repeat(cols));
  const inner = 44;
  const boxRow = (plain: string, styled: string) => `│ ${styled}${" ".repeat(inner - plain.length)} │`;
  const box = [
    `╭${"─".repeat(inner + 2)}╮`,
    boxRow("✻ Welcome to Claude Code", `${sgr("33", "✻")} Welcome to ${sgr("1", "Claude Code")}`),
    boxRow("", ""),
    boxRow("cwd: /work/billing-api/feat-csv-export", dim("cwd: /work/billing-api/feat-csv-export")),
    `╰${"─".repeat(inner + 2)}╯`,
  ];
  const lines = [
    ...box,
    "",
    `${sgr("1;36", ">")} ${sgr("1", "請求データを CSV で出力したい")}`,
    "",
    bullet("請求データを CSV で出力する機能を作ります。まず、今の集計の形と、金額の持ち方を確認します。"),
    "",
    bullet(`${sgr("1", "Read")}(package.json)`),
    result("Read 38 lines"),
    bullet(`${sgr("1", "Read")}(src/invoice/summary.ts)`),
    result("Read 96 lines"),
    bullet(`${sgr("1", "Read")}(src/invoice/types.ts)`),
    result("Read 52 lines"),
    bullet(`${sgr("1", "Search")}(pattern: "toRows")`),
    result("Found 4 files"),
    bullet(`${sgr("1", "Search")}(pattern: "Format")`),
    result("Found 2 files"),
    bullet(`${sgr("1", "Bash")}(git log --oneline -3)`),
    result("e4f1a92 請求書の端数の丸めを直す"),
    result("b7c3d05 集計の行に消費税の欄を足す"),
    result("9a02e6f 請求の集計を別のファイルに分ける"),
    "",
    bullet("集計は行の配列に直したあと、画面に出しています。この行をそのまま CSV にします。"),
    "",
    bullet(`${sgr("1", "Update Todos")}`),
    result("☒ 今の集計の形を確認する"),
    result("☐ 行を CSV にする関数を作る"),
    result("☐ 出力するコマンドを足す"),
    result("☐ テストを書いて実行する"),
    "",
    bullet("行を CSV にする関数を足します。金額は桁区切りを付けず、数字だけで書き出します。"),
    "",
    bullet(`${sgr("1", "Write")}(src/invoice/csv.ts)`),
    result("Wrote 38 lines to src/invoice/csv.ts"),
    bullet(`${sgr("1", "Update")}(src/invoice/summary.ts)`),
    result("Updated src/invoice/summary.ts with 6 additions and 1 removal"),
    `       ${dim("41")}  ${sgr("31", "- export function toRows(summary: Summary) {")}`,
    `       ${dim("41")}  ${sgr("32", '+ export function toRows(summary: Summary, format: Format = "table") {')}`,
    "",
    bullet(`${sgr("1", "Write")}(test/invoice/csv.test.ts)`),
    result("Wrote 54 lines to test/invoice/csv.test.ts"),
    bullet(`${sgr("1", "Bash")}(npm test -- invoice)`),
    result("PASS test/invoice/csv.test.ts"),
    "",
    `${sgr("33", "✻")} ${sgr("33", "テストを実行しています…")} ${dim("(esc to interrupt · 1m 12s · ↓ 2.3k tokens)")}`,
    "",
    rule,
    "> ",
    rule,
    `  ${dim("? for shortcuts")}`,
  ];
  // The last lines fill the pane from the bottom.
  const fit = lines.slice(-rows);
  // The cursor goes up from the last line to the prompt.
  return [...Array(Math.max(0, rows - fit.length)).fill(""), ...fit].join("\r\n") + "\x1b[2A\x1b[3G";
};

// ---- calendar ----

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
function week(): Week {
  const base = weekOfToday(0);
  const [y, m, d] = base.weekStart.split("-").map(Number);
  const dateOf = (day: number) => new Date(y, m - 1, d + day);
  const label = (day: number) => {
    const date = dateOf(day);
    return `${date.getMonth() + 1}月${date.getDate()}日（${WEEKDAYS[date.getDay()]}）`;
  };
  const clock = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
  const info = (day: number, summary: string, when: string, detail: Partial<Info> = {}): Info => ({
    summary,
    color: null,
    account: WORK,
    response: "accepted",
    calendar: "仕事",
    whenText: `${label(day)}${when}`,
    meetUrl: null,
    location: null,
    description: null,
    attendees: 0,
    accepted: 0,
    ...detail,
  });
  const ev = (day: number, from: string, to: string, summary: string, detail: Partial<Info> = {}, col = 0, cols = 1) => {
    const min = (t: string) => {
      const [h, mm] = t.split(":").map(Number);
      return h * 60 + mm;
    };
    return { day, startMin: min(from), endMin: min(to), col, cols, ...info(day, summary, ` ${clock(min(from))} - ${clock(min(to))}`, detail) };
  };
  const home = { account: HOME, calendar: "プライベート" };
  const todayIndex = now.getDay();
  return {
    weekStart: base.weekStart,
    allDay: [
      { day: 2, ...info(2, "文化の日", " 終日", { calendar: "日本の祝日", response: "unknown" }) },
      { day: 5, ...info(5, "ストア改修の検証日", " 終日") },
    ],
    timed: [
      ...[1, 3, 4, 5].map((day) => ev(day, "9:30", "10:00", "朝会", { location: "オンライン" })),
      ev(1, "11:00", "12:00", "採用の面談", { response: "tentative" }),
      ev(1, "13:30", "14:30", "ログイン画面の不具合のふりかえり"),
      ev(1, "16:00", "17:00", "スプリント計画"),
      ev(3, "11:00", "12:00", "デザイン案の確認"),
      ev(3, "14:00", "15:30", "請求まわりの設計レビュー"),
      ev(3, "16:00", "16:30", "高橋さんと 1on1"),
      ev(todayIndex, "11:00", "12:30", "クーポン機能の仕様の相談"),
      ev(todayIndex, "13:00", "14:00", "テスト環境のメンテナンス準備"),
      ev(todayIndex, "15:00", "16:00", "請求書の金額が合わない件の確認", {
        meetUrl: "https://meet.google.com/abc-defg-hij",
        location: "会議室 B",
        description: "10 月分の請求書と画面の差額について、原因と対応を確認します。\n資料: https://example.com/docs/invoice-1100",
        attendees: 5,
        accepted: 4,
      }),
      ev(todayIndex, "17:00", "17:30", "リリース判定"),
      ev(5, "11:00", "12:00", "週次の定例"),
      ev(5, "12:30", "13:30", "カート画面の打ち合わせ", { response: "needsAction" }),
      ev(6, "10:30", "11:30", "歯医者", home),
      ev(6, "12:00", "13:30", "友人と昼食", { ...home, response: "tentative" }),
    ],
    needsLogin: [],
    failed: {},
    calendarFailed: [],
  };
}

// ---- Todo ----

const dated = (t: TaskItem, date: string, time: string | null = null): TaskItem => ({ ...t, due: { date, time, string: date, recurring: false } });
function todo(): Todo {
  const yesterday = isoDate(new Date(daysAgo(1)));
  const yesterday2 = isoDate(new Date(daysAgo(2)));
  const t = (id: string, content: string, projectId: string, extra: Partial<TaskItem> = {}, time: string | null = null): TaskItem => ({ ...dated(task(id, content, projectId, "today"), today, time), ...extra });
  const late = (id: string, content: string, projectId: string, date: string, extra: Partial<TaskItem> = {}): TaskItem => ({ ...dated(task(id, content, projectId, "overdue"), date), ...extra });
  return {
    projects: [
      { id: "p0", name: "Inbox", color: "#808080", inbox: true, parentId: null, depth: 0 },
      { id: "p1", name: "請求まわり", color: "#1e7b52", inbox: false, parentId: null, depth: 0 },
      { id: "p2", name: "ストア改修", color: "#246fe0", inbox: false, parentId: null, depth: 0 },
      { id: "p3", name: "カート画面", color: "#eb8909", inbox: false, parentId: "p2", depth: 1 },
      { id: "p4", name: "ログイン", color: "#7c5cd6", inbox: false, parentId: "p2", depth: 1 },
      { id: "p5", name: "運用", color: "#0f9aa8", inbox: false, parentId: null, depth: 0 },
      { id: "p6", name: "個人", color: "#d1453b", inbox: false, parentId: null, depth: 0 },
    ],
    labels: [
      { name: "要確認", color: "#42A393" },
      { name: "急ぎ", color: "#B8255F" },
    ],
    tasks: [
      late("k1", "リリース手順書にコメントを返す", "p5", yesterday),
      late("k2", "クーポン併用の条件を営業に確認する", "p3", yesterday2, { priority: 2 }),
      t("k5", "週次の定例の議題を共有シートに書く", "p5", {}, "15:00"),
      t("k3", "請求書の差額の原因を田中さんへ伝える", "p1", { priority: 1, labels: ["急ぎ"] }, "16:00"),
            t("k6", "リリース判定の資料を用意する", "p5", { priority: 2 }, "16:30"),
      t("k4", "再発行が必要な請求書の一覧を確認する", "p1", { priority: 2, subTotal: 3, subDone: 1, labels: ["要確認"] }),
      t("k7", "ログイン画面の不具合の修正をレビューする", "p4", { priority: 2, labels: ["要確認"] }),
      t("k8", "スマートフォンでログインの動作を確かめる", "p4"),
      t("k9", "カート画面のデザイン案を選ぶ", "p3", { subTotal: 2, subDone: 0 }),
      t("k10", "管理画面の絞り込みのレビューを返す", "p2"),
      t("k11", "テスト環境のメンテナンスを周知する", "p5"),
      t("k12", "お問い合わせの月次集計に目を通す", "p0"),
      t("k13", "土曜のお店を予約する", "p6"),
    ],
  };
}

// ---- Slack ----

const wsA: Workspace = { teamId: "T1", team: "開発チーム", user: "aoi.sato", url: "https://minato-dev.example.com/" };
const wsB: Workspace = { teamId: "T2", team: "勉強会", user: "aoi", url: "https://soyokaze-lab.example.org/" };
const tsAgo = (m: number, n = 0) => `${Math.floor(minutesAgo(m) / 1000)}.${String(100 + n).padStart(6, "0")}`;
const inWs = (ws: Workspace, channel: string): Partial<TimelineMessage> => ({ teamId: ws.teamId, team: ws.team, workspaceUrl: ws.url, channel });

const rootTs = tsAgo(46, 1);
function feed() {
  const unread: TimelineMessage[] = [
    timelineMessage(tsAgo(4, 2), "田中 蓮", "support", "請求書の件、お客さまへの回答は明日の午前で調整しました。原因が分かりしだい共有をお願いします。", { ...inWs(wsA, "C1"), unread: true }),
    timelineMessage(tsAgo(52, 19), "佐藤 葵", "support", "請求書の再発行は、経理の確認が取れてから送ります。", { ...inWs(wsA, "C1"), unread: true }),
    timelineMessage(tsAgo(11, 3), "鈴木 陽菜", "dev-shop", "ログインの修正をテスト環境に入れました。スマートフォンでの確認をお願いできますか？", { ...inWs(wsA, "C2"), unread: true, replyCount: 1 }),
    timelineMessage(tsAgo(24, 4), "高橋 湊", "general", "明日の定例は 11 時からに変更します。議題は共有シートへお願いします。", { ...inWs(wsA, "C3"), unread: true }),
    timelineMessage(tsAgo(38, 5), "山本 悠", "lab-雑談", "来週の勉強会、テーマの案があれば書いてください。", { ...inWs(wsB, "D1"), unread: true }),
    timelineMessage(rootTs, "渡辺 大和", "dev-billing", "夜間バッチの集計が、昨日から 20 分ほど遅くなっています。心当たりのある方はいますか？", {
      ...inWs(wsA, "C4"),
      replyCount: 7,
      unreadReplies: unreadRepliesOf([timelineReply(tsAgo(9, 6), "小林 樹", "月初の明細が増えたぶんだと思います。インデックスを確認してみます。")]),
    }),
    timelineMessage(tsAgo(70, 7), "中村 さくら", "design", "カート画面の案を 2 つ置きました。金曜の打ち合わせまでに見ておいてください。", { ...inWs(wsA, "C5"), unread: true }),
    timelineMessage(tsAgo(120, 8), "伊藤 結衣", "dev-admin", "管理画面の絞り込みのプルリクエストを出しました。レビューをお願いします。", { ...inWs(wsA, "C6"), unread: true }),
    timelineMessage(tsAgo(150, 17), "小林 樹", "dev-shop", "金曜の 18 時からテスト環境のメンテナンスです。作業中のものがあれば教えてください。", { ...inWs(wsA, "C2"), unread: true }),
    timelineMessage(tsAgo(165, 18), "山本 悠", "lab-雑談", "先週の勉強会の資料を共有フォルダに入れました。", { ...inWs(wsB, "D1"), unread: true }),
    timelineMessage(tsAgo(180, 9), "監視通知", "alerts", "夜間バッチの集計が正常に終了しました。", { ...inWs(wsA, "C7"), unread: true }),
  ];
  const watched: TimelineMessage[] = [
    watchedMessage(tsAgo(200, 10), "加藤 美咲", "dev-shop", "クーポンの併用条件、営業の希望をまとめました。仕様に入れられそうか見てもらえますか？", 2, { ...inWs(wsA, "C2"), replyCount: 6 }),
  ];
  return timeline(unread, { watched, side: side() });
}
// The side menu (S-19): the joined channels of each workspace by name, with the unread number of each channel.
function side(): SideWorkspace[] {
  const ch = (id: string, name: string, extra: Partial<SideChannel> = {}): SideChannel => ({ id, name, private: false, unread: 0, ...extra });
  return [
    {
      teamId: wsA.teamId,
      team: wsA.team,
      channels: [
        ch("C7", "alerts", { unread: 1 }),
        ch("C5", "design", { unread: 1 }),
        ch("C6", "dev-admin", { unread: 1 }),
        ch("C4", "dev-billing", { unread: 1 }),
        ch("C2", "dev-shop", { unread: 2 }),
        ch("C3", "general", { unread: 1 }),
        ch("C8", "management", { private: true }),
        ch("C9", "release"),
        ch("C1", "support", { unread: 2 }),
      ],
    },
    { teamId: wsB.teamId, team: wsB.team, channels: [ch("D1", "lab-雑談", { unread: 2 }), ch("D2", "study-notes")] },
  ];
}
const slackDetail = () => ({
  ...slackThread([
    threadMessage(rootTs, "渡辺 大和", "夜間バッチの集計が、昨日から 20 分ほど遅くなっています。心当たりのある方はいますか？"),
    threadMessage(tsAgo(40, 11), "佐藤 葵", "請求データの件数は先週とほぼ同じでした。遅くなったのは割引の集計の段階です。", { rich: [para(span("請求データの件数は先週とほぼ同じでした。遅くなったのは"), span("割引の集計", "b"), span("の段階です。"))] }),
    threadMessage(tsAgo(33, 12), "渡辺 大和", "ありがとうございます。実行計画を見てみます。", {}),
    threadMessage(tsAgo(21, 13), "高橋 湊", "月曜に入れた discount_logs の変更が関係しているかもしれません。", {
      rich: [para(span("月曜に入れた "), span("discount_logs", "c"), span(" の変更が関係しているかもしれません。"))],
    }),
    threadMessage(tsAgo(19, 14), "佐藤 葵", "変更前と後で実行計画を比べました。割引の集計で、全件を読むようになっています。", {}),
    threadMessage(tsAgo(16, 15), "渡辺 大和", "それですね。今夜のバッチまでに直せそうですか？", {}),
    threadMessage(tsAgo(14, 16), "佐藤 葵", "インデックスを足せば直りそうです。テスト環境で試します。", {}),
    threadMessage(tsAgo(9, 6), "小林 樹", "月初の明細が増えたぶんだと思います。インデックスを確認してみます。", { rich: plain("月初の明細が増えたぶんだと思います。インデックスを確認してみます。") }),
  ]),
  channel: "C4",
});

// ---- the shots ----

const common = () => ({
  inbox: inboxOf(),
  orca_overview: overview(),
  orca_skills: [],
  claude_status: claudeReady,
  slack_load: { workspaces: [wsA, wsB], recent: [] },
  slack_timeline: feed(),
  todoist_load: todo(),
  calendar_week: week(),
  app_info: { version: "0.41.1", updatable: true },
});

async function start(extra: Record<string, unknown> = {}) {
  await boot({ ...common(), ...extra });
  await setClock(CLOCK);
  await waitForCount("#unread-threads li", 6);
  await browser.pause(300);
}

describe("readme shots", () => {
  it("handoff", async () => {
    await start();
    await mock("thread", invoiceThread());
    await mock("set_read", true);
    await rowOf("unread-threads", "請求書の金額が画面と合わない件").$(".subject").click();
    await expect($("#thread-subject")).toHaveText("請求書の金額が画面と合わない件");
    await $("#thread-orca").click();
    await expect($("#mail-handoff")).toBeDisplayed();
    // The list of Orca is read when the pane opens: the project chip is enabled once the projects are in.
    await expect($("#mail-handoff .ho-project")).toBeEnabled();
    await $("#mail-handoff .ho-project").click();
    await $('//div[@role="menu"]//button[normalize-space(.)="billing-api"]').click();
    const ask = await mock("claude_summarize_handoff", handoffPoints);
    await $("#mail-handoff textarea").setValue(INSTRUCTION);
    await $("#mail-handoff .ho-form .text-btn.primary").click();
    await waitForCalls(ask);
    await expect($("#mail-handoff .ho-agree")).toBeEnabled();
    await shot("handoff");
  });

  it("orca", async () => {
    await start({ orca_overview: streamOverview() });
    await $("#nav-orca").click();
    await expect($("#orca")).toBeDisplayed();
    await waitForCalls("orca_stream_open");
    await sendStream(streamList(rows(), worktreeList(), terminals()));
    await waitForCount("#orca-feed .orca-project", 12);
    await $(`#orca-feed .orca-project[data-key="proj_billing-api"]`).click();
    await $(`.orca-tabs [data-tab="claude:tab_${SHOT_SESSION}:leaf_1"] .orca-tab-btn`).click();
    const last = async () => ((await waitForCalls("orca_stream_terminal")).at(-1) ?? {}) as { handle?: string; viewport: { cols: number; rows: number } };
    await browser.waitUntil(async () => (await last()).handle === `term_${SHOT_SESSION}`, { timeoutMsg: "the terminal of the session was never subscribed" });
    const { cols, rows: termRows } = (await last()).viewport;
    await sendTerm({ kind: "snapshot", data: claudeScreen(cols, termRows), cols, rows: termRows });
    await browser.waitUntil(async () => (await $(".orca-term .orca-term-box:not([hidden]) .xterm-rows").getText()).includes("テストを実行しています"), { timeoutMsg: "the terminal never showed the screen" });
    await shot("orca");
  });

  it("inbox", async () => {
    await start();
    await shot("inbox");
  });

  it("calendar", async () => {
    await start();
    await $("#nav-calendar").click();
    await expect($("#calendar")).toBeDisplayed();
    const event = $(`//button[contains(@class, "cal-event")][contains(., "請求書の金額が合わない件の確認")]`);
    await event.waitForExist();
    await browser.pause(300);
    await browser.execute(() => {
      document.getElementById("cal-scroll")!.scrollTop = 9 * 64 - 12;
    });
    // By script: a WebDriver click scrolls the event to the middle of the view.
    await browser.execute(() => {
      [...document.querySelectorAll<HTMLElement>("button.cal-event")].find((b) => b.textContent!.includes("請求書の金額が合わない件の確認"))!.click();
    });
    await expect($(".cal-pop")).toBeDisplayed();
    await shot("calendar");
  });

  it("todo", async () => {
    await start();
    await $("#nav-todo").click();
    await waitForCount("#todo-list li.task", 13);
    await shot("todo");
  });

  it("slack", async () => {
    await start();
    await $("#nav-slack").click();
    await expect($("#slack-list")).toBeDisplayed();
    await waitForCount("#slack-feed .feed-row", 11);
    await waitForCount("#slack-side .slack-side-btn", 11);
    await shot("slack");
  });
});
