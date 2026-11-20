// The Claude Code pane's shared part (A-36): a terminal in which tsunagiai runs Claude Code itself, in a pseudo terminal that Rust opens (`src-tauri/src/claude_code.rs`), drawn by the xterm.js of `ts/orca-terminal.ts` (the kind "pty").
// No Orca is in between. Claude Code gets only the tools of `tsunagiai-mcp` (the built-in tools are off unless a screen asks for them with `builtinTools`), a saved skill and a first instruction (`prompt`) when the screen gives them.
// A screen that holds a pane gives it a host element and an `owner` (the name of the pane), shows it with `showClaudeCode` while it is in view, hides it with `hideClaudeCode` (the process goes on, and what it prints is drawn into the hidden terminal),
// and ends it with `closeClaudeCode` when the pane is closed or the screen no longer needs it (the process and what it started are ended). A message of a failed start or of the end of the process is drawn in the terminal.
// The orchestrator of A-37 is the pane `kind: "formation"`: Rust runs it in `formations/{name}/` of the config directory (the folder of its formation) (its own `CLAUDE.md`, the tools of `tsunagiai-mcp --formation {name}`, Claude Code's own tools on, and the projects saved with the formation as its first instruction, which Rust reads itself) when the id of the pane is `formationPaneId(name)`.
// `onEnd` is told when the process ends by itself with the exit code 0 (not when its start failed or it ended with an exit code or a signal, which stay drawn in the terminal), so a screen can drop the pane.
import type { ClaudeCodePermissionMode } from "./bindings/ClaudeCodePermissionMode";
import type { SkillScreen } from "./bindings/SkillScreen";
import { hideTerminals, isShowing, releaseTerminal, showTerminals, whenStarted } from "./orca-terminal.js";

// The id of the pane of the orchestrator of the formation `name`: Rust takes a pane of this id for that formation's orchestrator, and names its session and its folder by `name`.
export const formationPaneId = (name: string) => `formation:${name}`;

export interface ClaudeCodeOptions {
  // The id of the pane: Rust names the process by it, and starting an id again ends the process it had. With `kind: "formation"` it is `formationPaneId(name)`.
  id: string;
  // The orchestrator (A-37) in place of a pane of a screen: the pane id is `formationPaneId(name)`, and Claude Code's own tools are on.
  kind?: "formation";
  // Leaves Claude Code's own tools on (the database screen does; the others never).
  builtinTools?: boolean;
  // How Claude Code asks for a tool (#1074): "manual" (the default) asks the owner for every tool that writes; "auto" runs them unasked, and only the calendar pane takes it; "auto-slack-compose" is the Slack compose pane's (#1144: Sonnet at the effort high, and Claude Code asks before the post); "auto-todo-draft" is the pane of a Todo's draft (#1148: Sonnet at the effort high). Rust refuses all three with `builtinTools` and for the orchestrator.
  permissionMode?: ClaudeCodePermissionMode;
  // A saved skill that Claude Code is given with `--plugin-dir` (A-32).
  skill?: { name: string; screen: SkillScreen } | null;
  // The first instruction of Claude Code (1 to 20,000 characters, passed as `claude [prompt]`; a text that a screen built from data puts that data inside a quote). The orchestrator takes none from here.
  prompt?: string | null;
  // Called when the process ends by itself with the exit code 0.
  onEnd?: () => void;
}

// Shows the terminal of the pane in `host` and gives it the keyboard when it is new. The first show starts the process, with the size of `host`; a later one only draws it again.
export function showClaudeCode(host: HTMLElement, options: ClaudeCodeOptions, owner: string) {
  host.classList.add("claude-code-pane");
  const id = options.id;
  const pty = { builtinTools: options.kind === "formation" || (options.builtinTools ?? false), permissionMode: options.permissionMode ?? "manual", skill: options.skill ?? null, prompt: options.prompt ?? null, onEnd: options.onEnd };
  showTerminals([{ id, source: { kind: "pty", handle: id, path: "", environment: null, pty }, host }], id, owner);
}

// Whether the pane `owner` shows the terminal `id` in `host`, so that showing it again would change nothing.
export function isClaudeCodeShowing(host: HTMLElement, id: string, owner: string) {
  return isShowing({ id, source: { kind: "pty", handle: id, path: "", environment: null }, host }, owner);
}

// Hides the terminal of the pane `owner` (another screen, or the pane is out of view). The process stays and keeps drawing.
export function hideClaudeCode(owner: string) {
  hideTerminals(owner);
}

// Forgets the terminal `id` of the pane `owner` and ends its process.
export function closeClaudeCode(id: string, owner: string) {
  releaseTerminal(id, owner);
}

// Resolves when the start of the process of the pane `id` has answered, so a screen can leave a restart alone until then.
export const claudeCodeStarted = whenStarted;
