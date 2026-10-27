import { WINDOW_DAYS } from './service-detail.ts';

const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

export type Install = { at: number; version: string; was: string };

// The changes between known installed versions in the window before `now`,
// newest first, from a Service's version rows oldest first. The first known
// version is not a change, unknown rows are skipped, and a row that changes
// only the upstream carries the same version, so it is not one either. The walk
// starts before the window so the first change in it still says what it was.
export const installsOf = (
  rows: readonly { at: number; version: string | null }[],
  now: number,
): Install[] => {
  const installs: Install[] = [];
  let last: string | undefined;
  for (const { at, version } of rows) {
    if (version === null) {
      continue;
    }
    if (last !== undefined && last !== version && now - at <= WINDOW_MS) {
      installs.push({ at, version, was: last });
    }
    last = version;
  }
  return installs.toReversed();
};
