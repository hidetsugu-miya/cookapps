// The Slack workspaces last read from the backend: the settings card draws them, and the Todo add field decides by them whether a Slack link can be summarised.
import type { Workspace } from "./bindings/Workspace";
import { invoke } from "./ipc.js";
import { updateAddMode } from "./todo-add.js";

// slack_load's workspaces, or null until read; settings changes update it.
let slackWorkspaces: Workspace[] | null = null;
let loadingSlack = false;

// Bumped when settings changes what the Slack list shows (a channel put back), so that the list is read again at the next chance.
let listVersion = 0;
export const bumpSlackList = () => ++listVersion;
export const slackListVersion = () => listVersion;

export const getSlackWorkspaces = () => slackWorkspaces;
export const setSlackWorkspaces = (list: Workspace[]) => (slackWorkspaces = list);

export async function loadSlackWorkspaces() {
  if (loadingSlack) return;
  loadingSlack = true;
  try {
    slackWorkspaces = (await invoke("slack_load")).workspaces;
  } catch {
    slackWorkspaces = [];
  }
  loadingSlack = false;
  updateAddMode();
}
