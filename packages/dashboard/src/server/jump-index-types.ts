// The names the jump box searches: every System, every Service with its
// System, the projects and Sessions of the last 30 days. Names only, so the
// index stays small enough to read on each opening.
export type JumpSession = {
  harness: string;
  project: string | undefined;
  sessionId: string;
  source: string;
  system: string;
};

export type JumpIndex = {
  projects: string[];
  services: { name: string; system: string }[];
  sessions: JumpSession[];
  systems: string[];
};

// How far back the index reaches for projects and Sessions: the Agents page's
// longest period. A project counts only with a request inside it, so the
// Agents page it opens has a row to pick.
export const JUMP_SESSION_DAYS = 30;
