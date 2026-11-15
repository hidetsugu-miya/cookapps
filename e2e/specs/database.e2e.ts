import { boot, callsOf, count, databaseProfile, holds, inbox, mock, rejects, release, textsOf, waitForCalls, waitForCount } from "../support";

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
// Presses the menu of the row of `id`, and then the item (1 edit, 2 delete).
const pickFromMenu = async (id: string, item: 1 | 2) => {
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

  it("makes a press on a connection pressed and opens nothing", async () => {
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
    await pickFromMenu("p1", 2);
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
