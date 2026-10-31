// Inline SVG icons. Some are read from the buttons of index.html, so each has one drawing.
import { $ } from "./dom.js";

export const svgOf = (paths: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;

export const CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>';
export const PERSON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="5"/><path d="M2 24c0-6 4.5-9 10-9s10 3 10 9z"/></svg>';
export const TODO_SVG = $("thread-todo").innerHTML.trim();
export const MAIL_SVG = svgOf('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>');
export const SUB_SVG = svgOf('<path d="M6 4v10a3 3 0 0 0 3 3h9"/><path d="M15 14l3 3-3 3"/>');
export const OPEN_SVG = svgOf('<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>');
export const DAY_SVG = svgOf('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M12 14v3"/>');
export const DATE_SVG = svgOf('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/>');
export const GRIP_SVG = svgOf('<path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01"/>');
export const FLAG_SVG = svgOf('<path d="M5 21V4h11l-2 4 2 4H5"/>');
export const EDIT_SVG = svgOf('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>');
export const FOLDER_SVG = svgOf('<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>');
export const CLAUDE_SVG = svgOf('<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"/>');
export const SLACK_SVG = $("thread-slack").innerHTML.trim();
export const UNLINK_SVG = $("todo-disconnect").innerHTML.trim();
export const LOCK_SVG = svgOf('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>');
export const COPY_SVG = svgOf('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>');
export const CLOSE_SVG = svgOf('<path d="M6 6l12 12M18 6L6 18"/>');
export const INBOX_SVG = $("nav-mail").querySelector("svg")!.outerHTML;
export const PLUS_SVG = $("add-account").innerHTML.trim();
export const DELETE_SVG = $("todo-delete").innerHTML.trim();
