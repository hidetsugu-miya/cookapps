import { boot, callsOf, count, databaseCell, databaseColumn, databaseNull, databaseProfile, databaseRecords, databaseSqlResult, databaseStructure, databaseTable, holds, inbox, mock, rejects, release, textsOf, waitForCalls, waitForCount } from "../support";

const direct = databaseProfile("p1", "Example direct");
const tunnel = databaseProfile("p2", "Example tunnel", { useSsm: true, awsProfile: "work", region: "ap-northeast-1", bastionName: "bastion", dbHost: "db.internal.example.com", passwordSaved: true });

// The app with `profiles` saved, and the database screen open.
async function openDatabase(profiles = [direct, tunnel], fixtures: Record<string, unknown> = {}) {
  await boot({ inbox: inbox(), database_profiles: profiles, ...fixtures });
  await $("#nav-database").click();
  await expect($("#database")).toBeDisplayed();
  await waitForCount("#database-side-feed .database-item", profiles.length);
}

const names = () => textsOf("#database-side-feed .database-btn");
// Presses the menu of the row of `id`, and then the item (1 edit, 2 delete; 2 disconnect and 3 delete while the connection is open).
const pickFromMenu = async (id: string, item: 1 | 2 | 3) => {
  await $(`#database-side-feed [data-key="${id}/more"]`).click();
  await $(`.menu button[role="menuitem"]:nth-child(${item})`).click();
};
const field = (name: string) => $(`#database-form [name="${name}"]`);
// The profile that the popup sends when it is filled in as a connection with no SSM.
const typed = { id: "", name: "Example new", username: "reader", useSsm: false, awsProfile: "", region: "", bastionName: "", dbHost: "db.example.com", dbPort: 3306 };
const fillDirect = async () => {
  await field("name").setValue("Example new");
  await field("username").setValue("reader");
  await field("dbHost").setValue("db.example.com");
};

describe("database", () => {
  it("has a button with a drawn icon and no text, last before the bottom group, that opens the two-part screen and reads the connections", async () => {
    await openDatabase();
    const nav = $("#nav-database");
    await expect(nav).toHaveAttribute("aria-label", "データベース");
    await expect(nav).toHaveAttribute("aria-current", "page");
    expect(await nav.getText()).toBe("");
    await expect(nav.$("svg")).toExist();
    await expect($("#database-side")).toBeDisplayed();
    await expect($("#database-pane")).toBeDisplayed();
    await expect($("#database-side-split")).toBeDisplayed();
    expect(await callsOf("database_profiles")).toEqual([null]);
  });

  it("lists the connections by name, in the order Rust gives them, with no text that explains", async () => {
    await openDatabase();
    expect(await names()).toEqual(["Example direct", "Example tunnel"]);
    await expect($("#database-add")).toHaveAttribute("aria-label", "接続を追加");
    expect(await textsOf("#database-side-feed")).toEqual(["Example directExample tunnel"]);
    expect(await count("#database-form")).toBe(0);
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
    await openDatabase();
    await $('#database-side-feed [data-key="p2"]').click();
    await expect($('#database-side-feed [data-key="p2"]')).toHaveAttribute("aria-pressed", "true");
    await expect($('#database-side-feed [data-key="p1"]')).toHaveAttribute("aria-pressed", "false");
    expect(await count("#database-work > *")).toBe(0);
    expect(await callsOf("database_profiles")).toEqual([null]);
  });
});

