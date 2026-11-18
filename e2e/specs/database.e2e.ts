import type { OrcaStarted } from "../../ts/bindings/OrcaStarted";
import { orcaOverview as placedOverview, streamList as placedStream, studio } from "../orca-support";
import { boot, callsOf, copiedTexts, count, databaseCell, databaseColumn, databaseNull, databaseProfile, databaseRecords, databaseSqlResult, databaseStructure, databaseTable, holds, inbox, mock, onceId, orcaOverview, orcaTerminal, orcaWorktree, rejects, release, sendClaudeCode, sendStream, sendTerm, stubClipboard, textsOf, timers, waitForCalls, waitForCount } from "../support";

const direct = databaseProfile("p1", "Example direct");
// The read of the list at an interval (#866) put so far off that a spec that counts the reads of the list meets none of it.
const still = timers({ databaseProfiles: 600000 });
const tunnel = databaseProfile("p2", "Example tunnel", { script: "exec forward-port \"$TSUNAGIAI_PORT\"", dbHost: "db.internal.example.com", passwordSaved: true });

// The app with `profiles` saved, and the database screen open.
async function openDatabase(profiles = [direct, tunnel], fixtures: Record<string, unknown> = {}) {
  await boot({ inbox: inbox(), database_profiles: profiles, ...fixtures });
  await $("#nav-database").click();
  await expect($("#database")).toBeDisplayed();
  await waitForCount("#database-side-feed .database-item", profiles.length);
}

const names = () => textsOf("#database-side-feed .database-btn");
// The plus pressed in the page: the driver's click focuses the element it clicked after the handler ran, which would take the focus from the first field that the edit pane gives it (a real press focuses the plus before the handler runs).
const pressAdd = () => browser.execute((once) => window.__e2e_once__(once) && document.getElementById("database-add")!.click(), onceId());
// The page's own right button on the row of `id`, at `at` (the pointer; the middle of the row when none).
const rightPress = (id: string, at?: { x: number; y: number }) =>
  browser.execute(
    (key, point, once) => {
      if (!window.__e2e_once__(once)) return;
      const row = document.querySelector(`#database-side-feed [data-key="${key}"]`)!;
      const r = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: point?.x ?? r.left + 40, clientY: point?.y ?? r.top + r.height / 2 }));
    },
    id,
    at,
    onceId(),
  );
// Opens the menu of the row of `id` with a right press, and then picks the item (1 edit, 2 delete; 2 disconnect and 3 delete while the connection is open).
const pickFromMenu = async (id: string, item: 1 | 2 | 3) => {
  await rightPress(id);
  await $(`.menu button[role="menuitem"]:nth-child(${item})`).click();
};
const field = (name: string) => $(`#database-form [name="${name}"]`);
// The profile that the edit pane sends when it is filled in as a connection with no script.
const typed = { id: "", name: "Example new", username: "reader", script: "", dbHost: "db.example.com", dbPort: 3306 };
const fillDirect = async () => {
  await field("name").setValue("Example new");
  await field("username").setValue("reader");
  await field("dbHost").setValue("db.example.com");
};

describe("database", () => {
  it("has a button with a drawn icon and no text, last before the bottom group, that opens the two-part screen and reads the connections", async () => {
    await openDatabase([direct, tunnel], still);
    const nav = $("#nav-database");
    await expect(nav).toHaveAttribute("aria-label", "データベース");
    await expect(nav).toHaveAttribute("aria-current", "page");
    expect((await nav.getText()).trim()).toBe("");
    await expect(nav.$("svg")).toExist();
    await expect($("#database-side")).toBeDisplayed();
    await expect($("#database-pane")).toBeDisplayed();
    await expect($("#database-side-split")).toBeDisplayed();
    expect(await callsOf("database_profiles")).toEqual([null]);
  });

  it("opens the menu at the pointer on a right press of a row, with no button of a menu in the row", async () => {
    await openDatabase();
    expect(await count("#database-side-feed .database-item button")).toBe(2);
    expect(await count("#database-side-feed .database-more")).toBe(0);
    await rightPress("p1", { x: 120, y: 90 });
    await expect($('.menu[role="menu"]')).toBeDisplayed();
    expect(await textsOf('.menu button[role="menuitem"]')).toEqual(["編集", "削除"]);
    const at = await browser.execute(() => {
      const r = document.querySelector(".menu")!.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top) };
    });
    expect(at).toEqual({ x: 120, y: 90 });
    await expect($('#database-side-feed [data-key="p1"]')).toHaveAttribute("aria-expanded", "false");
    await browser.keys("Escape");
    await expect($(".menu")).not.toExist();
  });

  it("lists the connections by name, in the order Rust gives them, with no text that explains", async () => {
    await openDatabase();
    expect(await names()).toEqual(["Example direct", "Example tunnel"]);
    await expect($("#database-add")).toHaveAttribute("aria-label", "接続を追加");
    expect(await textsOf("#database-side-feed")).toEqual(["Example directExample tunnel"]);
    expect(await count("#database-form")).toBe(0);
    await expect($("#database-edit")).not.toBeDisplayed();
    expect(await count("#database input[placeholder]")).toBe(0);
  });

  it("reads the list again each time the screen is shown", async () => {
    await openDatabase();
    await $("#nav-mail").click();
    const read = await mock("database_profiles", [direct]);
    await $("#nav-database").click();
    await waitForCalls(read);
    await waitForCount("#database-side-feed .database-item", 1);
    expect(await names()).toEqual(["Example direct"]);
  });

  it("shows the error of a read that fails, and no connection", async () => {
    await boot({ inbox: inbox(), database_profiles: { __e2e_reject__: "接続の一覧を読めません" } });
    await $("#nav-database").click();
    await expect($("#error")).toHaveText("接続の一覧を読めません");
    expect(await count("#database-side-feed .database-item")).toBe(0);
  });

  it("makes a press on a connection pressed, and the work pane stays empty", async () => {
    await openDatabase([direct, tunnel], still);
    await $('#database-side-feed [data-key="p2"]').click();
    await expect($('#database-side-feed [data-key="p2"]')).toHaveAttribute("aria-pressed", "true");
    await expect($('#database-side-feed [data-key="p1"]')).toHaveAttribute("aria-pressed", "false");
    expect(await count("#database-work > *")).toBe(0);
    expect(await callsOf("database_profiles")).toEqual([null]);
  });
});

describe("database: register", () => {
  it("takes the place of the work pane from the plus, with the fields of a connection (the host, the port 3306 and the script all shown) and no tab", async () => {
    await openDatabase([]);
    await pressAdd();
    await expect($("#database-edit")).toBeDisplayed();
    await expect($("#database-form")).toBeDisplayed();
    await expect($("#database-pane")).not.toBeDisplayed();
    await expect($("#database-side")).toBeDisplayed();
    await expect($("#database-form")).toHaveAttribute("aria-label", "接続を追加");
    await expect($("#database-form h1")).toHaveText("接続を追加");
    expect(await textsOf("#database-form .database-edit-head button")).toEqual([""]);
    expect(await textsOf("#database-form .database-edit-foot button")).toEqual(["接続をテスト", "キャンセル", "保存"]);
    const row = await browser.execute(() => {
      const rect = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      const body = rect(".database-edit-body");
      const foot = rect(".database-edit-foot");
      const form = rect("#database-form");
      const probe = rect(".database-edit-foot > button");
      const actions = rect(".database-edit-actions");
      const buttons = [...document.querySelectorAll(".database-edit-foot button")].map((b) => b.getBoundingClientRect().top);
      return { under: foot.top >= body.bottom, bottom: Math.round(form.bottom - foot.bottom), probeLeft: Math.round(probe.left - foot.left), actionsRight: Math.round(foot.right - actions.right), sameRow: Math.max(...buttons) - Math.min(...buttons) < 2, apart: actions.left > probe.right };
    });
    expect(row.under).toBe(true);
    expect(row.bottom).toBe(0);
    expect(row.sameRow).toBe(true);
    expect(row.apart).toBe(true);
    expect(row.probeLeft).toBeLessThanOrEqual(32);
    expect(row.actionsRight).toBeLessThanOrEqual(32);
    expect(await count(".scrim")).toBe(0);
    expect(await count("#database-form .database-tab")).toBe(0);
    expect(await count('#database-form [role="tablist"]')).toBe(0);
    await expect(field("dbHost")).toBeDisplayed();
    await expect(field("dbHost")).toHaveValue("");
    await expect(field("dbPort")).toBeDisplayed();
    await expect(field("dbPort")).toHaveValue("3306");
    await expect(field("script")).toBeDisplayed();
    await expect(field("script")).toHaveValue("");
    expect(await browser.execute(() => document.activeElement?.getAttribute("name"))).toBe("name");
    expect(await count("#database-form [placeholder]")).toBe(0);
    await expect($("#database-form .status")).not.toExist();
    expect(await browser.execute(() => document.getElementById("content")!.inert)).toBe(false);
  });

  it("lists the fields in order, the host and the port before the optional script, and keeps what was typed in each", async () => {
    await openDatabase([]);
    await $("#database-add").click();
    expect(await textsOf("#database-form label.database-field .database-label")).toEqual(["接続名", "ユーザー名", "パスワード", "DB のホスト", "ポート", "事前スクリプト"]);
    await field("dbHost").setValue("127.0.0.1");
    await field("dbPort").setValue("3307");
    await field("script").setValue("exec forward-port $TSUNAGIAI_PORT");
    await expect(field("dbHost")).toHaveValue("127.0.0.1");
    await expect(field("dbPort")).toHaveValue("3307");
    await expect(field("script")).toHaveValue("exec forward-port $TSUNAGIAI_PORT");
  });

  it("saves a connection with no script, sends the id empty and the password, closes, and draws the list that Rust answers next", async () => {
    await openDatabase([direct]);
    const save = await mock("database_profile_save", databaseProfile("p3", "Example new", { passwordSaved: true }));
    await mock("database_profiles", [direct, databaseProfile("p3", "Example new")]);
    await $("#database-add").click();
    await fillDirect();
    await field("password").setValue("secret");
    await $("#database-form button[type=submit]").click();
    expect(await waitForCalls(save)).toEqual([{ profile: typed, password: "secret" }]);
    await expect($("#database-form")).not.toExist();
    await expect($("#database-edit")).not.toBeDisplayed();
    await expect($("#database-pane")).toBeDisplayed();
    await waitForCount("#database-side-feed .database-item", 2);
    expect(await names()).toEqual(["Example direct", "Example new"]);
  });

  it("sends the script as typed, with its line breaks, together with the host and the port as typed", async () => {
    await openDatabase([]);
    const save = await mock("database_profile_save", databaseProfile("p3", "Example new"));
    await mock("database_profiles", [databaseProfile("p3", "Example new")]);
    await $("#database-add").click();
    await fillDirect();
    await field("dbPort").setValue("3307");
    await field("script").setValue("#!/bin/sh\nexec forward-port $TSUNAGIAI_PORT");
    await $("#database-form button[type=submit]").click();
    expect(await waitForCalls(save)).toEqual([
      { profile: { ...typed, script: "#!/bin/sh\nexec forward-port $TSUNAGIAI_PORT", dbPort: 3307 }, password: "" },
    ]);
    await expect($("#database-form")).not.toExist();
  });

  it("sends an empty or non-numeric port as 0, which Rust refuses", async () => {
    await openDatabase([]);
    const save = await mock("database_profile_save", rejects("ポートは 1 から 65535 の間で入力してください"));
    await $("#database-add").click();
    await fillDirect();
    await field("dbPort").setValue("");
    await $("#database-form button[type=submit]").click();
    expect(await waitForCalls(save)).toEqual([{ profile: { ...typed, dbPort: 0 }, password: "" }]);
  });

  it("shows the reason of a refused save under the fields, keeps the edit pane and what was typed, and saves again", async () => {
    await openDatabase([]);
    const save = await mock("database_profile_save", rejects("同じ名前の接続があります: Example new"));
    await $("#database-add").click();
    await fillDirect();
    await field("password").setValue("secret");
    await $("#database-form button[type=submit]").click();
    await waitForCalls(save);
    await expect($("#database-form-error")).toHaveText("同じ名前の接続があります: Example new");
    await expect($("#database-form-error")).toHaveAttribute("role", "alert");
    await expect($("#database-form")).toBeDisplayed();
    await expect(field("name")).toHaveValue("Example new");
    await expect(field("password")).toHaveValue("secret");
    await expect($("#database-form button[type=submit]")).toBeEnabled();
    const again = await mock("database_profile_save", databaseProfile("p3", "Example new"));
    await mock("database_profiles", [databaseProfile("p3", "Example new")]);
    await $("#database-form button[type=submit]").click();
    await waitForCalls(again);
    await expect($("#database-form")).not.toExist();
    await expect($("#database-form-error")).not.toExist();
  });

  it("closes the edit pane when the keychain refuses after the connection was saved, shows the error on the screen, and lists the connection", async () => {
    await openDatabase([direct]);
    const message = "接続は保存しましたが、パスワードを保存できません: keychain is locked";
    const save = await mock("database_profile_save", rejects(message));
    await mock("database_profiles", [direct, databaseProfile("p3", "Example new")]);
    await $("#database-add").click();
    await fillDirect();
    await field("password").setValue("secret");
    await $("#database-form button[type=submit]").click();
    await waitForCalls(save);
    await expect($("#database-form")).not.toExist();
    await expect($("#error")).toHaveText(message);
    await waitForCount("#database-side-feed .database-item", 2);
    expect(await names()).toEqual(["Example direct", "Example new"]);
  });

  it("closes on キャンセル and on Escape, calls nothing, and gives the work pane back", async () => {
    await openDatabase([direct]);
    const save = await mock("database_profile_save", databaseProfile("p3", "x"));
    await $("#database-add").click();
    await fillDirect();
    await $("#database-form").$("button=キャンセル").click();
    await expect($("#database-form")).not.toExist();
    await expect($("#database-edit")).not.toBeDisplayed();
    await expect($("#database-pane")).toBeDisplayed();
    await pressAdd();
    await expect(field("name")).toHaveValue("");
    await browser.keys("Escape");
    await expect($("#database-form")).not.toExist();
    await expect($("#database-pane")).toBeDisplayed();
    expect(await callsOf(save)).toEqual([]);
  });

  it("closes when the screen is left", async () => {
    await openDatabase([direct]);
    await $("#database-add").click();
    await expect($("#database-form")).toBeDisplayed();
    await $("#nav-mail").click();
    await expect($("#database-form")).not.toExist();
    await $("#nav-database").click();
    await expect($("#database-pane")).toBeDisplayed();
    await expect($("#database-edit")).not.toBeDisplayed();
  });
});

describe("database: edit", () => {
  it("opens the edit pane from the menu of a row with the fields filled, the host, the port and the script of a connection with a script, and a saved password shown as a status, not the password", async () => {
    await openDatabase();
    await pickFromMenu("p2", 1);
    await expect($("#database-form")).toHaveAttribute("aria-label", "接続を編集");
    await expect($("#database-form h1")).toHaveText("接続を編集");
    await expect($("#database-pane")).not.toBeDisplayed();
    await expect(field("name")).toHaveValue("Example tunnel");
    await expect(field("username")).toHaveValue("reader");
    await expect(field("password")).toHaveValue("");
    await expect($("#database-form .status.ok")).toHaveText("保存済み");
    await expect(field("script")).toBeDisplayed();
    await expect(field("script")).toHaveValue('exec forward-port "$TSUNAGIAI_PORT"');
    await expect(field("dbHost")).toBeDisplayed();
    await expect(field("dbHost")).toHaveValue("db.internal.example.com");
    await expect(field("dbPort")).toBeDisplayed();
    await expect(field("dbPort")).toHaveValue("3306");
  });

  it("shows the host and the port and an empty script for a connection with no script", async () => {
    await openDatabase();
    await pickFromMenu("p1", 1);
    await expect(field("dbHost")).toHaveValue("db.example.com");
    await expect(field("dbPort")).toHaveValue("3306");
    await expect(field("script")).toBeDisplayed();
    await expect(field("script")).toHaveValue("");
  });

  it("shows the port 3306 and an empty host for a connection saved with a script and no host and no port", async () => {
    await openDatabase([databaseProfile("p4", "Example old", { script: "exec forward-port", dbHost: "", dbPort: 0 })]);
    await pickFromMenu("p4", 1);
    await expect(field("script")).toHaveValue("exec forward-port");
    await expect(field("dbHost")).toHaveValue("");
    await expect(field("dbPort")).toHaveValue("3306");
  });

  it("shows no saved-password status for a connection with none", async () => {
    await openDatabase();
    await pickFromMenu("p1", 1);
    await expect(field("name")).toHaveValue("Example direct");
    await expect($("#database-form .status")).not.toExist();
  });

  it("saves with the id of the connection and an empty password, and draws the renamed row", async () => {
    await openDatabase();
    const save = await mock("database_profile_save", databaseProfile("p2", "Example renamed", { passwordSaved: true }));
    await mock("database_profiles", [direct, { ...tunnel, name: "Example renamed" }]);
    await pickFromMenu("p2", 1);
    await field("name").setValue("Example renamed");
    await $("#database-form button[type=submit]").click();
    expect(await waitForCalls(save)).toEqual([
      {
        profile: { id: "p2", name: "Example renamed", username: "reader", script: "exec forward-port \"$TSUNAGIAI_PORT\"", dbHost: "db.internal.example.com", dbPort: 3306 },
        password: "",
      },
    ]);
    await expect($("#database-form")).not.toExist();
    await browser.waitUntil(async () => (await names()).includes("Example renamed"));
    expect(await names()).toEqual(["Example direct", "Example renamed"]);
  });

  it("sends a new password when one is typed", async () => {
    await openDatabase();
    const save = await mock("database_profile_save", databaseProfile("p1", "Example direct", { passwordSaved: true }));
    await pickFromMenu("p1", 1);
    await field("password").setValue("changed");
    await $("#database-form button[type=submit]").click();
    const [call] = (await waitForCalls(save)) as { profile: { id: string }; password: string }[];
    expect(call.profile.id).toBe("p1");
    expect(call.password).toBe("changed");
  });
});

