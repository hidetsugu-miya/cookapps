// The dialog that makes a formation (A-37): a name and the projects of the formation, the repositories of this Mac and of the saved environments (`formation_environments`). Rust checks the name and the projects and makes the formation (`formation_create`); this module draws the fields and tells the caller the formation that was made.
import type { FormationEntry } from "./bindings/FormationEntry";
import type { FormationProject } from "./bindings/FormationProject";
import { $, composing, partMatcher, tag } from "./dom.js";
import { ensureConsent } from "./formation-consent.js";
import { invoke } from "./ipc.js";
import { closeMenu, showMenu } from "./menu.js";
import { showError } from "./view.js";

// Opens the dialog under `anchor`. `created` runs with the formation that Rust made (a project of a saved environment with no consent asks for it first, `ensureConsent`). The environments are read when the dialog opens; the dialog is drawn at once and its list is filled when they answer.
export function openFormationDialog(anchor: Element, created: (entry: FormationEntry) => void) {
  const pop = tag("div", "menu formation-new-pop");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "新しいフォーメーション");
  const name = tag("input");
  name.type = "text";
  name.autocomplete = "off";
  name.spellcheck = false;
  name.setAttribute("aria-label", "名前");
  const nameField = tag("label", "formation-new-field");
  nameField.append(tag("span", "", "名前"), name);
  const filter = tag("input");
  filter.type = "text";
  filter.autocomplete = "off";
  filter.spellcheck = false;
  filter.setAttribute("aria-label", "プロジェクトを絞り込む");
  const list = tag("div", "formation-new-list");
  const projectField = tag("div", "formation-new-field");
  projectField.append(tag("span", "", "プロジェクト"), filter, list);
  const cancel = tag("button", "text-btn", "キャンセル");
  cancel.type = "button";
  const make = tag("button", "text-btn primary", "作成");
  make.type = "button";
  // The projects can be chosen once the environments have answered.
  make.disabled = true;
  const actions = tag("div", "formation-new-actions");
  actions.append(cancel, make);
  pop.append(nameField, projectField, actions);

  // The projects in the order of the lists, each with its row (for the filter) and its box.
  const projects: { project: FormationProject; row: HTMLLabelElement; box: HTMLInputElement }[] = [];
  const sections: { head: HTMLElement; rows: HTMLElement[] }[] = [];
  // A heading is shown only while a row under it is: an environment with no project, or none that the filter leaves, has none. An environment that could not be read, and a list of saved environments that could not be read, show nothing: their words are Orca's own and name no project to choose.
  const narrow = () => {
    const re = partMatcher(filter.value);
    for (const p of projects) p.row.hidden = re !== null && !re.test(p.project.repo);
    for (const s of sections) s.head.hidden = s.rows.every((r) => r.hidden);
  };
  // Each change of the text shows the list from its top, so that the rows that match are seen from the first (#942).
  filter.oninput = () => {
    narrow();
    list.scrollTop = 0;
  };

  let busy = false;
  const submit = async () => {
    const wanted = name.value;
    if (busy || make.disabled || wanted === "") return;
    $("error").hidden = true;
    busy = true;
    make.disabled = true;
    try {
      const chosen = projects.filter((p) => p.box.checked).map((p) => p.project);
      // The projects of one saved environment need the owner's consent for its PC. A mix of environments is refused by Rust with its own reason, so no consent is asked for it. The dialog of the consent replaces this one; when the owner declines, nothing is made.
      const environments = [...new Set(chosen.map((p) => p.environment))];
      if (environments.length === 1 && !(await ensureConsent(make, environments[0]))) {
        busy = false;
        make.disabled = false;
        return;
      }
      const entry = await invoke("formation_create", { name: wanted, projects: chosen });
      if (pop.isConnected) closeMenu();
      created(entry);
    } catch (e) {
      // A failure keeps the dialog (when it is still open) as it was typed.
      showError(e);
      busy = false;
      make.disabled = false;
    }
  };
  cancel.onclick = () => closeMenu();
  make.onclick = () => void submit();
  name.onkeydown = (e) => {
    if (composing(e) || e.key !== "Enter") return;
    e.preventDefault();
    void submit();
  };

  showMenu(anchor, pop);
  name.focus();

  $("error").hidden = true;
  void invoke("formation_environments").then(
    (view) => {
      if (!pop.isConnected) return;
      for (const environment of view.environments) {
        if (!environment.ok) continue;
        const head = tag("p", "formation-new-env", environment.label ?? environment.environment);
        const rows: HTMLElement[] = [];
        list.append(head);
        for (const repo of environment.repos ?? []) {
          const box = tag("input");
          box.type = "checkbox";
          const row = tag("label", "formation-new-repo");
          row.append(box, tag("span", "", repo.name));
          list.append(row);
          rows.push(row);
          projects.push({ project: { environment: environment.environment, repo: repo.name }, row, box });
        }
        sections.push({ head, rows });
      }
      narrow();
      make.disabled = false;
    },
    (e) => {
      // Without the environments no project can be chosen: the dialog closes with the words of the failure.
      if (pop.isConnected) closeMenu();
      showError(e);
    },
  );
}