describe("database: register", () => {
  it("opens a popup from the plus, with the fields of a connection with no SSM, the port 3306 and the AWS fields hidden", async () => {
    await openDatabase([]);
    await $("#database-add").click();
    await expect($("#database-form")).toBeDisplayed();
    await expect($("#database-form")).toHaveAttribute("aria-label", "接続を追加");
    await expect($("#database-form h2")).toHaveText("接続を追加");
    await expect(field("dbPort")).toHaveValue("3306");
    await expect(field("useSsm")).not.toBeSelected();
    await expect(field("awsProfile")).not.toBeDisplayed();
    await expect(field("region")).not.toBeDisplayed();
    await expect(field("bastionName")).not.toBeDisplayed();
    expect(await browser.execute(() => document.activeElement?.getAttribute("name"))).toBe("name");
    expect(await count("#database-form [placeholder]")).toBe(0);
    await expect($("#database-form .status")).not.toExist();
  });

  it("saves a connection with no SSM, sends the id empty and the password, closes, and draws the list that Rust answers next", async () => {
    await openDatabase([direct]);
    const save = await mock("database_profile_save", databaseProfile("p3", "Example new", { passwordSaved: true }));
    await mock("database_profiles", [direct, databaseProfile("p3", "Example new")]);
    await $("#database-add").click();
    await fillDirect();
    await field("password").setValue("secret");
    await $("#database-form button[type=submit]").click();
    expect(await waitForCalls(save)).toEqual([{ profile: typed, password: "secret" }]);
    await expect($("#database-form")).not.toExist();
    await waitForCount("#database-side-feed .database-item", 2);
    expect(await names()).toEqual(["Example direct", "Example new"]);
  });

  it("shows the three AWS fields with the checkbox, and sends them", async () => {
    await openDatabase([]);
    const save = await mock("database_profile_save", databaseProfile("p3", "Example new"));
    await mock("database_profiles", [databaseProfile("p3", "Example new")]);
    await $("#database-add").click();
    await fillDirect();
    await field("useSsm").click();
    await expect(field("awsProfile")).toBeDisplayed();
    await expect(field("region")).toBeDisplayed();
    await expect(field("bastionName")).toBeDisplayed();
    await field("awsProfile").setValue("work");
    await field("region").setValue("ap-northeast-1");
    await field("bastionName").setValue("bastion");
    await field("dbPort").setValue("3307");
    await $("#database-form button[type=submit]").click();
    expect(await waitForCalls(save)).toEqual([
      { profile: { ...typed, useSsm: true, awsProfile: "work", region: "ap-northeast-1", bastionName: "bastion", dbPort: 3307 }, password: "" },
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

  it("shows the reason of a refused save under the fields, keeps the popup and what was typed, and saves again", async () => {
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

  it("closes on キャンセル and on Escape, calls nothing, and makes the screen behind usable again", async () => {
    await openDatabase([direct]);
    const save = await mock("database_profile_save", databaseProfile("p3", "x"));
    await $("#database-add").click();
    await fillDirect();
    await $("#database-form .text-btn:not(.primary)").click();
    await expect($("#database-form")).not.toExist();
    await $("#database-add").click();
    await expect(field("name")).toHaveValue("");
    await browser.keys("Escape");
    await expect($("#database-form")).not.toExist();
    expect(await callsOf(save)).toEqual([]);
    expect(await browser.execute(() => document.getElementById("content")!.inert)).toBe(false);
  });
});

describe("database: edit", () => {
  it("opens the popup from the menu of a row with the fields filled and a saved password shown as a status, not the password", async () => {
    await openDatabase();
    await pickFromMenu("p2", 1);
    await expect($("#database-form")).toHaveAttribute("aria-label", "接続を編集");
    await expect(field("name")).toHaveValue("Example tunnel");
    await expect(field("username")).toHaveValue("reader");
    await expect(field("password")).toHaveValue("");
    await expect($("#database-form .status.ok")).toHaveText("保存済み");
    await expect(field("useSsm")).toBeSelected();
    await expect(field("awsProfile")).toHaveValue("work");
    await expect(field("region")).toHaveValue("ap-northeast-1");
    await expect(field("bastionName")).toHaveValue("bastion");
    await expect(field("dbHost")).toHaveValue("db.internal.example.com");
    await expect(field("dbPort")).toHaveValue("3306");
  });

  it("shows no saved-password status for a connection with none", async () => {
    await openDatabase();
    await pickFromMenu("p1", 1);
    await expect(field("name")).toHaveValue("Example direct");
    await expect($("#database-form .status")).not.toExist();
    await expect(field("awsProfile")).not.toBeDisplayed();
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
        profile: { id: "p2", name: "Example renamed", username: "reader", useSsm: true, awsProfile: "work", region: "ap-northeast-1", bastionName: "bastion", dbHost: "db.internal.example.com", dbPort: 3306 },
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
  const probe = () => $("#database-form .popup-actions button:nth-child(2)");
  const result = () => $("#database-test-result");

  it("has the button 接続をテスト between 保存 and キャンセル, with nothing shown and nothing called before it is pressed", async () => {
    const test = await mock("database_test", "8.0.36");
    await openDatabase([]);
    await $("#database-add").click();
    expect(await textsOf("#database-form .popup-actions button")).toEqual(["保存", "接続をテスト", "キャンセル"]);
    await expect(probe()).toHaveAttribute("type", "button");
    await expect(result()).not.toBeDisplayed();
    expect(await callsOf(test)).toEqual([]);
  });

  it("sends the fields as typed and the typed password, shows the version as a status, and saves nothing and keeps the popup", async () => {
    await openDatabase([direct]);
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
    await expect(probe()).toBeEnabled();
    await expect($("#database-form-error")).not.toBeDisplayed();
    expect(await callsOf(save)).toEqual([]);
    expect(await callsOf("database_profiles")).toEqual([null]);
  });

  it("tests the connection of an edit with its id and the fields as typed now, and an empty password for Rust to read the saved one", async () => {
    await openDatabase();
    const test = await mock("database_test", "5.7.44-log");
    await pickFromMenu("p2", 1);
    await field("dbPort").setValue("3307");
    await probe().click();
    expect(await waitForCalls(test)).toEqual([
      {
        profile: { id: "p2", name: "Example tunnel", username: "reader", useSsm: true, awsProfile: "work", region: "ap-northeast-1", bastionName: "bastion", dbHost: "db.internal.example.com", dbPort: 3307 },
        password: "",
      },
    ]);
    await expect(result()).toHaveText("MySQL 5.7.44-log");
  });

  it("shows the error as it is, in the danger color, keeps the popup, and a second test replaces it", async () => {
    await openDatabase([]);
    const message = "トンネルは開きましたが、MySQL が応えません。踏み台から DB のホストとポートに届くか（DB のセキュリティグループが踏み台からの接続を許しているか）を確かめてください";
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

  it("draws nothing when the popup was closed while the test was on its way, and a new popup shows no answer", async () => {
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
    const message = "AWS の認証が切れています。手元で aws login を行ってから、もう一度お試しください";
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
      { hasMore: true, summary: "1–2 行目 / 約 1,200 行" },
    );
    const page1 = databaseRecords(columns, [[num("3"), databaseCell("Carol"), databaseCell(""), bin("バイナリ 1.5 KB"), databaseNull, num("1.00")]], {
      page: 1,
      summary: "3–3 行目 / 約 1,200 行",
    });
    const read = (page: number) => ({ id: "p1", database: "shop", table: "users", page });
    const grid = () =>
      browser.execute(() => [...document.querySelectorAll("#database-work .database-grid tbody tr")].map((tr) => [...tr.children].map((td) => td.textContent)));
    const button = (key: string) => $(`#database-work [data-key="${key}"]`);

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

    it("draws the tab レコード, selected, in place of the table list", async () => {
      await openTable();
      expect(await textsOf("#database-work [role='tab']")).toEqual(["レコード", "構造", "SQL"]);
      await expect($("#database-work [role='tab']")).toHaveAttribute("aria-selected", "true");
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

    it("has the range and the estimated rows under the table, with 前へ off on the first page and 次へ on", async () => {
      await openTable();
      await expect($("#database-work .database-range")).toHaveText("1–2 行目 / 約 1,200 行");
      expect(await textsOf("#database-work .database-pager button")).toEqual(["前へ", "次へ", "再読み込み"]);
      await expect(button("prev")).toBeDisabled();
      await expect(button("next")).toBeEnabled();
      await expect(button("reload")).toBeEnabled();
    });

    it("reads the next page with 次へ and the page before with 前へ", async () => {
      await openTable();
      const next = await mock("database_records", page1);
      await button("next").click();
      expect(await waitForCalls(next)).toEqual([read(1)]);
      await expect($("#database-work .database-range")).toHaveText("3–3 行目 / 約 1,200 行");
      expect(await grid()).toEqual([["3", "Carol", "", "バイナリ 1.5 KB", "NULL", "1.00"]]);
      await expect(button("prev")).toBeEnabled();
      await expect(button("next")).toBeDisabled();
      const back = await mock("database_records", page0);
      await button("prev").click();
      expect(await waitForCalls(back)).toEqual([read(0)]);
      await expect($("#database-work .database-range")).toHaveText("1–2 行目 / 約 1,200 行");
      await expect(button("prev")).toBeDisabled();
    });

    it("reads the page that is shown again with 再読み込み, and draws what Rust answers now", async () => {
      await openTable();
      await mock("database_records", page1);
      await button("next").click();
      await waitForCalls("database_records");
      await expect($("#database-work .database-range")).toHaveText("3–3 行目 / 約 1,200 行");
      const changed = databaseRecords(columns, [[num("3"), databaseCell("Carol B"), databaseCell(""), bin("バイナリ 4 B"), databaseNull, num("2.00")]], { page: 1, summary: "3–3 行目" });
      const again = await mock("database_records", changed);
      await button("reload").click();
      expect(await waitForCalls(again)).toEqual([read(1)]);
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
      expect(await waitForCalls(again)).toEqual([read(0)]);
      await expect($("#database-work .database-range")).toHaveText("1–2 行目 / 約 1,200 行");
    });

    it("shows 読み込み中… under the table with the buttons off and the page kept while the next one is read", async () => {
      await openTable();
      const wait = await mock("database_records", holds);
      await button("next").click();
      await waitForCalls(wait);
      await expect($("#database-work .database-range")).toHaveText("読み込み中…");
      for (const key of ["prev", "next", "reload"]) await expect(button(key)).toBeDisabled();
      expect(await count("#database-work .database-grid tbody tr")).toBe(2);
      await release("database_records", page1);
      await expect($("#database-work .database-range")).toHaveText("3–3 行目 / 約 1,200 行");
      expect(await count("#database-work .database-grid tbody tr")).toBe(1);
      expect(await callsOf(wait)).toHaveLength(1);
    });

    it("draws only the range for a table with no row", async () => {
      await openTable(databaseRecords([], []));
      await expect($("#database-work .database-range")).toHaveText("0 行");
      expect(await count("#database-work .database-grid")).toBe(0);
      await expect(button("prev")).toBeDisabled();
      await expect(button("next")).toBeDisabled();
      await expect(button("reload")).toBeEnabled();
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
      await expect(button("reload")).toBeEnabled();
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

    it("has no control to add, edit or delete a row: only the tabs and the three buttons", async () => {
      await openTable();
      expect(await textsOf("#database-work button")).toEqual(["レコード", "構造", "SQL", "前へ", "次へ", "再読み込み"]);
      expect(await count("#database-work input, #database-work textarea, #database-work [contenteditable]")).toBe(0);
      await $("#database-work .database-grid tbody td:nth-child(2)").doubleClick();
      expect(await count("#database-work input, #database-work textarea, #database-work [contenteditable]")).toBe(0);
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
      expect(await count("#database-work .database-pager button")).toBe(0);
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
      expect(await callsOf(records)).toEqual([{ ...asked, page: 0 }]);
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

    it("has no control on the structure but the three tabs, and no input", async () => {
      await openTable();
      await mock("database_structure", structure);
      await tab("structure").click();
      await expect($("#database-work .database-range")).toHaveText("4 列 / InnoDB / utf8mb4");
      expect(await textsOf("#database-work button")).toEqual(["レコード", "構造", "SQL"]);
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

    it("has the tab SQL after 構造, which calls nothing when it is pressed and draws the field and 実行 with no placeholder and no text of help", async () => {
      await openSql();
      expect(await textsOf("#database-work [role='tab']")).toEqual(["レコード", "構造", "SQL"]);
      await expect(tab("sql")).toHaveAttribute("aria-selected", "true");
      await expect(tab("records")).toHaveAttribute("aria-selected", "false");
      expect(await callsOf("database_sql")).toEqual([]);
      expect(await callsOf("database_structure")).toEqual([]);
      await expect(input()).toHaveAttribute("aria-label", "SQL");
      await expect(input()).toHaveValue("");
      expect(await textsOf("#database-work button")).toEqual(["レコード", "構造", "SQL", "実行"]);
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

    it("has no other control on the tab than the tabs and 実行, and the field is the only input", async () => {
      await openSql();
      expect(await textsOf("#database-work button")).toEqual(["レコード", "構造", "SQL", "実行"]);
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

  it("has 切断 in the menu of an open connection only, between 編集 and 削除", async () => {
    await openTree();
    await $('#database-side-feed [data-key="p1/more"]').click();
    expect(await textsOf('.menu button[role="menuitem"]')).toEqual(["編集", "切断", "削除"]);
    await browser.keys("Escape");
    await $('#database-side-feed [data-key="p2/more"]').click();
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
    const closed = await mock("database_disconnect", rejects("AWS への接続が時間内に終わりませんでした"));
    await pickFromMenu("p1", 2);
    await waitForCalls(closed);
    await expect($("#error")).toHaveText("AWS への接続が時間内に終わりませんでした");
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