describe("database: edit pane, the Claude tab and reload", () => {
  const toggle = () => $("#database-edit-terminal");
  const fast = timers({ databaseProfiles: 250 });
  const pane = () => $("#database-terminal");
  const tab = () => $("#database-claude-tab");
  const tabClose = () => $('#database-terminal-tabs [role="presentation"]:first-child .icon-btn');
  // The commands of the Orca terminals (D-7) and of the choice of a worktree, none of which the Claude tab calls.
  const orcaCommands = ["orca_terminal_create", "orca_stream_terminal", "orca_terminal_read", "orca_stream_input"];
  const noOrca = async () => {
    for (const command of orcaCommands) expect(await callsOf(command)).toEqual([]);
    await expect($('.pop[role="dialog"]')).not.toExist();
  };

  it("has an icon button with no text at the right end of the header of the edit pane, and the pane at the right closed with no process", async () => {
    await openDatabase();
    await pickFromMenu("p1", 1);
    await expect(toggle()).toHaveAttribute("aria-label", "ターミナル");
    await expect(toggle()).toHaveAttribute("aria-pressed", "false");
    expect((await toggle().getText()).trim()).toBe("");
    await expect(toggle().$("svg")).toExist();
    await expect(pane()).not.toBeDisplayed();
    await expect($("#database-terminal-split")).not.toBeDisplayed();
    expect(await callsOf("claude_code_start")).toEqual([]);
    const atEnd = await browser.execute(() => {
      const head = document.querySelector(".database-edit-head")!.getBoundingClientRect();
      const button = document.getElementById("database-edit-terminal")!.getBoundingClientRect();
      return { inside: button.top >= head.top && button.bottom <= head.bottom, gap: Math.round(head.right - button.right) };
    });
    expect(atEnd.inside).toBe(true);
    expect(atEnd.gap).toBeLessThanOrEqual(32);
  });

  it("opens the pane at the right of the edit pane with the Claude tab first and selected, started with the built-in tools, and no Orca command or worktree choice", async () => {
    await openDatabase();
    await pickFromMenu("p1", 1);
    await toggle().click();
    await expect(toggle()).toHaveAttribute("aria-pressed", "true");
    await expect(pane()).toBeDisplayed();
    await expect($("#database-terminal-split")).toBeDisplayed();
    await expect($("#database-form")).toBeDisplayed();
    const order = await browser.execute(() => {
      const left = (id: string) => document.getElementById(id)!.getBoundingClientRect().left;
      return left("database-edit") < left("database-terminal-split") && left("database-terminal-split") < left("database-terminal");
    });
    expect(order).toBe(true);
    expect(await textsOf('#database-terminal-tabs [role="tab"]')).toEqual(["Claude"]);
    await expect(tab()).toHaveAttribute("aria-selected", "true");
    const [start] = await waitForCalls("claude_code_start");
    expect(start).toMatchObject({ id: "database-claude", builtinTools: true, skill: null });
    await expect($("#database-claude-term.claude-code-pane")).toBeDisplayed();
    await noOrca();
  });

  it("opens the same pane from the icon of the work pane, with the icons in step, and starts the process once", async () => {
    await openDatabase();
    await $("#database-terminal-toggle").click();
    await expect(tab()).toBeDisplayed();
    await waitForCalls("claude_code_start");
    await pickFromMenu("p1", 1);
    await expect(toggle()).toHaveAttribute("aria-pressed", "true");
    await toggle().click();
    await expect(pane()).not.toBeDisplayed();
    await expect(toggle()).toHaveAttribute("aria-pressed", "false");
    await $("#database-form").$("button=キャンセル").click();
    await expect($("#database-terminal-toggle")).toHaveAttribute("aria-pressed", "false");
    await $("#database-terminal-toggle").click();
    await expect(pane()).toBeDisplayed();
    expect((await callsOf("claude_code_start")).length).toBe(1);
  });

  it("closes the pane with a second press and shows it again with a third, starting the process once and ending nothing", async () => {
    await openDatabase();
    await pickFromMenu("p1", 1);
    await toggle().click();
    await waitForCalls("claude_code_start");
    const close = await mock("claude_code_close", null);
    await toggle().click();
    await expect(toggle()).toHaveAttribute("aria-pressed", "false");
    await expect(pane()).not.toBeDisplayed();
    await expect($("#database-terminal-split")).not.toBeDisplayed();
    await expect($("#database-form")).toBeDisplayed();
    await toggle().click();
    await expect(toggle()).toHaveAttribute("aria-pressed", "true");
    await expect(pane()).toBeDisplayed();
    await expect(tab()).toHaveAttribute("aria-selected", "true");
    expect((await callsOf("claude_code_start")).length).toBe(1);
    expect(await callsOf(close)).toEqual([]);
    await noOrca();
  });

  it("keeps the process and the pane when the edit pane is closed, and keeps the process when the screen is left", async () => {
    await openDatabase();
    await pickFromMenu("p1", 1);
    await toggle().click();
    await waitForCalls("claude_code_start");
    const close = await mock("claude_code_close", null);
    await $("#database-form").$("button=キャンセル").click();
    await expect($("#database-pane")).toBeDisplayed();
    await expect(pane()).toBeDisplayed();
    await expect($("#database-terminal-toggle")).toHaveAttribute("aria-pressed", "true");
    await $("#nav-mail").click();
    await $("#nav-database").click();
    await expect(pane()).toBeDisplayed();
    await expect(tab()).toHaveAttribute("aria-selected", "true");
    await pickFromMenu("p1", 1);
    await expect(toggle()).toHaveAttribute("aria-pressed", "true");
    await browser.pause(300);
    expect(await callsOf(close)).toEqual([]);
    expect((await callsOf("claude_code_start")).length).toBe(1);
  });

  it("drops the Claude tab and closes the pane when the process ends, and starts it again when the pane is opened", async () => {
    await openDatabase();
    await pickFromMenu("p1", 1);
    await toggle().click();
    await waitForCalls("claude_code_start");
    await sendClaudeCode({ kind: "output", data: "old screen" });
    await sendClaudeCode({ kind: "ended", message: "Claude Code が終わりました", clean: true });
    await expect(tab()).not.toExist();
    await expect(pane()).not.toBeDisplayed();
    await expect(toggle()).toHaveAttribute("aria-pressed", "false");
    await expect($("#database-terminal-toggle")).toHaveAttribute("aria-pressed", "false");
    await toggle().click();
    await expect(tab()).toBeDisplayed();
    expect((await waitForCalls("claude_code_start", 2)).length).toBe(2);
    await noOrca();
  });

  it("keeps the Claude tab, the pane and the message when the process ends with an exit code", async () => {
    await openDatabase();
    await pickFromMenu("p1", 1);
    await toggle().click();
    await waitForCalls("claude_code_start");
    await sendClaudeCode({ kind: "ended", message: "Claude Code が終わりました（終了コード 3）", clean: false });
    await browser.waitUntil(async () => (await $("#database-claude-term .xterm-rows").getText()).includes("終了コード 3"), { timeoutMsg: "the message of the end was never drawn" });
    await browser.pause(300);
    await expect(tab()).toBeDisplayed();
    await expect(pane()).toBeDisplayed();
    await expect(toggle()).toHaveAttribute("aria-pressed", "true");
    const close = await mock("claude_code_close", null);
    await tabClose().click();
    expect(await waitForCalls(close)).toEqual([{ id: "database-claude", launch: 1 }]);
    await expect(tab()).not.toExist();
    await expect(pane()).not.toBeDisplayed();
  });

  it("drops the Claude tab with its close button, ends the process, and closes the pane when no other tab is left", async () => {
    await openDatabase();
    await pickFromMenu("p1", 1);
    await toggle().click();
    await waitForCalls("claude_code_start");
    const close = await mock("claude_code_close", null);
    await expect(tabClose()).toHaveAttribute("aria-label", "閉じる");
    await tabClose().click();
    expect(await waitForCalls(close)).toEqual([{ id: "database-claude", launch: 1 }]);
    await expect(tab()).not.toExist();
    await expect(pane()).not.toBeDisplayed();
    await expect(toggle()).toHaveAttribute("aria-pressed", "false");
    await toggle().click();
    expect((await waitForCalls("claude_code_start", 2)).length).toBe(2);
  });

  it("keeps the Claude tab and the message of a start that failed", async () => {
    await openDatabase();
    await mock("claude_code_start", rejects("Claude Code が見つかりません。入れてから、もう一度試してください"));
    await $("#database-terminal-toggle").click();
    await waitForCalls("claude_code_start");
    await browser.waitUntil(async () => (await $("#database-claude-term .xterm-rows").getText()).includes("Claude Code が見つかりません"), { timeoutMsg: "the message of the failed start was never drawn" });
    await expect(tab()).toBeDisplayed();
    await expect(pane()).toBeDisplayed();
  });

  it("takes what was saved elsewhere into the fields that were not changed by hand, and leaves the ones that were", async () => {
    await openDatabase([direct, tunnel], fast);
    await pickFromMenu("p1", 1);
    await field("name").setValue("Typed by hand");
    await mock("database_profiles", [databaseProfile("p1", "Saved elsewhere", { username: "writer", dbHost: "db2.example.com", dbPort: 3307 }), tunnel]);
    await expect(field("username")).toHaveValue("writer");
    await expect(field("dbHost")).toHaveValue("db2.example.com");
    await expect(field("dbPort")).toHaveValue("3307");
    await expect(field("name")).toHaveValue("Typed by hand");
    await expect($('#database-side-feed [data-key="p1"]')).toHaveText("Saved elsewhere");
  });

  it("fills the script when a script was saved elsewhere, unless the script was typed by hand", async () => {
    await openDatabase([direct, tunnel], fast);
    await pickFromMenu("p1", 1);
    await mock("database_profiles", [databaseProfile("p1", "Example direct", { script: 'exec forward-port "$TSUNAGIAI_PORT"' }), tunnel]);
    await expect(field("script")).toHaveValue('exec forward-port "$TSUNAGIAI_PORT"');
    await expect(field("dbHost")).toHaveValue("db.example.com");
    await expect(field("dbPort")).toHaveValue("3306");

    await $("#database-form").$("button=キャンセル").click();
    await pickFromMenu("p2", 1);
    await field("script").setValue("exec typed-by-hand");
    await mock("database_profiles", [direct, { ...tunnel, script: "exec other-forward" }]);
    await browser.pause(300);
    await expect(field("script")).toHaveValue("exec typed-by-hand");
  });

  it("keeps the pane as it is when the connection is gone from the list", async () => {
    await openDatabase([direct, tunnel], fast);
    await pickFromMenu("p1", 1);
    await field("username").setValue("typed");
    const read = await mock("database_profiles", [tunnel]);
    await waitForCalls(read);
    await waitForCount("#database-side-feed .database-item", 1);
    await browser.pause(400);
    await expect($("#database-form")).toBeDisplayed();
    await expect(field("name")).toHaveValue("Example direct");
    await expect(field("username")).toHaveValue("typed");
  });
});

describe("database: the list is read while the screen is shown", () => {
  const fast = timers({ databaseProfiles: 250 });
  const added = databaseProfile("p3", "Example added by Claude Code");

  it("draws a connection that was saved elsewhere with no edit pane open, with the same command as every read of the list", async () => {
    await openDatabase([direct, tunnel], fast);
    const read = await mock("database_profiles", [direct, tunnel, added]);
    await waitForCount("#database-side-feed .database-item", 3);
    expect(await names()).toEqual(["Example direct", "Example tunnel", "Example added by Claude Code"]);
    const calls = await callsOf(read);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.every((c) => c === null)).toBe(true);
  });

  it("draws it with the edit pane of a new connection open, and leaves what was typed there", async () => {
    await openDatabase([direct, tunnel], fast);
    await pressAdd();
    await field("name").setValue("Typed by hand");
    await mock("database_profiles", [direct, tunnel, added]);
    await waitForCount("#database-side-feed .database-item", 3);
    await expect($("#database-form")).toBeDisplayed();
    await expect(field("name")).toHaveValue("Typed by hand");
  });

  it("keeps the focus and the open tree of a row when the list changes, and draws nothing when it does not", async () => {
    await openDatabase([direct, tunnel], fast);
    await mock("database_connect", ["shop"]);
    await $('#database-side-feed [data-key="p1"]').click();
    await expect($('#database-side-feed [data-key="p1"]')).toHaveAttribute("aria-expanded", "true");
    await browser.execute(() => {
      const row = document.querySelector('#database-side-feed [data-key="p1"]') as HTMLElement & { __seen?: boolean };
      row.__seen = true;
      row.focus();
    });
    const read = await mock("database_profiles", [direct, tunnel]);
    await waitForCalls(read, 3);
    const same = await browser.execute(() => (document.querySelector('#database-side-feed [data-key="p1"]') as HTMLElement & { __seen?: boolean }).__seen === true);
    expect(same).toBe(true);
    await mock("database_profiles", [direct, tunnel, added]);
    await waitForCount("#database-side-feed .database-item", 3);
    expect(await browser.execute(() => (document.activeElement as HTMLElement | null)?.dataset.key)).toBe("p1");
    await expect($('#database-side-feed [data-key="p1"]')).toHaveAttribute("aria-expanded", "true");
  });

  it("is one read at a time, with the edit pane's own read and the screen's together", async () => {
    await openDatabase([direct, tunnel], fast);
    await pickFromMenu("p1", 1);
    const read = await mock("database_profiles", holds);
    await waitForCalls(read);
    await browser.pause(900);
    expect(await callsOf(read)).toHaveLength(1);
    await release(read, [direct, tunnel, added]);
    await waitForCount("#database-side-feed .database-item", 3);
  });

  it("stops reading when the screen is left, and reads again when it is shown", async () => {
    await openDatabase([direct, tunnel], fast);
    await $("#nav-mail").click();
    await browser.pause(600);
    const read = await mock("database_profiles", [direct, tunnel]);
    await browser.pause(900);
    expect(await callsOf(read)).toEqual([]);
    await $("#nav-database").click();
    await waitForCalls(read);
    await waitForCalls(read, 3);
  });

  it("keeps the list and shows no error when a read at an interval fails", async () => {
    await openDatabase([direct, tunnel], fast);
    const read = await mock("database_profiles", rejects("接続の一覧を読めません"));
    await waitForCalls(read, 2);
    expect(await names()).toEqual(["Example direct", "Example tunnel"]);
    await expect($("#error")).not.toBeDisplayed();
  });
});

describe("database: delete", () => {
  const confirm = () => $('.pop[role="alertdialog"]');

  it("asks first, with the name, and calls nothing on キャンセル", async () => {
    await openDatabase();
    const del = await mock("database_profile_delete", null);
    await pickFromMenu("p1", 2);
    await expect(confirm()).toBeDisplayed();
    await expect($('.pop[role="alertdialog"] p')).toHaveText("Example direct を完全に削除します。元に戻せません。");
    await $('.pop[role="alertdialog"] .text-btn:not(.danger)').click();
    await expect(confirm()).not.toExist();
    expect(await callsOf(del)).toEqual([]);
    expect(await names()).toEqual(["Example direct", "Example tunnel"]);
  });

  it("deletes with the id on 削除 and draws the list that Rust answers next", async () => {
    await openDatabase();
    const del = await mock("database_profile_delete", null);
    await mock("database_profiles", [tunnel]);
    await pickFromMenu("p1", 2);
    await $('.pop[role="alertdialog"] .text-btn.danger').click();
    expect(await waitForCalls(del)).toEqual([{ id: "p1" }]);
    await waitForCount("#database-side-feed .database-item", 1);
    expect(await names()).toEqual(["Example tunnel"]);
  });

  it("shows the error of a failed delete and keeps the row", async () => {
    await openDatabase();
    const del = await mock("database_profile_delete", rejects("パスワードを削除できません"));
    await pickFromMenu("p1", 2);
    await $('.pop[role="alertdialog"] .text-btn.danger').click();
    await waitForCalls(del);
    await expect($("#error")).toHaveText("パスワードを削除できません");
    expect(await names()).toEqual(["Example direct", "Example tunnel"]);
  });

  it("drops the selection of a connection that is gone", async () => {
    await openDatabase();
    await mock("database_profile_delete", null);
    await mock("database_profiles", [tunnel]);
    await $('#database-side-feed [data-key="p1"]').click();
    await waitForCalls("database_connect");
    await pickFromMenu("p1", 3);
    await $('.pop[role="alertdialog"] .text-btn.danger').click();
    await waitForCount("#database-side-feed .database-item", 1);
    await expect($('#database-side-feed [data-key="p2"]')).toHaveAttribute("aria-pressed", "false");
  });
});

