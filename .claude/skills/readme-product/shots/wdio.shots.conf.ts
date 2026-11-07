// Runs only the README shots, in one app. shots.sh fills in __ROOT__ with the worktree root and runs a copy.
import { config as base } from "__ROOT__/wdio.conf.ts";

export const config = {
  ...base,
  specs: ["__ROOT__/e2e/specs/readme-shots.e2e.ts"],
  maxInstances: 1,
  capabilities: [base.capabilities[2]].map((c) => {
    const { "wdio:exclude": _x, ...rest } = c as Record<string, unknown>;
    return rest;
  }),
};
