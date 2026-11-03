// Inline SVG icons. Some are read from the buttons of index.html, so each has one drawing.
import { $ } from "./dom.js";

export const svgOf = (paths: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;

export const CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>';
export const PERSON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="5"/><path d="M2 24c0-6 4.5-9 10-9s10 3 10 9z"/></svg>';
export const TODO_SVG = $("thread-todo").innerHTML.trim();
export const MAIL_SVG = svgOf('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>');
export const RETURN_SVG = svgOf('<path d="M9 14 4 9l5-5M4 9h9a7 7 0 0 1 7 7v4"/>');
export const SUB_SVG = svgOf('<path d="M6 4v10a3 3 0 0 0 3 3h9"/><path d="M15 14l3 3-3 3"/>');
export const OPEN_SVG = svgOf('<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>');
export const DAY_SVG = svgOf('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M12 14v3"/>');
export const DATE_SVG = svgOf('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/>');
export const GRIP_SVG = svgOf('<path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01"/>');
export const CHEVRON_SVG = svgOf('<path d="M9 6l6 6-6 6"/>');
export const EDIT_SVG = svgOf('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>');
export const OUTDENT_SVG = svgOf('<path d="M3 5h18M13 12h8M3 19h18"/><path d="M8 9l-4 3 4 3"/>');
export const FOLDER_SVG = svgOf('<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>');
export const CLAUDE_SVG = svgOf('<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"/>');
export const SUMMARY_SVG = $("thread-summary").innerHTML.trim();
export const SLACK_SVG = $("thread-slack").innerHTML.trim();
export const KEY_SVG = svgOf('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/>');
export const LINK_SVG = svgOf('<path d="M9 15l6-6"/><path d="M11 6l1.5-1.5a3.5 3.5 0 0 1 5 5L16 11"/><path d="M13 18l-1.5 1.5a3.5 3.5 0 0 1-5-5L8 13"/>');
export const LOCK_SVG = svgOf('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>');
export const COPY_SVG = svgOf('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>');
export const MEET_SVG = svgOf('<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/>');
export const PIN_SVG = svgOf('<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>');
export const LINES_SVG = svgOf('<path d="M4 6h16M4 12h16M4 18h10"/>');
export const PEOPLE_SVG = svgOf('<circle cx="9" cy="8" r="3.5"/><path d="M3 20c.6-3.6 3-5.5 6-5.5s5.4 1.9 6 5.5M16 5a3.5 3.5 0 0 1 0 6.5M18 14.8c1.7.8 2.7 2.5 3 5.2"/>');
export const CLOSE_SVG = svgOf('<path d="M6 6l12 12M18 6L6 18"/>');
export const INBOX_SVG = $("nav-mail").querySelector("svg")!.outerHTML;
export const PLUS_SVG = svgOf('<path d="M12 5v14M5 12h14"/>');
export const DELETE_SVG = svgOf('<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>');
