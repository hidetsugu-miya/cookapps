// The popup that adds a project to Orca (A-38), under the button of the list's header: a select of the place (this Mac, and the saved environments of A-6) and 「フォルダを選ぶ…」.
// On this Mac Rust opens the folder dialog of the system and adds the folder picked (`orca_project_add_here`); a saved environment's folder is picked on its server (`orca-browse.ts`).
import { tag } from "./dom.js";
import { FOLDER_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { closeMenu, showMenu } from "./menu.js";
import { openBrowseDialog } from "./orca-browse.js";
import { showError } from "./view.js";

// Opens the popup under `anchor`. `environments` are the names of the saved environments, after this Mac in the select; `added` runs after a folder was added, to read the list again.
export function openAddProject(anchor: Element, environments: string[], added: () => void) {
  const pop = tag("div", "menu orca-add-pop");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "プロジェクトを追加");
  const place = tag("select");
  place.setAttribute("aria-label", "場所");
  place.append(new Option("この Mac"));
  for (const name of environments) place.append(new Option(name));
  const field = tag("label", "orca-add-field");
  field.append(tag("span", "", "場所"), place);
  const pick = tag("button", "orca-add-pick");
  pick.type = "button";
  pick.innerHTML = FOLDER_SVG;
  pick.append(tag("span", "", "フォルダを選ぶ…"));
  pop.append(field, pick);

  pick.onclick = async () => {
    // The first option is this Mac, and the others are the saved environments in the order given.
    const environment = place.selectedIndex === 0 ? null : environments[place.selectedIndex - 1];
    closeMenu();
    if (environment !== null) {
      openBrowseDialog(environment, anchor, added);
      return;
    }
    try {
      // Rust opens the folder dialog and adds the folder picked; a cancelled dialog answers false.
      if (await invoke("orca_project_add_here")) added();
    } catch (e) {
      showError(e);
    }
  };

  showMenu(anchor, pop);
  pick.focus();
}