describe("database: test the connection", () => {
  const probe = () => $("#database-form .database-edit-foot > button");
  const result = () => $("#database-test-result");

  it("has the button 接続をテスト at the left of the bottom row, before キャンセル and 保存, with nothing shown and nothing called before it is pressed", async () => {
    const test = await mock("database_test", "8.0.36");
    await openDatabase([]);
    await $("#database-add").click();
    expect(await textsOf("#database-form .database-edit-foot button")).toEqual(["接続をテスト", "キャンセル", "保存"]);
    await expect(probe()).toHaveAttribute("type", "button");
    await expect(result()).not.toBeDisplayed();
    expect(await callsOf(test)).toEqual([]);
  });

  it("sends the fields as typed and the typed password, shows the version as a status, and saves nothing and keeps the edit pane", async () => {
    await openDatabase([direct], still);
    const test = await mock("database_test", "8.0.36");
    const save = await mock("database_profile_save", databaseProfile("p3", "x"));
    await $("#database-add").click();
    await fillDirect();
    await field("password").setValue("secret");
    await probe().click();
    expect(await waitForCalls(test)).toEqual([{ profile: typed, password: "secret" }]);
    await expect(result()).toBeDisplayed();
    await expect(result()).toHaveText("MySQL 8.0.36");
    await expect(result()).toHaveElementClass("status");
    await expect(result()).toHaveElementClass("ok");
    await expect(result()).toHaveAttribute("role", "status");
    await expect($("#database-form")).toBeDisplayed();
    await expect($("#database-pane")).not.toBeDisplayed();
    await expect(probe()).toBeEnabled();
    await expect($("#database-form-error")).not.toBeDisplayed();
    expect(await callsOf(save)).toEqual([]);
    expect(await callsOf("database_profiles")).toEqual([null]);
  });

  it("tests the connection of an edit with its id and the fields as typed now, and an empty password for Rust to read the saved one", async () => {
    await openDatabase();
    const test = await mock("database_test", "5.7.44-log");
    await pickFromMenu("p2", 1);
    await field("script").setValue("exec other-forward");
    await probe().click();
    expect(await waitForCalls(test)).toEqual([
      {
        profile: { id: "p2", name: "Example tunnel", username: "reader", script: "exec other-forward", dbHost: "db.internal.example.com", dbPort: 3306 },
        password: "",
      },
    ]);
    await expect(result()).toHaveText("MySQL 5.7.44-log");
  });

  it("tests a connection with no script with its host and port and an empty script", async () => {
    await openDatabase();
    const test = await mock("database_test", "8.0.36");
    await pickFromMenu("p1", 1);
    await field("dbPort").setValue("3307");
    await probe().click();
    expect(await waitForCalls(test)).toEqual([
      { profile: { id: "p1", name: "Example direct", username: "reader", script: "", dbHost: "db.example.com", dbPort: 3307 }, password: "" },
    ]);
  });

  it("shows the error as it is, in the danger color, keeps the edit pane, and a second test replaces it", async () => {
    await openDatabase([]);
    const message = "接続のスクリプトが、準備ができる前に終了しました（終了コード 1）。標準エラーの最後の行: no route to host / connection refused";
    const test = await mock("database_test", rejects(message));
    await $("#database-add").click();
    await fillDirect();
    await probe().click();
    await waitForCalls(test);
    await expect(result()).toHaveText(message);
    await expect(result()).toHaveElementClass("danger");
    await expect(result()).not.toHaveElementClass("status");
    await expect($("#database-form")).toBeDisplayed();
    await expect(probe()).toBeEnabled();
    await expect($("#database-form-error")).not.toBeDisplayed();
    const again = await mock("database_test", "8.4.0");
    await probe().click();
    await waitForCalls(again);
    await expect(result()).toHaveText("MySQL 8.4.0");
    await expect(result()).not.toHaveElementClass("danger");
  });

  it("keeps the button off and the old answer hidden while the test is on its way", async () => {
    await openDatabase([]);
    const test = await mock("database_test", "8.0.36");
    await $("#database-add").click();
    await fillDirect();
    await probe().click();
    await waitForCalls(test);
    await mock("database_test", holds);
    await probe().click();
    await waitForCalls("database_test");
    await expect(probe()).toBeDisabled();
    await expect(result()).not.toBeDisplayed();
    await release("database_test", rejects("MySQL へのログインに失敗しました。ユーザー名とパスワードを確かめてください: Access denied"));
    await expect(probe()).toBeEnabled();
    await expect(result()).toHaveText("MySQL へのログインに失敗しました。ユーザー名とパスワードを確かめてください: Access denied");
  });

  it("draws nothing when the edit pane was closed while the test was on its way, and a new one shows no answer", async () => {
    await openDatabase([]);
    const test = await mock("database_test", holds);
    await $("#database-add").click();
    await fillDirect();
    await probe().click();
    await waitForCalls(test);
    await browser.keys("Escape");
    await expect($("#database-form")).not.toExist();
    await release("database_test", "8.0.36");
    await $("#database-add").click();
    await expect(result()).not.toBeDisplayed();
    await expect(probe()).toBeEnabled();
  });
});

