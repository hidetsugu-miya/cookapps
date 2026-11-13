// The period of a timer that an E2E spec has to wait out, in milliseconds: `normal` in the app, and in the E2E build the value the spec gave `boot` (`timers` in e2e/support.ts).
// Only e2e/fixtures.js sets `window.__e2e_timers__`, and it is loaded in the E2E build alone, so the app's own periods never change.
export type TimerName = "orcaClock" | "orcaMirror" | "arrival";

export const periodMs = (name: TimerName, normal: number): number => window.__e2e_timers__?.[name] ?? normal;
