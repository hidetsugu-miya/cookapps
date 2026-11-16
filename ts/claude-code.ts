// The Claude Code pane's shared part (A-36): a terminal in which cookapps runs Claude Code itself, in a pseudo terminal that Rust opens (`src-tauri/src/claude_code.rs`), drawn by the xterm.js of `ts/orca-terminal.ts` (the kind "pty").
// No Orca is in between. Claude Code gets only the tools of `cookapps-mcp` (the built-in tools are off unless a screen asks for them with `builtinTools`), and a saved skill when the screen gives one.
// A screen that holds a pane gives it a host element and an `owner` (the name of the pane), shows it with `showClaudeCode` while it is in view, hides it with `hideClaudeCode` (the process goes on, and what it prints is drawn into the hidden terminal),
// and ends it with `closeClaudeCode` when the pane is closed or the screen no longer needs it (the process and what it started are ended). A message of a failed start or of the end of the process is drawn in the terminal.
import type { SkillScreen } from "./bindings/SkillScreen";
import { hideTerminals, releaseTerminal, showTerminals } from "./orca-terminal.js";

export interface ClaudeCodeOptions {
  // The id of the pane: Rust names the process by it, and starting an id again ends the process it had.
  id: string;
  // Leaves Claude Code's own tools on (the database screen does; the others never).
  builtinTools?: boolean;
  // A saved skill that Claude Code is given with `--plugin-dir` (A-32).
  skill?: { name: string; screen: SkillScreen } | null;
}

// Shows the terminal of the pane in `host` and gives it the keyboard when it is new. The first show starts the process, with the size of `host`; a later one only draws it again.
export function showClaudeCode(host: HTMLElement, options: ClaudeCodeOptions, owner: string) {
  host.classList.add("claude-code-pane");
  const pty = { builtinTools: options.builtinTools ?? false, skill: options.skill ?? null };
  showTerminals([{ id: options.id, source: { kind: "pty", handle: options.id, path: "", environment: null, pty }, host }], options.id, owner);
}

// Hides the terminal of the pane `owner` (another screen, or the pane is out of view). The process stays and keeps drawing.
export function hideClaudeCode(owner: string) {
  hideTerminals(owner);
}

// Forgets the terminal `id` of the pane `owner` and ends its process.
export function closeClaudeCode(id: string, owner: string) {
  releaseTerminal(id, owner);
}