describe("database: tree", () => {
  const row = (key: string) => $(`#database-side-feed [data-key="${key}"]`);
  const dot = (id: string) => $(`#database-side-feed [data-key="${id}"] .database-dot`);
  // The keys of the rows of the tree, in order, without the buttons of the menus.
  const keys = () =>
    browser.execute(() => [...document.querySelectorAll("#database-side-feed .database-btn")].map((e) => e.getAttribute("data-key")));
  const notes = () => textsOf("#database-side-feed .database-note");
  const paneCells = () =>
    browser.execute(() => [...document.querySelectorAll("#database-work tbody tr")].map((tr) => [...tr.children].map((td) => td.textContent)));
  const tables = [databaseTable("orders"), databaseTable("users", { rows: "30", size: "16.0 KB", engine: "MyISAM" }), databaseTable("v_orders", { rows: "", size: "", engine: "" })];
  const lost = "MySQL との接続が切れました。もう一度開いてください: broken pipe";
  // The widths of the cells of the column `column` (from 1) of the grid in the work pane, the header first.
  const columnWidths = (column: number) =>
    browser.execute((n) => [...document.querySelectorAll(`#database-work .database-grid tr > :nth-child(${n})`)].map((c) => Math.round(c.getBoundingClientRect().width)), column);
  // The grip of the header of the column `column` (from 1), pressed and moved by `dx` pixels.
  const dragGrip = (column: number, dx: number) =>
    browser
      .action("pointer")
      .move({ origin: $(`#database-work .database-grid thead th:nth-child(${column}) .database-grip`) })
      .down()
      .move({ origin: "pointer", x: dx, y: 0 })
      .up()
      .perform();
  // The left border of a header and a cell of each column: the first has none, the others have the vertical line. The header and the last row are read (`tr:first-child` alone would also take the first row of the body, the first child of its own parent).
  const lines = () =>
    browser.execute(() => {
      const left = (e: Element) => getComputedStyle(e).borderLeftWidth;
      return [...document.querySelectorAll("#database-work .database-grid thead tr > *, #database-work .database-grid tbody tr:last-child > *")].map(left);
    });
  const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(2);
  const onlyFirstHasNoLine = (all: string[]) => {
    const per = all.length / 2;
    for (const half of [all.slice(0, per), all.slice(per)]) {
      expect(half[0]).toBe("0px");
      for (const w of half.slice(1)) expect(w).toBe("1px");
    }
  };

  // The app with the connection p1 open on its database shop (tables mocked), and the tree drawn.
  async function openTree(shopTables = tables) {
    await openDatabase();
    await mock("database_connect", ["information_schema", "shop"]);
    await mock("database_tables", shopTables);
    await row("p1").click();
    await waitForCount('#database-side-feed [data-key^="p1/d/"]', 2);
  }

  it("opens a connection on a press, calls database_connect with its id and lists the databases under it with a green dot", async () => {
    await openDatabase();
    const connect = await mock("database_connect", ["information_schema", "shop"]);
    await row("p1").click();
    expect(await waitForCalls(connect)).toEqual([{ id: "p1" }]);
    await waitForCount('#database-side-feed [data-key^="p1/d/"]', 2);
    expect(await keys()).toEqual(["p1", "p1/d/information_schema", "p1/d/shop", "p2"]);
    await expect(row("p1")).toHaveAttribute("aria-expanded", "true");
    await expect(row("p1")).toHaveAttribute("aria-pressed", "true");
    await expect(dot("p1")).toHaveAttribute("data-state", "connected");
    await expect(dot("p1")).toHaveAttribute("aria-label", "接続済み");
    await expect(dot("p2")).toHaveAttribute("data-state", "closed");
    expect(await notes()).toEqual([]);
    expect(await count("#database-work > *")).toBe(0);
  });

  it("shows 接続中… under the connection and an orange dot while it opens, and ignores a press meanwhile", async () => {
    await openDatabase();
    const connect = await mock("database_connect", holds);
    await row("p1").click();
    await waitForCalls(connect);
    await expect(dot("p1")).toHaveAttribute("data-state", "connecting");
    expect(await notes()).toEqual(["接続中…"]);
    await row("p1").click();
    expect(await callsOf(connect)).toHaveLength(1);
    await release("database_connect", ["shop"]);
    await waitForCount('#database-side-feed [data-key^="p1/d/"]', 1);
    await expect(dot("p1")).toHaveAttribute("data-state", "connected");
    expect(await notes()).toEqual([]);
  });

  it("shows the error of a connection that cannot be opened under it, with a gray dot, and opens again on the next press", async () => {
    await openDatabase();
    const message = "接続のスクリプトが、準備ができる前に終了しました（終了コード 1）。標準エラーの最後の行: aws login required";
    const connect = await mock("database_connect", rejects(message));
    await row("p1").click();
    await waitForCalls(connect);
    await browser.waitUntil(async () => (await notes()).length === 1);
    expect(await notes()).toEqual([message]);
    await expect($("#database-side-feed .database-note")).toHaveElementClass("danger");
    await expect($("#database-side-feed .database-note")).toHaveAttribute("role", "alert");
    await expect(dot("p1")).toHaveAttribute("data-state", "closed");
    expect(await keys()).toEqual(["p1", "p2"]);
    const again = await mock("database_connect", ["shop"]);
    await row("p1").click();
    expect(await waitForCalls(again)).toEqual([{ id: "p1" }]);
    await waitForCount('#database-side-feed [data-key^="p1/d/"]', 1);
    expect(await notes()).toEqual([]);
    await expect(dot("p1")).toHaveAttribute("data-state", "connected");
  });

  it("closes the tree on a second press and keeps the connection, and reads again when it is opened once more", async () => {
    await openTree();
    await row("p1").click();
    expect(await keys()).toEqual(["p1", "p2"]);
    await expect(row("p1")).toHaveAttribute("aria-expanded", "false");
    await expect(dot("p1")).toHaveAttribute("data-state", "connected");
    expect(await callsOf("database_connect")).toHaveLength(1);
    await row("p1").click();
    await waitForCalls("database_connect", 2);
    await waitForCount('#database-side-feed [data-key^="p1/d/"]', 2);
  });

  it("opens a database on a press: database_tables with the id and the name, its tables under it, and the table list at the right", async () => {
    await openTree();
    const read = await mock("database_tables", tables);
    await row("p1/d/shop").click();
    expect(await waitForCalls(read)).toEqual([{ id: "p1", database: "shop" }]);
    await waitForCount('#database-side-feed [data-key^="p1/d/shop/t/"]', 3);
    expect(await keys()).toEqual(["p1", "p1/d/information_schema", "p1/d/shop", "p1/d/shop/t/orders", "p1/d/shop/t/users", "p1/d/shop/t/v_orders", "p2"]);
    await expect(row("p1/d/shop")).toHaveAttribute("aria-expanded", "true");
    await expect(row("p1/d/shop")).toHaveAttribute("aria-pressed", "true");
    await expect(row("p1")).toHaveAttribute("aria-pressed", "false");
    await expect($("#database-work h3")).toHaveText("shop");
    expect(await textsOf("#database-work thead th")).toEqual(["名前", "行数（概算）", "サイズ", "エンジン"]);
    expect(await paneCells()).toEqual([
      ["orders", "1,200", "1.5 MB", "InnoDB"],
      ["users", "30", "16.0 KB", "MyISAM"],
      ["v_orders", "", "", ""],
    ]);
  });

  it("shows 読み込み中… under the database and in the work pane while its tables are read", async () => {
    await openTree();
    const read = await mock("database_tables", holds);
    await row("p1/d/shop").click();
    await waitForCalls(read);
    expect(await notes()).toEqual(["読み込み中…"]);
    expect(await textsOf("#database-work .database-note")).toEqual(["読み込み中…"]);
    await expect($("#database-work h3")).toHaveText("shop");
    await row("p1/d/shop").click();
    expect(await callsOf(read)).toHaveLength(1);
    await release("database_tables", tables);
    await waitForCount("#database-work tbody tr", 3);
    expect(await notes()).toEqual([]);
    expect(await count("#database-work .database-note")).toBe(0);
  });

  it("shows the error of a read of tables under the database and in the work pane, keeps the connection, and reads again on the next press", async () => {
    await openTree();
    const message = "MySQL がエラーを返しました (1142): SELECT command denied";
    const read = await mock("database_tables", rejects(message));
    await mock("database_connections", ["p1"]);
    await row("p1/d/shop").click();
    await waitForCalls(read);
    await browser.waitUntil(async () => (await notes()).length === 1);
    expect(await notes()).toEqual([message]);
    expect(await textsOf("#database-work .database-note")).toEqual([message]);
    await expect($("#database-work .database-note")).toHaveElementClass("danger");
    expect(await count("#database-work table")).toBe(0);
    await expect(dot("p1")).toHaveAttribute("data-state", "connected");
    await expect(row("p1/d/shop")).toHaveAttribute("aria-expanded", "true");
    const again = await mock("database_tables", tables);
    await row("p1/d/shop").click();
    await waitForCalls(again);
    await waitForCount("#database-work tbody tr", 3);
    expect(await notes()).toEqual([]);
  });

  it("closes the tree of a connection that the read shows lost, and says why under the connection", async () => {
    await openTree();
    const read = await mock("database_tables", rejects(lost));
    await mock("database_connections", []);
    await row("p1/d/shop").click();
    await waitForCalls(read);
    await waitForCount('#database-side-feed [data-key^="p1/d/"]', 0);
    expect(await notes()).toEqual([lost]);
    await expect(dot("p1")).toHaveAttribute("data-state", "closed");
    expect(await count("#database-work > *")).toBe(0);
    await expect(row("p1")).toHaveAttribute("aria-pressed", "true");
  });

  it("closes a database on a second press, keeps its table list at the right, and reads again when it is opened once more", async () => {
    await openTree();
    await row("p1/d/shop").click();
    await waitForCount("#database-work tbody tr", 3);
    await row("p1/d/shop").click();
    await expect(row("p1/d/shop")).toHaveAttribute("aria-expanded", "false");
    expect(await count('#database-side-feed [data-key^="p1/d/shop/t/"]')).toBe(0);
    expect(await count("#database-work tbody tr")).toBe(3);
    expect(await callsOf("database_tables")).toHaveLength(1);
    await row("p1/d/shop").click();
    await waitForCalls("database_tables", 2);
    await waitForCount('#database-side-feed [data-key^="p1/d/shop/t/"]', 3);
  });

  describe("records of a table", () => {
    const num = (text: string) => databaseCell(text, "number");
    const bin = (text: string) => databaseCell(text, "binary");
    const long = `${"x".repeat(200)}…`;
    const columns = ["id", "name", "note", "avatar", "deleted_at", "price"];
    const page0 = databaseRecords(
      columns,
      [
        [num("1"), databaseCell("Alice"), databaseCell(long), bin("バイナリ 16 B"), databaseNull, num("12.50")],
        [num("2"), databaseCell("Bob"), databaseCell("注文メモ"), databaseNull, databaseCell("2024-01-02 03:04:05"), num("0.00")],
      ],
      { hasMore: true, estimate: 1200, summary: "1–2 行目 / 約 1,200 行", lastPage: 11, pages: "/ 約 12", tsv: "id\tname\n1\tAlice\n2\tBob" },
    );
    const page1 = databaseRecords(columns, [[num("3"), databaseCell("Carol"), databaseCell(""), bin("バイナリ 1.5 KB"), databaseNull, num("1.00")]], {
      page: 1,
      estimate: 1200,
      summary: "3–3 行目 / 約 1,200 行",
      lastPage: 11,
      pages: "/ 約 12",
      tsv: "id\tname\n3\tCarol",
    });
    // `estimate` is the one of the page that is shown (none before a first page): Rust reads it with the page 0 only.
    const read = (page: number, estimate: number | null = null) => ({ id: "p1", database: "shop", table: "users", page, estimate });
    const grid = () =>
      browser.execute(() => [...document.querySelectorAll("#database-work .database-grid tbody tr")].map((tr) => [...tr.children].map((td) => td.textContent)));
    const button = (key: string) => $(`#database-work [data-key="${key}"]`);
    const pageInput = () => $("#database-work .database-pager input");
    // Types `text` in the page field and presses Enter.
    async function typePage(text: string) {
      await pageInput().setValue(text);
      await browser.keys("Enter");
    }

    // The app with the table users of the database shop pressed, and its first page drawn.
    async function openTable(first = page0) {
      await openTree();
      await row("p1/d/shop").click();
      await waitForCount('#database-side-feed [data-key^="p1/d/shop/t/"]', 3);
      const command = await mock("database_records", first);
      await row("p1/d/shop/t/users").click();
      await waitForCalls(command);
      await expect($("#database-work .database-range")).toHaveText(first.summary);
      return command;
    }

    it("selects a table on a press and calls database_records with the id, the database, the table and the page 0", async () => {
      const command = await openTable();
      expect(await callsOf(command)).toEqual([read(0)]);
      await expect(row("p1/d/shop/t/users")).toHaveAttribute("aria-pressed", "true");
      await expect(row("p1/d/shop")).toHaveAttribute("aria-pressed", "false");
      expect(await callsOf("database_tables")).toHaveLength(1);
      await expect($("#database-work h3")).toHaveText("shop.users");
    });

    it("opens the records on a press on a row of the table list, as the row of the tree does", async () => {
      await openTree();
      await row("p1/d/shop").click();
      await waitForCount('#database-side-feed [data-key^="p1/d/shop/t/"]', 3);
      const command = await mock("database_records", page0);
      await $('#database-work [data-key="table-users"]').click();
      expect(await waitForCalls(command)).toEqual([read(0)]);
      await expect($("#database-work h3")).toHaveText("shop.users");
      await expect(row("p1/d/shop/t/users")).toHaveAttribute("aria-pressed", "true");
      await expect(row("p1/d/shop")).toHaveAttribute("aria-pressed", "false");
      expect(await count("#database-work table.database-tables")).toBe(0);
      expect(await textsOf("#database-work [role='tab']")).toEqual(["レコード", "構造", "SQL"]);
    });

    it("opens the records on Enter on a row of the table list, a row that takes the focus", async () => {
      await openTree();
      await row("p1/d/shop").click();
      await waitForCount('#database-side-feed [data-key^="p1/d/shop/t/"]', 3);
      const command = await mock("database_records", page0);
      const focused = await browser.execute(() => {
        const tr = document.querySelector<HTMLElement>('#database-work [data-key="table-orders"]')!;
        tr.focus();
        return [document.activeElement === tr, getComputedStyle(tr).cursor];
      });
      expect(focused).toEqual([true, "pointer"]);
      await browser.keys("Enter");
      expect(await waitForCalls(command)).toEqual([{ ...read(0), table: "orders" }]);
      await expect($("#database-work h3")).toHaveText("shop.orders");
      await expect(row("p1/d/shop/t/orders")).toHaveAttribute("aria-pressed", "true");
    });

    it("draws the tab レコード, selected, in place of the table list", async () => {
      await openTable();
      expect(await textsOf("#database-work [role='tab']")).toEqual(["レコード", "構造", "SQL"]);
      await expect($("#database-work [role='tab'][aria-selected='true']")).toHaveText("レコード");
      expect(await count("#database-work table.database-tables")).toBe(0);
    });

    it("draws the columns and the values as Rust gave them: NULL, binary and a long text", async () => {
      await openTable();
      expect(await textsOf("#database-work .database-grid thead th")).toEqual(columns);
      expect(await grid()).toEqual([
        ["1", "Alice", long, "バイナリ 16 B", "NULL", "12.50"],
        ["2", "Bob", "注文メモ", "NULL", "2024-01-02 03:04:05", "0.00"],
      ]);
      const kinds = await browser.execute(() =>
        [...document.querySelectorAll("#database-work .database-grid tbody tr")].map((tr) => [...tr.children].map((td) => (td as HTMLElement).dataset.kind)),
      );
      expect(kinds).toEqual([
        ["number", "text", "text", "binary", "null", "number"],
        ["number", "text", "text", "null", "text", "number"],
      ]);
    });

    it("cuts a long text in the cell by its width, with the text as its title, and puts a number at the right", async () => {
      await openTable();
      const note = $("#database-work .database-grid tbody tr:first-child td:nth-child(3)");
      await expect(note).toHaveAttribute("title", long);
      expect((await note.getSize("width")) as number).toBeLessThan(400);
      const style = await browser.execute(() => ({
        overflow: getComputedStyle(document.querySelector("#database-work .database-grid tbody tr td:nth-child(3)")!).textOverflow,
        align: getComputedStyle(document.querySelector("#database-work .database-grid tbody tr td:nth-child(6)")!).textAlign,
      }));
      expect(style).toEqual({ overflow: "ellipsis", align: "right" });
    });

    it("draws a vertical line between the columns and a grip in each header, and no line at the left of the first column", async () => {
      await openTable();
      onlyFirstHasNoLine(await lines());
      expect(await count("#database-work .database-grid thead .database-grip")).toBe(columns.length);
    });

    it("changes the width of a column by dragging its grip, with no upper limit of 320 px and a lower limit, and leaves the other columns", async () => {
      await openTable();
      const before = await columnWidths(3);
      const others = [await columnWidths(1), await columnWidths(2), await columnWidths(4)];
      near(before[0], before[1]);
      await dragGrip(3, 200);
      const wider = await columnWidths(3);
      for (const w of wider) near(w, before[0] + 200);
      expect(wider[0]).toBeGreaterThan(400);
      expect([await columnWidths(1), await columnWidths(2), await columnWidths(4)]).toEqual(others);
      await dragGrip(3, -wider[0]);
      for (const w of await columnWidths(3)) near(w, 48);
      // The text is still cut in the narrow cell, with its title.
      await expect($("#database-work .database-grid tbody tr:first-child td:nth-child(3)")).toHaveAttribute("title", long);
    });

    it("keeps the widths of the table on the next page, on the other tabs and when the table is pressed again, and draws another table with its own widths", async () => {
      await openTable();
      const before = await columnWidths(3);
      await dragGrip(3, 120);
      const sized = await columnWidths(3);
      near(sized[0], before[0] + 120);
      await mock("database_records", page1);
      await button("next").click();
      await expect($("#database-work .database-range")).toHaveText("3–3 行目 / 約 1,200 行");
      expect(await columnWidths(3)).toEqual([sized[0], sized[0]]);
      await mock("database_structure", databaseStructure([databaseColumn("id", "bigint")]));
      await $('#database-work [data-tab="structure"]').click();
      await expect($("#database-work .database-structure")).toExist();
      await $('#database-work [data-tab="records"]').click();
      expect(await columnWidths(3)).toEqual([sized[0], sized[0]]);
      const other = await mock("database_records", page0);
      await row("p1/d/shop/t/orders").click();
      await waitForCalls(other);
      await expect($("#database-work h3")).toHaveText("shop.orders");
      await expect($("#database-work .database-grid")).toExist();
      expect((await columnWidths(3))[0]).toBeLessThan(sized[0]);
      await mock("database_records", page0);
      await row("p1/d/shop/t/users").click();
      await expect($("#database-work h3")).toHaveText("shop.users");
      await waitForCount("#database-work .database-grid tbody tr", 2);
      expect(await columnWidths(3)).toEqual([sized[0], sized[0], sized[0]]);
    });

    it("has the range and the estimated rows under the table, with the first and the previous page off on the first page and the next and the last on", async () => {
      await openTable();
      await expect($("#database-work .database-range")).toHaveText("1–2 行目 / 約 1,200 行");
      const labels = await browser.execute(() => [...document.querySelectorAll("#database-work .database-pager button")].map((b) => [b.getAttribute("aria-label"), b.textContent]));
      expect(labels).toEqual([
        ["再読み込み", ""],
        ["一覧をコピー", ""],
        ["最初のページ", ""],
        ["前のページ", ""],
        ["次のページ", ""],
        ["最後のページ", ""],
      ]);
      await expect(button("first")).toBeDisabled();
      await expect(button("prev")).toBeDisabled();
      await expect(button("next")).toBeEnabled();
      await expect(button("last")).toBeEnabled();
      await expect(button("reload")).toBeEnabled();
    });

    it("puts the reload, the copy and the range at the left of the footer and the page buttons, the number and the pages at the right, the buttons having an icon", async () => {
      await openTable();
      const order = await browser.execute(() => [...document.querySelectorAll("#database-work .database-pager > *, #database-work .database-pager-nav > *")].map((n) => (n as HTMLElement).dataset.key ?? n.className));
      expect(order).toEqual(["reload", "copy", "database-range", "database-pager-nav", "first", "prev", "page", "database-pages", "next", "last"]);
      const places = await browser.execute(() => {
        const left = (key: string) => document.querySelector(`#database-work [data-key="${key}"]`)!.getBoundingClientRect().left;
        const range = document.querySelector("#database-work .database-range")!.getBoundingClientRect();
        const svgs = (key: string) => document.querySelectorAll(`#database-work [data-key="${key}"] svg`).length;
        return { reload: left("reload") < left("copy"), copy: left("copy") < range.left, first: left("first") > range.right, svg: [svgs("reload"), svgs("copy")] };
      });
      expect(places).toEqual({ reload: true, copy: true, first: true, svg: [1, 1] });
    });

    it("has the page number and the pages from the estimate beside the number", async () => {
      await openTable();
      await expect(pageInput()).toHaveValue("1");
      await expect($("#database-work .database-pages")).toHaveText("/ 約 12");
      await mock("database_records", page1);
      await button("next").click();
      await expect(pageInput()).toHaveValue("2");
      await expect($("#database-work .database-pages")).toHaveText("/ 約 12");
    });

    it("draws no pages and has the last page off for a table with no estimate", async () => {
      await openTable(databaseRecords(columns, [[num("1"), databaseCell("A"), databaseCell(""), bin("バイナリ 1 B"), databaseNull, num("1")]], { hasMore: true }));
      await expect($("#database-work .database-pages")).toHaveText("");
      await expect(button("last")).toBeDisabled();
      await expect(button("next")).toBeEnabled();
    });

    it("reads the first page with the first-page button and the last page that Rust gave with the last-page button", async () => {
      await openTable();
      const last = await mock("database_records", { ...page1, page: 11, summary: "1,101–1,101 行目 / 約 1,200 行" });
      await button("last").click();
      expect(await waitForCalls(last)).toEqual([read(11, 1200)]);
      await expect($("#database-work .database-range")).toHaveText("1,101–1,101 行目 / 約 1,200 行");
      await expect(pageInput()).toHaveValue("12");
      await expect(button("last")).toBeDisabled();
      await expect(button("first")).toBeEnabled();
      const first = await mock("database_records", page0);
      await button("first").click();
      expect(await waitForCalls(first)).toEqual([read(0, 1200)]);
      await expect($("#database-work .database-range")).toHaveText("1–2 行目 / 約 1,200 行");
      await expect(pageInput()).toHaveValue("1");
    });

    it("sends the text typed in the page field on Enter, for Rust to name the page, with the estimate the page holds", async () => {
      await openTable();
      const typed = await mock("database_records", page1);
      await typePage("2");
      expect(await waitForCalls(typed)).toEqual([{ ...read(0, 1200), typed: "2" }]);
      await expect($("#database-work .database-range")).toHaveText("3–3 行目 / 約 1,200 行");
      await expect(pageInput()).toHaveValue("2");
    });

    it("sends a text that is not a page number as it is, and draws the page Rust answers", async () => {
      await openTable();
      await mock("database_records", page1);
      await button("next").click();
      await expect(pageInput()).toHaveValue("2");
      const typed = await mock("database_records", page0);
      await typePage("abc");
      expect(await waitForCalls(typed)).toEqual([{ ...read(1, 1200), typed: "abc" }]);
      await expect($("#database-work .database-range")).toHaveText("1–2 行目 / 約 1,200 行");
      await expect(pageInput()).toHaveValue("1");
    });

    it("sends nothing before Enter is pressed in the page field", async () => {
      await openTable();
      const typed = await mock("database_records", page1);
      await pageInput().setValue("2");
      expect(await callsOf(typed)).toEqual([]);
    });

    it("keeps the page field read only while a page is read, and sends nothing on Enter then", async () => {
      await openTable();
      const wait = await mock("database_records", holds);
      await typePage("2");
      await waitForCalls(wait);
      await expect($("#database-work .database-range")).toHaveText("読み込み中…");
      await expect(pageInput()).toHaveAttribute("readonly");
      for (const key of ["first", "prev", "next", "last", "reload"]) await expect(button(key)).toBeDisabled();
      await browser.keys("Enter");
      expect(await callsOf(wait)).toHaveLength(1);
      await release("database_records", page1);
      await expect($("#database-work .database-range")).toHaveText("3–3 行目 / 約 1,200 行");
      await expect(pageInput()).not.toHaveAttribute("readonly");
    });

    it("reads the next page with 次へ and the page before with 前へ", async () => {
      await openTable();
      const next = await mock("database_records", page1);
      await button("next").click();
      expect(await waitForCalls(next)).toEqual([read(1, 1200)]);
      await expect($("#database-work .database-range")).toHaveText("3–3 行目 / 約 1,200 行");
      expect(await grid()).toEqual([["3", "Carol", "", "バイナリ 1.5 KB", "NULL", "1.00"]]);
      await expect(button("prev")).toBeEnabled();
      await expect(button("next")).toBeDisabled();
      const back = await mock("database_records", page0);
      await button("prev").click();
      expect(await waitForCalls(back)).toEqual([read(0, 1200)]);
      await expect($("#database-work .database-range")).toHaveText("1–2 行目 / 約 1,200 行");
      await expect(button("prev")).toBeDisabled();
    });

    it("reads the page that is shown again with 再読み込み, and draws what Rust answers now", async () => {
      await openTable();
      await mock("database_records", page1);
      await button("next").click();
      await waitForCalls("database_records");
      await expect($("#database-work .database-range")).toHaveText("3–3 行目 / 約 1,200 行");
      const changed = databaseRecords(columns, [[num("3"), databaseCell("Carol B"), databaseCell(""), bin("バイナリ 4 B"), databaseNull, num("2.00")]], { page: 1, estimate: 1200, summary: "3–3 行目" });
      const again = await mock("database_records", changed);
      await button("reload").click();
      expect(await waitForCalls(again)).toEqual([read(1, 1200)]);
      await expect($("#database-work .database-range")).toHaveText("3–3 行目");
      expect(await grid()).toEqual([["3", "Carol B", "", "バイナリ 4 B", "NULL", "2.00"]]);
    });

    it("reads the first page again when the table is pressed once more", async () => {
      await openTable();
      await mock("database_records", page1);
      await button("next").click();
      await waitForCalls("database_records");
      await expect($("#database-work .database-range")).toHaveText("3–3 行目 / 約 1,200 行");
      const again = await mock("database_records", page0);
      await row("p1/d/shop/t/users").click();
      expect(await waitForCalls(again)).toEqual([read(0, 1200)]);
      await expect($("#database-work .database-range")).toHaveText("1–2 行目 / 約 1,200 行");
    });

    it("shows 読み込み中… under the table with the buttons off and the page kept while the next one is read", async () => {
      await openTable();
      const wait = await mock("database_records", holds);
      await button("next").click();
      await waitForCalls(wait);
      await expect($("#database-work .database-range")).toHaveText("読み込み中…");
      for (const key of ["first", "prev", "next", "last", "reload", "copy"]) await expect(button(key)).toBeDisabled();
      expect(await count("#database-work .database-grid tbody tr")).toBe(2);
      await release("database_records", page1);
      await expect($("#database-work .database-range")).toHaveText("3–3 行目 / 約 1,200 行");
      expect(await count("#database-work .database-grid tbody tr")).toBe(1);
      expect(await callsOf(wait)).toHaveLength(1);
    });

    it("does not build the grid again when only the footer changes: the same table stays while the next page is read", async () => {
      await openTable();
      await browser.execute(() => {
        (document.querySelector("#database-work .database-grid") as HTMLElement & { kept?: boolean }).kept = true;
      });
      await mock("database_records", holds);
      await button("next").click();
      await expect($("#database-work .database-range")).toHaveText("読み込み中…");
      const kept = () => browser.execute(() => (document.querySelector("#database-work .database-grid") as (HTMLElement & { kept?: boolean }) | null)?.kept === true);
      expect(await kept()).toBe(true);
      await release("database_records", page1);
      await expect($("#database-work .database-range")).toHaveText("3–3 行目 / 約 1,200 行");
      expect(await kept()).toBe(false);
    });

    it("draws only the range for a table with no row", async () => {
      await openTable(databaseRecords([], []));
      await expect($("#database-work .database-range")).toHaveText("0 行");
      expect(await count("#database-work .database-grid")).toBe(0);
      await expect(button("prev")).toBeDisabled();
      await expect(button("next")).toBeDisabled();
      await expect(button("last")).toBeDisabled();
      await expect(button("reload")).toBeEnabled();
      await expect(button("copy")).toBeDisabled();
    });

    it("shows the error of a read under the tab, drops the page, and 再読み込み reads it again", async () => {
      await openTable();
      const message = "MySQL がエラーを返しました (1142): SELECT command denied";
      await mock("database_records", rejects(message));
      await mock("database_connections", ["p1"]);
      await button("next").click();
      await waitForCalls("database_records");
      await expect($("#database-work .database-note")).toHaveText(message);
      await expect($("#database-work .database-note")).toHaveElementClass("danger");
      expect(await count("#database-work .database-grid")).toBe(0);
      await expect(button("next")).toBeDisabled();
      await expect(button("last")).toBeDisabled();
      await expect(button("reload")).toBeEnabled();
      await expect(button("copy")).toBeDisabled();
      await expect(dot("p1")).toHaveAttribute("data-state", "connected");
      const again = await mock("database_records", page1);
      await button("reload").click();
      expect(await waitForCalls(again)).toEqual([read(1)]);
      await expect($("#database-work .database-range")).toHaveText("3–3 行目 / 約 1,200 行");
      expect(await count("#database-work .database-note")).toBe(0);
    });

    it("closes the tree of a connection that the read shows lost, and says why under the connection", async () => {
      await openTable();
      await mock("database_records", rejects(lost));
      await mock("database_connections", []);
      await button("reload").click();
      await waitForCalls("database_records");
      await waitForCount('#database-side-feed [data-key^="p1/d/"]', 0);
      expect(await notes()).toEqual([lost]);
      await expect(dot("p1")).toHaveAttribute("data-state", "closed");
      expect(await count("#database-work > *")).toBe(0);
    });

    it("copies the page that is shown as Rust made it, and says so, and copies the next page when it is shown", async () => {
      await openTable();
      await stubClipboard();
      await expect(button("copy")).toBeEnabled();
      await button("copy").click();
      await browser.waitUntil(async () => (await copiedTexts()).length === 1, { timeoutMsg: "the clipboard was never written" });
      expect(await copiedTexts()).toEqual([page0.tsv]);
      await expect($(".toast")).toHaveText(expect.stringContaining("一覧をコピーしました"));
      await mock("database_records", page1);
      await button("next").click();
      await expect($("#database-work .database-range")).toHaveText(page1.summary);
      await button("copy").click();
      await browser.waitUntil(async () => (await copiedTexts()).length === 2, { timeoutMsg: "the clipboard was never written" });
      expect(await copiedTexts()).toEqual([page0.tsv, page1.tsv]);
    });

    it("calls no command to copy, and shows the error of a clipboard that refuses", async () => {
      await openTable();
      const command = await mock("database_records", page0);
      await browser.execute(() => {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => Promise.reject(new Error("denied")) } });
      });
      await button("copy").click();
      await expect($("#error")).toHaveText(expect.stringContaining("denied"));
      await expect($(".toast")).not.toBeDisplayed();
      expect(await callsOf(command)).toEqual([]);
    });

    it("has no control to add, edit or delete a row: only the tabs, the reload, the copy, the four page buttons and the page field", async () => {
      await openTable();
      expect(await textsOf("#database-work button")).toEqual(["レコード", "構造", "SQL", "", "", "", "", "", ""]);
      expect(await count("#database-work input")).toBe(1);
      expect(await count("#database-work textarea, #database-work [contenteditable]")).toBe(0);
      await $("#database-work .database-grid tbody tr:first-child td:nth-child(2)").doubleClick();
      expect(await count("#database-work input")).toBe(1);
      expect(await count("#database-work textarea, #database-work [contenteditable]")).toBe(0);
    });

    it("goes back to the table list on a press on the database, and the next press on a table opens the records again", async () => {
      await openTable();
      await row("p1/d/shop").click();
      await expect($("#database-work h3")).toHaveText("shop");
      expect(await count("#database-work .database-grid")).toBe(0);
      expect(await count("#database-work tbody tr")).toBe(3);
      await row("p1/d/shop").click();
      await waitForCalls("database_tables", 2);
      await waitForCount('#database-side-feed [data-key^="p1/d/shop/t/"]', 3);
      const again = await mock("database_records", page0);
      await row("p1/d/shop/t/users").click();
      await waitForCalls(again);
      await expect($("#database-work h3")).toHaveText("shop.users");
    });
  });

  describe("structure of a table", () => {
    const page0 = databaseRecords(["id", "name"], [[databaseCell("1", "number"), databaseCell("Alice")]], { summary: "1–1 行目 / 約 1,200 行" });
    const comment = "注文を作ったユーザー".repeat(40);
    const structure = databaseStructure([
      databaseColumn("id", "bigint unsigned", { key: "PRI", comment: "注文の ID" }),
      databaseColumn("user_id", "int", { key: "MUL", comment }),
      databaseColumn("note", "varchar(255)", { nullable: true, default: "NULL" }),
      databaseColumn("status", "tinyint(1)", { default: "0" }),
    ]);
    const asked = { id: "p1", database: "shop", table: "users" };
    const tab = (id: string) => $(`#database-work [data-tab="${id}"]`);
    const grid = () =>
      browser.execute(() => [...document.querySelectorAll("#database-work .database-grid:not(.database-structure) tbody tr")].map((tr) => [...tr.children].map((td) => td.textContent)));
    const cells = () =>
      browser.execute(() => [...document.querySelectorAll("#database-work .database-structure tbody tr")].map((tr) => [...tr.children].map((td) => td.textContent)));

    // The app with the table users of the database shop pressed and its first page drawn.
    async function openTable() {
      await openTree();
      await row("p1/d/shop").click();
      await waitForCount('#database-side-feed [data-key^="p1/d/shop/t/"]', 3);
      const records = await mock("database_records", page0);
      await row("p1/d/shop/t/users").click();
      await waitForCalls(records);
      await expect($("#database-work .database-range")).toHaveText(page0.summary);
      return records;
    }

    it("draws the vertical lines and changes the width of a column by its grip, kept when the structure is read again", async () => {
      await openTable();
      await mock("database_structure", structure);
      await tab("structure").click();
      await expect($("#database-work .database-structure")).toExist();
      onlyFirstHasNoLine(await lines());
      expect(await count("#database-work .database-structure thead .database-grip")).toBe(6);
      const before = await columnWidths(6);
      await dragGrip(6, 150);
      const sized = await columnWidths(6);
      for (const w of sized) near(w, before[0] + 150);
      await tab("records").click();
      await tab("structure").click();
      await expect($("#database-work .database-structure")).toExist();
      expect(await columnWidths(6)).toEqual(sized);
    });

    it("has the tabs レコード and 構造 with レコード selected, and calls database_structure on a press of 構造 only", async () => {
      await openTable();
      expect(await textsOf("#database-work [role='tab']")).toEqual(["レコード", "構造", "SQL"]);
      await expect(tab("records")).toHaveAttribute("aria-selected", "true");
      await expect(tab("structure")).toHaveAttribute("aria-selected", "false");
      expect(await callsOf("database_structure")).toEqual([]);
      const command = await mock("database_structure", structure);
      await tab("structure").click();
      expect(await waitForCalls(command)).toEqual([asked]);
      await expect(tab("structure")).toHaveAttribute("aria-selected", "true");
      await expect(tab("records")).toHaveAttribute("aria-selected", "false");
    });

    it("draws the columns with the name, type, NULL, key, default and comment, and the summary under them", async () => {
      await openTable();
      await mock("database_structure", structure);
      await tab("structure").click();
      await expect($("#database-work .database-range")).toHaveText("4 列 / InnoDB / utf8mb4");
      expect(await textsOf("#database-work .database-structure thead th")).toEqual(["名前", "型", "NULL", "キー", "既定値", "注釈"]);
      expect(await cells()).toEqual([
        ["id", "bigint unsigned", "NO", "PRI", "", "注文の ID"],
        ["user_id", "int", "NO", "MUL", "", comment],
        ["note", "varchar(255)", "YES", "", "NULL", ""],
        ["status", "tinyint(1)", "NO", "", "0", ""],
      ]);
      expect(await count("#database-work .database-grid")).toBe(1);
      expect(await count('#database-work .database-pager button:not([data-key="copy"])')).toBe(0);
    });

    it("cuts a long comment in its cell with the text as its title", async () => {
      await openTable();
      await mock("database_structure", structure);
      await tab("structure").click();
      const cell = $("#database-work .database-structure tbody tr:nth-child(2) td:nth-child(6)");
      await expect(cell).toHaveAttribute("title", comment);
      expect((await cell.getSize("width")) as number).toBeLessThan(400);
    });

    it("keeps the table when the tab changes: the title, the selected row, and the records are not read again", async () => {
      const records = await openTable();
      await mock("database_structure", structure);
      await tab("structure").click();
      await expect($("#database-work .database-range")).toHaveText("4 列 / InnoDB / utf8mb4");
      await expect($("#database-work h3")).toHaveText("shop.users");
      await expect(row("p1/d/shop/t/users")).toHaveAttribute("aria-pressed", "true");
      await tab("records").click();
      await expect($("#database-work .database-range")).toHaveText(page0.summary);
      await expect($("#database-work h3")).toHaveText("shop.users");
      await expect(row("p1/d/shop/t/users")).toHaveAttribute("aria-pressed", "true");
      expect(await grid()).toEqual([["1", "Alice"]]);
      expect(await callsOf(records)).toEqual([{ ...asked, page: 0, estimate: null }]);
      expect(await callsOf("database_tables")).toHaveLength(1);
    });

    it("reads the structure again at every press of its tab, and not on a press of the tab that is selected", async () => {
      await openTable();
      const command = await mock("database_structure", structure);
      await tab("structure").click();
      await waitForCalls(command);
      await tab("structure").click();
      await tab("records").click();
      await tab("structure").click();
      expect(await waitForCalls(command, 2)).toEqual([asked, asked]);
    });

    it("selects the records again when a table is pressed", async () => {
      await openTable();
      await mock("database_structure", structure);
      await tab("structure").click();
      await expect(tab("structure")).toHaveAttribute("aria-selected", "true");
      const records = await mock("database_records", page0);
      await row("p1/d/shop/t/users").click();
      await waitForCalls(records);
      await expect(tab("records")).toHaveAttribute("aria-selected", "true");
      expect(await count("#database-work .database-structure")).toBe(0);
    });

    it("shows 読み込み中… while the structure is read, and draws the columns after", async () => {
      await openTable();
      const command = await mock("database_structure", holds);
      await tab("structure").click();
      await waitForCalls(command);
      await expect($("#database-work .database-range")).toHaveText("読み込み中…");
      expect(await count("#database-work .database-structure")).toBe(0);
      await release("database_structure", structure);
      await expect($("#database-work .database-range")).toHaveText("4 列 / InnoDB / utf8mb4");
      expect(await count("#database-work .database-structure tbody tr")).toBe(4);
    });

    it("draws only the summary for a table with no column", async () => {
      await openTable();
      await mock("database_structure", databaseStructure([], "0 列"));
      await tab("structure").click();
      await expect($("#database-work .database-range")).toHaveText("0 列");
      expect(await count("#database-work .database-structure")).toBe(0);
      await expect($('#database-work [data-key="copy"]')).toBeDisabled();
    });

    it("puts the copy at the left of the footer, off while the structure is read, and copies the text Rust made", async () => {
      await openTable();
      await stubClipboard();
      const text = "名前\t型\nid\tbigint unsigned";
      const command = await mock("database_structure", holds);
      await tab("structure").click();
      await waitForCalls(command);
      await expect($('#database-work [data-key="copy"]')).toBeDisabled();
      await release("database_structure", databaseStructure([databaseColumn("id", "bigint unsigned")], "1 列 / InnoDB / utf8mb4", text));
      await expect($("#database-work .database-range")).toHaveText("1 列 / InnoDB / utf8mb4");
      const order = await browser.execute(() => [...document.querySelectorAll("#database-work .database-pager > *")].map((n) => (n as HTMLElement).dataset.key ?? n.className));
      expect(order).toEqual(["copy", "database-range"]);
      await expect($('#database-work [data-key="copy"]')).toHaveAttribute("aria-label", "一覧をコピー");
      await $('#database-work [data-key="copy"]').click();
      await browser.waitUntil(async () => (await copiedTexts()).length === 1, { timeoutMsg: "the clipboard was never written" });
      expect(await copiedTexts()).toEqual([text]);
    });

    it("shows the error of a read in the danger color with the connection kept, and a press on the tab again reads it", async () => {
      await openTable();
      const message = "MySQL がエラーを返しました (1142): SELECT command denied";
      await mock("database_structure", rejects(message));
      await mock("database_connections", ["p1"]);
      await tab("structure").click();
      await waitForCalls("database_structure");
      await expect($("#database-work .database-note")).toHaveText(message);
      await expect($("#database-work .database-note")).toHaveElementClass("danger");
      expect(await count("#database-work .database-structure")).toBe(0);
      await expect($('#database-work [data-key="copy"]')).toBeDisabled();
      await expect(dot("p1")).toHaveAttribute("data-state", "connected");
      await tab("records").click();
      const again = await mock("database_structure", structure);
      await tab("structure").click();
      await waitForCalls(again);
      await expect($("#database-work .database-range")).toHaveText("4 列 / InnoDB / utf8mb4");
      expect(await count("#database-work .database-note")).toBe(0);
    });

    it("closes the tree of a connection that the read shows lost, and says why under the connection", async () => {
      await openTable();
      await mock("database_structure", rejects(lost));
      await mock("database_connections", []);
      await tab("structure").click();
      await waitForCalls("database_structure");
      await waitForCount('#database-side-feed [data-key^="p1/d/"]', 0);
      expect(await notes()).toEqual([lost]);
      await expect(dot("p1")).toHaveAttribute("data-state", "closed");
      expect(await count("#database-work > *")).toBe(0);
    });

    it("has no control on the structure but the three tabs and the copy, and no input", async () => {
      await openTable();
      await mock("database_structure", structure);
      await tab("structure").click();
      await expect($("#database-work .database-range")).toHaveText("4 列 / InnoDB / utf8mb4");
      expect(await textsOf("#database-work button")).toEqual(["レコード", "構造", "SQL", ""]);
      expect(await count("#database-work input, #database-work textarea, #database-work [contenteditable]")).toBe(0);
    });
  });

  describe("sql of a table", () => {
    const page0 = databaseRecords(["id", "name"], [[databaseCell("1", "number"), databaseCell("Alice")]], { summary: "1–1 行目 / 約 1,200 行" });
    const result = databaseSqlResult(
      ["id", "name", "deleted_at"],
      [
        [databaseCell("1", "number"), databaseCell("Alice"), databaseNull],
        [databaseCell("2", "number"), databaseCell("Bob"), databaseCell("2024-01-02 03:04:05")],
      ],
      "2 行 / 12 ms",
    );
    const text = "SELECT id, name, deleted_at FROM users;";
    const ran = (sql = text, database = "shop") => ({ id: "p1", database, sql });
    const tab = (id: string) => $(`#database-work [data-tab="${id}"]`);
    const input = () => $("#database-work .database-sql-text");
    const run = () => $('#database-work [data-key="run"]');
    const range = () => $("#database-work .database-range");
    const grid = () =>
      browser.execute(() => [...document.querySelectorAll("#database-work .database-grid tbody tr")].map((tr) => [...tr.children].map((td) => td.textContent)));

    // The app with the table users of the database shop pressed, and the tab SQL selected.
    async function openSql() {
      await openTree();
      await row("p1/d/shop").click();
      await waitForCount('#database-side-feed [data-key^="p1/d/shop/t/"]', 3);
      const records = await mock("database_records", page0);
      await row("p1/d/shop/t/users").click();
      await waitForCalls(records);
      await tab("sql").click();
      await expect(input()).toBeDisplayed();
    }

    // Types the text and presses 実行.
    async function runText(sql = text) {
      await input().setValue(sql);
      await run().click();
    }

    it("draws the vertical lines and changes the width of a column by its grip, kept when the statement is run again", async () => {
      await openSql();
      await mock("database_sql", result);
      await runText();
      await expect(range()).toHaveText("2 行 / 12 ms");
      onlyFirstHasNoLine(await lines());
      expect(await count("#database-work .database-grid thead .database-grip")).toBe(3);
      const before = await columnWidths(2);
      await dragGrip(2, 80);
      const sized = await columnWidths(2);
      for (const w of sized) near(w, before[0] + 80);
      await run().click();
      await expect(range()).toHaveText("2 行 / 12 ms");
      expect(await columnWidths(2)).toEqual(sized);
    });

    it("has the tab SQL after 構造, which calls nothing when it is pressed and draws the field and 実行 with no placeholder and no text of help", async () => {
      await openSql();
      expect(await textsOf("#database-work [role='tab']")).toEqual(["レコード", "構造", "SQL"]);
      await expect(tab("sql")).toHaveAttribute("aria-selected", "true");
      await expect(tab("records")).toHaveAttribute("aria-selected", "false");
      expect(await callsOf("database_sql")).toEqual([]);
      expect(await callsOf("database_structure")).toEqual([]);
      await expect(input()).toHaveAttribute("aria-label", "SQL");
      await expect(input()).toHaveValue("");
      expect(await textsOf("#database-work button")).toEqual(["レコード", "構造", "SQL", "実行", ""]);
      expect(await count("#database-work [placeholder]")).toBe(0);
      expect(await count("#database-work .database-grid")).toBe(0);
      await expect(range()).toHaveText("");
    });

    it("runs the text as typed with the id, the database of the tree and the table's database, and draws the result as the grid of the records", async () => {
      await openSql();
      const command = await mock("database_sql", result);
      await runText();
      expect(await waitForCalls(command)).toEqual([ran()]);
      await expect(range()).toHaveText("2 行 / 12 ms");
      expect(await grid()).toEqual([
        ["1", "Alice", "NULL"],
        ["2", "Bob", "2024-01-02 03:04:05"],
      ]);
      expect(await textsOf("#database-work .database-grid th")).toEqual(["id", "name", "deleted_at"]);
      const kinds = await browser.execute(() => [...document.querySelectorAll("#database-work .database-grid tbody tr:first-child td")].map((td) => (td as HTMLElement).dataset.kind));
      expect(kinds).toEqual(["number", "text", "null"]);
      expect(await count("#database-work .database-note")).toBe(0);
    });

    it("shows 実行中… with 実行 off and the old result kept while it runs, and draws the new result after", async () => {
      await openSql();
      await mock("database_sql", result);
      await runText();
      await expect(range()).toHaveText("2 行 / 12 ms");
      const command = await mock("database_sql", holds);
      await run().click();
      await waitForCalls(command);
      await expect(range()).toHaveText("実行中…");
      await expect(run()).toBeDisabled();
      expect(await count("#database-work .database-grid tbody tr")).toBe(2);
      await expect(input()).toHaveValue(text);
      await release("database_sql", databaseSqlResult(["n"], [[databaseCell("7", "number")]], "1 行 / 5 ms"));
      await expect(range()).toHaveText("1 行 / 5 ms");
      expect(await grid()).toEqual([["7"]]);
      await expect(run()).toBeEnabled();
    });

    it("puts the copy at the left of the footer, off before a run and while one runs, and copies the result as Rust made it", async () => {
      await openSql();
      await stubClipboard();
      const copy = $('#database-work [data-key="copy"]');
      await expect(copy).toBeDisabled();
      const text = "id\tname\tdeleted_at\n1\tAlice\tNULL";
      await mock("database_sql", { ...result, tsv: text });
      await runText();
      await expect(range()).toHaveText("2 行 / 12 ms");
      const order = await browser.execute(() => [...document.querySelectorAll("#database-work .database-pager > *")].map((n) => (n as HTMLElement).dataset.key ?? n.className));
      expect(order).toEqual(["copy", "database-range"]);
      await expect(copy).toBeEnabled();
      await copy.click();
      await browser.waitUntil(async () => (await copiedTexts()).length === 1, { timeoutMsg: "the clipboard was never written" });
      expect(await copiedTexts()).toEqual([text]);
      const wait = await mock("database_sql", holds);
      await run().click();
      await waitForCalls(wait);
      await expect(copy).toBeDisabled();
      await release("database_sql", databaseSqlResult([], [], "0 行 / 2 ms"));
      await expect(range()).toHaveText("0 行 / 2 ms");
      await expect(copy).toBeDisabled();
    });

    it("says under the table that the rows were cut, as Rust worded it", async () => {
      await openSql();
      const cut = "先頭の 1,000 行だけを表示しています（残りは読み込んでいません） / 120 ms";
      const rows = Array.from({ length: 1000 }, (_, i) => [databaseCell(String(i + 1), "number")]);
      await mock("database_sql", databaseSqlResult(["n"], rows, cut));
      await runText("SELECT n FROM numbers");
      await expect(range()).toHaveText(cut);
      expect(await count("#database-work .database-grid tbody tr")).toBe(1000);
    });

    it("draws only the line for a statement with no row", async () => {
      await openSql();
      await mock("database_sql", databaseSqlResult([], [], "0 行 / 2 ms"));
      await runText("SET @a = 1");
      await expect(range()).toHaveText("0 行 / 2 ms");
      expect(await count("#database-work .database-grid")).toBe(0);
      expect(await count("#database-work .database-note")).toBe(0);
    });

    it("shows the error of MySQL in the danger color, drops the old result, keeps the text and the connection, and runs again", async () => {
      await openSql();
      await mock("database_sql", result);
      await runText();
      await expect(range()).toHaveText("2 行 / 12 ms");
      const message = "この接続は読み取り専用です。データを書き換える文は実行できません (1792): Cannot execute statement in a READ ONLY transaction.";
      await mock("database_sql", rejects(message));
      await mock("database_connections", ["p1"]);
      await input().setValue("DELETE FROM users");
      await run().click();
      await waitForCalls("database_sql");
      await expect($("#database-work .database-note")).toHaveText(message);
      await expect($("#database-work .database-note")).toHaveElementClass("danger");
      expect(await count("#database-work .database-grid")).toBe(0);
      await expect(range()).toHaveText("");
      await expect(input()).toHaveValue("DELETE FROM users");
      await expect(dot("p1")).toHaveAttribute("data-state", "connected");
      await expect(run()).toBeEnabled();
      const again = await mock("database_sql", result);
      await runText();
      expect(await waitForCalls(again)).toEqual([ran()]);
      await expect(range()).toHaveText("2 行 / 12 ms");
      expect(await count("#database-work .database-note")).toBe(0);
    });

    it("closes the tree of a connection that the run shows lost, and says why under the connection", async () => {
      await openSql();
      await mock("database_sql", rejects(lost));
      await mock("database_connections", []);
      await runText();
      await waitForCalls("database_sql");
      await waitForCount('#database-side-feed [data-key^="p1/d/"]', 0);
      expect(await notes()).toEqual([lost]);
      await expect(dot("p1")).toHaveAttribute("data-state", "closed");
      expect(await count("#database-work > *")).toBe(0);
    });

    it("keeps the text and the result when the tab changes and when another table of the database is pressed, and runs on the same database", async () => {
      await openSql();
      const command = await mock("database_sql", result);
      await runText();
      await expect(range()).toHaveText("2 行 / 12 ms");
      await tab("records").click();
      await tab("sql").click();
      await expect(input()).toHaveValue(text);
      await expect(range()).toHaveText("2 行 / 12 ms");
      await row("p1/d/shop/t/orders").click();
      await waitForCalls("database_records", 2);
      await tab("sql").click();
      await expect($("#database-work h3")).toHaveText("shop.orders");
      await expect(input()).toHaveValue(text);
      await expect(range()).toHaveText("2 行 / 12 ms");
      await run().click();
      expect(await waitForCalls(command, 2)).toEqual([ran(), ran()]);
    });

    it("uses the database of the table that is pressed, with an empty field for a database that has not been used", async () => {
      await openSql();
      await mock("database_sql", result);
      await runText();
      await expect(range()).toHaveText("2 行 / 12 ms");
      await row("p1/d/information_schema").click();
      await waitForCount('#database-side-feed [data-key^="p1/d/information_schema/t/"]', 3);
      await row("p1/d/information_schema/t/users").click();
      await waitForCalls("database_records", 2);
      await tab("sql").click();
      await expect($("#database-work h3")).toHaveText("information_schema.users");
      await expect(input()).toHaveValue("");
      await expect(range()).toHaveText("");
      const command = await mock("database_sql", result);
      await runText("SELECT 1");
      expect(await waitForCalls(command)).toEqual([ran("SELECT 1", "information_schema")]);
    });

    it("sends a field that is empty as it is, and shows the refusal of Rust", async () => {
      await openSql();
      await mock("database_sql", rejects("SQL を入力してください"));
      await mock("database_connections", ["p1"]);
      await run().click();
      expect(await waitForCalls("database_sql")).toEqual([ran("")]);
      await expect($("#database-work .database-note")).toHaveText("SQL を入力してください");
    });

    it("has no other control on the tab than the tabs, 実行 and the copy, and the field is the only input", async () => {
      await openSql();
      expect(await textsOf("#database-work button")).toEqual(["レコード", "構造", "SQL", "実行", ""]);
      expect(await count("#database-work input, #database-work [contenteditable]")).toBe(0);
      expect(await count("#database-work textarea")).toBe(1);
    });
  });

  it("draws only the title for a database with no table", async () => {
    await openTree([]);
    await row("p1/d/shop").click();
    await waitForCalls("database_tables");
    await expect($("#database-work h3")).toHaveText("shop");
    expect(await count("#database-work table")).toBe(0);
    expect(await count("#database-work .database-note")).toBe(0);
    expect(await count('#database-side-feed [data-key^="p1/d/shop/t/"]')).toBe(0);
  });

  describe("tabs and menu of a database", () => {
    const tab = (id: string) => $(`#database-work [data-tab="${id}"]`);
    const input = () => $("#database-work .database-sql-text");
    const run = () => $('#database-work [data-key="run"]');
    const range = () => $("#database-work .database-range");
    const result = databaseSqlResult(["id"], [[databaseCell("1", "number")]], "1 行 / 3 ms");
    const text = "SELECT id FROM users";
    const ran = (sql = text, database = "shop") => ({ id: "p1", database, sql });
    // Picks the item (1 新規クエリ, 2 データベースを閉じる) of the menu of the database row `key`.
    const pickDb = async (key: string, item: 1 | 2) => {
      await rightPress(key);
      await $(`.menu button[role="menuitem"]:nth-child(${item})`).click();
    };
    // The tree of p1 with the tables of shop read, and the database shop pressed.
    async function openShop() {
      await openTree();
      await row("p1/d/shop").click();
      await waitForCount("#database-work tbody tr", 3);
    }
    // Types the text in the SQL tab and runs it.
    async function runText() {
      await input().setValue(text);
      await run().click();
      await expect(range()).toHaveText("1 行 / 3 ms");
    }

    it("has the tabs テーブル and SQL after the name of a database, テーブル selected with the table list, and a press on SQL calls nothing", async () => {
      await openShop();
      expect(await textsOf("#database-work [role='tab']")).toEqual(["テーブル", "SQL"]);
      await expect(tab("tables")).toHaveAttribute("aria-selected", "true");
      await expect(tab("sql")).toHaveAttribute("aria-selected", "false");
      await tab("sql").click();
      await expect(tab("sql")).toHaveAttribute("aria-selected", "true");
      await expect(input()).toBeDisplayed();
      await expect(input()).toHaveAttribute("aria-label", "SQL");
      await expect(input()).toHaveValue("");
      expect(await count("#database-work [placeholder]")).toBe(0);
      expect(await count("#database-work table")).toBe(0);
      expect(await textsOf("#database-work button")).toEqual(["テーブル", "SQL", "実行", ""]);
      await expect($("#database-work h3")).toHaveText("shop");
      await tab("tables").click();
      await waitForCount("#database-work tbody tr", 3);
      expect(await count("#database-work textarea")).toBe(0);
      expect(await callsOf("database_tables")).toHaveLength(1);
      expect(await callsOf("database_sql")).toEqual([]);
    });

    it("runs the text of the SQL tab of a database with the id and the database it shows, and keeps the text and the result when the tab テーブル is pressed", async () => {
      await openShop();
      await tab("sql").click();
      const command = await mock("database_sql", result);
      await runText();
      expect(await waitForCalls(command)).toEqual([ran()]);
      expect(await count("#database-work .database-grid")).toBe(1);
      await tab("tables").click();
      await tab("sql").click();
      await expect(input()).toHaveValue(text);
      await expect(range()).toHaveText("1 行 / 3 ms");
    });

    it("shares the text and the result with the tab SQL of a table of the database", async () => {
      await openShop();
      await tab("sql").click();
      await mock("database_sql", result);
      await runText();
      await mock("database_records", databaseRecords(["id"], [[databaseCell("1", "number")]]));
      await row("p1/d/shop/t/users").click();
      await waitForCalls("database_records");
      await expect($("#database-work h3")).toHaveText("shop.users");
      await tab("sql").click();
      await expect(input()).toHaveValue(text);
      await expect(range()).toHaveText("1 行 / 3 ms");
    });

    it("keeps the tab on a second press of the database that the pane shows, and selects テーブル on a press from a table or another database", async () => {
      await openShop();
      await tab("sql").click();
      await row("p1/d/shop").click();
      await expect(row("p1/d/shop")).toHaveAttribute("aria-expanded", "false");
      await expect(tab("sql")).toHaveAttribute("aria-selected", "true");
      await row("p1/d/information_schema").click();
      await waitForCalls("database_tables", 2);
      await expect($("#database-work h3")).toHaveText("information_schema");
      await expect(tab("tables")).toHaveAttribute("aria-selected", "true");
      await tab("sql").click();
      await mock("database_records", databaseRecords(["id"], [[databaseCell("1", "number")]]));
      await row("p1/d/shop").click();
      await waitForCount('#database-side-feed [data-key^="p1/d/shop/t/"]', 3);
      await tab("sql").click();
      await row("p1/d/shop/t/users").click();
      await waitForCalls("database_records");
      await row("p1/d/shop").click();
      await expect($("#database-work h3")).toHaveText("shop");
      await expect(tab("tables")).toHaveAttribute("aria-selected", "true");
    });

    it("opens the menu of a database row at the pointer with 新規クエリ and データベースを閉じる, selecting and calling nothing, and has none on a table row", async () => {
      await openShop();
      await rightPress("p1/d/information_schema", { x: 130, y: 100 });
      await expect($('.menu[role="menu"]')).toBeDisplayed();
      expect(await textsOf('.menu button[role="menuitem"]')).toEqual(["新規クエリ", "データベースを閉じる"]);
      expect(await count('.menu button[role="menuitem"] svg')).toBe(2);
      const at = await browser.execute(() => {
        const r = document.querySelector(".menu")!.getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top) };
      });
      expect(at).toEqual({ x: 130, y: 100 });
      await expect(row("p1/d/information_schema")).toHaveAttribute("aria-pressed", "false");
      await expect(row("p1/d/shop")).toHaveAttribute("aria-pressed", "true");
      await browser.keys("Escape");
      await expect($(".menu")).not.toExist();
      await rightPress("p1/d/shop/t/users");
      expect(await count(".menu")).toBe(0);
      expect(await callsOf("database_tables")).toHaveLength(1);
      expect(await callsOf("database_disconnect")).toEqual([]);
    });

    it("opens the SQL tab of the database with an empty field, no result and the caret in it on 新規クエリ", async () => {
      await openShop();
      await tab("sql").click();
      await mock("database_sql", result);
      await runText();
      await mock("database_records", databaseRecords(["id"], [[databaseCell("1", "number")]]));
      await row("p1/d/shop/t/orders").click();
      await waitForCalls("database_records");
      await pickDb("p1/d/shop", 1);
      await expect($("#database-work h3")).toHaveText("shop");
      await expect(tab("sql")).toHaveAttribute("aria-selected", "true");
      await expect(row("p1/d/shop")).toHaveAttribute("aria-pressed", "true");
      await expect(input()).toHaveValue("");
      await expect(range()).toHaveText("");
      expect(await count("#database-work .database-grid")).toBe(0);
      expect(await browser.execute(() => document.activeElement === document.querySelector("#database-work .database-sql-text"))).toBe(true);
      expect(await callsOf("database_sql")).toHaveLength(1);
      expect(await callsOf("database_tables")).toHaveLength(1);
    });

    it("empties the field on 新規クエリ when its text was typed and not run", async () => {
      await openShop();
      await tab("sql").click();
      await input().setValue(text);
      await expect(input()).toHaveValue(text);
      await pickDb("p1/d/shop", 1);
      await expect(input()).toHaveValue("");
      expect(await callsOf("database_sql")).toEqual([]);
    });

    it("keeps the width of a column of the SQL result for the tab of the database and the tabs SQL of its tables, which share the result", async () => {
      await openShop();
      await tab("sql").click();
      await mock("database_sql", result);
      await runText();
      const before = await columnWidths(1);
      await dragGrip(1, 120);
      const sized = await columnWidths(1);
      for (const w of sized) near(w, before[0] + 120);
      await mock("database_records", databaseRecords(["id"], [[databaseCell("1", "number")]]));
      await row("p1/d/shop/t/orders").click();
      await waitForCalls("database_records");
      await tab("sql").click();
      await run().click();
      await waitForCalls("database_sql", 2);
      await expect(range()).toHaveText("1 行 / 3 ms");
      expect(await columnWidths(1)).toEqual(sized);
    });

    it("opens a new query on a database that is not open, without reading its tables, and runs on that database", async () => {
      await openTree();
      await pickDb("p1/d/information_schema", 1);
      await expect($("#database-work h3")).toHaveText("information_schema");
      await expect(tab("sql")).toHaveAttribute("aria-selected", "true");
      await expect(row("p1/d/information_schema")).toHaveAttribute("aria-expanded", "false");
      expect(await callsOf("database_tables")).toEqual([]);
      const command = await mock("database_sql", result);
      await runText();
      expect(await waitForCalls(command)).toEqual([ran(text, "information_schema")]);
    });

    it("closes the tree of the database on データベースを閉じる, keeps the connection, and empties the pane that showed it", async () => {
      await openShop();
      await pickDb("p1/d/shop", 2);
      await expect(row("p1/d/shop")).toHaveAttribute("aria-expanded", "false");
      expect(await count('#database-side-feed [data-key^="p1/d/shop/t/"]')).toBe(0);
      await expect(dot("p1")).toHaveAttribute("data-state", "connected");
      expect(await count("#database-work > *")).toBe(0);
      await expect(row("p1")).toHaveAttribute("aria-pressed", "true");
      expect(await callsOf("database_disconnect")).toEqual([]);
      expect(await callsOf("database_tables")).toHaveLength(1);
      await row("p1/d/shop").click();
      await waitForCalls("database_tables", 2);
      await waitForCount('#database-side-feed [data-key^="p1/d/shop/t/"]', 3);
      await waitForCount("#database-work tbody tr", 3);
    });

    it("empties the pane on データベースを閉じる when it showed a table of the database, and leaves a pane that shows another database", async () => {
      await openShop();
      await mock("database_records", databaseRecords(["id"], [[databaseCell("1", "number")]]));
      await row("p1/d/shop/t/users").click();
      await waitForCalls("database_records");
      await pickDb("p1/d/information_schema", 2);
      await expect($("#database-work h3")).toHaveText("shop.users");
      await pickDb("p1/d/shop", 2);
      expect(await count("#database-work > *")).toBe(0);
      await expect(row("p1")).toHaveAttribute("aria-pressed", "true");
    });
  });

  it("has 切断 in the menu of an open connection only, between 編集 and 削除", async () => {
    await openTree();
    await rightPress("p1");
    expect(await textsOf('.menu button[role="menuitem"]')).toEqual(["編集", "切断", "削除"]);
    await browser.keys("Escape");
    await rightPress("p2");
    expect(await textsOf('.menu button[role="menuitem"]')).toEqual(["編集", "削除"]);
    await browser.keys("Escape");
  });

  it("disconnects from the menu: database_disconnect with the id, the tree closes, the dot goes gray and the work pane empties", async () => {
    await openTree();
    await row("p1/d/shop").click();
    await waitForCount("#database-work tbody tr", 3);
    const closed = await mock("database_disconnect", null);
    await pickFromMenu("p1", 2);
    expect(await waitForCalls(closed)).toEqual([{ id: "p1" }]);
    expect(await keys()).toEqual(["p1", "p2"]);
    await expect(row("p1")).toHaveAttribute("aria-expanded", "false");
    await expect(row("p1")).toHaveAttribute("aria-pressed", "true");
    await expect(dot("p1")).toHaveAttribute("data-state", "closed");
    expect(await count("#database-work > *")).toBe(0);
    // A press opens it again, with a new call of database_connect.
    await row("p1").click();
    await waitForCalls("database_connect", 2);
  });

  it("closes the tree on a disconnect that fails and shows its error", async () => {
    await openTree();
    const closed = await mock("database_disconnect", rejects("接続を閉じられませんでした"));
    await pickFromMenu("p1", 2);
    await waitForCalls(closed);
    await expect($("#error")).toHaveText("接続を閉じられませんでした");
    expect(await keys()).toEqual(["p1", "p2"]);
    await expect(dot("p1")).toHaveAttribute("data-state", "closed");
  });

  it("closes the tree of an edited connection that Rust closed", async () => {
    await openTree();
    await mock("database_profile_save", databaseProfile("p1", "Example direct"));
    await mock("database_connections", []);
    await pickFromMenu("p1", 1);
    await $("#database-form button[type=submit]").click();
    await waitForCalls("database_connections");
    await waitForCount('#database-side-feed [data-key^="p1/d/"]', 0);
    await expect(dot("p1")).toHaveAttribute("data-state", "closed");
    await expect($("#database-form")).not.toExist();
  });

  it("closes the tree of a connection that is deleted", async () => {
    await openTree();
    await mock("database_profile_delete", null);
    await mock("database_connections", []);
    await mock("database_profiles", [tunnel]);
    await pickFromMenu("p1", 3);
    await $('.pop[role="alertdialog"] .text-btn.danger').click();
    await waitForCount("#database-side-feed .database-item", 1);
    expect(await keys()).toEqual(["p2"]);
    expect(await count("#database-work > *")).toBe(0);
  });

  it("closes the connection that was deleted while it opened, once it is open", async () => {
    await openDatabase();
    const connect = await mock("database_connect", holds);
    await mock("database_profile_delete", null);
    await row("p1").click();
    await waitForCalls(connect);
    await mock("database_profiles", [tunnel]);
    await pickFromMenu("p1", 2);
    await $('.pop[role="alertdialog"] .text-btn.danger').click();
    await waitForCount("#database-side-feed .database-item", 1);
    const closed = await mock("database_disconnect", null);
    await release("database_connect", ["shop"]);
    expect(await waitForCalls(closed)).toEqual([{ id: "p1" }]);
    expect(await keys()).toEqual(["p2"]);
  });
});

