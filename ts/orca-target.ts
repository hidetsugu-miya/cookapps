// The card of the target in the Orca tab of the settings screen (A-6): "このマシン" and the saved environments, the one in use marked, and a pick saves it and reads again.
// The Orca screen holds the environments and the target (`heldOrca`), and picks through `chooseTarget`; nothing is asked of Rust here.
import { $, tag } from "./dom.js";
import { code, hintPopup, toggleHint } from "./hint.js";
import { chooseTarget, heldOrca, readOrcaTargets, THIS_MACHINE } from "./orca.js";

// "このマシン" and each environment the Orca screen holds, a label on the target and a button on the others.
function draw() {
  const v = heldOrca();
  const rows = [null, ...(v?.environments ?? [])].map((name) => {
    const who = tag("div", "who");
    who.append(tag("div", "item-name", name ?? THIS_MACHINE));
    const item = tag("div", "item");
    item.dataset.target = name ?? "";
    item.append(who);
    if (name === (v?.target ?? null)) {
      item.append(tag("span", "status ok", "選択中"));
      return item;
    }
    const pick = tag("button", "text-btn", "選ぶ");
    pick.setAttribute("aria-label", `${name ?? THIS_MACHINE}を選ぶ`);
    pick.onclick = async () => {
      await chooseTarget(name);
      draw();
    };
    item.append(pick);
    return item;
  });
  $("orca-target-items").replaceChildren(...rows);
}

// The tab is shown: what the Orca screen holds is drawn at once, and the environments are read again, as when the Orca screen is shown.
export function showOrcaTargetCard() {
  $("orca-target-help").onclick = (e) =>
    toggleHint(
      e.currentTarget as Element,
      hintPopup(
        "Orca の接続先",
        [
          ["Orca 画面が読む Orca を選びます。「このマシン」は、この Mac の Orca です"],
          ["保存した環境は、Orca に登録したサーバーです。", code("orca environment list"), " に出るものが並びます"],
          ["選ぶと保存して、Orca 画面が読み直します。選んだ接続先のほかに、この Mac の Orca も一覧に並びます"],
        ],
        "選んだ接続先は、cookapps の設定に保存します",
      ),
    );
  draw();
  void readOrcaTargets().then(draw);
}
