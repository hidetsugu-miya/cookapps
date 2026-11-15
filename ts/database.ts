// The database screen (D-1): the connections at the left (the side menu), and at the right the work pane, which holds nothing yet (the tree of databases and tables and the tabs of records, structure and SQL come next).
// This module holds the list that `database_profiles` last answered and what is selected; the side menu only draws it (database-side.ts), and the popup (database-form.ts) only asks for the fields.
import type { DatabaseProfile } from "./bindings/DatabaseProfile";
import type { DatabaseProfileView } from "./bindings/DatabaseProfileView";
import { drawDatabaseSide, type SideActions } from "./database-side.js";
import { openDatabaseForm } from "./database-form.js";
import { $ } from "./dom.js";
import { confirmDelete } from "./hint.js";
import { PLUS_SVG } from "./icons.js";
import { invoke } from "./ipc.js";
import { initSplit } from "./split.js";
import { show, showError } from "./view.js";

let profiles: DatabaseProfileView[] = [];
let selected: string | null = null;
// The newest read: an older one that ends later is dropped.
let loadSeq = 0;

const draw = () => drawDatabaseSide({ profiles, selected }, actions);

// Reads the connections from Rust (the file and the keychain are the only copy) and draws them.
async function load() {
  const seq = ++loadSeq;
  try {
    const list = await invoke("database_profiles");
    if (seq !== loadSeq) return;
    profiles = list;
    if (selected !== null && !profiles.some((p) => p.id === selected)) selected = null;
    draw();
  } catch (e) {
    if (seq === loadSeq) showError(e);
  }
}

async function save(profile: DatabaseProfile, password: string) {
  await invoke("database_profile_save", { profile, password });
  await load();
}

// The version that the server of the connection as typed answers; Rust opens the tunnel, logs in, reads it and closes the tunnel.
const test = (profile: DatabaseProfile, password: string) => invoke("database_test", { profile, password });

async function remove(profile: DatabaseProfileView, anchor: Element) {
  confirmDelete(anchor, profile.name, async () => {
    try {
      await invoke("database_profile_delete", { id: profile.id });
    } catch (e) {
      showError(e);
    }
    await load();
  });
}

const actions: SideActions = {
  // A connection opens nothing yet.
  choose: (profile) => {
    selected = profile.id;
    draw();
  },
  edit: (profile) => openDatabaseForm(profile, save, test),
  remove,
};

export function showDatabase() {
  show("database");
  draw();
  load();
}

export function initDatabase() {
  const add = $("database-add");
  add.innerHTML = PLUS_SVG;
  add.onclick = () => openDatabaseForm(null, save, test);
  initSplit($("database"), $("database-side-split"), { side: "left", min: 0.15, max: 0.4, initial: 0.2, property: "--side-w" });
}