describe("database: terminal pane", () => {
  const toggle = () => $("#database-terminal-toggle");
  // The share of #database that `id` takes, and the pane's place against the work pane and the divider.
  const share = (id: string) => browser.execute((i) => document.getElementById(i)!.getBoundingClientRect().width / document.getElementById("database")!.getBoundingClientRect().width, id);
  const press = (key: string) => browser.execute((k) => document.getElementById("database-terminal-split")!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })), key);
  // A drag of the divider (pointer events, as the divider listens for them) that ends with the pointer at `fraction` of #database's width from its left edge.
  const drag = (fraction: number) =>
    browser.execute((f) => {
      const box = document.getElementById("database")!.getBoundingClientRect();
      const at = (x: number): PointerEventInit => ({ bubbles: true, cancelable: true, pointerId: 7, button: 0, clientX: box.left + box.width * x, clientY: box.top + 80 });
      document.getElementById("database-terminal-split")!.dispatchEvent(new PointerEvent("pointerdown", at(0.6)));
      document.dispatchEvent(new PointerEvent("pointermove", at(f)));
      document.dispatchEvent(new PointerEvent("pointerup", at(f)));
    }, fraction);

  it("has an icon button with no text at the right end of the header of the work pane, and the pane and its divider closed", async () => {
    await openDatabase();
    await expect(toggle()).toHaveAttribute("aria-label", "ターミナル");
    await expect(toggle()).toHaveAttribute("aria-pressed", "false");
    expect((await toggle().getText()).trim()).toBe("");
    await expect(toggle().$("svg")).toExist();
    await expect($("#database-terminal")).not.toBeDisplayed();
    await expect($("#database-terminal-split")).not.toBeDisplayed();
    const atEnd = await browser.execute(() => {
      const header = document.getElementById("database-header")!.getBoundingClientRect();
      const button = document.getElementById("database-terminal-toggle")!.getBoundingClientRect();
      return { inside: button.top >= header.top && button.bottom <= header.bottom, gap: Math.round(header.right - button.right) };
    });
    expect(atEnd.inside).toBe(true);
    expect(atEnd.gap).toBeLessThanOrEqual(32);
  });

  it("opens the pane at the right of the work pane with the divider between them, and closes it with a second press, reading no connection", async () => {
    await openDatabase([direct, tunnel], still);
    const before = await callsOf("database_profiles");
    await toggle().click();
    await expect(toggle()).toHaveAttribute("aria-pressed", "true");
    await expect($("#database-terminal")).toBeDisplayed();
    await expect($("#database-terminal-split")).toBeDisplayed();
    await expect($("#database-terminal")).toHaveAttribute("aria-label", "ターミナル");
    const order = await browser.execute(() => {
      const left = (id: string) => document.getElementById(id)!.getBoundingClientRect().left;
      return left("database-pane") < left("database-terminal-split") && left("database-terminal-split") < left("database-terminal");
    });
    expect(order).toBe(true);
    // The pane starts Claude Code: the Claude tab is the only tab, and its box the only child of the body.
    expect(await textsOf('#database-terminal-tabs [role="tab"]')).toEqual(["Claude"]);
    expect(await count("#database-terminal-body > *")).toBe(1);
    await toggle().click();
    await expect(toggle()).toHaveAttribute("aria-pressed", "false");
    await expect($("#database-terminal")).not.toBeDisplayed();
    await expect($("#database-terminal-split")).not.toBeDisplayed();
    expect(await callsOf("database_profiles")).toEqual(before);
  });

  it("makes the head of the pane as high as the header of the work pane", async () => {
    await openDatabase();
    await toggle().click();
    const heights = await browser.execute(() => [document.getElementById("database-header")!.getBoundingClientRect().height, document.getElementById("database-terminal-head")!.getBoundingClientRect().height]);
    expect(heights[1]).toBeCloseTo(heights[0], 0);
    await expect($("#database-terminal-head")).toHaveAttribute("data-tauri-drag-region");
  });

  it("starts the pane at 35% of the screen and keeps it between 25% and 50% with the arrow keys", async () => {
    await openDatabase();
    await toggle().click();
    const split = $("#database-terminal-split");
    await expect(split).toHaveAttribute("aria-label", "ターミナルの幅");
    await expect(split).toHaveAttribute("aria-valuemin", "25");
    await expect(split).toHaveAttribute("aria-valuemax", "50");
    await expect(split).toHaveAttribute("aria-valuenow", "35");
    expect(await share("database-terminal")).toBeCloseTo(0.35, 2);
    for (let i = 0; i < 10; i++) await press("ArrowLeft");
    await expect(split).toHaveAttribute("aria-valuenow", "50");
    expect(await share("database-terminal")).toBeCloseTo(0.5, 2);
    for (let i = 0; i < 20; i++) await press("ArrowRight");
    await expect(split).toHaveAttribute("aria-valuenow", "25");
    expect(await share("database-terminal")).toBeCloseTo(0.25, 2);
  });

  it("changes the width with a drag of the divider, held to the range, and keeps it over a close and an opening", async () => {
    await openDatabase();
    await toggle().click();
    await drag(0.6);
    expect(await share("database-terminal")).toBeCloseTo(0.4, 1);
    await drag(0.1);
    await expect($("#database-terminal-split")).toHaveAttribute("aria-valuenow", "50");
    await drag(0.9);
    await expect($("#database-terminal-split")).toHaveAttribute("aria-valuenow", "25");
    await drag(0.7);
    const kept = (await $("#database-terminal-split").getAttribute("aria-valuenow")) ?? "";
    await toggle().click();
    await toggle().click();
    await expect($("#database-terminal-split")).toHaveAttribute("aria-valuenow", kept);
    expect(await share("database-terminal")).toBeCloseTo(Number(kept) / 100, 1);
  });
});

