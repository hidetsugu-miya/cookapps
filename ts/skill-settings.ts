// The Skill tab of the settings screen (A-32): the skills at the left and the form of one at the right, to make, change and delete them.
// Rust holds the skills and checks every text (`ts/ipc.ts`: `skill_list`, `skill_get`, `skill_save`, `skill_delete`); this module draws them and sends what the form holds.
import type { Skill } from "./bindings/Skill";
import type { SkillScreen } from "./bindings/SkillScreen";
import { $, tag } from "./dom.js";
import { confirmDelete } from "./hint.js";
import { invoke } from "./ipc.js";
import { logError, showFailure } from "./error-card.js";

// The skills as last read, by name.
let skills: Skill[] = [];
// What the form shows: null while it is hidden, the name of a saved skill, or "" for a new one.
let shown: string | null = null;
// Only the latest read may draw the list.
let listSeq = 0;
// A save or a delete is on its way: the list and the form wait.
let busy = false;

const field = (id: string) => $<HTMLInputElement>(id);
const screenBoxes = () => [...document.querySelectorAll<HTMLInputElement>("#skill-screens input[data-screen]")];

function drawList() {
  $("skill-new").setAttribute("aria-pressed", String(shown === ""));
  if (skills.length === 0) return $("skill-list").replaceChildren(tag("div", "item-meta skill-empty", "スキルはまだありません"));
  $("skill-list").replaceChildren(
    ...skills.map((s) => {
      const row = tag("button", "skill-row");
      row.type = "button";
      row.setAttribute("aria-current", String(s.name === shown));
      row.append(tag("div", "item-name", s.displayName), tag("div", "item-meta", s.name));
      row.onclick = () => showSkill(s);
      return row;
    }),
  );
}

// Fills the form with `skill` (a saved one), or empties it (null: a new one).
function showSkill(skill: Skill | null) {
  if (busy) return;
  shown = skill?.name ?? "";
  $("skill-form").hidden = false;
  field("skill-name").value = skill?.name ?? "";
  // The name is the folder of the skill: a saved skill keeps it, and a name typed for another one would make a second skill.
  field("skill-name").readOnly = skill !== null;
  field("skill-display-name").value = skill?.displayName ?? "";
  for (const box of screenBoxes()) box.checked = skill?.screens.includes(box.dataset.screen as SkillScreen) ?? false;
  $<HTMLTextAreaElement>("skill-description").value = skill?.description ?? "";
  $<HTMLTextAreaElement>("skill-instructions").value = skill?.instructions ?? "";
  $("skill-delete").hidden = skill === null;
  drawList();
  if (skill === null) field("skill-name").focus();
}

async function loadSkills() {
  const seq = ++listSeq;
  let list: Skill[];
  try {
    list = await invoke("skill_list");
  } catch (e) {
    return logError("skill-settings", e);
  }
  if (seq !== listSeq) return;
  skills = list;
  drawList();
}

// The tab was shown: the skills are read, so a start without the settings never reads them.
export function showSkillTab() {
  loadSkills();
}

async function saveSkill() {
  if (busy) return;
  const skill: Skill = {
    name: field("skill-name").value,
    displayName: field("skill-display-name").value,
    screens: screenBoxes().filter((b) => b.checked).map((b) => b.dataset.screen as SkillScreen),
    description: $<HTMLTextAreaElement>("skill-description").value,
    instructions: $<HTMLTextAreaElement>("skill-instructions").value,
  };
  // A save of an existing name replaces that skill, so a new skill with a taken name is stopped here too (Rust refuses it by `create` when this list was not read).
  const create = shown === "";
  if (create && skills.some((s) => s.name === skill.name)) return showFailure("skill-settings", `スキル「${skill.name}」はもうあります`);
  busy = true;
  let saved: Skill;
  try {
    saved = await invoke("skill_save", { skill, create });
  } catch (e) {
    return showFailure("skill-settings", e);
  } finally {
    busy = false;
  }
  showSkill(saved);
  loadSkills();
}

async function deleteSkill(name: string) {
  if (busy) return;
  busy = true;
  try {
    await invoke("skill_delete", { name });
  } catch (e) {
    return showFailure("skill-settings", e);
  } finally {
    busy = false;
  }
  shown = null;
  $("skill-form").hidden = true;
  loadSkills();
}

export function initSkillSettings() {
  $("skill-new").onclick = () => showSkill(null);
  $("skill-form").onsubmit = (e) => {
    e.preventDefault();
    saveSkill();
  };
  $("skill-delete").onclick = () => {
    const skill = skills.find((s) => s.name === shown);
    if (skill) confirmDelete($("skill-delete"), skill.displayName, () => deleteSkill(skill.name));
  };
}