describe("database: terminal pane, terminals", () => {
  const plus = () => $("#database-terminal-plus");
  const toggle = () => $("#database-terminal-toggle");
  const apiPath = "/work/example-api";
  const zsh = "term_example-api_zsh";
  const created: OrcaStarted = { paneKey: null, handle: zsh };
  const worktreesOf = () => [orcaWorktree("example-app", "feat/a"), orcaWorktree("example-api", "main")];
  // The list of Orca with a plain terminal of example-api in it, and without.
  const listed = () => orcaOverview([], worktreesOf(), { terminals: [orcaTerminal("example-api", "zsh")] });
  const unlisted = () => orcaOverview([], worktreesOf());
  const fast = timers({ orcaMirror: 250, orcaClock: 600 });
  // The app with the database screen open and the pane open, Orca answering `list`.
  async function openPane(list = listed(), fixtures: Record<string, unknown> = {}) {
    await boot({ inbox: inbox(), database_profiles: [direct], orca_overview: list, ...fast, ...fixtures });
    await $("#nav-database").click();
    await expect($("#database")).toBeDisplayed();
    await toggle().click();
    await expect($("#database-terminal")).toBeDisplayed();
  }
  const pick = async (path: string) => {
    await plus().click();
    await $(`.orca-dest-pop button[data-path="${path}"]`).click();
  };
  // The tabs of the terminals: the fixed Claude tab, the first of the strip, is left out.
  const termTab = '#database-terminal-tabs [role="tab"]:not(#database-claude-tab)';
  const tabs = () => textsOf(termTab);
  const screenText = () => $(".database-terminal-term .xterm-rows").getText();
  const waitScreen = (text: string) => browser.waitUntil(async () => (await screenText()).includes(text), { timeoutMsg: `the terminal never showed "${text}"` });
  // The terminal opened in example-api, and mirrored.
  async function openTerminal() {
    await openPane();
    const create = await mock("orca_terminal_create", created);
    await mock("orca_terminal_read", ["$ pwd"]);
    await pick(apiPath);
    await waitScreen("$ pwd");
    return create;
  }

  it("has a plus with no text after a strip that holds the Claude tab only, and a body that holds its box only", async () => {
    await openPane();
    await expect(plus()).toHaveAttribute("aria-label", "ターミナルを開く");
    await expect(plus()).toHaveAttribute("aria-haspopup", "dialog");
    expect((await plus().getText()).trim()).toBe("");
    await expect(plus().$("svg")).toExist();
    await expect($("#database-terminal-tabs")).toHaveAttribute("role", "tablist");
    expect(await count("#database-terminal-tabs > *")).toBe(1);
    expect(await count("#database-terminal-body > *")).toBe(1);
    const order = await browser.execute(() => document.getElementById("database-terminal-tabs")!.getBoundingClientRect().left < document.getElementById("database-terminal-plus")!.getBoundingClientRect().left);
    expect(order).toBe(true);
  });

  it("opens the dialog of Orca's worktrees under the plus, and creates nothing before one is picked", async () => {
    await openPane();
    const create = await mock("orca_terminal_create", created);
    await plus().click();
    await expect($(".orca-dest-pop")).toBeDisplayed();
    expect(await textsOf(".orca-dest-pop button b")).toEqual(["example-app", "example-api"]);
    expect(await textsOf(".orca-dest-pop button span")).toEqual(["feat/a", "main"]);
    await browser.keys("Escape");
    await expect($(".orca-dest-pop")).not.toExist();
    expect(await callsOf(create)).toEqual([]);
    expect(await count("#database-terminal-body > *")).toBe(1);
  });

  it("opens a plain terminal in the worktree picked, with its tab, and draws its screen by the mirror", async () => {
    const create = await openTerminal();
    expect(await callsOf(create)).toEqual([{ path: apiPath, environment: null }]);
    expect(await tabs()).toEqual(["example-api ・ main"]);
    await expect($(termTab)).toHaveAttribute("aria-selected", "true");
    await expect($("#database-claude-tab")).toHaveAttribute("aria-selected", "false");
    expect(await count("#database-terminal-body > .database-terminal-term")).toBe(1);
    expect(await count("#database-terminal-body > .pending")).toBe(0);
    expect((await callsOf("orca_terminal_read"))[0]).toEqual({ handle: zsh });
  });

  it("streams the terminal of a saved environment and draws what Orca sends", async () => {
    await openPane(placedOverview([], worktreesOf(), studio));
    await waitForCalls("orca_stream_open");
    await sendStream(placedStream([], worktreesOf(), [orcaTerminal("example-api", "zsh")]));
    const create = await mock("orca_terminal_create", created);
    const read = await mock("orca_terminal_read", ["$ mirror"]);
    await pick(apiPath);
    expect(await waitForCalls(create)).toEqual([{ path: apiPath, environment: "Studio" }]);
    const streamed = await waitForCalls("orca_stream_terminal");
    expect((streamed[0] as { handle: string }).handle).toBe(zsh);
    await sendTerm({ kind: "snapshot", data: "$ hello", cols: 80, rows: 24 });
    await waitScreen("$ hello");
    expect(await callsOf(read)).toEqual([]);
  });

  it("reads nothing while the pane is closed, and shows the terminal again when it is opened", async () => {
    await openTerminal();
    await toggle().click();
    await expect($("#database-terminal")).not.toBeDisplayed();
    const read = await mock("orca_terminal_read", ["$ again"]);
    await browser.pause(400);
    expect(await callsOf(read)).toEqual([]);
    expect(await count(".database-terminal-term")).toBe(1);
    await toggle().click();
    expect((await waitForCalls(read))[0]).toEqual({ handle: zsh });
    await waitScreen("$ again");
    expect(await tabs()).toEqual(["example-api ・ main"]);
  });

  it("reads nothing while another screen is shown, and goes on when the database screen is shown again", async () => {
    await openTerminal();
    await $("#nav-mail").click();
    await expect($("#database")).not.toBeDisplayed();
    // The tick that lets the terminal go comes within a period of the mirror.
    await browser.pause(400);
    const read = await mock("orca_terminal_read", ["$ back"]);
    await browser.pause(400);
    expect(await callsOf(read)).toEqual([]);
    await $("#nav-database").click();
    expect((await waitForCalls(read))[0]).toEqual({ handle: zsh });
  });

  it("forgets the terminal, with its tab and its reads, when the list no longer holds it", async () => {
    await openTerminal();
    await mock("orca_overview", unlisted());
    await waitForCount("#database-terminal-tabs > *", 1);
    await waitForCount(".database-terminal-term", 0);
    expect(await count("#database-terminal-body > *")).toBe(1);
    await expect($("#database-claude-tab")).toHaveAttribute("aria-selected", "true");
    const read = await mock("orca_terminal_read", ["$"]);
    await browser.pause(400);
    expect(await callsOf(read)).toEqual([]);
  });

  it("shows no terminal while the list does not hold it, and forgets nothing it has not held yet", async () => {
    await openPane(unlisted());
    const read = await mock("orca_terminal_read", ["$ late"]);
    await mock("orca_terminal_create", created);
    await pick(apiPath);
    await expect($(termTab)).toExist();
    await browser.pause(400);
    expect(await callsOf(read)).toEqual([]);
    await mock("orca_overview", listed());
    expect((await waitForCalls(read))[0]).toEqual({ handle: zsh });
    await waitScreen("$ late");
  });

  it("keeps the plus off while the terminal is opened", async () => {
    await openPane();
    const create = await mock("orca_terminal_create", holds);
    await mock("orca_terminal_read", ["$ pwd"]);
    await pick(apiPath);
    await waitForCalls(create);
    await expect(plus()).toBeDisabled();
    await release(create, created);
    await expect(plus()).toBeEnabled();
    await waitScreen("$ pwd");
  });

  it("starts no reads when the pane was closed while the terminal was opened, and starts them when it is opened", async () => {
    await openPane();
    const create = await mock("orca_terminal_create", holds);
    await pick(apiPath);
    await waitForCalls(create);
    await toggle().click();
    await expect($("#database-terminal")).not.toBeDisplayed();
    // A closed pane reads nothing even with the watch running, so the watch itself is counted: the intervals set at the period of the mirror.
    await browser.execute(() => {
      const w = window as unknown as { __watches: number };
      const set = window.setInterval.bind(window);
      w.__watches = 0;
      window.setInterval = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
        if (ms === 250) w.__watches++;
        return set(handler, ms, ...args);
      }) as typeof window.setInterval;
    });
    const watches = () => browser.execute(() => (window as unknown as { __watches: number }).__watches);
    await release(create, created);
    await waitForCount(termTab, 1);
    const overview = await mock("orca_overview", listed());
    const read = await mock("orca_terminal_read", ["$ pwd"]);
    await browser.pause(600);
    expect(await watches()).toBe(0);
    expect(await callsOf(overview)).toEqual([]);
    expect(await callsOf(read)).toEqual([]);
    await toggle().click();
    expect(await watches()).toBeGreaterThan(0);
    await waitForCalls(overview);
    expect((await waitForCalls(read))[0]).toEqual({ handle: zsh });
    await waitScreen("$ pwd");
  });

  const app = "term_example-app_zsh";
  const appPath = "/work/example-app";
  const bothListed = () => orcaOverview([], worktreesOf(), { terminals: [orcaTerminal("example-api", "zsh"), orcaTerminal("example-app", "zsh")] });
  // The Claude tab is the first of the strip, so the n-th terminal tab is the (n + 1)-th child.
  const tabButton = (n: number) => $(`#database-terminal-tabs [role="presentation"]:nth-child(${n + 1}) [role="tab"]`);
  const closeButton = (n: number) => $(`#database-terminal-tabs [role="presentation"]:nth-child(${n + 1}) .icon-btn`);
  const selection = () => browser.execute(() => [...document.querySelectorAll('#database-terminal-tabs [role="tab"]:not(#database-claude-tab)')].map((e) => e.getAttribute("aria-selected")));
  const readHandles = async () => [...new Set(((await callsOf("orca_terminal_read")) as { handle: string }[]).map((c) => c.handle))];
  // The two terminals, example-api first and example-app second (selected), mirrored.
  async function openTwo(list = bothListed()) {
    await openPane(list);
    await mock("orca_terminal_create", created);
    await mock("orca_terminal_read", ["$ pwd"]);
    await pick(apiPath);
    await waitScreen("$ pwd");
    await mock("orca_terminal_create", { paneKey: null, handle: app });
    await pick(appPath);
    await waitForCount(termTab, 2);
  }

  it("gives a second terminal a second tab that is selected, and keeps the first", async () => {
    await openTwo();
    expect(await tabs()).toEqual(["example-api ・ main", "example-app ・ feat/a"]);
    expect(await selection()).toEqual(["false", "true"]);
    expect(await count(".database-terminal-term")).toBe(1);
    await browser.waitUntil(async () => ((await callsOf("orca_terminal_read")) as { handle: string }[]).at(-1)?.handle === app, { timeoutMsg: "the second terminal was never read" });
  });

  it("switches to the terminal of the tab pressed, and reads only the one shown", async () => {
    await openTwo();
    await tabButton(1).click();
    expect(await selection()).toEqual(["true", "false"]);
    await browser.pause(500);
    const read = await mock("orca_terminal_read", ["$ pwd"]);
    await browser.pause(600);
    expect(await readHandles()).toEqual([zsh]);
    await tabButton(2).click();
    expect(await selection()).toEqual(["false", "true"]);
    await browser.pause(500);
    await mock(read, ["$ pwd"]);
    await browser.pause(600);
    expect(await readHandles()).toEqual([app]);
    expect(await count(".database-terminal-term")).toBe(1);
  });

  it("streams only the terminal of the tab selected, and ends the stream of the one left", async () => {
    await openPane(placedOverview([], worktreesOf(), studio));
    await waitForCalls("orca_stream_open");
    await sendStream(placedStream([], worktreesOf(), [orcaTerminal("example-api", "zsh"), orcaTerminal("example-app", "zsh")]));
    await mock("orca_terminal_create", created);
    await pick(apiPath);
    expect(((await waitForCalls("orca_stream_terminal"))[0] as { handle: string }).handle).toBe(zsh);
    const closed = await mock("orca_stream_terminal_close", null);
    await mock("orca_terminal_create", { paneKey: null, handle: app });
    await pick(appPath);
    expect(((await waitForCalls("orca_stream_terminal", 2))[1] as { handle: string }).handle).toBe(app);
    expect(((await waitForCalls(closed))[0] as { handle: string }).handle).toBe(zsh);
    await tabButton(1).click();
    expect(((await waitForCalls("orca_stream_terminal", 3))[2] as { handle: string }).handle).toBe(zsh);
    expect(((await waitForCalls(closed, 2))[1] as { handle: string }).handle).toBe(app);
  });

  it("does not show a terminal of the tab that the list does not hold yet", async () => {
    await openPane(listed());
    await mock("orca_terminal_create", created);
    await mock("orca_terminal_read", ["$ pwd"]);
    await pick(apiPath);
    await waitScreen("$ pwd");
    await mock("orca_terminal_create", { paneKey: null, handle: app });
    await pick(appPath);
    await waitForCount(termTab, 2);
    await browser.pause(400);
    const read = await mock("orca_terminal_read", ["$ pwd"]);
    await browser.pause(600);
    expect(await callsOf(read)).toEqual([]);
    expect(await selection()).toEqual(["false", "true"]);
  });

  it("has a close button beside each tab, with a drawn cross and no text", async () => {
    await openTwo();
    for (const n of [1, 2]) {
      await expect(closeButton(n)).toHaveAttribute("aria-label", "閉じる");
      expect((await closeButton(n).getText()).trim()).toBe("");
      await expect(closeButton(n).$("svg")).toExist();
      await expect(closeButton(n)).toBeEnabled();
    }
    expect(await count('#database-terminal-tabs [role="tab"] .icon-btn')).toBe(0);
  });

  it("closes the terminal in Orca with its handle and place, and drops its tab without selecting it", async () => {
    await openTwo();
    const close = await mock("orca_close", null);
    await closeButton(1).click();
    expect(await waitForCalls(close)).toEqual([{ handle: zsh, environment: null }]);
    await waitForCount(termTab, 1);
    expect(await tabs()).toEqual(["example-app ・ feat/a"]);
    expect(await selection()).toEqual(["true"]);
    await mock("orca_terminal_read", ["$ pwd"]);
    await browser.pause(600);
    expect(await readHandles()).toEqual([app]);
  });

  it("selects the tab before the one closed when the last tab is closed, and selects the Claude tab when no terminal is left", async () => {
    await openTwo();
    const close = await mock("orca_close", null);
    await closeButton(2).click();
    await waitForCount(termTab, 1);
    expect(await tabs()).toEqual(["example-api ・ main"]);
    expect(await selection()).toEqual(["true"]);
    await browser.waitUntil(async () => ((await callsOf("orca_terminal_read")) as { handle: string }[]).at(-1)?.handle === zsh, { timeoutMsg: "the first terminal was not shown again" });
    await closeButton(1).click();
    expect((await waitForCalls(close, 2)).map((c) => (c as { handle: string }).handle)).toEqual([app, zsh]);
    await waitForCount("#database-terminal-tabs > *", 1);
    await waitForCount(".database-terminal-term", 0);
    expect(await count("#database-terminal-body > *")).toBe(1);
    await expect($("#database-claude-tab")).toHaveAttribute("aria-selected", "true");
    await expect($("#database-claude-term")).toBeDisplayed();
    const read = await mock("orca_terminal_read", ["$"]);
    await browser.pause(600);
    expect(await callsOf(read)).toEqual([]);
  });

  it("selects the tab that followed the one closed", async () => {
    await openTwo();
    await tabButton(1).click();
    await mock("orca_close", null);
    await closeButton(1).click();
    await waitForCount(termTab, 1);
    expect(await tabs()).toEqual(["example-app ・ feat/a"]);
    expect(await selection()).toEqual(["true"]);
  });

  it("closes a terminal of a saved environment with the name of the environment", async () => {
    await openPane(placedOverview([], worktreesOf(), studio));
    await waitForCalls("orca_stream_open");
    await sendStream(placedStream([], worktreesOf(), [orcaTerminal("example-api", "zsh")]));
    await mock("orca_terminal_create", created);
    await pick(apiPath);
    await waitForCalls("orca_stream_terminal");
    const close = await mock("orca_close", null);
    await closeButton(1).click();
    expect(await waitForCalls(close)).toEqual([{ handle: zsh, environment: "Studio" }]);
    await waitForCount("#database-terminal-tabs > *", 1);
  });

  it("keeps the close button off while the close is on its way, and drops the tab when Orca has closed it", async () => {
    await openTwo();
    const close = await mock("orca_close", holds);
    await closeButton(1).click();
    await waitForCalls(close);
    await expect(closeButton(1)).toBeDisabled();
    await expect(closeButton(2)).toBeEnabled();
    expect(await count(termTab)).toBe(2);
    await release(close, null);
    await waitForCount(termTab, 1);
  });

  it("keeps the tab and says Rust's message when the close fails, reads the list again, and clears the notice at the next press", async () => {
    await openTwo();
    const close = await mock("orca_close", rejects("Orca が時間内に応答しませんでした"));
    const overview = await mock("orca_overview", bothListed());
    await closeButton(1).click();
    await waitForCalls(close);
    await expect($("#database-terminal-body > .pending.fail")).toHaveText("Orca が時間内に応答しませんでした");
    await waitForCalls(overview);
    expect(await tabs()).toEqual(["example-api ・ main", "example-app ・ feat/a"]);
    await expect(closeButton(1)).toBeEnabled();
    await mock("orca_close", null);
    await closeButton(1).click();
    await waitForCount(termTab, 1);
    expect(await count("#database-terminal-body > .pending")).toBe(0);
  });

  it("forgets a terminal that Orca closed, whether or not its tab is selected, and keeps the other with its reads", async () => {
    await openTwo();
    await mock("orca_overview", orcaOverview([], worktreesOf(), { terminals: [orcaTerminal("example-app", "zsh")] }));
    await waitForCount(termTab, 1);
    expect(await tabs()).toEqual(["example-app ・ feat/a"]);
    expect(await selection()).toEqual(["true"]);
    const read = await mock("orca_terminal_read", ["$ pwd"]);
    expect(((await waitForCalls(read))[0] as { handle: string }).handle).toBe(app);
    expect(await count(".database-terminal-term")).toBe(1);
  });

  it("shows the Claude tab first, selects the terminal that is opened, and shows the Claude box again when its tab is pressed", async () => {
    await openTerminal();
    expect(await textsOf('#database-terminal-tabs [role="tab"]')).toEqual(["Claude", "example-api ・ main"]);
    await expect($("#database-claude-term")).not.toBeDisplayed();
    await expect($(".database-terminal-term")).toBeDisplayed();
    await $("#database-claude-tab").click();
    await expect($("#database-claude-tab")).toHaveAttribute("aria-selected", "true");
    expect(await selection()).toEqual(["false"]);
    await expect($("#database-claude-term")).toBeDisplayed();
    await expect($(".database-terminal-term")).not.toBeDisplayed();
    expect((await callsOf("claude_code_start")).length).toBe(1);
    await tabButton(1).click();
    expect(await selection()).toEqual(["true"]);
    await expect($("#database-claude-term")).not.toBeDisplayed();
  });

  it("drops the Claude tab with its close button and keeps the pane and the terminal, which is selected", async () => {
    await openTerminal();
    await $("#database-claude-tab").click();
    const close = await mock("claude_code_close", null);
    await closeButton(0).click();
    expect(await waitForCalls(close)).toEqual([{ id: "database-claude", launch: 1 }]);
    await expect($("#database-claude-tab")).not.toExist();
    await expect($("#database-terminal")).toBeDisplayed();
    await expect(toggle()).toHaveAttribute("aria-pressed", "true");
    expect(await tabs()).toEqual(["example-api ・ main"]);
    expect(await selection()).toEqual(["true"]);
    await mock("orca_terminal_read", ["$ pwd"]);
    await waitScreen("$ pwd");
  });

  it("drops the Claude tab when its process ends, keeps the pane while a terminal is open, and starts Claude Code again when the pane is opened after the terminals are gone", async () => {
    await openTerminal();
    await sendClaudeCode({ kind: "ended", message: "Claude Code が終わりました", clean: true });
    await expect($("#database-claude-tab")).not.toExist();
    await expect($("#database-terminal")).toBeDisplayed();
    expect(await tabs()).toEqual(["example-api ・ main"]);
    await toggle().click();
    await toggle().click();
    expect((await waitForCalls("claude_code_start", 2)).length).toBe(2);
    await expect($("#database-claude-tab")).toBeDisplayed();
  });

  it("keeps the process of Claude Code when the pane is closed and when another screen is shown", async () => {
    await openPane();
    await waitForCalls("claude_code_start");
    const close = await mock("claude_code_close", null);
    await toggle().click();
    await expect($("#database-terminal")).not.toBeDisplayed();
    await toggle().click();
    await $("#nav-mail").click();
    await browser.pause(400);
    await $("#nav-database").click();
    await expect($("#database-claude-tab")).toBeDisplayed();
    await expect($("#database-claude-term")).toBeDisplayed();
    expect(await callsOf(close)).toEqual([]);
    expect((await callsOf("claude_code_start")).length).toBe(1);
  });

  it("says in the pane that Orca is missing, and opens no dialog", async () => {
    await openPane(orcaOverview([], [], { state: "missing" }));
    const create = await mock("orca_terminal_create", created);
    await plus().click();
    await expect($("#database-terminal-body > .pending.fail")).toHaveText(expect.stringContaining("orca コマンドが見つかりません"));
    await expect($(".orca-dest-pop")).not.toExist();
    expect(await callsOf(create)).toEqual([]);
  });

  it("says in the pane that the list could not be read, and clears it at the next press", async () => {
    await openPane(orcaOverview([], [], { state: "failed", message: "接続できません" }));
    await plus().click();
    await expect($("#database-terminal-body > .pending.fail")).toHaveText("読み込めませんでした: 接続できません");
    await mock("orca_overview", listed());
    await plus().click();
    await expect($(".orca-dest-pop")).toBeDisplayed();
    expect(await count("#database-terminal-body > .pending")).toBe(0);
  });

  it("says Rust's message when the terminal cannot be opened, and keeps the one that is held", async () => {
    await openTerminal();
    await mock("orca_terminal_create", rejects("起動先の worktree が見つかりません。一覧を読み直してください"));
    await pick("/work/example-app");
    await expect($("#database-terminal-body > .pending.fail")).toHaveText("起動先の worktree が見つかりません。一覧を読み直してください");
    expect(await tabs()).toEqual(["example-api ・ main"]);
    await expect(plus()).toBeEnabled();
    await mock("orca_terminal_create", { paneKey: null, handle: null });
    await pick("/work/example-app");
    await expect($("#database-terminal-body > .pending.fail")).toHaveText("Orca がターミナルの名前を返しませんでした");
    expect(await tabs()).toEqual(["example-api ・ main"]);
  });
});
